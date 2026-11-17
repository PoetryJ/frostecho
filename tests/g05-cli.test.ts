/**
 * G05-R1 workstream D — the needs-lifecycle CLI as a real child process.
 *
 * Proves the restored contract: `world advance <steps>` decays satiety and
 * rejects out-of-range steps without touching simTime, the initial all-70
 * world runs its first check at zero provider calls, the need switch only
 * accepts one-shot/recurring, provider thinking and metadata agree, and every
 * exit path persists exactly one g05 record that settles under verification.
 * Save assertions are cross-platform: real files on disk, no hardcoded
 * path-separator matching, and the child's output is fully collected first.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifyReactiveEpisode } from '../src/reactive/record';
import type { ReactiveRecord } from '../src/reactive/contracts';

const CLI = resolve('dist/scripts/play-g05.js');

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

async function runCliSteps(
  args: string[],
  steps: { line: string; until?: string }[],
): Promise<CliRun> {
  const outDir = mkdtempSync(join(tmpdir(), 'g05-cli-'));
  const child = spawn(process.execPath, [CLI, '--out', outDir, '--episode', 'ep', ...args], {
    env: { ...process.env, FROSTECHO_LLM_URL: '', FROSTECHO_LLM_MODEL: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let seen = 0;
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const waitFor = async (marker: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const next = stdout.indexOf(marker, seen);
      if (next >= 0) { seen = next + marker.length; return; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(marker)}\n${stdout}`);
      await new Promise(r => setTimeout(r, 10));
    }
  };
  for (const step of steps) {
    child.stdin.write(step.line);
    if (step.until !== undefined) await waitFor(step.until);
  }
  child.stdin.end();
  // Wait for the child to fully close so every write (incl. the save line) is collected.
  const code = await new Promise<number | null>(resolveExit => child.on('close', c => resolveExit(c)));
  return { code, stdout, stderr, outDir };
}

function readSaved(outDir: string): { record: ReactiveRecord; verification: ReturnType<typeof verifyReactiveEpisode> } {
  // Cross-platform: locate the record through path joins, never by matching
  // a '/episodes/' substring in process output.
  const episodeDir = join(outDir, 'ep', 'episodes', 'ep');
  const gameFile = join(episodeDir, 'game.json');
  assert.ok(existsSync(gameFile), `game.json must be saved under ${episodeDir}`);
  const record = JSON.parse(readFileSync(gameFile, 'utf8')) as ReactiveRecord;
  return { record, verification: verifyReactiveEpisode(episodeDir) };
}

const savedCount = (stdout: string): number =>
  stdout.split('\n').filter(line => line.includes('saved ') && !line.includes('[save]')).length;

test('full session: initial 70 checks at zero calls, advance reactivates under recurring, quit saves once', async () => {
  const run = await runCliSteps(['--need', 'recurring'], [
    { line: 'run\n', until: '[run idle]' },
    { line: 'status\n', until: 'simTime=0' },
    { line: 'world advance 3\n', until: 'simTime 0 -> 3' },
    { line: 'run\n', until: 'hunger=70' },
    { line: 'status\n', until: 'simTime=3' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(savedCount(run.stdout), 1, 'exactly one save');
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.equal(record.schema, 'frostecho.g05.game/2');
  assert.equal(record.needPolicy, 'recurring');
  assert.equal(record.finalState.simTime, 3);
  // Initial 70 check: 0 calls; after advance 3 both actors eat once back to 70.
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 2);
  assert.equal(record.finalState.npcs.npc_a.hunger, 70);
  assert.equal(record.thinking, true, 'metadata thinking matches the provider configuration');
  rmSync(run.outDir, { recursive: true, force: true });
});

test('advance rejects out-of-range steps without advancing simTime; status makes no request', async () => {
  const run = await runCliSteps(['--need', 'one-shot'], [
    { line: 'world advance 0\n', until: '[advance rejected]' },
    { line: 'world advance 11\n', until: '[advance rejected]' },
    { line: 'world advance abc\n', until: '[advance rejected]' },
    { line: 'status\n', until: 'simTime=0' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.equal(record.finalState.simTime, 0, 'no rejected advance may land');
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 0);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('one-shot stays at zero calls across decay; the initial check is free', async () => {
  const run = await runCliSteps(['--need', 'one-shot'], [
    // Contract §4: every episode first completes the initial at-goal check.
    { line: 'run\n', until: '[run idle]' },
    { line: 'world advance 3\n', until: 'simTime=3' },
    { line: 'world advance 3\n', until: 'simTime=6' },
    { line: 'run\n', until: '[run idle]' },
    { line: 'status\n', until: 'simTime=6' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 0);
  assert.deepEqual(
    [record.finalState.npcs.npc_a.hunger, record.finalState.npcs.npc_b.hunger, record.finalState.npcs.npc_c.hunger],
    [10, 10, 10],
  );
  rmSync(run.outDir, { recursive: true, force: true });
});

test('the need switch rejects the removed third arm and accepts recurring', async () => {
  const run = await runCliSteps(['--need', 'one-shot'], [
    { line: 'need never\n', until: '[need rejected]' },
    { line: 'need recurring\n', until: 'need policy -> recurring' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record } = readSaved(run.outDir);
  assert.equal(record.needPolicy, 'recurring');
  rmSync(run.outDir, { recursive: true, force: true });
});

test('EOF on an open session still finalizes exactly once with exit 0', async () => {
  const run = await runCliSteps(['--need', 'one-shot'], [
    { line: 'world advance 1\n', until: 'simTime=1' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(savedCount(run.stdout), 1);
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.equal(record.stopReason, 'user_closed');
  rmSync(run.outDir, { recursive: true, force: true });
});
