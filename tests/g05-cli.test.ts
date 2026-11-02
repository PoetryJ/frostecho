/**
 * G05 workstream D — the needs-lifecycle CLI as a real child process.
 *
 * Proves the G05 contract points: `time` grants needs per the active policy
 * and rejects out-of-range minutes without touching simTime, the runtime
 * `need` switch changes what future boundaries grant, a never-policy session
 * stays at zero provider calls, and every exit path persists exactly one g05
 * record that settles under verification.
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
  const code = await new Promise<number | null>(resolveExit => child.on('exit', c => resolveExit(c)));
  return { code, stdout, stderr, outDir };
}

function readSaved(outDir: string): { record: ReactiveRecord; verification: ReturnType<typeof verifyReactiveEpisode> } {
  const episodeDir = join(outDir, 'ep', 'episodes', 'ep');
  const gameFile = join(episodeDir, 'game.json');
  assert.ok(existsSync(gameFile), `game.json must be saved under ${episodeDir}`);
  const record = JSON.parse(readFileSync(gameFile, 'utf8')) as ReactiveRecord;
  return { record, verification: verifyReactiveEpisode(episodeDir) };
}

const savedCount = (stdout: string): number =>
  stdout.split('\n').filter(line => line.includes('saved ') && line.includes('/episodes/')).length;

test('full session: time grants, restock feeds the need, run satisfies, quit exits 0 with one record', async () => {
  const run = await runCliSteps(['--need', 'one-shot'], [
    { line: 'time 30\n', until: 'needs: npc_a' },
    { line: 'world restock kitchen 3\n', until: 'need=one-shot' },
    { line: 'run\n', until: 'satisfied' },
    { line: 'status\n', until: 'need=one-shot' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(savedCount(run.stdout), 1, 'exactly one save');
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.equal(record.schema, 'frostecho.g05.game/1');
  assert.equal(record.needPolicy, 'one-shot');
  assert.equal(record.finalState.simTime, 30);
  assert.deepEqual(record.needs?.map(n => [n.actorId, n.period, n.outcome]), [['npc_a', 1, 'satisfied']]);
  assert.equal(record.actors.npc_a.state, 'satisfied');
  rmSync(run.outDir, { recursive: true, force: true });
});

test('time rejects out-of-range minutes without advancing simTime, and status makes no request', async () => {
  const run = await runCliSteps(['--need', 'never'], [
    { line: 'time 0\n', until: '[time rejected]' },
    { line: 'time 130\n', until: '[time rejected]' },
    { line: 'time abc\n', until: '[time rejected]' },
    { line: 'status\n', until: 'simTime=0' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.equal(record.finalState.simTime, 0, 'no rejected time may land');
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 0);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('never policy stays at zero provider calls across metabolism', async () => {
  const run = await runCliSteps(['--need', 'never'], [
    { line: 'time 30\n', until: 'simTime=30' },
    { line: 'time 30\n', until: 'simTime=60' },
    { line: 'status\n', until: 'simTime=60' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.deepEqual(record.needs, []);
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 0);
  assert.deepEqual([record.finalState.npcs.npc_a.hunger, record.finalState.npcs.npc_c.hunger], [46, 26]);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('the runtime need switch changes what the next boundary grants', async () => {
  const run = await runCliSteps(['--need', 'never'], [
    { line: 'time 30\n', until: 'simTime=30' },
    { line: 'need one-shot\n', until: 'need policy -> one-shot' },
    { line: 'time 30\n', until: 'needs: npc_a' },
    { line: 'need never\n', until: 'need policy -> never' },
    { line: 'time 30\n', until: 'simTime=90' },
    { line: 'status\n', until: 'need=never' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record } = readSaved(run.outDir);
  assert.deepEqual(record.needs?.map(n => [n.actorId, n.period, n.outcome, n.decisionsUsed]), [['npc_a', 2, 'pending', 0]]);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('EOF on an open session still finalizes exactly once with exit 0', async () => {
  const run = await runCliSteps(['--need', 'never'], [
    { line: 'time 10\n', until: 'simTime=10' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(savedCount(run.stdout), 1);
  const { record, verification } = readSaved(run.outDir);
  assert.ok(verification.ok, verification.issues.join('; '));
  assert.equal(record.stopReason, 'user_closed');
  rmSync(run.outDir, { recursive: true, force: true });
});
