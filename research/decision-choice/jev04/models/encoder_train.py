#!/usr/bin/env python3
"""R5 (M): real training entry — one qualification gate, then the model.

Order is part of the contract:
  1. recompute the v4 data gate from the current bytes (never a cached flag);
  2. resolve a REAL registered backbone;
  3. only then import torch / transformers and load weights.

A blocked gate or a missing registration exits non-zero BEFORE any model import
or load. The regression test runs this file with a stub `torch` module and
asserts the stub was never imported.

`--smoke` is a 2-step CPU wiring check on the fixture registration; it writes no
model artifact and its metrics are labelled smoke, not training results.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_V4 = HERE.parent / "data" / "v4"
RUNS = HERE / "runs"
RUNS.mkdir(exist_ok=True)

TRUSTED_MANIFEST = HERE / "policy-manifest.json"


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _load_validator(data_dir: Path):
    path = data_dir / "validate_v4.py"
    spec = importlib.util.spec_from_file_location("frostecho_v4_validator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load validator from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["frostecho_v4_validator"] = module
    spec.loader.exec_module(module)
    return module


def data_gate_status(data_dir: Path | None = None) -> dict:
    """The ONLY data qualification report; recomputed on every call."""
    directory = data_dir or DATA_V4
    try:
        validator = _load_validator(directory)
    except Exception as error:  # a missing/tampered validator is a refusal
        return {"mayTrainOnJev": False, "reason": f"validator unavailable: {error}",
                "failures": ["validator_unavailable"], "summary": {}}
    try:
        failures, summary = validator.check(directory)
    except Exception as error:
        return {"mayTrainOnJev": False, "reason": f"validator error: {error}",
                "failures": ["validator_error"], "summary": {}}
    ready = bool(not failures and summary.get("researchTrainReady"))
    reason = ("gate passed and counts meet 512/128 with independent reviews"
              if ready else
              "; ".join(failures[:5]) or
              f"not ready: qualified {summary.get('qualifiedTrain')}/"
              f"{summary.get('requiredTrain')} train, "
              f"{summary.get('qualifiedDev')}/{summary.get('requiredDev')} dev")
    return {"mayTrainOnJev": ready, "reason": reason, "failures": failures,
            "summary": summary}


def gate_status() -> dict:
    """Backward-compatible name used by the R5 audit probe."""
    return data_gate_status()


def resolve_backbone(mode: str) -> dict:
    """mode 'full' needs a REAL registration with weights on disk; 'smoke'
    may use a fixture-registered local substitute, labelled as such."""
    if not TRUSTED_MANIFEST.is_file():
        return {"ok": False,
                "reason": f"no trusted policy manifest at {TRUSTED_MANIFEST}"}
    manifest = json.loads(TRUSTED_MANIFEST.read_text(encoding="utf-8"))
    for registration in manifest.get("registrations", []):
        path = registration.get("weightsPath")
        if not path or not Path(path).is_dir():
            continue
        if mode == "full" and registration.get("mode") != "real":
            continue
        if mode == "smoke" and registration.get("mode") != "fixture":
            continue
        return {"ok": True, "path": path,
                "identity": registration.get("identity"),
                "registrationMode": registration.get("mode"),
                "utilitySource": registration.get("utility_source")}
    if mode == "full":
        return {"ok": False, "reason": "no REAL-registered weights present on disk "
                "(target Qwen/Qwen3.5-27B absent; HF outbound blocked; local "
                "checkpoints are fixture-registered substitutes)"}
    return {"ok": False, "reason": "no fixture-registered local substitute found"}


def render_item(case: dict) -> str:
    narrative = case.get("narrative") or {}
    text = narrative.get("text") if isinstance(narrative, dict) else None
    head = f"任务：{case.get('task')}\n叙述：{text or case.get('question') or ''}\n"
    if case.get("observation") is not None and not text:
        head += f"观察：{json.dumps(case['observation'], ensure_ascii=False)}\n"
    facts = "；".join(f"{fact['id']}={fact['content']}" for fact in case.get("facts", []))
    if facts:
        head += f"事实：{facts}\n"
    candidates = "\n".join(f"{cand['id']}. {cand.get('text', '')}"
                           for cand in case.get("candidates", []))
    return head + f"候选：\n{candidates}"


def candidate_ids(case: dict) -> list[str]:
    return [candidate["id"] for candidate in case.get("candidates", [])]


def acceptable_ids(case: dict, row: dict) -> list[str]:
    raw = row.get("acceptableOpaque") or row.get("acceptable")
    if raw is None:
        raw = [candidate["id"] for candidate in case.get("candidates", [])
               if candidate.get("acceptable") is True]
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"{case.get('caseId')}: no acceptable set")
    known = set(candidate_ids(case))
    unknown = [entry for entry in raw if entry not in known]
    if unknown:
        raise ValueError(f"{case.get('caseId')}: acceptable outside candidates {unknown}")
    return [str(entry) for entry in raw]


def target_index(case: dict, row: dict) -> tuple[int, list[int]]:
    """Training target is the adjudicated label inside the acceptable set."""
    ids = candidate_ids(case)
    acceptable = acceptable_ids(case, row)
    acceptable_indices = [ids.index(entry) for entry in acceptable]
    label = row.get("label")
    if label is not None:
        if label not in ids:
            raise ValueError(f"{case.get('caseId')}: label outside candidates {label!r}")
        if label not in acceptable:
            raise ValueError(f"{case.get('caseId')}: label outside acceptable set {label!r}")
        return ids.index(label), acceptable_indices
    return acceptable_indices[0], acceptable_indices


def load_v4_rows(data_dir: Path) -> tuple[dict[str, dict], list[dict], list[dict]]:
    cases = {row["caseId"]: row for row in load_jsonl(data_dir / "cases.v4.jsonl")}
    train = load_jsonl(data_dir / "train.v4.jsonl")
    dev = load_jsonl(data_dir / "dev.v4.jsonl")
    for split_name, rows in (("train", train), ("dev", dev)):
        for row in rows:
            case = cases.get(row.get("caseId"))
            if case is None:
                raise ValueError(f"{split_name}:{row.get('caseId')}: case missing")
            target_index(case, row)  # fail closed on a bad label/acceptable set
    return cases, train, dev


def acceptable_loss(logits, acceptable_indices: list[int]):
    """Negative log of the softmax mass on the acceptable set (shared component)."""
    import torch
    all_mass = torch.logsumexp(logits, dim=0)
    accept_mass = torch.logsumexp(logits[torch.tensor(acceptable_indices)], dim=0)
    return all_mass - accept_mass


def build_head(hidden: int):
    import torch
    from torch import nn
    return nn.Linear(hidden, 1).float()


def weight_digest(head) -> str:
    digest = hashlib.sha256()
    for name, tensor in head.state_dict().items():
        digest.update(name.encode())
        digest.update(tensor.detach().cpu().numpy().tobytes())
    return digest.hexdigest()


def save_head(path: Path, head, metadata: dict) -> dict:
    """Production save component: state dict + manifest, then reload verify."""
    import torch
    path.mkdir(parents=True, exist_ok=True)
    head_path = path / "head.pt"
    torch.save(head.state_dict(), head_path)
    digest = weight_digest(head)
    manifest = {
        "schema": "frostecho.jev04.shared-head/1",
        "headPath": str(head_path),
        "weightsSha256": hashlib.sha256(head_path.read_bytes()).hexdigest(),
        "weightDigest": digest,
        **metadata,
    }
    (path / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def reload_head(path: Path, hidden: int):
    import torch
    head = build_head(hidden)
    head.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
    head.eval()
    return head


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true",
                        help="2-step CPU wiring check; writes no model artifact")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--model-loader-audit", default=None,
                        help="write this file only if a model loader is actually called")
    args = parser.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else DATA_V4
    gate = data_gate_status(data_dir)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")

    if not args.smoke and not gate["mayTrainOnJev"]:
        result = {
            "schema": "frostecho.jev04.encoder-train/1",
            "at": now(),
            "status": "refused",
            "mode": "full",
            "gate": gate,
            "modelLoads": 0,
            "note": "refused BEFORE any torch/transformers import or weight load; "
                    "the v4 gate is recomputed from the current bytes, not read "
                    "from an editable gate cache.",
        }
        out = RUNS / f"encoder-train-refused-{stamp}.json"
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print(f"written: {out}", file=sys.stderr)
        return 2

    backbone = resolve_backbone("full" if not args.smoke else "smoke")
    if not backbone.get("ok"):
        result = {"schema": "frostecho.jev04.encoder-train/1", "at": now(),
                  "status": "refused", "mode": "full" if not args.smoke else "smoke",
                  "gate": gate, "backbone": backbone, "modelLoads": 0,
                  "note": "nothing was loaded."}
        out = RUNS / f"encoder-train-{'full' if not args.smoke else 'smoke'}-refused-{stamp}.json"
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2

    # Only after gate + registration: import and load.
    import torch
    from torch import nn
    from transformers import AutoModel, AutoTokenizer
    if args.model_loader_audit:
        Path(args.model_loader_audit).write_text("model_loader_called\n", encoding="utf-8")

    cases, train, dev = load_v4_rows(data_dir)
    backbone_path = backbone["path"]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(backbone_path, trust_remote_code=False)
    encoder = AutoModel.from_pretrained(backbone_path, torch_dtype=dtype).to(device)
    encoder.eval()
    for parameter in encoder.parameters():
        parameter.requires_grad_(False)

    hidden = encoder.config.hidden_size
    head = build_head(hidden).to(device)
    optimizer = torch.optim.AdamW(head.parameters(), lr=args.lr)

    def encode(text: str) -> torch.Tensor:
        tokens = tokenizer(text, return_tensors="pt", truncation=True, max_length=96)
        tokens = {key: value.to(device) for key, value in tokens.items()}
        with torch.no_grad():
            output = encoder(**tokens).last_hidden_state  # (1, T, H)
            pooled = output.mean(dim=1)                    # (1, H)
        return pooled[0].float().cpu()

    def batches(rows: list[dict], size: int):
        for start in range(0, len(rows), size):
            yield rows[start:start + size]

    steps_limit = 2 if args.smoke else 10 ** 9
    steps = 0
    history = []
    for epoch in range(1 if args.smoke else args.epochs):
        for batch in batches(train, args.batch):
            losses = []
            for row in batch:
                case = cases[row["caseId"]]
                _, acceptable = target_index(case, row)
                logits = torch.cat([
                    head(encode(render_item(case) + f"\n评估候选 {cand['id']}。"))
                    for cand in case["candidates"]])
                losses.append(acceptable_loss(logits, acceptable))
            loss = torch.stack(losses).mean()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            steps += 1
            history.append({"epoch": epoch, "step": steps,
                            "loss": round(float(loss), 6)})
            if steps >= steps_limit:
                break
        if steps >= steps_limit:
            break

    # Dev pass, reported as scores only (no risk certificate: no independent
    # calibration/select/cert split exists in this round).
    correct = 0
    with torch.no_grad():
        for row in dev:
            case = cases[row["caseId"]]
            acceptable = set(acceptable_ids(case, row))
            scores = torch.cat([head(encode(render_item(case) + f"\n评估候选 {c['id']}。"))
                                for c in case["candidates"]])
            best = case["candidates"][int(scores.argmax())]["id"]
            if best in acceptable:
                correct += 1
    dev_accuracy = round(correct / max(1, len(dev)), 4)

    artifact_path = None
    artifact_written = False
    reload_identical = False
    if not args.smoke:
        artifact_path = RUNS / f"encoder-train-full-{stamp}"
        manifest = save_head(artifact_path, head, {
            "at": now(), "mode": "full", "identity": backbone.get("identity"),
            "steps": steps, "hidden": hidden, "device": device,
            "dataGate": gate["summary"],
        })
        reloaded = reload_head(artifact_path / "head.pt", hidden)
        reload_identical = weight_digest(reloaded) == manifest["weightDigest"]
        artifact_written = reload_identical

    result = {
        "schema": "frostecho.jev04.encoder-train/1",
        "at": now(),
        "status": "completed",
        "mode": "smoke" if args.smoke else "full",
        "gate": gate,
        "backbone": {"path": backbone_path, "identity": backbone.get("identity")},
        "steps": steps,
        "history": history,
        "dev": {"cases": len(dev), "top1InAcceptable": dev_accuracy,
                "warning": "scores only; no independent calibration/select/cert "
                           "split, so no risk certificate is claimed"},
        "artifactPath": str(artifact_path) if artifact_path else None,
        "modelArtifactWritten": artifact_written,
        "reloadIdentical": reload_identical,
        "fixture": args.smoke,
    }
    out = RUNS / f"encoder-train-{'smoke' if args.smoke else 'full'}-{stamp}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    print(json.dumps({k: result[k] for k in
                      ("status", "mode", "steps", "dev", "modelArtifactWritten")},
                     ensure_ascii=False, indent=2))
    print(f"written: {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
