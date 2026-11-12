# FrostEcho R5 closeout (2026-11-12)

## HEAD / executor
- Branch: `codex/sprint-1116`; not merged to `main`.
- Baseline: `db34123423a06cc5118fb92e1c3cfb9f0c03fceb`.
- HEAD: `498c00015e51dc6d48668e2603e2e1877aa8e399`.
- Executor: one CodeBuddy session. Roles P/R/D/M/H were executed sequentially by
  the same session and recorded as such; this is not a claim of four independent
  writers.
- Handoff integrity: `sha256sum -c SHA256SUMS.txt` -> **128/128 OK**, no missing
  file.

## Real-entry prerequisite gates
1. **Commitment lifecycle** — real CLI, `dist/scripts/play-sprint.js`:
   - `withdraw/relinquish` -> linked task `cancelled`, 8 later steps deliver **0**
     (`world.spatial.deliveredMeals=0`), terminal status stays `withdrawn`.
   - `cancel-commitment` -> open change closed, a later `respond-change accept`
     is ignored; commitment stays `cancelled` at the old revision.
   - initial counter-accept -> exactly one `deliver-meal` task; the accepted
     `resumeWhen` keeps it waiting; after the condition is legally met the same
     task delivers and is fulfilled (receipt-backed).
   - Transition table tests `R5-T1..T5` cover active/pending-change/suspended ×
     accept/reject/cancel/withdraw/late fulfil.
2. **Barrier** — real CLI with the async scorer:
   - two queued NPC steps + save timeout -> both captured jobs get terminal
     records; saved world version stays 0; release produces no effects.
   - a new step submitted after the barrier executes normally (version 1).
   - later jobs outside the captured set are not revoked.
   - original single-NPC cancel and EOF bounds still pass.
3. **Idempotent original input** — travel receipt is keyed on canonical
   actor/target/params/id before route planning:
   - same id + same destination replays the first receipt (`duplicate:true`,
     same tiles/minutes) across processes;
   - same id + different destination is `command_id_conflict` with zero effect.

Raw traces: `artifacts/sprint-r5/probes/` (world, lifecycle, promise, data/port).

## Morning-council vertical slice
- `council-open` derives **two** proposals from visible resources/actor state;
  their cost differs (plan A 108 estimated minutes, plan B 168 + one rest block).
- Votes are explicitly `fixture-reference/1`; no model/LLM claim.
- `council-resolve` emits `councilId/resolutionId/source/revision` and creates
  resident **requests** only. It does not create a second execution queue.
- Residents answer `accept/decline/counter`. Accept goes through
  `requestCommitment` -> existing commitment/task/attempt/receipt path.
  - supply resident: real `supply-warehouse` work, completion only on
    `stock_deposited`;
  - delivery resident: real `deliver-meal`, completion/fulfilment only on
    `meal_delivered`;
  - counter stays proposed until the beneficiary answers.
- Exit test: `relinquish` cancels the old person's task; `council-reassign`
  creates a **new** request at revision 2 for a substitute; the substitute
  accepts a new commitment. The old task is never renamed or revived.
- Same-day replay: open/resolve are idempotent, a late vote after resolution is
  ignored, and no duplicate requests are dispatched across processes.
- Four-day chain: 8 NPCs, spatial from day 1, councils on each day, real
  movement/work, one real delivery and one honest `out_of_stock` event.
  Continuous 96h and save-at-every-day split runs have identical authoritative
  state (time, resources, NPC needs/locations, spatial stocks/carry, tasks,
  commitments, councils).

## Data adjudication (39 cases)
- Input: handoff `blind-review/`, 39 cases, 26 source groups.
- Raw A/B outputs preserved (per-case `rawReviewSha256`); labels were not
  rewritten. Reviews were re-bound to the wider v4 visible-input hash; the old
  blind-packet hash is not reused.
- Agent adjudication (not human double-label, not cross-model validation):
  - **eligible: 0**
  - ambiguous: 29
  - inconsistent / revision-queue: 10 (9 stock-scope conflicts, 1
    retraction-exists conflict)
  - acceptable-set disagreements: 4, kept as union; status differences: 18.
- `validate_v4.py` recomputes task/narrative/facts/candidate text+kind+params
  hashes, rejects duplicate IDs/rows, illegal labels, group/family overlap,
  synthetic-count inflation, and non-projected splits. Unique counts, not JSONL
  line counts, gate training.
- Current v4: 39 cases, 39/39 reviews, **0 qualified train / 0 qualified dev**;
  target 512/128 remains unreached. `researchTrainReady=false`.
- `encoder_train.py` now calls this validator before any model import/load and
  refuses non-zero. A stub-import test proves torch/transformers are never
  imported when the gate is closed.
- Correction to the R4 report: the old “96/96” was a suite-size count. R5 fixed
  TAP is **737 core tests + 15 G11 tests = 752**, 101 files, 0 fail.

## JEV / model boundary
- `port_v3`: empty `{}` evidence, reused calT/select/cert files/partitions,
  non-disjoint samples, wrong risk protocol, identity drift, NaN/Inf/K errors
  are refused; a real artifact without sealed evidence is `shadow_only`;
  fixture artifacts never set `counts_as_real=true`.
- TS shadow bridge keeps `selectedId=null`; no world execution from JEV.
- `prepare_t27.download`: the first real request is now
  `https://huggingface.co/Qwen/Qwen3.5-27B/resolve/<revision>/config.json`;
  snapshot args are repo `Qwen/Qwen3.5-27B` + the same revision; the resume
  command includes the revision. Mock tests verify this.
- Real network remains unavailable (`[Errno 101] Network is unreachable`); the
  exact path/resume command are retained in
  `artifacts/sprint-r5/jev/t27-download.log`.
- No real 27B weights were downloaded or loaded, no GPU training was run, and
  the original three-arm/seed budget was not reset. The CPU tiny head remains a
  fixture mechanism proof, not a formal encoder result.
- No calT/select/cert real model evidence exists, so no risk guarantee is
  claimed. Training readiness (certificate gate) and world execution remain
  separate.

## Experience comparison
- `summary` arm removed from comparison: it was the same `belief.level`
  implementation as `raw`, with no independent generation/storage/retrieval.
- Compared `none` (historical), `raw`, `experience`; metrics count authoritative
  commands/receipts, normal waits are excluded, and an untriggered accept path
  is `N/A` instead of a fake 0.
- New `alt-source-accepted` scenario exercises an actual accepted source change
  -> gathered/deposited/delivered. `none` shows the expected mismatch; raw and
  experience both recover and deliver. No positive model gain is claimed.

## Independent clone acceptance
- Bundle cloned to `/tmp/frostecho-r5-clone2`; `npm ci` + `npm run build` from the
  lockfile succeeded.
- In the clone: acceptance-v5 **9/9**, four handoff repros **4/4**, Python
  **66 passed**, eval-full **13 passed / 0 failed / 0 blocked**, features
  **11/11 pass**, verify-r5 **5/5**. The root run recorded one pre-registered
  known flake as `blocked` (2/2 reruns passed); the clean clone run is the
  final 13/0/0 record.
- Logs and outputs: `artifacts/sprint-r5/clone/`.

## Bundle / delivery
- `artifacts/sprint-r5/delivery/frostecho-r5.bundle` (branch `codex/sprint-1116`,
  complete history, HEAD `498c000`).
- Bundle SHA256: `86d32bb6da473863c6c1ffec5a0f2dcfce4c70163b3480ecebf6f9239329f26d`.
- Raw traces: `delivery/traces/council/` (two-process council -> two accepted
  assignments -> one real delivery) and `delivery/traces/fourday/` (continuous
  and segmented raw CLI rows + sidecars).
- `PACKAGE-SHA256` covers this report, features, eval summary/TAP, probe raw
  outputs, data gate/adjudication files, JEV logs, clone logs, traces and the
  bundle.

## Product vs research
- **Product capability (verified):** commitment lifecycle, capture-only barrier,
  canonical input replay, morning council -> explicit resident acceptance ->
  real supply/delivery, save/restore, reassignment, 8-NPC 96h spatial chain.
- **Research capability (not proven):** real 27B encoder training, risk
  certificates, model semantic understanding, positive experience gain, human
  double-labeling of the 39 cases.

## Not proven / remaining original work
1. Formal training is still closed: 0 eligible, 0/512 train, 0/128 dev, no
   independent human double-label, no calT/select/cert.
2. Ten inconsistent cases need content fixes, new hashes and a fresh review; 29
   ambiguous cases keep their acceptable-set and are not admitted.
3. Network/weights remain blocked; no real model download/training was performed.
4. Council is one morning proposal with fixture-reference votes. Crisis triggers,
   UI, multi-proposal rounds and reincarnation from the original game are not
   implemented.
5. The 96h run uses a pre-registered starting food reserve and a deliberate
   warehouse drain for the shortage case; it is a causality/reproducibility
   check, not a survival-balance claim.
6. `none` vs `raw` vs `experience` is a short fixture comparison; no model
   learning or generalization claim. `summary` was not compared.
7. G11 evidence is the packaged archive, not a new live model run.
8. No merge to `main`.
