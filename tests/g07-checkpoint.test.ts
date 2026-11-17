/**
 * G07 worker C — envelope save/load, cross-process resume, and format guardrails.
 *
 * Pending messages resume as pending and bind only at the next natural
 * decision; consumed messages are never re-delivered; mode/sequences/dedupe/
 * budgets survive; a busy game refuses SAVE_BUSY; G06 and G07 files are never
 * mistaken for each other; corrupt files and unwritable paths fail loudly.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createMailbox } from '../src/communication/mailbox';
import { g07CheckpointPath, loadG07Checkpoint, saveG07Checkpoint } from '../src/communication/checkpoint';
import { createNeedsGame, buildNeedsWorld, type NeedsGame } from '../src/needs/game';
import { createReferenceProvider } from '../src/agent/providers/reference';
import { createMessageProvider } from '../src/communication/provider';
import { saveCheckpoint } from '../src/persistence/file-store';
import { exportGameCheckpoint, restoreNeedsGame } from '../src/reactive/checkpoint';
import type { Mailbox } from '../src/communication/contracts';
import type { Provider } from '../src/agent/contracts';

const CLI_G07 = resolve('dist/scripts/play-g07.js');
const CLI_G06 = resolve('dist/scripts/play-g06.js');

function makeGame(episodeId: string, mailbox: Mailbox, enabled: boolean): NeedsGame {
  const providerFor = (actorId: string): Provider =>
    createMessageProvider(createReferenceProvider(), mailbox, { enabled, actorId });
  return createNeedsGame({
    episodeId,
    initialState: buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40, npc_b: 40 } }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor,
    mode: 'reference',
    needPolicy: 'recurring',
  });
}

const positions = { npc_b: 'kitchen', npc_a: 'kitchen', npc_c: 'kitchen' };

test('pending message survives save/load and binds at the next natural decision only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-ck-'));
  try {
    const mailbox = createMailbox();
    const game = makeGame('g07-ck-pending', mailbox, true);
    const sent = mailbox.send({ commandId: 'm1', to: 'npc_a', text: '请把最后一份留给我' }, positions);
    assert.equal(sent.ok, true);
    const saved = saveG07Checkpoint(root, 'p1', game, mailbox, 'on');
    assert.equal(saved.ok, true, saved.ok ? '' : `${saved.code} ${(saved.issues ?? []).join('; ')}`);

    // Load in this process (the CLI test below does the real new process).
    const loaded = loadG07Checkpoint(g07CheckpointPath(root, 'p1'));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.value.envelope.messageMode, 'on');
    assert.equal(loaded.value.mailbox.status().pending.npc_a?.length, 1, 'still pending after load');
    assert.equal(loaded.value.mailbox.status().bindSeq, 0, 'loading binds nothing');

    // The restored game consumes it in its next decision.
    const resumedMailbox = loaded.value.mailbox;
    const restoredGame = restoreNeedsGame(loaded.value.envelope.game, {
      providerFor: (actorId) => createMessageProvider(createReferenceProvider(), resumedMailbox, { enabled: true, actorId }),
    });
    assert.equal(restoredGame.ok, true, restoredGame.ok ? '' : `${restoredGame.code} ${(restoredGame.issues ?? []).join('; ')}`);
    if (!restoredGame.ok) return;
    await restoredGame.value.advance();
    const receipt = resumedMailbox.status().lastReceipt;
    assert.equal(receipt?.actorId, 'npc_a');
    assert.equal(receipt?.text, '请把最后一份留给我');
    assert.equal(receipt?.status, 'attempted');
    assert.deepEqual(resumedMailbox.status().pending, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumed messages never re-deliver: save after the bind, load, and the next bind has no text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-ck-'));
  try {
    const mailbox = createMailbox();
    const game = makeGame('g07-ck-consumed', mailbox, true);
    mailbox.send({ commandId: 'm1', to: 'npc_a', text: 'leave it' }, positions);
    await game.advance(); // A decides; the message is consumed
    assert.equal(mailbox.status().bindSeq, 1);
    assert.equal(mailbox.status().lastReceipt?.text, 'leave it');
    const saved = saveG07Checkpoint(root, 'p2', game, mailbox, 'on');
    assert.equal(saved.ok, true);

    const loaded = loadG07Checkpoint(g07CheckpointPath(root, 'p2'));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.value.mailbox.status().pending, {}, 'nothing pending after a consumed save');
    assert.equal(loaded.value.mailbox.status().bindSeq, 1);
    // Dedupe survives: the same commandId cannot insert a second copy.
    const again = loaded.value.mailbox.send({ commandId: 'm1', to: 'npc_a', text: 'leave it' }, positions);
    assert.equal(again.ok, true);
    assert.equal(again.ok ? again.value.outcome : '', 'duplicate');
    // A fresh bind (next decision) carries no old text.
    const next = loaded.value.mailbox.bindNext('npc_a', true);
    assert.deepEqual(next.ok ? next.value.messages : ['unexpected'], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mode, message sequence, dedupe, bind count and budgets stay continuous across a save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-ck-'));
  try {
    const mailbox = createMailbox();
    const game = makeGame('g07-ck-seq', mailbox, false);
    mailbox.send({ commandId: 'a1', to: 'npc_a', text: 'one' }, positions);
    await game.advance(); // off arm: suppressed receipt, message consumed
    assert.equal(mailbox.status().lastReceipt?.status, 'suppressed');
    const before = { calls: game.snapshot().actors.npc_a.providerCalls, bind: mailbox.status().bindSeq, msg: mailbox.status().messageSeq };
    const saved = saveG07Checkpoint(root, 'p3', game, mailbox, 'off');
    assert.equal(saved.ok, true);

    const loaded = loadG07Checkpoint(g07CheckpointPath(root, 'p3'));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.value.envelope.messageMode, 'off', 'the saved mode is kept');
    assert.equal(loaded.value.mailbox.status().messageSeq, before.msg);
    assert.equal(loaded.value.mailbox.status().bindSeq, before.bind);
    // A new message gets the next sequence number, not a restart.
    const next = loaded.value.mailbox.send({ commandId: 'a2', to: 'npc_c', text: 'two' }, positions);
    assert.equal(next.ok, true);
    assert.equal(next.ok ? next.value.seq : 0, before.msg + 1);
    // NPC budgets come from the checkpoint, unchanged by the save.
    assert.equal(loaded.value.envelope.game.totalCalls, game.snapshot().actors.npc_a.providerCalls + 0);
    assert.equal(loaded.value.envelope.game.cycles.npc_a[0].session.providerCalls, before.calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a busy game refuses the save at the decision boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-ck-'));
  try {
    const mailbox = createMailbox();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const providerFor = (actorId: string): Provider => createMessageProvider(
      { decide: async () => { await gate; return '{"type":"eat"}'; } },
      mailbox,
      { enabled: true, actorId },
    );
    const game = createNeedsGame({
      episodeId: 'g07-ck-busy',
      initialState: buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40, npc_b: 40 } }),
      actorIds: ['npc_a', 'npc_c'],
      providerFor,
      mode: 'reference',
      needPolicy: 'recurring',
    });
    const inflight = game.advance();
    await new Promise(r => setTimeout(r, 20));
    const denied = saveG07Checkpoint(root, 'busy', game, mailbox, 'on');
    assert.equal(denied.ok, false);
    assert.equal(denied.ok ? '' : denied.code, 'QUEUE_FULL');
    assert.ok((denied.ok ? [] : denied.issues ?? []).some(i => i.includes('in flight')));
    assert.equal(existsSync(g07CheckpointPath(root, 'busy')), false, 'nothing was published');
    release();
    await inflight;
    const after = saveG07Checkpoint(root, 'busy', game, mailbox, 'on');
    assert.equal(after.ok, true, 'saving works again at the boundary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('G06 and G07 files never load through each other', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-ck-'));
  try {
    const mailbox = createMailbox();
    const game = makeGame('g07-ck-cross', mailbox, false);
    const g07 = saveG07Checkpoint(root, 'seven', game, mailbox, 'off');
    assert.equal(g07.ok, true);
    // G06 reader sees a foreign schema.
    const asG06 = await import('../src/persistence/file-store').then(m => m.loadCheckpoint(g07CheckpointPath(root, 'seven')));
    assert.equal(asG06.ok, false);
    assert.equal(asG06.ok ? '' : asG06.code, 'SCHEMA_MISMATCH');
    // G07 reader sees a foreign schema too.
    const exported = exportGameCheckpoint(game);
    assert.equal(exported.ok, true);
    const six = saveCheckpoint(root, 'six', exported.ok ? exported.value : ({} as never));
    assert.equal(six.ok, true);
    const asG07 = loadG07Checkpoint(join(root, 'six.g06.json'));
    assert.equal(asG07.ok, false);
    assert.equal(asG07.ok ? '' : asG07.code, 'SCHEMA_MISMATCH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- CLI: real cross-process resume ---------------- */

interface Outcome { code: number | null; stdout: string; stderr: string }

async function runCli(cli: string, args: string[], input: string): Promise<Outcome> {
  const child = spawn(process.execPath, [cli, ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c; });
  child.stderr.on('data', (c: Buffer) => { stderr += c; });
  child.stdin.end(input);
  const code = await new Promise<number | null>(r => child.on('close', c => r(c)));
  return { code, stdout, stderr };
}

test('CLI: say → save → quit → new process loads and the NPC consumes it in one decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-cli-'));
  const slots = join(root, 'slots');
  try {
    const first = await runCli(CLI_G07, ['--messages', 'on', '--episode', 'g07-cli', '--out', join(root, 'ep1'), '--slots', slots], 'player say npc_a 请把最后一份留给我\nworld advance 2\nsave p1\nquit\n');
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /\[say new\] seq=1 to=npc_a/);
    assert.match(first.stdout, /pending=npc_a:1/);
    const file = join(slots, 'p1.g07.json');
    assert.equal(existsSync(file), true);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; payload: { messageMode: string; communication: { pending: Record<string, unknown[]> } } };
    assert.equal(stored.schema, 'frostecho.g07.checkpoint/1');
    assert.equal(stored.payload.messageMode, 'on');
    assert.equal(stored.payload.communication.pending.npc_a?.length, 1);

    const second = await runCli(CLI_G07, ['--load', file, '--out', join(root, 'ep2'), '--slots', slots], 'step\nquit\n');
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /G07 resumed g07-cli .*messages=on, pending=1, binds=0/);
    assert.match(second.stdout, /binds=1 last=\[attempted npc_a "请把最后一份留给我"\]/);
    assert.match(second.stdout, /pending=none/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: message-mode conflict, foreign file and corrupt file all exit 2', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-cli-'));
  const slots = join(root, 'slots');
  try {
    const offSave = await runCli(CLI_G07, ['--episode', 'g07-cli-off', '--out', join(root, 'ep1'), '--slots', slots], 'save o1\nquit\n');
    assert.equal(offSave.code, 0, `${offSave.stdout}\n${offSave.stderr}`);
    const offFile = join(slots, 'o1.g07.json');
    const conflict = await runCli(CLI_G07, ['--load', offFile, '--messages', 'on', '--out', join(root, 'ep2')], 'quit\n');
    assert.equal(conflict.code, 2);
    assert.match(conflict.stderr, /MODE_CONFLICT/);

    // A real G06 file must be refused by the G07 CLI.
    const g06Save = await runCli(CLI_G06, ['--episode', 'g07-cli-g06', '--out', join(root, 'ep3'), '--slots', join(root, 'slots6')], 'save s1\nquit\n');
    assert.equal(g06Save.code, 0);
    const g06Load = await runCli(CLI_G07, ['--load', join(root, 'slots6', 's1.g06.json'), '--out', join(root, 'ep4')], 'quit\n');
    assert.equal(g06Load.code, 2);
    assert.match(g06Load.stderr, /SCHEMA_MISMATCH/);

    // Truncated file.
    const broken = join(slots, 'broken.g07.json');
    const raw = readFileSync(offFile, 'utf8');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(broken, raw.slice(0, Math.floor(raw.length / 3)));
    const corrupt = await runCli(CLI_G07, ['--load', broken, '--out', join(root, 'ep5')], 'quit\n');
    assert.equal(corrupt.code, 2);
    assert.match(corrupt.stderr, /\[load rejected\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: an unwritable slot path fails the run, the ordinary duplicate stays exit 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-cli-'));
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory\n');
    const io = await runCli(CLI_G07, ['--episode', 'g07-cli-io', '--out', join(root, 'ep'), '--slots', join(blocked, 'nested')], 'save s1\nquit\n');
    assert.equal(io.code, 1, `${io.stdout}\n${io.stderr}`);
    assert.match(io.stdout, /\[save rejected\] IO_ERROR/);

    const slots = join(root, 'slots');
    mkdirSync(slots, { recursive: true });
    const first = await runCli(CLI_G07, ['--episode', 'g07-cli-dup', '--out', join(root, 'ep2'), '--slots', slots], 'save twice\nquit\n');
    assert.equal(first.code, 0);
    const second = await runCli(CLI_G07, ['--episode', 'g07-cli-dup', '--out', join(root, 'ep3'), '--slots', slots], 'save twice\nquit\n');
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /\[save rejected\] EXISTS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


