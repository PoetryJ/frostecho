#!/usr/bin/env python3
"""CPU read-out of the three frozen heads over the persisted features.

M0 and C score the four candidate vectors (display order, mapped to stable class
ids); Q scores hq, which is order-independent by construction. Nothing crosses
between presentations and no head is re-trained, re-fitted or re-selected.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "heads"))

import j3config as R3  # noqa: E402
import j3heads as H  # noqa: E402
from runtime import CacheBinding  # noqa: E402


def load_heads() -> dict:
    seal = R3.read_json(R3.RESULTS / "selection-seal.json")
    from safetensors.torch import load_file
    import torch

    m0 = H.build("C")
    m0.load_state_dict({"score.weight": load_file(seal["M0"]["path"])["w"].reshape(1, -1)})
    m0.eval()
    heads = {"M0": (m0, seal["M0"]["tensorSha256"])}
    for arm in ("C", "Q"):
        path = Path(seal["selected"][arm]["path"])
        heads[arm] = (H.load_trained(arm, path), seal["selected"][arm]["tensorSha256"])
    return heads


def main() -> int:
    import torch

    plan = R3.read_json(HERE / "plan.json")
    presentations = R3.read_jsonl(HERE / "results" / "presentations.jsonl")
    cache = HERE / "results" / "behavior-features.npz"
    binding = CacheBinding(R3.read_json(HERE / "results" / "cache-binding.json"))
    rows = [{"caseId": row["caseId"], "order": row["order"]} for row in presentations]
    head_ids = {arm: value[1] for arm, value in load_heads().items()}
    # verifying here means the read-out refuses a cache that no longer matches its binding
    class _Case:
        pass
    data = np.load(cache)
    if list(data["cand"].shape)[:2] != [len(rows), 4]:
        raise SystemExit(f"cache shape {data['cand'].shape} does not match {len(rows)} rows")
    if binding.payload["cacheSha"] != R3.sha256_file(cache):
        raise SystemExit("cache bytes changed after binding")
    if binding.payload["tokenHashes"] != [row["tokenHash"] for row in presentations]:
        raise SystemExit("token hashes changed after binding")
    heads = load_heads()
    scores = []
    with torch.no_grad():
        for index, row in enumerate(rows):
            order = int(row["order"])
            cand = torch.from_numpy(data["cand"][index]).unsqueeze(0)
            hq = torch.from_numpy(data["hq"][index]).unsqueeze(0)
            for arm in R3.ARMS:
                head, sha = heads[arm]
                if arm in ("M0", "C"):
                    display = head(cand)[0].tolist()
                    logits = [0.0] * 4
                    for position, class_id in enumerate(R3.ORDERS[order]):
                        logits[R3.CLASSES.index(class_id)] = float(display[position])
                else:
                    logits = [float(value) for value in head(hq)[0].tolist()]
                scores.append({"caseId": row["caseId"], "order": order, "arm": arm,
                               "canonicalClassIds": list(R3.CLASSES), "logits": logits,
                               "prediction": R3.CLASSES[int(np.argmax(logits))],
                               "headSha": sha,
                               "inputSha": presentations[index]["inputListSha"]})
    digest = R3.write_jsonl(HERE / "results" / "scores.jsonl", scores)
    R3.write_json(HERE / "results" / "scores-meta.json",
                  {"schema": "frostecho.jev03r1.scores/1", "at": R3.now_iso(),
                   "rows": len(scores), "sha256": digest, "presentations": len(rows),
                   "arms": list(R3.ARMS), "plan": plan["campaign"],
                   "headShas": head_ids, "device": "cpu"})
    print(R3.canonical({"scores": len(scores), "sha256": digest[:16]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
