#!/usr/bin/env node
/**
 * Continuous vs restored: are the MEMORY INPUTS the same?
 *
 * Runs the same seed twice with the real four-day runner:
 *   A) one process to the end      (`--out cont`)
 *   B) stop at D2 08:00, new PID   (`--out split --stop-after-days 2`,
 *                                   then `--out split --restore <save>`)
 *
 * Then matches every decision of the restored segment with the decision the
 * continuous run made for the same (actor, world clock, requestId) and compares
 * the memory block byte for byte. This is the memory part of the equivalence;
 * the full authority comparison is H's.
 *
 *   node scripts/r11-b/compare-continuous.mjs <continuousDir> <restoredDir>
 *     [--out artifacts/r11-b/continuous-vs-restored.json]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function readDecisions(dir) {
  const file = readdirSync(dir).find(name => name.startsWith('trajectory'));
  if (!file) throw new Error(`no trajectory in ${dir}`);
  return readFileSync(join(dir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : null;
const [continuousDir, restoredDir] = args.filter((value, index) =>
  !value.startsWith('--') && index !== outIndex + 1);
if (!continuousDir || !restoredDir) {
  console.error('usage: compare-continuous.mjs <continuousDir> <restoredDir> [--out file]');
  process.exit(2);
}

const continuous = readDecisions(continuousDir);
const restored = readDecisions(restoredDir);
const keyOf = row => `${row.actorId}|${row.at}|${row.requestId}`;
const continuousByKey = new Map(continuous.map(row => [keyOf(row), row]));

const compared = [];
for (const row of restored) {
  if (row.memoryBlockSha256 === undefined) continue;
  const twin = continuousByKey.get(keyOf(row));
  if (!twin) {
    compared.push({ status: 'missing-twin', actorId: row.actorId, at: row.at });
    continue;
  }
  compared.push({
    status: twin.memoryBlockSha256 === row.memoryBlockSha256
      && twin.memoryTokens === row.memoryTokens
      && twin.memoryKept === row.memoryKept
      && twin.memoryDropped === row.memoryDropped ? 'identical' : 'different',
    actorId: row.actorId, at: row.at,
    continuous: { units: twin.memoryTokens, kept: twin.memoryKept,
      bytes: twin.memoryBytes, blockSha256: twin.memoryBlockSha256,
      cursor: twin.memoryCursor ?? null },
    restored: { units: row.memoryTokens, kept: row.memoryKept,
      bytes: row.memoryBytes, blockSha256: row.memoryBlockSha256,
      cursor: row.memoryCursor ?? null },
  });
}

const counts = compared.reduce((acc, entry) => {
  acc[entry.status] = (acc[entry.status] ?? 0) + 1;
  return acc;
}, {});
const summary = {
  schema: 'frostecho.r11b.continuous-vs-restored/1',
  continuous: { dir: continuousDir, decisions: continuous.length },
  restored: { dir: restoredDir, decisions: restored.length },
  memoryDecisionsCompared: compared.length,
  counts,
  allIdentical: compared.every(entry => entry.status === 'identical'),
  note: 'Compared on (actorId, world clock, requestId): the same decision, made in a '
    + 'different process after a D2 save. Only the memory fields are compared here; '
    + 'the full authority comparison belongs to H.',
  differences: compared.filter(entry => entry.status !== 'identical').slice(0, 20),
};
if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ counts, allIdentical: summary.allIdentical,
  compared: summary.memoryDecisionsCompared }, null, 2));
if (!summary.allIdentical) process.exitCode = 1;
