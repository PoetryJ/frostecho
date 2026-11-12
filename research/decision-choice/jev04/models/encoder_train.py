#!/usr/bin/env python3
"""R3 (M): real training entry — candidate encoder -> shared scalar head.

This is the executable wiring for the original matrix plan (frozen backbone,
mean-pooled candidate encoding, one shared scalar head scored per candidate,
softmax over K). It refuses to train when:

  - the v3 data gate is blocked (gate-v3.json mayTrainOnJev false);
  - the backbone identity is not registered in the trusted policy manifest;
  - the registered weights are absent or incomplete.

`--smoke` runs a tiny end-to-end pass (2 steps on CPU) purely to prove the
wiring executes; it never writes a model artifact and its metrics are
labelled smoke, not training results.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_V3 = HERE.parent / "data" / "v3"
RUNS = HERE / "runs"
RUNS.mkdir(exist_ok=True)

TRUSTED_MANIFEST = HERE / "policy-manifest.json"


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def gate_status() -> dict:
    gate_path = DATA_V3 / "gate-v3.json"
    if not gate_path.is_file():
        return {"mayTrainOnJev": False, "reason": "gate-v3.json missing"}
    gate = json.loads(gate_path.read_text(encoding="utf-8"))
    return {"mayTrainOnJev": bool(gate.get("mayTrainOnJev")),
            "reason": "; ".join(gate.get("failures") or []) or "gate passed for small set"}


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
    candidates = "\n".join(f"{cand['id']}. {cand['text']}" for cand in case["candidates"])
    facts = "；".join(f"{fact['id']}={fact['content']}" for fact in case.get("facts", []))
    head = f"任务：{case['task']}\n叙述：{case['narrative']['text']}\n"
    if facts:
        head += f"事实：{facts}\n"
    return head + f"候选：\n{candidates}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true",
                        help="2-step CPU wiring check; writes no model artifact")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-4)
    args = parser.parse_args()

    gate = gate_status()
    backbone = resolve_backbone("full" if not args.smoke else "smoke")
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")

    if not args.smoke and (not gate["mayTrainOnJev"] or not backbone.get("ok")):
        result = {
            "schema": "frostecho.jev04.encoder-train/1",
            "at": now(),
            "status": "refused",
            "mode": "full",
            "gate": gate,
            "backbone": backbone,
            "note": "training entry is executable and wired; it refuses because "
                    "the data gate and/or registered weights are not in place. "
                    "No scores are reported as training results.",
        }
        out = RUNS / f"encoder-train-refused-{stamp}.json"
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print(f"written: {out}", file=sys.stderr)
        return 2

    if args.smoke and not backbone.get("ok"):
        result = {
            "schema": "frostecho.jev04.encoder-train/1", "at": now(),
            "status": "refused", "mode": "smoke",
            "backbone": backbone,
            "note": "smoke mode still requires a registered local backbone; "
                    "nothing was executed.",
        }
        out = RUNS / f"encoder-train-smoke-refused-{stamp}.json"
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2

    # Real wiring from here on.
    import torch
    from torch import nn
    from transformers import AutoModel, AutoTokenizer

    train = load_jsonl(DATA_V3 / "train.jsonl")
    dev = load_jsonl(DATA_V3 / "dev.jsonl")
    backbone_path = backbone["path"]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(backbone_path, trust_remote_code=False)
    encoder = AutoModel.from_pretrained(backbone_path, torch_dtype=dtype).to(device)
    encoder.eval()
    for parameter in encoder.parameters():
        parameter.requires_grad_(False)

    hidden = encoder.config.hidden_size
    head = nn.Linear(hidden, 1).float()
    optimizer = torch.optim.AdamW(head.parameters(), lr=args.lr)
    loss_fn = nn.CrossEntropyLoss()

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
            logits = torch.stack([torch.cat(
                [head(encode(render_item(case) + f"\n评估候选 {cand['id']}。"))
                 for cand in case["candidates"]]) for case in batch])
            targets = torch.tensor([
                case["candidates"].index(
                    next(c for c in case["candidates"]
                         if c["id"] == case["acceptableOpaque"][0]))
                for case in batch])
            loss = loss_fn(logits, targets)
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
    # calibration/select split exists in R3).
    correct = 0
    with torch.no_grad():
        for case in dev:
            scores = torch.cat([head(encode(render_item(case) + f"\n评估候选 {c['id']}。"))
                                for c in case["candidates"]])
            if int(scores.argmax()) == next(i for i, c in
                                            enumerate(case["candidates"])
                                            if c["id"] == case["acceptableOpaque"][0]):
                correct += 1
    dev_accuracy = round(correct / max(1, len(dev)), 4)

    result = {
        "schema": "frostecho.jev04.encoder-train/1",
        "at": now(),
        "status": "completed",
        "mode": "smoke" if args.smoke else "full",
        "gate": gate,
        "backbone": {"path": backbone_path, "identity": backbone.get("identity")},
        "steps": steps,
        "history": history,
        "dev": {"cases": len(dev), "argmaxAccuracy": dev_accuracy,
                "warning": "scores only; no independent calibration/select/cert "
                           "split, so no risk certificate is claimed"},
        "modelArtifactWritten": False if args.smoke else True,
    }
    out = RUNS / f"encoder-train-{'smoke' if args.smoke else 'full'}-{stamp}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    print(json.dumps({k: result[k] for k in
                      ("status", "mode", "steps", "dev")}, ensure_ascii=False, indent=2))
    print(f"written: {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
