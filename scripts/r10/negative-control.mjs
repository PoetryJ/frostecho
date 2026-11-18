#!/usr/bin/env node
/**
 * R10 (A) negative control: prove the clock-boundary assertions can fail.
 *
 * The mutation is deliberately surgical and temporary: the authoritative
 * generation check in `settleDueIntents` is replaced by `false` in the compiled
 * artifact. With that guard gone, an intent whose authorisation was revoked one
 * minute before its due time settles anyway and pays a receipt, so
 * `tests/r10/clock-boundary` MUST go red. The artifact is restored and hashed
 * before the script exits; a surviving mutation makes the script fail.
 *
 * Run: node scripts/r10/negative-control.mjs
 * Exit 0 only when the positive run is green AND the mutated run is red.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve('.');
const out = resolve(process.argv[2] ?? 'artifacts/r10/negative-control');
mkdirSync(out, { recursive: true });

const target = join(root, 'dist/src/r7/integration/runtime.js');
const source = join(root, 'src/r7/integration/runtime.ts');
const needle = 'this.session.generationFor(intent.actorId) !== intent.generation';
const replacement = 'false /* R10 negative control: generation guard disabled */';
const tests = {
  clock: join(root, 'dist/tests/r10/clock-boundary.test.js'),
  sidecar: join(root, 'dist/tests/r10/four-day-sidecar.test.js'),
  demand: join(root, 'dist/tests/r10/duplicate-demand.test.js'),
};

const sha256 = text => createHash('sha256').update(text).digest('hex');
const original = readFileSync(target, 'utf8');
const originalHash = sha256(original);
if (!original.includes(needle)) throw new Error(`mutation site not found in ${target}`);

function run(file, name, arm) {
  const result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tap = join(out, `${arm}-${name}.tap`);
  writeFileSync(tap, text, 'utf8');
  const failing = text.split('\n').filter(line => line.startsWith('not ok '));
  const errorLine = text.split('\n').find(line => line.trim().startsWith('error:')) ?? null;
  return { file, tap, exitCode: result.status, failing, errorLine };
}

const evidence = {
  schema: 'frostecho.r10.negative-control/1',
  generatedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  artifact: { path: target, sha256Before: originalHash },
  sourceArtifact: { path: source, sha256: sha256(readFileSync(source, 'utf8')) },
  mutation: { needle, replacement, kind: 'generation-guard-disabled' },
  positive: {},
  negative: {},
};

let exitCode = 0;
try {
  for (const [name, file] of Object.entries(tests)) {
    evidence.positive[name] = run(file, name, 'positive');
  }
  if (Object.values(evidence.positive).some(row => row.exitCode !== 0)) {
    throw new Error('positive control is not green; refusing to claim a negative result');
  }

  const mutated = original.replace(needle, replacement);
  writeFileSync(target, mutated, 'utf8');
  evidence.negative.clock = run(tests.clock, 'clock', 'negative');
  evidence.negative.sidecar = run(tests.sidecar, 'sidecar', 'negative');
  evidence.negative.demand = run(tests.demand, 'demand', 'negative');

  // The control is only valid if the clock test really turns red.
  if (evidence.negative.clock.exitCode === 0) {
    exitCode = 1;
    evidence.verdict = 'vacuous: mutated clock test still passed';
  } else if (evidence.negative.clock.failing.length === 0) {
    exitCode = 1;
    evidence.verdict = 'vacuous: no failing assertion was reported';
  } else {
    evidence.verdict = 'valid: generation guard removal makes the clock test red';
  }
} finally {
  writeFileSync(target, original, 'utf8');
  evidence.artifact.sha256After = sha256(readFileSync(target, 'utf8'));
  evidence.artifact.restored = evidence.artifact.sha256After === originalHash;
  if (!evidence.artifact.restored) exitCode = 1;
  writeFileSync(join(out, 'negative-control.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({ verdict: evidence.verdict,
  restored: evidence.artifact.restored,
  positive: Object.fromEntries(Object.entries(evidence.positive)
    .map(([name, row]) => [name, row.exitCode])),
  negative: Object.fromEntries(Object.entries(evidence.negative)
    .map(([name, row]) => [name, { exitCode: row.exitCode, failing: row.failing }])),
  evidence: join(out, 'negative-control.json') }, null, 2));
process.exitCode = exitCode;
