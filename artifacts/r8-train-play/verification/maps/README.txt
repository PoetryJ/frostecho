Map verification evidence package
39 relevant new/legacy tests passed; original map read-back covers 8 maps, 2560 cells and 17 source hashes.
D2 authority was compared after explicit nonfinite-number decoding, including world, domain states, committed receipts, journal and knowledge.
The original failed D2 result and raw four-day before/after summaries are preserved. The first failure note is explanatory; it is not a raw console log.
Large sessions and trajectories are retained at the absolute paths in raw-index.json, with byte sizes and SHA256. They are not included in this package.
Four-day summary sourceHEAD values are null; implementation-manifest identifies a captured working-tree overlay, not a retroactive run commit.
No model calls were performed by packaging; reference gameplay results do not establish learned-policy gains.
Original command room has no indoor PNG; old teleport rescue is rejected under the original map profile; automatic gate closing is not demonstrated.
Re-run: node src/r7/integration/spatial-proof.mjs --out <new-directory>
Source read-back: node src/spatial-v2/extract-legacy-maps.mjs --reference <reference-extracted> --check src/spatial-v2/legacy-map-data.ts
