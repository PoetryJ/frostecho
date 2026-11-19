#!/usr/bin/env bash
# R10 C line: one command for the whole chain.
#
#   research/decision-choice/r10/run-all.sh <outRoot> [episodes] [slices]
#
# Order: capture -> branch labels -> two label families -> corpus -> identity
# probe -> real 27B encoding on one GPU -> four heads per family (dev select)
# -> one test evaluation per family -> consistency gate -> evidence index.
# Every output directory must not exist yet: the tools refuse to overwrite.
set -euo pipefail
ROOT="${1:?usage: run-all.sh <outRoot> [episodes] [slices]}"
EPISODES="${2:-12}"
SLICES="${3:-30}"
export PATH=/data/home/user_00/.local/node22/bin:$PATH
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
python=/data/home/user_00/frostecho-r7/.venv/bin/python
encoder=/data2/model_weights/Qwen3.8-27B
head="$REPO/artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors"
cd "$REPO"

npm run build
node "$HERE/capture-cases.mjs" --out "$ROOT/capture" --episodes "$EPISODES" --slices "$SLICES"
node "$HERE/label-branches.mjs" --cases "$ROOT/capture/cases.jsonl" --out "$ROOT/labels-primary" \
  --horizon 120 --require-discharge
for rule in base discharge; do
  node "$HERE/relabel.mjs" --labels "$ROOT/labels-primary/labels.jsonl" --rule "$rule" --out "$ROOT/labels-$rule"
  node "$HERE/build-corpus.mjs" --cases "$ROOT/capture/cases.jsonl" \
    --labels "$ROOT/labels-$rule/labels.jsonl" --out "$ROOT/corpus-$rule-e2" --sample-every 2
done

# The feature identity contains the placement, so probe it and record it before
# spending encoding time. The four heads are trained on whatever this prints.
"$python" "$HERE/probe-identity.py" --encoder "$encoder" --hog-mib 0 --out "$ROOT/identity-probes"
"$python" "$HERE/../../jev05/action/encode_joint_corpus.py" --inputs "$ROOT/corpus-base-e2/corpus.jsonl" \
  --out "$ROOT/enc-gpu1" --encoder "$encoder" --physical-gpus 1 --placement auto \
  --batch-size 1 --max-length 2048

for family in base discharge; do
  "$python" "$HERE/train-heads.py" --corpus "$ROOT/corpus-$family-e2/corpus.jsonl" \
    --features-dir "$ROOT/enc-gpu1" --training-manifest "$ROOT/enc-gpu1/metadata.json" \
    --head "$head" --output-dir "$ROOT/train-$family-gpu1" --renderer-source src/r7/jev/render.ts
  "$python" "$HERE/eval-test-once.py" --corpus "$ROOT/corpus-$family-e2/corpus.jsonl" \
    --features-dir "$ROOT/enc-gpu1" --output-dir "$ROOT/train-$family-gpu1" \
    --renderer-source src/r7/jev/render.ts
done

node "$HERE/check-consistency.mjs" --root "$ROOT" --corpus "$ROOT/corpus-base-e2" --labels "$ROOT/labels-base"
node "$HERE/write-evidence.mjs" --root "$ROOT" --repo "$REPO"
