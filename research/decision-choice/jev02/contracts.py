"""JEV-02 frozen contracts. Budget is checked at reserve, before any compute."""
from __future__ import annotations

import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CACHE = ROOT / "cache"
RESULTS = ROOT / "results"
EVIDENCE = ROOT / "evidence"
RUNS = ROOT / "runs"
AUDIT = ROOT / "audit"
LABEL = ROOT / "label"
MODEL_PATH = Path("/data2/model_weights/Qwen3.8-27B")

SCHEMA = "frostecho.jev02"
CLASSES = ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION")
CLASS_SET = set(CLASSES)
LETTERS = ("A", "B", "C", "D")

# Four fixed permutations; across them every class appears at every position
# exactly once (a Latin square), so no class is tied to a letter.
ORDERS = (
    ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION"),
    ("NEEDS_CLARIFICATION", "NO_PRIORITY_REQUEST", "NPC_FIRST", "PLAYER_FIRST"),
    ("NPC_FIRST", "PLAYER_FIRST", "NEEDS_CLARIFICATION", "NO_PRIORITY_REQUEST"),
    ("NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION", "PLAYER_FIRST", "NPC_FIRST"),
)
LETTER_LABEL = {
    "PLAYER_FIRST": "玩家先吃，npc 等玩家吃完再吃",
    "NPC_FIRST": "npc 先吃，玩家等 npc 吃完再吃",
    "NO_PRIORITY_REQUEST": "玩家没有提出谁先吃",
    "NEEDS_CLARIFICATION": "玩家这句话没有说清谁先吃",
}

CAPS = {
    "model_jobs": 25000,
    "generation_jobs": 1700,
    "max_new_tokens": 64,
    "per_gpu_gib": 24,
    "window_seconds": 12 * 3600,
    "retries_total": 10,
    "retries_per_task": 1,
    "feature_jobs": 24000,
    "forward_jobs": 23300,
    "latency_jobs": 200,
    "warmup_jobs": 16,
}

TRAIN = {
    "hidden": 5120,
    "batch_groups": 32,
    "lr": 0.001,
    "weight_decay": 0.01,
    "epochs_max": 100,
    "patience": 10,
    "grad_clip": 1.0,
    "seeds": (17, 29, 43),
    "consistency_weight": 0.1,
    "variants": ("M1", "M2"),
}

DISPLAY_ORDERS = 4


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json(value) -> str:
    return sha256_text(canonical(value))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def display_to_stable(order_index: int) -> dict[str, str]:
    return {letter: stable for letter, stable in zip(LETTERS, ORDERS[order_index])}


def letters_for(order_index: int) -> dict[str, str]:
    return {stable: letter for letter, stable in display_to_stable(order_index).items()}


def model_fingerprint() -> dict:
    files = {}
    total = 0
    for name in ("config.json", "tokenizer_config.json", "chat_template.jinja",
                 "model.safetensors.index.json", "generation_config.json"):
        path = MODEL_PATH / name
        if not path.exists():
            continue
        files[name] = {"sha256": sha256_file(path), "bytes": path.stat().st_size}
        total += files[name]["bytes"]
    return {"path": str(MODEL_PATH), "files": files, "metadataBytes": total}
