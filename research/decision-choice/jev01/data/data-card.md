# JEV-01 data card

## What this is

A bounded synthetic/annotated pilot for one semantic task: given a player's
current utterance and local visible context, decide **who is asked to eat
first**. It is **not** 640 real players, not a natural distribution sample,
and not evidence of general semantic coverage. 640 base cases × 2 fixed
display orders = at most 1,280 model inputs.

## Labels (stable IDs, authored by template family)

| id | meaning |
| --- | --- |
| PLAYER_FIRST | the player explicitly asks to keep this food / eat first |
| NPC_FIRST | the player explicitly tells the NPC to eat first (including "don't wait for me") |
| NO_PRIORITY_REQUEST | no current ordering request: statement, pure reported speech, revocation with no new order |
| NEEDS_CLARIFICATION | a current request exists but object/referent/conflict leaves the order undecidable |

Understanding a request is not acceptance, binding, or fulfilment.

## Splits (assigned by family BEFORE variants)

| split | base cases | families | per class |
| --- | --- | --- | --- |
| train | 384 | 36 | 96 |
| dev | 64 | 8 | 16 |
| cal | 64 | 8 | 16 |
| test | 128 | 8 | 32 |

Test composition: 64 `new_combination`, 64 `language_ood` (families that never
appear in train/dev/cal). No family crosses splits; two orders of a case stay
in the same split.

## Provenance and leakage

`provenance` names the family, template index and seed; `capture/captures.json`
records 10 real controller→Provider inputs from shipped fixtures (5 goal,
5 action) plus two zero-call boundaries. The semantic texts are synthetic
templates; the only natural-language entry available is the fixed G09 S1 text,
so natural semantic coverage is insufficient and is reported as a limitation.

Visible input is `{context, playerText}` only. Labels, family names,
`request.kind`, `selectedGoal`, `activeGoal` never enter it; the verifier scans
for those tokens. Test inputs are written without labels; gold is in
`test.gold.json` with a published SHA and is read only after all test
predictions are written and hashed.

## Known judgment calls

`NEEDS_CLARIFICATION` includes utterances with no beneficiary ("留一点"),
no subject ("先吃吧"), referent ambiguity, explicit conflicts, and meta
questions about whether an earlier order still holds. These are labeled by
construction and remain debatable; D's review can quarantine any item as an
unscored challenge instead of forcing a truth.

## Files

`base_cases.jsonl` (public cases, test labels withheld) · `test.inputs.jsonl` ·
`test.gold.json` · `dataset-stats.json` (sizes, families, hashes, limitations).
