#!/usr/bin/env python3
"""Count the REAL tokenizer's tokens for the memory blocks the game emits.

The Node side cannot do this: it has no tokenizer. It writes the exact block
bytes to ``artifacts/r11-b/texts/`` and this script counts them with the
encoder's own tokenizer, writing ``encoder-tokens.json`` next to the estimate.
The two numbers are never merged into one field.

    python scripts/r11-b/tokenize_blocks.py \
      --out artifacts/r11-b --model /data2/model_weights/Qwen3.8-27B

CPU only; no model weights are loaded (tokenizer files only).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts/r11-b")
    parser.add_argument("--model", default="/data2/model_weights/Qwen3.8-27B")
    args = parser.parse_args()

    out = Path(args.out).resolve()
    manifest = json.loads((out / "tokenizer-inputs.json").read_text(encoding="utf-8"))

    from transformers import AutoTokenizer  # imported late: CPU tokenizer only

    model = Path(args.model)
    tokenizer = AutoTokenizer.from_pretrained(str(model), local_files_only=True)

    identity_files = {}
    for name in ("tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt"):
        candidate = model / name
        if candidate.exists():
            identity_files[name] = sha256(candidate)

    entries = []
    for item in manifest["texts"]:
        path = out / item["file"]
        text = path.read_text(encoding="utf-8")
        encoded = tokenizer(text, add_special_tokens=False, truncation=False)
        tokens = len(encoded["input_ids"])
        raw = text.encode("utf-8")
        estimate = math.ceil(len(raw) / 3)
        entries.append(
            {
                "file": item["file"],
                "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "manifestSha256": item["sha256"],
                "shaMatchesManifest": hashlib.sha256(raw).hexdigest() == item["sha256"],
                "estimateUnits": estimate,
                "encoderTokens": tokens,
                "encoderMinusEstimate": tokens - estimate,
                "ratioEncoderOverEstimate": round(tokens / estimate, 4) if estimate else None,
            }
        )

    estimates = [entry["estimateUnits"] for entry in entries]
    actuals = [entry["encoderTokens"] for entry in entries]
    document = {
        "schema": "frostecho.r11b.encoder-tokens/1",
        "tokenizer": {
            "id": str(model),
            "className": type(tokenizer).__name__,
            "vocabSize": len(tokenizer),
            "files": identity_files,
            "device": "cpu",
            "addSpecialTokens": False,
        },
        "meaning": (
            "estimateUnits = ceil(utf8 bytes / 3), the game's deterministic budget unit. "
            "encoderTokens = the encoder tokenizer applied to the same bytes. "
            "They are different quantities and are reported separately."
        ),
        "summary": {
            "texts": len(entries),
            "allShaMatch": all(entry["shaMatchesManifest"] for entry in entries),
            "estimateIsConservative": all(a >= e for a, e in zip(actuals, estimates)),
            "maxEncoderOverEstimate": max((a - e) for a, e in zip(actuals, estimates)),
            "meanRatio": round(sum(actuals) / sum(estimates), 4) if sum(estimates) else None,
        },
        "entries": entries,
    }
    (out / "encoder-tokens.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(document["summary"], indent=2))
    return 0 if document["summary"]["allShaMatch"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
