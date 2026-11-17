#!/usr/bin/env bash
# One real encoding run, then matched warm-start and random-init head training.
set -eu
RUN_ID=${1:?Supply a fresh run ID}
case "$RUN_ID" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid run ID' >&2; exit 2;; esac
WORKROOT=${FROSTECHO_WORKROOT:-/data/home/user_00/frostecho-r7}
LEGACY=${FROSTECHO_LEGACY:-/data3/DATA/project/project_meishijiang/FrostEcho-jev03-readout/research/decision-choice/jev03}
MODEL=${FROSTECHO_MODEL:-/data2/model_weights/Qwen3.8-27B}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON="$WORKROOT/.venv/bin/python"
DATA="$WORKROOT/workbench/incremental-c"
OUT="$WORKROOT/artifacts/legacy-reuse/$RUN_ID"
test ! -e "$OUT"
mkdir -p "$OUT/source"
cp "$SCRIPT_DIR/encode_bf16.py" "$SCRIPT_DIR/runner.py" "$0" "$OUT/source/"
cp "$DATA/reviewed/manifest.json" "$OUT/reviewed-manifest.json"
export CUDA_VISIBLE_DEVICES=1 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false
trap 'code=$?; printf "%s\n" "$code" > "$OUT/exit-code.txt"' EXIT
"$PYTHON" -u "$OUT/source/encode_bf16.py" \
  --legacy-root "$LEGACY" --model-path "$MODEL" \
  --init-checkpoint "$LEGACY/runs/C-seed43/best.safetensors" \
  --reference-train-cache "$LEGACY/cache/features-train.npz" \
  --inputs "$DATA/batch-064.inputs.jsonl" --allow-device-migration \
  --order-batch-size 4 --output-dir "$OUT/encoding" > "$OUT/encoding.log" 2>&1
for mode in warm-start random; do
  for seed in 17 43; do
    "$PYTHON" -u "$OUT/source/runner.py" train \
      --legacy-root "$LEGACY" --init-checkpoint "$LEGACY/runs/C-seed43/best.safetensors" \
      --train-data "$DATA/reviewed/train.jsonl" --dev-data "$DATA/reviewed/dev.jsonl" \
      --train-cache "$OUT/encoding/features-increment.npz" --dev-cache "$OUT/encoding/features-increment.npz" \
      --base-train-data "$LEGACY/data/train.jsonl" --base-train-cache "$LEGACY/cache/features-train.npz" \
      --base-dev-data "$LEGACY/data/dev.jsonl" --base-dev-cache "$LEGACY/cache/features-dev.npz" \
      --review-evidence "$DATA/reviewed/manifest.json" --allow-device-migration \
      --mode "$mode" --seed "$seed" --epochs 20 --device cpu \
      --output-dir "$OUT/$mode-$seed" > "$OUT/$mode-$seed.log" 2>&1
  done
done
printf 'Completed real encoder and four candidate-head training runs: %s\n' "$OUT"
