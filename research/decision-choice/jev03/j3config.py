"""JEV-03 frozen configuration: paths, budget, interfaces, identities.

Everything the contract fixes lives here, so the training, prediction and
verification entry points cannot drift apart. The renderer, candidate strings,
ORDERS, backbone and tokenizer are inherited unchanged from the frozen JEV-02
package in this worktree; this module never redefines them.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import sys
from pathlib import Path

J3 = Path(__file__).resolve().parent
R1 = J3.parent / "jev02r1"
JEV02 = J3.parent / "jev02"
for path in (JEV02, R1):
    if str(path) not in sys.path:
        sys.path.append(str(path))

import contracts as C0  # noqa: E402  frozen JEV-02 constants

SCHEMA = "frostecho.jev03"
CONTRACT_SCHEMA = "frostecho.jev03.semantic/2"
DATA_SCHEMA = "frostecho.jev03.case/1"
ENCODED_SCHEMA = "frostecho.jev03.encoded/1"
SCORES_SCHEMA = "frostecho.jev03.scores/1"

CLASSES = C0.CLASSES
ORDERS = C0.ORDERS
LETTERS = C0.LETTERS
LETTER_LABEL = C0.LETTER_LABEL
MODEL_PATH = C0.MODEL_PATH
PROMPT_VERSION = "jev02r1.prompt/1"          # renderer/候选描述沿用 R1，未改
CANDIDATE_VERSION = "jev02r1.candidates/1"

DATA = J3 / "data"
CACHE = J3 / "cache"
RUNS = J3 / "runs"
RESULTS = J3 / "results"
EVIDENCE = J3 / "evidence"
HEAD_DIR = J3 / "heads"
TESTS = J3 / "tests"

# --- budget (contract 5) -----------------------------------------------------
CAPS = {
    "model_jobs": 4300,
    "generation_jobs": 1100,
    "feature_jobs": 3200,
    "max_new_tokens": 64,
    "per_gpu_gib": 24,
    "window_seconds": 4 * 3600,
}
PLAN = {"features": 768 * 4, "json": 256 * 4, "timing": 64, "warmup": 16}
PLAN["total"] = PLAN["features"] + PLAN["json"] + PLAN["timing"] + PLAN["warmup"]
PLAN["generation"] = PLAN["json"] + 32 + 8

# --- frozen read-out structures (contract 4) ---------------------------------
C_PARAMS = 5120      # z_i = w . LN(h_i), 4 x 1280
Q_PARAMS = 20480     # z = W . LN(hq), 4 x 5120
SEEDS = (17, 29, 43)
ARMS = ("M0", "C", "Q")
TRAIN = {"lr": 1e-3, "weight_decay": 1e-2, "batch_groups": 32, "epochs_max": 100,
         "optimizer": "AdamW", "objective": "case_mean_ce_over_four_orders"}

# --- interfaces frozen before any GPU run ------------------------------------
ENCODED_KEYS = ("caseId", "orderIds", "cand", "hq", "tokenHash", "featureIdentityHash")
SCORES_KEYS = ("caseId", "classIds", "logits", "headSha", "presentation")


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def canonical(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(payload) -> str:
    return hashlib.sha256(canonical(payload).encode()).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload) -> str:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode()).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> str:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows)
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode()).hexdigest()


SPLITS = ("train", "dev", "test")


def split_file(split: str) -> Path:
    return DATA / f"{split}.jsonl"


def inputs_file(split: str) -> Path:
    return DATA / f"{split}.inputs.jsonl"


def gold_file() -> Path:
    return DATA / "test.gold.json"


def features_file(split: str) -> Path:
    return CACHE / f"features-{split}.npz"


def identity() -> dict:
    """Backbone/tokenizer identity inherited from R1 (metadata fingerprint only)."""
    import r1config as R

    return R.identity()


def prompt_identity() -> dict:
    import r1config as R

    return R.prompt_identity()


def feature_identity() -> dict:
    """Identity stamped into every cached EncodedDecision."""
    live = identity()
    prompt = prompt_identity()
    return {
        "backbone": live["backbone"], "tokenizer": live["tokenizer"], "prompt": prompt,
        "renderer": "jev02/render.py", "orders": [list(order) for order in ORDERS],
        "precision": "bfloat16", "shard": "single process, 4 GPUs, batch 1",
        "schema": ENCODED_SCHEMA,
    }


def feature_identity_hash() -> str:
    return sha256_json(feature_identity())


def state_hash_identity() -> dict:
    """Identity of the frozen JEV-02 M1 head used as the M0 baseline."""
    import r1config as R1

    identity = R1.head_identity()
    return {"path": identity["path"], "fileSha256": identity["fileSha256"],
            "tensorSha256": identity["tensorSha256"], "params": identity["params"],
            "kind": identity["kind"]}


def state_hash(state: dict) -> str:
    """JEV-02's frozen tensor hash, imported by file path to avoid name clashes."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("jev02_heads_train", JEV02 / "heads" / "train.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.state_hash(state)


def stable_from_display(order_index: int, display_index: int) -> str:
    """Display position -> stable semantic class id (never a letter)."""
    return ORDERS[int(order_index)][int(display_index)]


def display_from_stable(order_index: int, class_id: str) -> int:
    return list(ORDERS[int(order_index)]).index(class_id)
