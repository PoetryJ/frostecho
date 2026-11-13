# Reuse the actual trained JEV-03 C head

**This is the continuation of the existing trained route.** It keeps the original joint renderer, four re-encoded display orders, candidate-position hidden states `[4,5120]`, non-affine LayerNorm (`eps=1e-5`) and `score.weight[1,5120]`. It does not substitute the newer per-candidate last-token/L2 experiment. The historical semantic task remains interpreting who the player requests to eat first; it does not automatically become a general gameplay action policy.

Existing selected C-seed43 checkpoint SHA:
`a55cc47f1c30353b9c1a38e6de3d79e1765a26412b215486d40e06e04514c989`.
The archived training record binds feature identity:
`555f5f55f6f8037508067331c11e548e671e881fb5312e9d5cb62b0f0828e159`.

## 1. Restore predictions in a new CPU process

Requires NumPy, PyTorch and safetensors, **no GPU or model reload**. Set `LEGACY` to the recovered original checkout:

```bash
LEGACY=/data3/DATA/project/project_meishijiang/FrostEcho-jev03-readout/research/decision-choice/jev03
python research/decision-choice/jev05/legacy/runner.py verify \
  --legacy-root "$LEGACY" \
  --init-checkpoint "$LEGACY/runs/C-seed43/best.safetensors" \
  --cache "$LEGACY/cache/features-test.npz" \
  --reference-scores "$LEGACY/results/test-scores.jsonl" \
  --output-dir artifacts/legacy-reuse/c43-restore-1
```

This checks actual checkpoint bytes against `runs/trainings.json`, cache identity and its embedded identity object, token hashes, all four presentations and the stable label mapping. It computes every C logit again from real cached features. The result reports `bitExactLogits`, maximum absolute logit error and prediction mismatches. Default numeric tolerance is `1e-5`; an approximate comparison is never described as bit-exact. Output must be a new empty directory outside the archive, so previous scores/checkpoints are preserved.

Historical test data is read only for restoration/evaluation, never fed to optimization. No new training or model gain is claimed by restoration.

## 2. Incremental weights-only warm-start and random-init control

Do this only when actual additional semantic training cases and corresponding real encoder features exist. The new data retains the historical `semantic-contract/2` fields: `caseId`, `groupId`, `context`, `playerText`, `labelId`, `split`. Labels remain the original four classes. Preserve original source/review/correction provenance; these historical weak-supervision inputs are not automatically v5-qualified.

The original renderer is `jev02/render.py`, with the frozen original tokenizer, backbone and readout. Re-encode all four orders; never merely swap cached rows. The cache uses the old NPZ `cand`/`hq` format and `.meta.json`. New caches additionally bind:

```text
dataSha256 = SHA256(the exact new train/dev JSONL bytes)
inputHashes = one value per cache presentation, SHA256(canonical({context,playerText}))
```

All other original meta fields (`featureIdentityHash`, `featureIdentity`, `caseIds`, `orderIds`, `tokenHash`) are retained. A changed model/tokenizer/renderer/precision must get a new feature identity and is a separate transfer experiment; it is not an exact continuation of this frozen route.

```bash
python research/decision-choice/jev05/legacy/runner.py train \
  --legacy-root "$LEGACY" --init-checkpoint "$LEGACY/runs/C-seed43/best.safetensors" \
  --train-data data/legacy-increment/train.jsonl --dev-data data/legacy-increment/dev.jsonl \
  --train-cache artifacts/legacy-increment/features-train.npz \
  --dev-cache artifacts/legacy-increment/features-dev.npz \
  --mode warm-start --seed 43 --epochs 20 --output-dir artifacts/legacy-reuse/warm43-1
```

Run exactly the same inputs with `--mode random` and a separate output directory for the random-initialized control. The original AdamW settings (lr `1e-3`, weight decay `1e-2`, 32 cases per batch, four-order mean CE, clip 1) remain fixed. The best epoch is selected on dev NLL, with the initial checkpoint included as epoch 0 so a degraded extension does not silently replace it.

Old JEV-03 checkpoint files did not retain optimizer state. Therefore this is **weights-only warm-start with a new AdamW state**, not continuation of the old optimizer trajectory. New best checkpoints and optimizer states are saved separately.

If no new semantic training input exists, the runner evaluates the restored baseline and returns `restored-baseline-only` without optimizing, even if `train` was requested. Historical test IDs and visible inputs from JEV-01/02/02R1/03 are protected against entering new train/dev under renamed IDs. Train/dev source groups and semantic input overlap are checked. No static numeric count of v4 eligible cases is used to erase the validity of the old trained research result.

The runner does not issue a calibrated execution certificate. New calibration and long-horizon gameplay evidence remain separate work, and old revealed test results cannot be relabelled as a new independent certificate.

## 3. Authorized BF16 device migration and incremental encoding

The new server has only physical GPU1 authorized. `encode_bf16.py` requires `CUDA_VISIBLE_DEVICES=1` and explicit `--allow-device-migration`. It loads the **original** Qwen3.8-27B directory as BF16 with logical GPU0 limited to 20GiB and CPU offload limited to 50GiB. It never applies NF4 or changes the joint renderer/readout.

```bash
CUDA_VISIBLE_DEVICES=1 python research/decision-choice/jev05/legacy/encode_bf16.py \
  --legacy-root "$LEGACY" --model-path /data2/model_weights/Qwen3.8-27B \
  --init-checkpoint "$LEGACY/runs/C-seed43/best.safetensors" \
  --reference-train-cache "$LEGACY/cache/features-train.npz" \
  --inputs data/incremental-c/batch-064.inputs.jsonl \
  --output-dir artifacts/legacy-reuse/bf16-increment-1 --allow-device-migration
```

Before extracting incremental inputs, it compares the first archived training case from each of the four classes in all four display orders: exact token hash, numeric candidate feature differences, C logits, and class predictions. Model/tokenizer metadata must match the archive. All 16 token hashes and decisions must agree for the compatibility record to permit warm-start. Feature/logit differences remain in the evidence; it does not call new hardware numerically identical. The certificate covers these bounded training anchors, not unseen-model accuracy or a risk guarantee.

The new runtime has a **new featureIdentityHash**, including device map, torch/Transformers version, attention implementation and BF16 precision. The original `555f...` identity is retained as `legacyFeatureIdentityHash`, never copied over the new identity. Original feature files are read only.

Encoding needs no labels. It produces `features-increment.npz` plus `.meta.json`, original visible-input hashes, forward records and `compatibility.json`. The cache initially has split `pending`. After blind review, labelled train/dev files may select disjoint subsets of the frozen input population; the runner filters only in memory and records original source-row indices.

```bash
python research/decision-choice/jev05/legacy/runner.py train \
  --legacy-root "$LEGACY" --init-checkpoint "$LEGACY/runs/C-seed43/best.safetensors" \
  --train-data data/incremental-c/train.jsonl --dev-data "$LEGACY/data/dev.jsonl" \
  --train-cache artifacts/legacy-reuse/bf16-increment-1/features-increment.npz \
  --dev-cache "$LEGACY/cache/features-dev.npz" \
  --base-train-data "$LEGACY/data/train.jsonl" --base-train-cache "$LEGACY/cache/features-train.npz" \
  --allow-device-migration --mode warm-start --seed 43 --epochs 20 \
  --output-dir artifacts/legacy-reuse/warm43-increment-1
```

Omit the two base options to train only on the increment. For the random-init control use the identical frozen data/cache composition and `--mode random` in a new output directory. Combining original and migrated features records both hashes/identities and the compatibility evidence; it never relabels the old cache as a new run. A failing anchor migration produces exit 3 with evidence and does not silently proceed.

### Batch the four actual presentation orders

Add `--order-batch-size 4` to the BF16 encoding command and use a new output directory such as `artifacts/legacy-reuse/bf16-increment-batch4-1`. The script independently renders/tokenizes each of the four orders, groups only sequences of exactly equal token length and performs a real batch forward. Unequal lengths form separate batches; no padding or truncation is introduced. Every hidden-state row uses its own candidate token positions. This is not exchanging rows of one encoded candidate order.

The batch size/policy is part of the new runtime identity. The same four training anchors are processed with the selected batching policy, so their actual token/logit/prediction comparison validates that run. Forward records include `batchShape`, `batchRow`, `batchOrders`, `forwardBatchId`, per-order token hash/positions, and actual `batchSeconds`. The legacy `seconds` field is the explicitly labelled equal share of batch wall time; do not sum repeated `batchSeconds` across rows as if they were separate forwards. Runtime reduction remains an empirical result, not a guaranteed fourfold speedup.
