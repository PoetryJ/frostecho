# JEV-02 data card

## What it is

A coding-agent **synthetic_dialogue** pilot for one task: given the player's
current utterance and local visible context, decide **who is being asked to eat
first**. It is not real-player natural data and not an IID sample. There are
no human labels. 1,664 base cases × 4 display permutations.

## Labels

`PLAYER_FIRST`, `NPC_FIRST`, `NO_PRIORITY_REQUEST`, `NEEDS_CLARIFICATION`.
Understanding a request is not acceptance, binding, or fulfilment; the data
never trains “must yield”.

Ambiguous-by-construction items (omitted subject, no beneficiary, conflict,
multi-turn reversal) are labeled by the authored pattern and then adjudicated
against a second blind pass; see `label/disagreements.json` (30 disagreements,
all resolved, 0 unscored challenge).

## Splits (by authored pattern, before variants)

| split | cases | families | per class |
| --- | --- | --- | --- |
| train | 1024 | 32 | 256 |
| dev | 128 | 8 | 32 |
| cal | 512 | 16 | 128 (256 temp + 256 policy) |
| test | 256 | 32 | 64 (8 new patterns/class) |

Test composition: 128 new-combination + 128 language-OOD presentations. No
pattern or family crosses splits. Every case has 4 fixed permutations.

## Dedupe and coverage (reported, not hidden)

- train: 59 unique player texts / 1024 (duplicate text rate 94.2%), 0 duplicate
  dialogues; 32 semantic families.
- dev: 26 unique texts, 8 families.
- cal: 37 unique texts, 16 families.
- test: 59 unique texts / 256 (77.0%), 32 families, 8 per family.

The high player-text duplication comes from short slotless utterances reused
across different contexts; contexts and addressees vary. Phenomena covered:
omitted subject, negation, revocation, correction, quoting, reference,
multi-turn last valid request, different food objects, and player text that
contains a literal fake candidate block (position regression, not scored).

## Provenance / leakage

All rows: `source=synthetic_dialogue`, `author=coding-agent`, family/pattern
index recorded. Test inputs carry no label, family, or provenance; gold is a
separate SHA-sealed file. `visibleInput` never contains `labelId`,
`request.kind`, `selectedGoal` or `activeGoal` (checked by tests and audit).

## Limits

Synthetic templates, 32 test families, 8 cases/family, single-operator
authoring/blind pass, and a 256-case calibration split. Conclusions are bounded
to this pilot; a production claim would need human-labeled natural dialogue.
