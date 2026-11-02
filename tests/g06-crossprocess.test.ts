/**
 * G06 worker D — black-box cross-process tests.
 *
 * 1. The eval-g06 matrix itself: 4 scenarios × ac/ca, every resume branch in a
 *    fresh node process. 8/8 full-checkpoint equality plus scenario semantics
 *    (R4's hungry NPC really waits, R2's 100 idle pumps spend nothing).
 * 2. Budget boundaries across a real restart: saving right before the last
 *    call lets exactly one more call happen; an exhausted session never calls
 *    the provider again after restore; per-episode totals are never reset.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const EVAL = resolve('dist/scripts/eval-g06.js');
const DRIVER = resolve('dist/tests/g06-budget-driver.js');

interface CliOutcome { code: number | null; stdout: string; stderr: string }

async function run(script: string, args: string[]): Promise<CliOutcome> {
  const child = spawn(process.execPath, [script, ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c; });
  child.stderr.on('data', (c: Buffer) => { stderr += c; });
  const code = await new Promise<number | null>(r => child.on('close', c => r(c)));
  return { code, stdout, stderr };
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

test('eval-g06 matrix: 8/8 cross-process pairs identical, evidence on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-x-'));
  try {
    const out = await run(EVAL, ['--out', root, '--batch', 'matrix']);
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /8\/8 pairs identical/);
    const summary = readJson(join(root, 'matrix', 'summary.json')) as {
      totals: { pairs: number; passed: number };
      pairs: { caseId: string; pass: boolean; savepointCalls: number; finalCalls: number; finalStates: Record<string, string>; playerHunger: number | null }[];
    };
    assert.equal(summary.totals.pairs, 8);
    assert.equal(summary.totals.passed, 8);
    for (const pair of summary.pairs) {
      const dir = join(root, 'matrix', pair.caseId);
      for (const name of ['savepoint.g06.json', 'continuous.json', 'resume.json', 'diff.json']) {
        assert.equal(existsSync(join(dir, name)), true, `${pair.caseId}/${name} exists`);
      }
      const diff = readJson(join(dir, 'diff.json')) as { pass: boolean; diffs: string[] };
      assert.equal(diff.pass, true, pair.caseId);
      assert.deepEqual(diff.diffs, []);
      if (pair.caseId.startsWith('r4')) {
        const states = Object.values(pair.finalStates);
        assert.ok(states.includes('waiting'), 'the NPC that found no food waits');
        assert.equal(pair.playerHunger, 70, 'the player ate the last food');
        const resume = readJson(join(dir, 'resume.json')) as { engine: { state: { npcs: Record<string, { hunger: number }> } } };
        const hungry = Object.values(resume.engine.state.npcs).filter(n => n.hunger === 40);
        assert.ok(hungry.length >= 1, 'no hunger is conjured from an empty kitchen');
      }
      if (pair.caseId.startsWith('r2')) {
        // savepoint: both waiting after one call each; tail: restock feeds both.
        assert.equal(pair.savepointCalls, 2);
        assert.equal(pair.finalCalls, 4, '100 idle pumps added zero calls');
      }
      if (pair.caseId.startsWith('r3')) {
        assert.equal(pair.savepointCalls, 0, 'goal pre-check and decay save zero calls');
        assert.equal(pair.finalCalls, 2);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget boundary: save right before the last call; exactly one call after restore, then exhaustion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-budget-'));
  try {
    const file = join(root, 'lastcall.g06.json');
    const saved = await run(DRIVER, ['--mode', 'save', '--file', file, '--steps', '4']);
    assert.equal(saved.code, 0, saved.stderr);
    const saveReport = readJson(join(root, 'save-report.json')) as { providerCalls: number; status: string };
    assert.equal(saveReport.providerCalls, 4);
    assert.equal(saveReport.status, 'ready');
    // New process: one advance spends the fifth (last) call → budget_exhausted;
    // a second advance must not call again.
    const resumed = await run(DRIVER, ['--mode', 'resume', '--file', file, '--steps', '2']);
    assert.equal(resumed.code, 0, resumed.stderr);
    const report = readJson(join(root, 'resume-report.json')) as {
      providerCallsAfterRestore: number;
      outcomes: string[];
      totalCalls: number;
      sessionProviderCalls: number;
      sessionStatus: string;
      actorState: string;
    };
    assert.equal(report.providerCallsAfterRestore, 1, 'exactly the one remaining call, never a reset budget');
    assert.equal(report.sessionProviderCalls, 5);
    assert.equal(report.totalCalls, 5, 'episode total = 4 saved + 1 after restore');
    assert.equal(report.sessionStatus, 'budget_exhausted');
    assert.equal(report.actorState, 'budget_exhausted');
    assert.deepEqual(report.outcomes, ['stepped', 'idle']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget boundary: an exhausted session saved and restored never calls the provider again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-budget-'));
  try {
    const file = join(root, 'exhausted.g06.json');
    const saved = await run(DRIVER, ['--mode', 'save', '--file', file, '--steps', '5']);
    assert.equal(saved.code, 0, saved.stderr);
    const resumed = await run(DRIVER, ['--mode', 'resume', '--file', file, '--steps', '3']);
    assert.equal(resumed.code, 0, resumed.stderr);
    const report = readJson(join(root, 'resume-report.json')) as {
      providerCallsAfterRestore: number;
      sessionProviderCalls: number;
      sessionStatus: string;
      outcomes: string[];
    };
    assert.equal(report.providerCallsAfterRestore, 0, 'no provider call after restoring an exhausted session');
    assert.equal(report.sessionProviderCalls, 5);
    assert.equal(report.sessionStatus, 'budget_exhausted');
    assert.deepEqual(report.outcomes, ['idle', 'idle', 'idle']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
