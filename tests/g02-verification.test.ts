/**
 * H01 — black-box regression tests for the deterministic evidence verifier.
 * Every mutation happens in a throwaway temp copy of the committed live-18
 * batch; the committed artifacts under artifacts/ are never touched.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyGameEvidence } from '../src/eval/verify-game';

const LIVE18 = join('artifacts', 'g02', 'g02-r1-live-18');
const VERIFY_CLI = join('dist', 'scripts', 'eval-g02.js');

interface MutableGame {
  batchId: string;
  scenarioId: string | null;
  goalReached: boolean;
  replayMatches: boolean;
  scenarioPass: boolean | null;
  commands: { role: string; command: Record<string, unknown>; exec: Record<string, unknown> }[];
  events: unknown[];
  steps: unknown[];
  initialState: unknown;
  finalState: { npcs: { npc_a: { hunger: number } } };
}

function tempBatch(): string {
  const root = mkdtempSync(join(tmpdir(), 'frostecho-verify-'));
  const batchDir = join(root, 'batch');
  cpSync(LIVE18, batchDir, { recursive: true });
  return batchDir;
}

function gameDirOf(batchDir: string, id: string): string {
  return join(batchDir, 'games', id);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8')) as any;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function verifyCli(batchDir: string): { code: number; stdout: string } {
  const run = spawnSync(process.execPath, [VERIFY_CLI, '--verify', batchDir], { encoding: 'utf8' });
  return { code: run.status ?? 1, stdout: `${run.stdout}${run.stderr}` };
}

test('original live-18 evidence verifies per game and via the CLI', () => {
  const batchDir = tempBatch();
  try {
    const s1 = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    const okGame = verifyGameEvidence(s1);
    assert.equal(okGame.ok, true, `issues: ${okGame.issues.join('; ')}`);
    assert.equal(okGame.game?.scenarioPass, true);
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 0, cli.stdout);
    assert.match(cli.stdout, /verify ok=true/);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('real goal-miss records (S2/S3) still verify as self-consistent', () => {
  const batchDir = tempBatch();
  try {
    for (const id of ['s2-thinking-on-rep-1', 's3-thinking-on-rep-1']) {
      const dir = gameDirOf(batchDir, id);
      const verification = verifyGameEvidence(dir);
      assert.equal(verification.ok, true, `${id}: ${verification.issues.join('; ')}`);
      assert.equal(verification.game?.goalReached, false, `${id} goalReached must stay false`);
      assert.equal(verification.game?.scenarioPass, true, `${id} expected pass stays pass`);
    }
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('tampered sidecar final-state.json is rejected', () => {
  const batchDir = tempBatch();
  try {
    const dir = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    const sidecar = readJson(join(dir, 'final-state.json'));
    sidecar.npcs.npc_a.hunger = 99;
    writeJson(join(dir, 'final-state.json'), sidecar);
    const verification = verifyGameEvidence(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('final-state.json does not match game.json')), verification.issues.join('; '));
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 1, cli.stdout);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('tampered game.json final state is rejected', () => {
  const batchDir = tempBatch();
  try {
    const dir = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    const game = readJson(join(dir, 'game.json')) as MutableGame;
    game.finalState.npcs.npc_a.hunger = 99;
    writeJson(join(dir, 'game.json'), game);
    const verification = verifyGameEvidence(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('engine replay state does not match game.json finalState')), verification.issues.join('; '));
    assert.ok(verification.issues.some(i => i.includes('replayMatches contradicts recomputation')), verification.issues.join('; '));
    assert.ok(verification.issues.some(i => i.includes('scenarioPass contradicts re-judgement')), verification.issues.join('; '));
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 1, cli.stdout);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('missing events.json is rejected', () => {
  const batchDir = tempBatch();
  try {
    const dir = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    unlinkSync(join(dir, 'events.json'));
    const verification = verifyGameEvidence(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('events.json missing')), verification.issues.join('; '));
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 1, cli.stdout);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('events inconsistent with the recorded final state are rejected', () => {
  const batchDir = tempBatch();
  try {
    const dir = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    const game = readJson(join(dir, 'game.json')) as MutableGame;
    game.events.pop(); // drop the last committed event: replay can no longer reach the final state
    writeJson(join(dir, 'game.json'), game);
    writeJson(join(dir, 'events.json'), game.events);
    const verification = verifyGameEvidence(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('engine replay events do not match game.json')), verification.issues.join('; '));
    assert.ok(verification.issues.some(i => i.includes('replayMatches contradicts recomputation')), verification.issues.join('; '));
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 1, cli.stdout);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('command exec result mismatch is rejected', () => {
  const batchDir = tempBatch();
  try {
    const dir = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    const game = readJson(join(dir, 'game.json')) as MutableGame;
    const last = game.commands[game.commands.length - 1];
    last.exec.status = 'rejected'; // forge a rejection the engine never produced
    writeJson(join(dir, 'game.json'), game);
    writeJson(join(dir, 'commands.json'), game.commands);
    const verification = verifyGameEvidence(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('engine replay exec mismatch')), verification.issues.join('; '));
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 1, cli.stdout);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('forged goalReached and replay flags are rejected', () => {
  const batchDir = tempBatch();
  try {
    const dir = gameDirOf(batchDir, 's2-thinking-on-rep-1'); // real goalReached=false, hunger 40
    const game = readJson(join(dir, 'game.json')) as MutableGame;
    game.goalReached = true;
    writeJson(join(dir, 'game.json'), game);
    const meta = readJson(join(dir, 'meta.json'));
    meta.goalReached = true;
    writeJson(join(dir, 'meta.json'), meta);
    let verification = verifyGameEvidence(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('goalReached contradicts finalState')), verification.issues.join('; '));
    // separate probe: forged replay.json flag
    const dir2 = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    const replay = readJson(join(dir2, 'replay.json'));
    replay.matches = false;
    writeJson(join(dir2, 'replay.json'), replay);
    verification = verifyGameEvidence(dir2);
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('replay.json matches does not match game.json')), verification.issues.join('; '));
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 1, cli.stdout);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test('corrupt game.json is rejected without throwing', () => {
  const batchDir = tempBatch();
  try {
    const dir = gameDirOf(batchDir, 's1-thinking-on-rep-1');
    writeFileSync(join(dir, 'game.json'), '{"batchId": "not json');
    const verification = verifyGameEvidence(dir);
    assert.equal(verification.ok, false);
    assert.equal(verification.game, null);
    assert.ok(verification.issues.some(i => i.includes('game.json unreadable')), verification.issues.join('; '));
    const cli = verifyCli(batchDir);
    assert.equal(cli.code, 1, cli.stdout);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
});
