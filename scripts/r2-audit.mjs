#!/usr/bin/env node
/**
 * R2 single audit entry (H). Runs the full acceptance exactly once, records the
 * real exit codes/raw tails and writes artifacts/sprint-r2/acceptance/summary.json.
 * A failure is recorded as FAIL; nothing is retried to force green.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'artifacts/sprint-r2/acceptance');
mkdirSync(OUT, { recursive: true });
const results = [];

function run(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024, ...options });
  const stdout = `${result.stdout ?? ''}`;
  const stderr = `${result.stderr ?? ''}`;
  const exit = result.status ?? 1;
  const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-25).join('\n');
  results.push({ name, exit, ok: exit === 0, ms: Date.now() - started, tail });
  console.log(`${exit === 0 ? 'PASS' : 'FAIL'} ${name} (exit=${exit}, ${Date.now() - started}ms)`);
  return { exit, stdout, stderr };
}

const node = process.execPath;

// 1. Build (a build failure invalidates everything else).
const build = run('build', node, [join(process.cwd(), 'node_modules/typescript/bin/tsc'),
  '-p', 'tsconfig.json']);
if (build.exit !== 0) {
  writeSummary();
  process.exit(1);
}

// 2. Full test suite once (recursive, includes tests/acceptance-v2).
const tests = run('unit-tests', node, ['scripts/run-tests.mjs']);
const passMatch = tests.stdout.match(/# pass (\d+)|ℹ pass (\d+)/);
const failMatch = tests.stdout.match(/# fail (\d+)|ℹ fail (\d+)/);
results[results.length - 1].detail = {
  pass: passMatch ? Number(passMatch[1] ?? passMatch[2]) : null,
  fail: failMatch ? Number(failMatch[1] ?? failMatch[2]) : null,
};

// 3. Integration acceptance (eval-full, recursive discovery).
const evalFull = run('eval-full', node, ['dist/scripts/eval-full.js']);
if (existsSync(join(process.cwd(), 'artifacts/sprint-r1/acceptance/summary.json'))) {
  results[results.length - 1].detail = JSON.parse(
    readFileSync(join(process.cwd(), 'artifacts/sprint-r1/acceptance/summary.json'), 'utf8'));
}

// 4. Python suites.
const pyJev = run('python-jev04', 'python3',
  ['-m', 'unittest', 'discover', '-s', 'research/decision-choice/jev04/tests', '-p', 'test_*.py']);
const pyPort = run('python-scorer-port', 'python3',
  ['-m', 'unittest', 'discover', '-s', 'research/decision-choice/jev04/scorers/tests',
    '-p', 'test_*.py']);
const dataV2 = run('data-v2-validation', 'python3',
  ['research/decision-choice/jev04/data/v2/validate_v2.py']);

// 5. World matrix with the corrected scenarioDays.
const world = run('world-matrix-96h-720h', node, ['scripts/r2-world-evidence.mjs']);
if (existsSync(join(process.cwd(), 'artifacts/sprint-r2/world/matrix.json'))) {
  const matrix = JSON.parse(readFileSync(join(process.cwd(), 'artifacts/sprint-r2/world/matrix.json'),
    'utf8'));
  results[results.length - 1].detail = { groups: matrix.groups,
    settleAtDay30: matrix.settleAtDay30, failures: matrix.failures.length };
}

writeSummary();

function writeSummary() {
  const failed = results.filter(item => !item.ok);
  const summary = {
    schema: 'frostecho.r2.audit-summary/1',
    at: new Date().toISOString(),
    mode: 'CPU fixture/reference; no live model claim',
    passed: results.filter(item => item.ok).length,
    failed: failed.length,
    blocked: 0,
    results,
  };
  const path = join(OUT, 'summary.json');
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ path, passed: summary.passed, failed: summary.failed }));
  process.exit(failed.length === 0 ? 0 : 1);
}
