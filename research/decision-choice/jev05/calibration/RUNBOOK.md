# JEV-05 calibrated selective policy

This module connects actual frozen-Qwen checkpoint logits to set-label temperature fitting, frozen threshold selection, independent certification and accept/abstain decisions. It does not train or pretend that a synthetic score is real.

## Input and production build

Use the same frozen qualified cases and checkpoint as `models/cli.py train`. Pass its actual `score` JSONL, whose candidate IDs/input/checkpoint/encoder hashes must match. The build takes labels and source partitions from the qualified cases rather than trusting labels inside a score file. `calT`, `select`, and `cert` must be nonempty, with distinct case IDs/source groups/template families. Train/dev/test records do not participate in temperature or threshold fitting.

```bash
python research/decision-choice/jev05/calibration/cli.py calibrate \
  --qualification data/v5/qualification.json \
  --checkpoint artifacts/jev05/q4-head-seed17 \
  --scores artifacts/jev05/q4-scores.jsonl \
  --memory-policy-version layered-memory-v1 \
  --certificate-registry artifacts/jev05/certificate-registry \
  --out artifacts/jev05/q4-head-seed17/calibration.json
```

The certificate registry is shared and retained across experiments. It binds the cert population to the chosen checkpoint/T/tau before certificate computation. The same frozen run can be repeated; changing policy on that consumed cert set refuses. Never delete or relocate the registry to turn a failed cert into a purported independent pass. A new model after a failed cert needs new independent cert data. Cases whose actual runtime memory policy differs require a separately bound policy evaluation.

Temperature minimizes `-log(sum softmax(logits / T)[acceptableIds])` on calT only, over T in `[0.05,20]`. Select chooses greatest coverage on the existing fixed tau grid subject to at least 100 accepted cases and empirical error <=5%. Cert requires coverage >=30% and a one-sided 95% Clopper-Pearson error bound <=5%. The binomial bound describes the frozen decision distribution under its sampling assumptions; it is not a guarantee for arbitrary distribution shifts or all future game states.

Every artifact contains original per-sample logits, acceptable sets, source groups, input and policy hashes, T/tau and recomputable statistics. ECE/reliability and binary Brier use the event `argmax belongs to acceptableIds` and confidence `max softmax`; NLL uses total acceptable-set mass. The CLI preserves failed artifacts but exits **3** when the risk protocol does not pass. Malformed or unbound inputs exit **2**. It never relaxes thresholds to manufacture acceptance.

## Runtime admission

The calibration file declares eligibility, not its own trusted registration. Register its `artifactSha256` in deployment configuration outside the artifact and construct `runtime-identity.json` from the actual loaded checkpoint/encoder plus the current renderer/memory policy:

```json
{"checkpointSha256":"ACTUAL_CHECKPOINT_HASH","encoderSha256":"ACTUAL_ENCODER_HASH","renderer":"jev05-context-candidate/1","memoryPolicyVersion":"layered-memory-v1"}
```

```bash
python research/decision-choice/jev05/calibration/cli.py inspect --calibration artifacts/jev05/q4-head-seed17/calibration.json --trusted-artifact-sha ACTUAL_ARTIFACT_HASH --runtime-identity runtime-identity.json
python research/decision-choice/jev05/calibration/cli.py predict --calibration artifacts/jev05/q4-head-seed17/calibration.json --trusted-artifact-sha ACTUAL_ARTIFACT_HASH --runtime-identity runtime-identity.json --scores new-real-scores.jsonl --out calibrated-decisions.jsonl
```

Online Python adapter:

```python
loaded = load_calibration(path, expected_artifact_sha=trusted_sha, expected_identity=runtime_identity)
decision = predict(raw_logits, candidate_ids, loaded, identity=runtime_identity, content_hash=input_hash)
```

`load_calibration` recomputes the temperature/selection/certificate from records and checks exact registered identity. `predict` emits probabilities, proposed candidate, `accept/abstain` and an executable `selectedId` only if the registered real certificate passed. The game must still perform its existing generation/version/memory/permissions validation and event commit. Abstention or a later invalidated job does not count as a JEV action. `utility` stays null; candidate probabilities are not long-term utility.

Missing registration, synthetic evidence or failed certification yields no executable selection. Unknown candidate cardinality, mismatched memory policy/encoder/checkpoint, NaN/Inf and altered artifact statistics refuse. Unit-test evidence can exercise high-confidence accept and low-confidence abstain while always having `executionAdmitted=false`.

## Evidence boundary

`python -m unittest discover -s tests/r7/jev05 -p 'test_*.py' -v` includes constructed-logit tests. These show mechanics only. Real deployment requires original model scores, qualified data, an independent passing certificate and the actual registered game adapter. None of those outcomes is implied by this module merely being implemented.
