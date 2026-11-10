#!/usr/bin/env python3
"""CPU read-out of the two calibration splits through the frozen head."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from r1config import CACHE, RESULTS
from score import scores_for, write_scores


def main() -> int:
    for split in ("cal-temperature", "cal-policy"):
        rows = scores_for(split, CACHE / f"features-{split}.npz")
        digest = write_scores(RESULTS / f"cal-scores-{'temperature' if split.endswith('temperature') else 'policy'}.jsonl", rows)
        print(f"{split}: rows={len(rows)} sha256={digest[:16]} cases={len({r['caseId'] for r in rows})}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
