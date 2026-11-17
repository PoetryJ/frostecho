# JEV-05 real frozen encoder and trained shared head

Primary models are **Qwen/Qwen3.5-4B and Qwen/Qwen3.5-27B**. This component performs actual frozen text-backbone inference, caches each complete context/candidate representation, trains a scalar head with acceptable-set likelihood, saves it and produces new raw scores. It does not declare calibration, execution admission or long-memory improvement.

`SCHEMA.json` documents cases and the qualification manifest. `contracts.qualify` recomputes file hashes, original review bindings, source/family separation and the fixed 512/128 threshold. There is no `--force` or fixture bypass. The separate `train_model` library function is used by explicitly labelled unit tests; the production CLI always qualifies first. An optional external validator is an argv JSON array (`shell=False`), adds checks and cannot override refusals.

## Environment and model identity

Create a dedicated venv, install `requirements.txt`, then record `python -m pip freeze` in the run evidence. Current Transformers must support `Qwen3_5Model`; the old 4.51.3 environment does not. NF4 additionally requires compatible `bitsandbytes`. Do not overwrite the game's environment. The loader only uses the provided local weights and does not download anything or run remote model code.

Use an actual pinned upstream revision. If its source is unknown, pass `--revision local-unknown`; the manifest states that limitation. Default identity mode hashes actual safetensors plus tokenizer/config/index bytes. `--identity-mode probe` skips expensive weight-byte hashing for the first hardware load probe; its `real-model-probe` cache is refused by training. The example config is documentation, not an executable config loader.

## First real load/feature probe (not training)

```bash
CUDA_VISIBLE_DEVICES=1 python research/decision-choice/jev05/models/cli.py encode \
  --cases research/decision-choice/jev05/models/probe.cases.jsonl \
  --out artifacts/r7/jev05-q27-load-probe \
  --model-path /data2/model_weights/Qwen3.5-27B \
  --model-id Qwen/Qwen3.5-27B --revision local-unknown \
  --device auto --dtype bfloat16 --load-in-4bit --batch-size 1 \
  --max-tokens 1024 --identity-mode probe
```

The input is explicitly a unit-test case; a successful run proves only actual model load and feature extraction. For formal encoding, use the real case file, full identity mode and a new cache directory. NF4 is part of the frozen identity and must match scoring; it is not silently equivalent to BF16. The loader refuses missing/mismatched loaded tensors and an incorrect architecture. It computes masked last-token features by default (optional masked mean); it never silently truncates context or candidate text/parameters. If `maxTokens` is exceeded, increase a measured supported limit or explicitly revise the input/renderer and repeat reviews as applicable.

## Production sequence

Replace paths and revision with actual values. Seed 17 and seed 43 are separate runs; choose models/epochs on dev only.

```bash
python research/decision-choice/jev05/models/cli.py validate-data --qualification data/v5/qualification.json
python research/decision-choice/jev05/models/cli.py encode --cases data/v5/cases.jsonl --out artifacts/jev05/q4-features --model-path /models/Qwen3.5-4B --model-id Qwen/Qwen3.5-4B --revision ACTUAL_COMMIT --device auto --dtype bfloat16 --batch-size 4 --max-tokens 4096
python research/decision-choice/jev05/models/cli.py train --qualification data/v5/qualification.json --cache artifacts/jev05/q4-features --out artifacts/jev05/q4-head-seed17 --seed 17 --epochs 30 --device cpu
python research/decision-choice/jev05/models/cli.py score --checkpoint artifacts/jev05/q4-head-seed17 --cache artifacts/jev05/q4-features --cases data/v5/cases.jsonl --out artifacts/jev05/q4-scores.jsonl
```

CPU head training uses NumPy AdamW; `--device cuda:0` uses PyTorch AdamW with the same acceptable-set objective and L2 input normalization. Frozen features are extracted once, not once per epoch. A cache resumes completed batches after an interrupted process; existing input/model/feature mismatches refuse rather than overwrite. Model selection uses dev set NLL; calT/select/cert/test are never used for optimizer updates or epoch selection. Checkpoint files contain NumPy weights (no pickle), optimizer arrays, encoder/qualification/cache identities, config/seed and training history. Restore in a new process through `score`; permutation of candidates must permute corresponding scores.

## Online scorer / game adapter boundary

```bash
python research/decision-choice/jev05/models/cli.py serve --checkpoint artifacts/jev05/q4-head-seed17 --model-path /models/Qwen3.5-4B --model-id Qwen/Qwen3.5-4B --revision ACTUAL_COMMIT --device auto --dtype bfloat16 --max-tokens 4096
```

One JSON request per stdin line: `{"requestId":"job-1","case":{...context and candidates...}}`. A ready event goes to stderr after actual loading and identity matching. Each stdout line carries `rawLogits`, ordered `candidateIds`, checkpoint/encoder/input hashes and the matching requestId. Errors return no selection. **Raw scoring deliberately returns `selectedId=null` and `executionAdmitted=false`: the separate calibrated scorer applies T/tau and the registered execution gate, then the existing game lifecycle validates/commits the action.** This module is not evidence that downstream game execution already exists. `score-live --cases ... --out ...` executes real new-input forward passes with the same contract.

`import-embeddings` is a separately named compatibility path for recorded API responses; it makes no API calls and is not the R7 Qwen deliverable. It requires the original request model/input and response vectors, not a handwritten similarity score.

## Mechanism checks

```bash
python -m unittest discover -s tests/r7/jev05 -p 'test_*.py' -v
```

These use only small constructed CPU tensors and temporary files; they verify gradients, full candidate rendering, permutation, cache binding/resume, training/reload and qualification refusals. They are not real Qwen training or a model-gain experiment.
