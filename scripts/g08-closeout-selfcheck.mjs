#!/usr/bin/env node
/**
 * G08 closeout self-check for an independent clone.
 *
 * The repository keeps handoff/ (probes, golden, execution packages) out of
 * git by convention, so a fresh clone contains the code, the tests and the
 * committed artifact batches but not those scripts. This checker therefore
 * verifies everything that IS in the clone:
 *
 *   1. the tree builds (`tsc -p tsconfig.json`)
 *   2. the full test suite passes
 *   3. the committed evidence re-verifies READ-ONLY:
 *        - artifacts/g08-closeout/fixture-closeout-legal  -> ok, exit 0
 *        - artifacts/g08-closeout/fixture-closeout-illegal -> exit 1
 *        - artifacts/g08-closeout/g08-closeout-live-20261103 -> ok, exit 0
 *   4. verification did not modify any evidence byte (hash before/after)
 *
 * Usage: node scripts/g08-closeout-selfcheck.mjs [repo-root]
 * Exit code 0 only when every step passes.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(process.argv[2] ?? process.cwd());
const node = process.execPath;

function run(args) {
  try {
    const out = execFileSync(node, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function hashTree(dir) {
  const hash = createHash('sha256');
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        hash.update(path.slice(dir.length));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

const failures = [];
const say = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

/* 1. build ---------------------------------------------------------- */
const tsc = run(['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
say(tsc.code === 0, 'tsc build', tsc.code === 0 ? '' : tsc.out.split('\n').slice(0, 3).join(' | '));

/* 2. tests ---------------------------------------------------------- */
const tests = run(['scripts/run-tests.mjs']);
const summary = tests.out.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)).join(' ');
const pass = /# pass (\d+)/.exec(tests.out);
const fail = /# fail (\d+)/.exec(tests.out);
say(tests.code === 0 && (fail === null || fail[1] === '0'), `full test suite (${summary})`);

/* 3/4. read-only verification of the committed evidence ------------- */
const cases = [
  { rel: 'artifacts/g08-closeout/fixture-closeout-legal', expect: 0 },
  { rel: 'artifacts/g08-closeout/fixture-closeout-illegal', expect: 1 },
  { rel: 'artifacts/g08-closeout/g08-closeout-live-20261103', expect: 0 },
];
for (const item of cases) {
  const dir = join(repo, item.rel);
  if (!existsSync(dir)) {
    say(false, `verify ${item.rel}`, 'batch is missing from the checkout');
    continue;
  }
  const before = hashTree(dir);
  const batchId = item.rel.split('/').pop();
  const result = run(['dist/scripts/eval-g08.js', '--verify', '--out', join(repo, 'artifacts/g08-closeout'), '--batch', batchId]);
  const after = hashTree(dir);
  const okExit = result.code === item.expect;
  const okReadOnly = before === after;
  say(okExit && okReadOnly, `verify ${batchId} (exit ${result.code}, expected ${item.expect})`,
    okReadOnly ? '' : 'verification modified the evidence');
}

/* golden / probes live in the (git-ignored) handoff packages --------- */
const handoff = [
  'handoff/20261103-g08-closeout/golden-g05.cjs',
  'handoff/20261103-g08-closeout/probes/verifier-probe.cjs',
  'handoff/20261103-g08-closeout/probes/runtime-probe.cjs',
  'handoff/20261103-g08-r1/probes/state-probe.cjs',
  'handoff/20261103-g08-r1/probes/cli-probe.cjs',
  'handoff/20261103-g08-r1/probes/eval-audit-probe.cjs',
];
console.log('\nNot in git by repo convention (run them from the delivery machine):');
for (const rel of handoff) {
  console.log(`  ${existsSync(join(repo, rel)) ? 'present' : 'absent '} ${rel}`);
}

console.log('');
if (failures.length > 0) {
  console.error(`self-check FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('self-check: all green');
