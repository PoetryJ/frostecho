/**
 * R11-O: measure whether B's memory-window fix (aa2ec8d) changes the memory
 * bytes of the already-frozen C capture. It reloads every captured snapshot
 * with the CURRENT runtime and prints one line per case: units, kept, omitted
 * level and the SHA of the exact rendered memory block.
 *
 *   node scripts/r11-o/memory-impact.mjs --cases <cases.jsonl> --out <jsonl>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { R8Runtime } from '../../dist/src/r7/integration/runtime.js';
import { visibleMemory } from '../../dist/src/r7/integration/step.js';

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const casesPath = arg('--cases', '/tmp/r11-real/capture/cases.jsonl');
const out = arg('--out');
const rows = readFileSync(casesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const results = [];
for (const row of rows) {
  const base = row.snapshotBase;
  const actorId = row.actorId;
  try {
    const runtime = R8Runtime.load(base);
    const projection = visibleMemory(runtime, actorId, 12, 'obligation-first', 640);
    results.push({ caseId: row.caseId, actorId,
      units: projection.units ?? projection.tokens ?? null,
      kept: projection.kept, dropped: projection.dropped,
      truncated: projection.truncated,
      omitted: (projection.truncatedFacts ?? []).map(entry => entry.level ?? 'trim'),
      blockSha256: createHash('sha256').update(projection.block ?? '').digest('hex'),
      blockBytes: Buffer.byteLength(projection.block ?? '', 'utf8') });
  } catch (error) {
    results.push({ caseId: row.caseId, actorId, error: String(error.message).slice(0, 300) });
  }
}
const text = `${results.map(entry => JSON.stringify(entry)).join('\n')}\n`;
if (out) writeFileSync(out, text, 'utf8');
const changed = results.filter(entry => entry.error);
console.log(JSON.stringify({ cases: results.length, errors: changed.length,
  maxUnits: Math.max(0, ...results.map(entry => entry.units ?? 0)),
  over640: results.filter(entry => (entry.units ?? 0) > 640).length,
  omittedCases: results.filter(entry => (entry.omitted ?? []).length > 0).length,
  out: out ?? null }, null, 1));
