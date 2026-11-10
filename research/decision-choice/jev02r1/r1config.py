"""JEV-02R1 frozen configuration.

Reuses the frozen JEV-02 renderer/head/backbone; this module owns the R1 budget,
paths and the pre-registered strategy surface. It deliberately shadows no JEV-02
module name, so `import contracts` still resolves to the frozen parent.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import sys
from pathlib import Path

R1 = Path(__file__).resolve().parent
JEV02 = R1.parent / "jev02"
sys.path.append(str(JEV02))

import contracts as C0  # noqa: E402  frozen JEV-02 constants

SCHEMA = "frostecho.jev02r1"
POLICY_SCHEMA = "frostecho.jev02r1.policy/1"
SCORE_SCHEMA = "frostecho.jev02r1.scores/1"
CLASSES = C0.CLASSES
ORDERS = C0.ORDERS
LETTERS = C0.LETTERS
LETTER_LABEL = C0.LETTER_LABEL
MODEL_PATH = C0.MODEL_PATH

# Pre-registered only: full four-order support for S1, both reverse pairs for S2.
# No post-hoc subset search is permitted by the contract.
SUPPORTED_ORDERS = (0, 1, 2, 3)
SUPPORTED_PAIRS = ((0, 1), (2, 3))

# Contract 22/24: fixed grid, fixed gates.
THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975, 0.99, 0.995)
MAX_RISK = 0.05
MIN_ACCEPTED_BASES = 50
MIN_ACCEPTED_PER_CLASS = 5

FAILSAFE_METHODS = ("single_pass", "reverse_pair_consensus")
SINGLE = "single_pass"
PAIR = "reverse_pair_consensus"

CAPS = {
    "model_jobs": 3300,
    "generation_jobs": 1100,
    "max_new_tokens": 64,
    "per_gpu_gib": 24,
    "window_seconds": 4 * 3600,
    "feature_jobs": 2400,
}
CYCLE_CAPS = dict(CAPS)

# Deployment modes written into a policy; `unavailable` never decides.
DECISION_MODES = ("selective", "unavailable")
GATING = {SINGLE: "max_confidence", PAIR: "min_confidence"}

DATA = R1 / "data"
CACHE = R1 / "cache"
POLICIES = R1 / "policies"
RESULTS = R1 / "results"
EVIDENCE = R1 / "evidence"
AUDIT = R1 / "audit"
TESTS = R1 / "tests"

SPLITS = {
    "cal-temperature": 128,
    "cal-policy": 128,
    "test": 256,
}
MIN_FAMILIES = {"cal-temperature": 16, "cal-policy": 16, "test": 32}
MIN_UNIQUE_FRACTION = 0.9

# The frozen head under re-verification (JEV-02 M1-seed17).
# `runs/` is gitignored, so the isolated worktree does not carry it; the read-only
# source tree is the fallback. Either path must hash to the frozen value.
SOURCE_TREE = Path("/data3/DATA/project/project_meishijiang/FrostEcho-jev02")
HEAD_PATH = JEV02 / "runs" / "M1-seed17" / "candidate.safetensors"
HEAD_FALLBACK = SOURCE_TREE / "research" / "decision-choice" / "jev02" / "runs" / "M1-seed17" / "candidate.safetensors"
HEAD_FILE_SHA256 = "d53d9b368cac14acecfaaa5aca5fc5ae8873028ca92af9ba9d8423b273be634e"
HEAD_TENSOR_SHA256 = "5cda925fe9ae691ca31078db32eaee01305e351792940d34592ab093e29d172b"
PROMPT_VERSION = "jev02r1/prompt=render.py@e12ac4c/arm=label"
CANDIDATE_VERSION = "jev02r1/candidates=letter_label@e12ac4c"


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json(value) -> str:
    return sha256_text(canonical(value))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def split_file(split: str) -> Path:
    return DATA / f"{split}.jsonl"


def inputs_file(split: str) -> Path:
    return DATA / ("test.inputs.jsonl" if split == "test" else f"{split}.inputs.jsonl")


def identity() -> dict:
    """Cheap pre-load identities: no weights are read here."""
    from contracts import model_fingerprint  # frozen parent function
    model = model_fingerprint()
    tokenizer_files = {}
    for name in ("tokenizer_config.json", "chat_template.jinja", "tokenizer.json", "merges.txt", "vocab.json"):
        path = MODEL_PATH / name
        if path.exists():
            tokenizer_files[name] = sha256_file(path)
    return {
        "backbone": {"path": str(MODEL_PATH), "sha256": sha256_json(model), "files": model["files"]},
        "tokenizer": {"sha256": sha256_json(tokenizer_files), "files": tokenizer_files},
    }


def prompt_identity() -> dict:
    """Renderer + candidate-label text: any silent prompt change changes this hash."""
    render_path = JEV02 / "render.py"
    return {
        "version": PROMPT_VERSION,
        "sha256": sha256_json({
            "renderer": sha256_file(render_path),
            "question": "玩家现在把优先权交给谁？只按这句话和上下文判断。",
            "candidates": CANDIDATE_VERSION,
            "labels": {key: LETTER_LABEL[key] for key in sorted(LETTER_LABEL)},
            "orders": [list(order) for order in ORDERS],
        }),
    }


def find_head() -> Path:
    """Frozen head file, verified byte-for-byte against the recorded digest."""
    for candidate in (HEAD_PATH, HEAD_FALLBACK):
        if candidate.exists() and sha256_file(candidate) == HEAD_FILE_SHA256:
            return candidate
    raise FileNotFoundError(
        f"frozen head not found or its bytes changed; expected sha256 {HEAD_FILE_SHA256} "
        f"at {HEAD_PATH} or {HEAD_FALLBACK}")


def head_identity(path: Path | None = None) -> dict:
    from heads.train import state_hash  # frozen parent helper
    from safetensors.torch import load_file
    path = Path(path) if path else find_head()
    state = load_file(str(path))
    return {
        "path": str(path),
        "fileSha256": sha256_file(path),
        "tensorSha256": state_hash(state),
        "params": int(sum(tensor.numel() for tensor in state.values())),
        "kind": "linear_head",
    }
