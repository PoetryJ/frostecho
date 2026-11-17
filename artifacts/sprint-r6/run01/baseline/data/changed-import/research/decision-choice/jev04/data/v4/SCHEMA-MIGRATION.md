# v3 case -> v4 case / production task mapping (R5)

The v3 source names are task *families*, not the production ChoiceTask. The
migration is explicit and never silently renames a task:

| v3 task | production ChoiceTask | why |
| --- | --- | --- |
| `reference_resolution` | `interpret_request` | resolving who is addressed is request interpretation |
| `promise_cancel` | `choose_goal` | deciding whether the promise goal still stands |
| `info_asymmetry` | `choose_action` | choosing whether to verify, wait, or act |

`candidate.text` is the semantic intent; `candidate.params` is the world-command
candidate. They are separate fields. The v4 content hash covers both, plus
task/K/narrative/facts and candidate order/id/text/kind/params. A text or params
change invalidates every old review and split row.

The 39-case import re-binds the two independent review judgments to the v4 hash
(`review-s1/s2.v4.jsonl`). The original raw review lines stay in the handoff
package with `rawReviewSha256`; the blind packet hash is NOT reused as the v4
hash.

`adjudication.v4.jsonl` is an agent adjudication, not a human double-label and
not cross-model validation. Inconsistent cases are queued for content revision;
ambiguous cases keep their acceptable-set union.
