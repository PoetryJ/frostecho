#!/usr/bin/env bash
# R11 C line: one command for the CPU chain, and an explicit GPU chain that only
# runs inside an O-allocated slot.
#
#   research/decision-choice/r11/run-all.sh <outRoot> <FREEZE.json> <freezeSha256> \
#       [episodes] [slices] [--with-gpu]
#
# CPU (default):
#   build -> reference capture -> common-deadline labels (strict clock gate)
#   -> two corpora -> blind package for F/G -> verify
#
# GPU (only with --with-gpu AND FROSTECHO_GPU_ALLOCATION set by O):
#   identity probe -> real 27B encoding on the allocated physical GPUs
#   -> four heads per family (dev select) -> one test evaluation per family
#
# Every output directory must not exist yet; the tools refuse to overwrite.
set -euo pipefail
ROOT="${1:?usage: run-all.sh <outRoot> <FREEZE.json> <freezeSha256> [episodes] [slices] [--with-gpu]}"
FREEZE="${2:?need the FREEZE.json published by O}"
FREEZE_SHA="${3:?need the out-of-band FREEZE.json sha256}"
EPISODES="${4:-12}"
SLICES="${5:-8}"
WITH_GPU=0
for value in "$@"; do [[ "$value" == "--with-gpu" ]] && WITH_GPU=1; done
export PATH=/data/home/user_00/.local/node22/bin:$PATH
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PYTHON="${FROSTECHO_PYTHON:-/data/home/user_00/frostecho-r7/.venv/bin/python}"
ENCODER="${FROSTECHO_ENCODER:-/data2/model_weights/Qwen3.8-27B}"
HEAD="${FROSTECHO_BASE_HEAD:-$REPO/artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors}"
cd "$REPO"

test -f "$FREEZE" || { echo "no FREEZE.json at $FREEZE" >&2; exit 2; }
ACTUAL_SHA="$(sha256sum "$FREEZE" | cut -d' ' -f1)"
[[ "$ACTUAL_SHA" == "$FREEZE_SHA" ]] || {
  echo "FREEZE.json sha $ACTUAL_SHA differs from the pinned $FREEZE_SHA" >&2; exit 2; }

npm run build

# 1. Real reference access states from the full map.
node "$HERE/collect-cases.mjs" --freeze "$FREEZE" --freeze-sha256 "$FREEZE_SHA" \
  --out "$ROOT/capture-reference" --episodes "$EPISODES" --slices "$SLICES"

# 2. Common-deadline branch labels. The strict clock gate refuses to write
#    labels while the shared runner re-settles intents or overruns t*.
LABEL_FLAGS=()
[[ "${FROSTECHO_ALLOW_CLOCK_DEFECT:-0}" == "1" ]] && LABEL_FLAGS+=(--allow-known-clock-defect)
node "$HERE/label-deadline-branches.mjs" --cases "$ROOT/capture-reference/cases.jsonl" \
  --out "$ROOT/labels" --horizon "${FROSTECHO_HORIZON_MINUTES:-240}" --slice 30 \
  "${LABEL_FLAGS[@]}"

# 3. Two corpora from the same states and split.
node "$HERE/build-deadline-corpus.mjs" --cases "$ROOT/capture-reference/cases.jsonl" \
  --labels "$ROOT/labels/labels.jsonl" --out "$ROOT/corpus"

# 4. Two-stage anonymous package for F and G; both get these exact bytes.
"$PYTHON" "$HERE/blind_package.py" build --cases "$ROOT/capture-reference/cases.jsonl" \
  --branches "$ROOT/labels/labels.jsonl" --out "$ROOT/blind" --salt "$FREEZE_SHA"
"$PYTHON" "$HERE/blind_package.py" verify --package "$ROOT/blind"

if [[ "$WITH_GPU" == "1" ]]; then
  : "${FROSTECHO_GPU_ALLOCATION:?O must allocate a GPU slot (FROSTECHO_GPU_ALLOCATION)}"
  GPUS="${FROSTECHO_PHYSICAL_GPUS:?O must pin physical GPU indices}"
  echo "GPU slot $FROSTECHO_GPU_ALLOCATION on physical GPUs $GPUS"
  "$PYTHON" "$HERE/../r10/probe-identity.py" --encoder "$ENCODER" \
    --physical-gpu "${GPUS%%,*}" --hog-mib 0 --out "$ROOT/identity-probe"
  "$PYTHON" "$HERE/../jev05/action/encode_joint_corpus.py" \
    --inputs "$ROOT/corpus/base.jsonl" --out "$ROOT/enc" --encoder "$ENCODER" \
    --physical-gpus "$GPUS" --placement "${FROSTECHO_PLACEMENT:-auto}" \
    --batch-size 1 --max-length 2048
  for family in base fulfillment; do
    "$PYTHON" "$HERE/train-heads.py" --family "$family" \
      --corpus "$ROOT/corpus/$family.jsonl" --features-dir "$ROOT/enc" \
      --training-manifest "$ROOT/enc/metadata.json" --head "$HEAD" \
      --output-dir "$ROOT/train-$family" --renderer-source src/r7/jev/render.ts
    "$PYTHON" "$HERE/eval-test-once.py" --family "$family" \
      --corpus "$ROOT/corpus/$family.jsonl" --features-dir "$ROOT/enc" \
      --output-dir "$ROOT/train-$family" --renderer-source src/r7/jev/render.ts
  done
fi

echo "R11 C chain complete under $ROOT"
