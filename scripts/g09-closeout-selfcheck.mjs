#!/usr/bin/env node
/**
 * G09 self-check for an independent clone: build, full suite, and a READ-ONLY
 * re-verification of every committed batch (G09 fake + live, G08 live), proving
 * the evidence bytes do not change. handoff/ is git-ignored by repo convention;
 * the golden and probe scripts are listed at the end when present.
 *
 * Usage: node scripts/g09-closeout-selfcheck.mjs [repo-root]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(process.argv[2] ?? process.cwd());
const node = process.execPath;

function run(args) {
  try {
    return { code: 0, out: execFileSync(node, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
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

const tsc = run(['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
say(tsc.code === 0, 'tsc build', tsc.code === 0 ? '' : tsc.out.split('\n').slice(0, 3).join(' | '));

const tests = run(['scripts/run-tests.mjs']);
const summary = tests.out.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)).join(' ');
const fail = /# fail (\d+)/.exec(tests.out);
say(tests.code === 0 && (fail === null || fail[1] === '0'), `full test suite (${summary})`);

const cases = [
  { rel: 'artifacts/g09/fixture-g09-fake', expect: 0, script: 'eval-g09' },
  { rel: 'artifacts/g09/g09-live-20261104-frozen', expect: 0, script: 'eval-g09' },
  { rel: 'artifacts/g08-closeout/g08-closeout-live-20261103', expect: 0, script: 'eval-g08' },
];
for (const item of cases) {
  const dir = join(repo, item.rel);
  if (!existsSync(dir)) {
    say(false, `verify ${item.rel}`, 'batch is missing from the checkout');
    continue;
  }
  const before = hashTree(dir);
  const batchId = item.rel.split('/').pop();
  const result = run([`dist/scripts/${item.script}.js`, '--verify', '--out', join(repo, item.rel, '..'), '--batch', batchId]);
  const after = hashTree(dir);
  say(result.code === item.expect && before === after, `verify ${batchId} (exit ${result.code}, expected ${item.expect})`,
    before === after ? '' : 'verification modified the evidence');
}

console.log('\nNot in git by repo convention (run them from the delivery machine):');
for (const rel of [
  'handoff/20261102-g08-timed-wait/golden-g05.cjs',
  'handoff/20261103-g08-closeout/probes/verifier-probe.cjs',
  'handoff/20261103-g08-closeout/probes/runtime-probe.cjs',
  'handoff/20261103-g08-r1/probes/state-probe.cjs',
  'handoff/20261103-g08-r1/probes/cli-probe.cjs',
  'handoff/20261103-g08-r1/probes/eval-audit-probe.cjs',
]) {
  console.log(`  ${existsSync(join(repo, rel)) ? 'present' : 'absent '} ${rel}`);
}

console.log('');
if (failures.length > 0) {
  console.error(`self-check FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('self-check: all green');
