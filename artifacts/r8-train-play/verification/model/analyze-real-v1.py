"""Read-only comparison of the frozen v1 archive; no simulation/model calls."""
import argparse, collections, hashlib, io, json, math, re, statistics, subprocess, tarfile
from pathlib import Path

def sha(value):
    return hashlib.sha256(value).hexdigest()

def distribution(values):
    return dict(sorted(collections.Counter(values).items()))

def numeric(values):
    return {"min": min(values), "mean": statistics.mean(values),
            "median": statistics.median(values), "max": max(values)}

def action_key(candidate):
    if candidate is None:
        return "none"
    p = candidate["parameters"]
    action = p.get("action", candidate["kind"])
    detail = p.get("resource") if action == "gather" else p.get("purpose") if action == "move" else None
    return action + (":" + str(detail) if detail else "")

def selected(row):
    return next((c for c in row["candidates"] if c["id"] == row["selectedId"]), None)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    args = parser.parse_args()
    raw = {}
    prefix = "source/artifacts/r8-train-play/"
    with tarfile.open(args.archive, "r|gz") as archive:
        for member in archive:
            wanted = (member.name.startswith(prefix + "live-fourday-v1/")
                      or member.name.startswith(prefix + "reference-fourday-v1/")
                      or member.name in ("runs/online-v1/reference-exit.json",
                                         "runs/online-v1/fourday-exit.json",
                                         "runs/online-v1/commands.json",
                                         "online-deploy-v1.tar.gz"))
            if member.isfile() and wanted:
                raw[member.name] = archive.extractfile(member).read()
    used = set()
    def document(name):
        used.add(name)
        return json.loads(raw[name])
    def lines(name):
        used.add(name)
        return [json.loads(line) for line in raw[name].splitlines() if line.strip()]
    def locate(arm, stem):
        matches = [name for name in raw if name.startswith(prefix + arm + "/" + stem + "-")
                   and not name.endswith(".r8.json")]
        if len(matches) != 1:
            raise ValueError((arm, stem, matches))
        return matches[0]
    arms, datasets = {}, {}
    for label, directory, stage in (("jev", "live-fourday-v1", "fourday"),
                                     ("reference", "reference-fourday-v1", "reference")):
        summary = document(locate(directory, "summary"))
        runtime = document(locate(directory, "runtime"))
        session = document(locate(directory, "session"))
        trajectory = lines(locate(directory, "trajectory"))
        council = [r for r in trajectory if r["scorerId"] == "council-reference/1"]
        actions = [r for r in trajectory if r["scorerId"] != "council-reference/1"]
        tasks = runtime["states"]["tasks"]["tasks"]
        task_events = [e for e in runtime["committed"] if e["type"] == "task_completed"]
        end = document("runs/online-v1/" + stage + "-exit.json")
        world = session["world"]
        source = runtime["states"]["production"]
        same_place = [r for r in actions if selected(r) and selected(r)["parameters"].get("action") == "move"
                      and "自身:位置" + str(selected(r)["parameters"].get("to")) + " " in r["observationText"]]
        counters = [r for r in actions if selected(r) and selected(r)["parameters"].get("action") == "council-counter"]
        arms[label] = {
            "seed": summary["seed"], "profile": summary["profile"], "sourceHEAD": summary["sourceHEAD"],
            "fullMap": summary["environment"].get("fullMap"),
            "ending": summary["endings"], "allDecisionRows": len(trajectory),
            "referenceCouncilRows": len(council), "actionRows": len(actions),
            "actionScorers": distribution(r["scorerId"] for r in actions),
            "actionExecutionStatus": distribution(r["executionStatus"] for r in actions),
            "allAppliedRows": sum(bool(r["executed"]) for r in trajectory),
            "selectedActionDistribution": distribution(action_key(selected(r)) for r in actions),
            "appliedActionDistribution": distribution(action_key(selected(r)) for r in actions if r["executionStatus"] == "applied"),
            "selectedMoveToAlreadyCurrentLocation": len(same_place),
            "communicationCounterSelections": len(counters),
            "finalResources": world["resources"], "finalFurnace": world["furnace"],
            "finalMachineState": source,
            "tasks": {"totalInstances": len(tasks), "statusCounts": distribution(task["status"] for task in tasks),
                      "doneByType": distribution(task["type"] for task in tasks if task["status"] == "done"),
                      "acceptedByType": distribution(task["type"] for task in tasks if task["status"] == "accepted"),
                      "committedCompletionEventCount": len(task_events),
                      "committedCompletionEvents": task_events,
                      "trajectoryTaskCompletedFields": sum(r.get("taskCompleted") is not None for r in actions)},
            "npcHealth": numeric([npc["health"] for npc in world["npcs"].values()]),
            "npcHunger": numeric([npc["hunger"] for npc in world["npcs"].values()]),
            "npcStamina": numeric([npc["stamina"] for npc in world["npcs"].values()]),
            "wallSeconds": end["wallSeconds"], "processExitCode": end["returncode"],
            "actionLatencyMs": numeric([r["latencyMs"] for r in actions]),
        }
        datasets[label] = {"summary": summary, "runtime": runtime, "session": session,
                           "trajectory": trajectory, "actions": actions}
    if arms["jev"]["seed"] != arms["reference"]["seed"] or arms["jev"]["sourceHEAD"] != arms["reference"]["sourceHEAD"]:
        raise ValueError("paired run identity mismatch")
    transcript_name = locate("live-fourday-v1", "scorer")
    transcript = lines(transcript_name)
    requests = [row["envelope"] for row in transcript if row["event"] == "score_request"]
    replies = [row["reply"] for row in transcript if row["event"] == "score_reply"]
    by_request = {row["request"]["requestId"]: row for row in requests}
    by_reply = {row["requestId"]: row for row in replies if "requestId" in row}
    if len(requests) != len(by_request) or len(replies) != len(by_reply):
        raise ValueError("duplicate protocol request IDs")
    for row in datasets["jev"]["actions"]:
        request, reply = by_request[row["requestId"]], by_reply[row["requestId"]]
        if sha(request["requestJson"].encode()) != request["inputSha256"]:
            raise ValueError("raw input hash mismatch")
        if row["inputSha256"] != request["inputSha256"] or reply["inputSha256"] != request["inputSha256"]:
            raise ValueError("trajectory/service input identity mismatch")
        if row["selectedId"] != reply["selectedId"] or row["candidateSetHash"] != reply["candidateSetHash"]:
            raise ValueError("selected action binding differs")
    rejection_details = []
    for row in datasets["jev"]["actions"]:
        if row["executionStatus"] != "rejected":
            continue
        envelope, reply = by_request[row["requestId"]], by_reply[row["requestId"]]
        request, choice = envelope["request"], selected(row)
        score = next(score for score in reply["scores"] if score["candidateId"] == row["selectedId"])
        alternatives = [candidate for candidate in request["candidates"] if candidate["parameters"].get("action") != "medical"]
        remaining_scores = [score for score in reply["scores"] if score["candidateId"] in {c["id"] for c in alternatives}]
        best_other = max(remaining_scores, key=lambda score: score["logit"])
        other_candidate = next(c for c in alternatives if c["id"] == best_other["candidateId"])
        rejection_details.append({
            "requestId": row["requestId"], "actorId": row["actorId"], "day": row["day"], "minuteOfDay": row["minuteOfDay"],
            "reason": row["reason"], "inputSha256": row["inputSha256"], "resources": request["observation"]["resources"],
            "self": request["observation"]["self"], "selected": choice, "modelScore": score,
            "selectedIndex": next(i for i,c in enumerate(request["candidates"]) if c["id"] == row["selectedId"]),
            "taskRulePresent": "task.prepare-medical" in row["rules"],
            "explicitMedicinePrecondition": "medicine >= 1" in choice["preconditions"],
            "medicineKnownBeforeInference": request["observation"]["resources"]["medicine"],
            "selectedMedicineCost": choice["parameters"].get("medicine"),
            "maskedScoreDiagnosticAlternative": {"action": action_key(other_candidate), "candidateId": other_candidate["id"],
                                                 "logit": best_other["logit"], "originalProbability": best_other["probability"]},
            "diagnosticScope": "Re-ranking existing logits only; this is not a replay or a proved alternative episode."
        })
    medical_offers = [r for r in requests if any(c["parameters"].get("action") == "medical" for c in r["request"]["candidates"])]
    known_empty_offers = [r for r in medical_offers if r["request"]["observation"]["resources"]["medicine"] == 0]
    invalid_selection_count = sum(r["medicineKnownBeforeInference"] == 0 and r["selectedMedicineCost"] == 1 for r in rejection_details)
    latencies = sorted(reply["latencyMs"] for reply in replies)
    arms["jev"]["realNeuralForwards"] = replies[-1]["identity"]["encoderForwardCalls"]
    arms["jev"]["serviceRequests"] = len(requests)
    arms["jev"]["serviceSuccessfulReplies"] = sum("error" not in row for row in replies)
    arms["jev"]["serviceLatencyMs"] = {
        **numeric(latencies), "p95NearestRank": latencies[math.ceil(.95*len(latencies))-1],
        "sum": sum(latencies), "includesModelLoad": False}
    arms["jev"]["scorerIdentity"] = replies[-1]["identity"]
    arms["jev"]["stockBeliefLevelNullRequests"] = sum(r["request"]["observation"]["belief"]["level"] is None for r in requests)
    corpus_rows = [json.loads(line) for line in args.corpus.read_text(encoding="utf-8").splitlines() if line]
    corpus_medical = [r for r in corpus_rows if any(c["parameters"].get("action") == "medical" for c in r["request"]["candidates"])]
    source_evidence = {}
    with tarfile.open(fileobj=io.BytesIO(raw["online-deploy-v1.tar.gz"])) as deployment:
        name = next((name for name in deployment.getnames() if name.endswith("src/r7/agency/options.ts")), None)
        if name is not None:
            code = deployment.extractfile(name).read()
        else:
            # The deployment is an overlay; unchanged options.ts comes from the
            # named immutable base commit, also hashed in the frozen corpus.
            name = arms["jev"]["sourceHEAD"].split("+")[0] + ":src/r7/agency/options.ts"
            code = subprocess.run(["git", "show", name], cwd=Path(__file__).resolve().parents[4],
                                  capture_output=True, check=True).stdout
        expected_options_sha = json.loads((args.corpus.parent / "summary.json").read_text(encoding="utf-8"))["sourceHashes"]["src/r7/agency/options.ts"]
        if sha(code) != expected_options_sha:
            raise ValueError("frozen options source disagrees with original corpus SHA")
        text = code.decode()
        source_evidence = {"deploymentMember": "online-deploy-v1.tar.gz", "deploymentSha256": sha(raw["online-deploy-v1.tar.gz"]),
                           "member": name, "memberSha256": sha(code),
                           "genericMedicalGuardPresent": "npc.health < 70 && resources.medicine >= 1" in text,
                           "taskMedicalSourceExcerpt": text[text.index("case 'PREPARE_MEDICAL':"):text.index("case 'BOOST_MORALE':")]}
    used.add("online-deploy-v1.tar.gz")
    initial = requests[0]["request"]["observation"]["resources"]
    report = {
        "schema": "frostecho.real-v1-paired-audit/1",
        "archive": {"path": str(args.archive), "sha256": sha(args.archive.read_bytes()), "bytes": args.archive.stat().st_size},
        "initialResources": initial, "arms": arms,
        "deltasJevMinusReference": {
            "finalResources": {key: arms["jev"]["finalResources"][key] - arms["reference"]["finalResources"][key]
                               for key in arms["jev"]["finalResources"]},
            "doneTaskInstances": arms["jev"]["tasks"]["statusCounts"].get("done",0) - arms["reference"]["tasks"]["statusCounts"].get("done",0),
            "wallSeconds": arms["jev"]["wallSeconds"] - arms["reference"]["wallSeconds"]},
        "rejectionAudit": {"count": len(rejection_details), "reasons": distribution(r["reason"] for r in rejection_details),
            "allMedicineZeroBeforeInferenceAndCostOne": invalid_selection_count == len(rejection_details),
            "medicalOfferedRequests": len(medical_offers), "medicineZeroButMedicalOfferedRequests": len(known_empty_offers),
            "v1TrainingMedicalCandidateCases": len(corpus_medical),
            "v1TrainingMedicalPositiveLabels": sum(r["selectedAction"] == "medical" for r in corpus_rows),
            "frozenSource": source_evidence, "details": rejection_details,
            "rootCause": "Task-specific PREPARE_MEDICAL appends an explicitly medicine>=1 candidate without the generic public-resource guard; the model selects it despite public medicine=0. The authority rejects correctly.",
            "exclusions": ["Not unknown warehouse stock", "Not a post-inference resource race: medicine is already zero in all 10 exact model inputs", "Not a scoring-service failure"],
            "modelContribution": "The model violates its own visible precondition on all 10 attempts; medical has no positive weak-label examples in the 96-case corpus. Distribution shift is a supported limitation, not a proven causal ablation.",
            "scope": "V1 audit only; no frozen V2 code/data modified."},
        "limitations": [
            "One paired seed, original full-map mode disabled; equal perfect/8 survival is a tie, not an improvement.",
            "Forty council rows per arm are reference policy; only 320 rows in the JEV arm are real neural action decisions.",
            "Applied counts include communication/no-op-like repeated moves, and do not by themselves prove promise completion.",
            "V1 taskCompleted trajectory field underreports domain-only task completion; compare final task state and committed task_completed events.",
            "The same v1 policy/data errors are preserved; this audit does not rerun or relabel this episode.",
            "No live certificate, calibrated risk guarantee, independently reviewed long-term memory dataset, or generalization claim."
        ],
        "evidenceMembers": [{"member": name, "sha256": sha(raw[name]), "bytes": len(raw[name])} for name in sorted(used)],
        "reproduce": f"python analyze-real-v1.py --archive <v1-full-evidence.tar.gz> --corpus <corpus-96-v1/cases.jsonl> --out <new-output.json>"
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        raise ValueError("choose a new comparison output; preserve prior evidence")
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"arms": {key: {field: value[field] for field in ("allDecisionRows","referenceCouncilRows","actionRows","actionExecutionStatus","selectedActionDistribution","finalResources","tasks","wallSeconds","npcHealth","selectedMoveToAlreadyCurrentLocation")}
                                  for key,value in arms.items()},
                      "rejectionSummary": {key: report["rejectionAudit"][key] for key in ("count","allMedicineZeroBeforeInferenceAndCostOne","medicalOfferedRequests","medicineZeroButMedicalOfferedRequests","v1TrainingMedicalCandidateCases","v1TrainingMedicalPositiveLabels")}},
                     ensure_ascii=True, indent=2))

if __name__ == "__main__":
    main()
