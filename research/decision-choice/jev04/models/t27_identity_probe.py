"""T27 real-identity preflight (R2, new run id).

The R1 probe only looked for directories literally named Qwen3.5 and recorded
`anchors=0`. This probe walks the real model roots, reads every config.json it
can, estimates parameter count from the safetensors index (or config dims), and
reports complete/incomplete weights with the missing shards. No weights are
loaded, no GPU is allocated and nothing is trained.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

RUN_ID = "t27-identity-20261111-r2"
SEARCH_ROOTS = ["/data3/DATA/models", "/data3/DATA/model", "/data/models",
                "/data/model", "/data", "/root/.cache/huggingface"]
SKIP = {"node_modules", ".git", "__pycache__", "site-packages"}
MAX_DEPTH = 5


def config_candidates():
    seen = set()
    for root in SEARCH_ROOTS:
        base = Path(root)
        if not base.exists():
            continue
        base_depth = len(base.parts)
        for current, dirs, files in os.walk(base):
            depth = len(Path(current).parts) - base_depth
            if depth >= MAX_DEPTH:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith(".")]
            if "config.json" in files:
                resolved = str(Path(current).resolve())
                if resolved not in seen:
                    seen.add(resolved)
                    yield Path(current)


def infer_params(path: Path, config: dict) -> tuple[int | None, str, list, list]:
    files = sorted(p.name for p in path.iterdir() if p.is_file())
    index_files = [name for name in files if name.endswith(".safetensors.index.json")]
    if index_files:
        try:
            index = json.loads((path / index_files[0]).read_text(encoding="utf-8"))
            total = int(index.get("metadata", {}).get("total_size", 0))
            shards = sorted(set(index.get("weight_map", {}).values()))
            missing = [shard for shard in shards if not (path / shard).exists()]
            if total:
                return total // 2, "index.total_size/2", shards, missing
        except Exception:
            pass
    shards = [name for name in files if name.endswith(".safetensors")]
    if shards:
        total = sum((path / shard).stat().st_size for shard in shards)
        return total // 2, "safetensors-size/2", shards, []
    hidden = config.get("hidden_size") or config.get("n_embd")
    layers = config.get("num_hidden_layers") or config.get("n_layer")
    vocab = config.get("vocab_size")
    if hidden and layers and vocab:
        approx = 12 * int(layers) * int(hidden) ** 2 + int(vocab) * int(hidden)
        return approx, "config-dims-approx", [], []
    return None, "unknown", [], []


def main() -> int:
    models = []
    for path in config_candidates():
        try:
            config = json.loads((path / "config.json").read_text(encoding="utf-8"))
        except Exception:
            continue
        model_type = str(config.get("model_type", ""))
        architectures = [str(item) for item in config.get("architectures", [])]
        name_blob = f"{path.name} {model_type} {' '.join(architectures)}".lower()
        params, source, shards, missing = infer_params(path, config)
        relevant = ("qwen" in name_blob or "echo" in name_blob or "frost" in name_blob
                    or (params is not None and 20e9 <= params <= 40e9))
        if not relevant:
            continue
        models.append({
            "path": str(path),
            "modelType": model_type,
            "architectures": architectures,
            "paramCount": params,
            "paramSource": source,
            "billionParams": round(params / 1e9, 2) if params else None,
            "shardCount": len(shards),
            "missingShards": missing,
            "complete": not missing,
            "looksLike27B": params is not None and 24e9 <= params <= 32e9,
        })
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                                text=True, cwd=Path(__file__).resolve().parents[4],
                                check=False).stdout.strip()
    except Exception:
        commit = "unknown"
    found27 = [entry for entry in models if entry["looksLike27B"] and entry["complete"]]
    report = {
        "schema": "frostecho.jev04.t27-identity/1",
        "runId": RUN_ID,
        "at": datetime.now(timezone.utc).isoformat(),
        "commit": commit,
        "mode": "preflight only; no weights loaded, no GPU allocated",
        "searchRoots": SEARCH_ROOTS,
        "candidates": models,
        "verdict": "found" if found27 else "not-found",
        "reasons": [] if found27 else [
            "no complete 24B-32B checkpoint under the searched roots",
            "download list: Qwen3.5-27B base + tokenizer (official source), then rerun this probe",
        ],
    }
    out = Path(__file__).resolve().parent / f"{RUN_ID}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"runId": RUN_ID, "verdict": report["verdict"],
                      "candidates": len(models), "output": str(out)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
