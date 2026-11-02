/**
 * G07 worker A — mailbox self-tests.
 *
 * Same-location only, one pending per NPC, 256 codepoints, commandId dedupe by
 * content, deep-copied bind context, off-arm suppression without leaking text,
 * bind-once consumption, and restore of both pending and consumed states.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMailbox, restoreMailbox } from '../src/communication/mailbox';
import { PLAYER_SENDER_ID, type MessageCommand } from '../src/communication/contracts';

const positions = (player: string, a: string, c: string): Record<string, string> => ({ npc_b: player, npc_a: a, npc_c: c });
const cmd = (commandId: string, to: string, text: string): MessageCommand => ({ commandId, to, text });
const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; code: string; issues?: string[] }): T => {
  if (!r.ok) throw new Error(`${r.code}: ${(r.issues ?? []).join('; ')}`);
  return r.value;
};

test('send accepts a local target once and rejects the second pending message', () => {
  const box = createMailbox();
  const ok = box.send(cmd('c1', 'npc_a', '  please save the last food  '), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(ok.ok, true);
  assert.equal(unwrap(ok).outcome, 'new');
  assert.equal(unwrap(ok).seq, 1);
  assert.equal(unwrap(ok).to, 'npc_a');
  const status = box.status();
  assert.deepEqual(status.pending.npc_a, [{ seq: 1, text: 'please save the last food' }]);
  assert.equal(status.pending.npc_c, undefined);
  const full = box.send(cmd('c2', 'npc_a', 'second message'), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(full.ok, false);
  assert.equal(full.code, 'QUEUE_FULL');
});

test('same commandId: identical content duplicates, different content conflicts, never a second insert', () => {
  const box = createMailbox();
  const first = unwrap(box.send(cmd('same', 'npc_a', 'leave it'), positions('kitchen', 'kitchen', 'kitchen')));
  const again = unwrap(box.send(cmd('same', 'npc_a', 'leave it'), positions('kitchen', 'kitchen', 'kitchen')));
  assert.equal(again.outcome, 'duplicate');
  assert.equal(again.seq, first.seq);
  assert.equal(box.status().messageSeq, 1);
  assert.equal(box.status().pending.npc_a?.length, 1);
  const conflict = box.send(cmd('same', 'npc_a', 'eat it'), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CONFLICT');
});

test('recipient, locality, blank and length bounds are enforced', () => {
  const box = createMailbox();
  const unknown = box.send(cmd('u1', 'npc_z', 'hi'), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_RECIPIENT');
  const far = box.send(cmd('u2', 'npc_c', 'hi'), positions('kitchen', 'kitchen', 'dorm'));
  assert.equal(far.ok, false);
  assert.equal(far.code, 'NOT_LOCAL');
  const blank = box.send(cmd('u3', 'npc_a', '   '), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(blank.ok, false);
  assert.equal(blank.code, 'BLANK');
  const tooLong = box.send(cmd('u4', 'npc_a', '字'.repeat(257)), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'TOO_LONG');
  // 256 codepoints (not UTF-16 units) is allowed.
  const exact = box.send(cmd('u5', 'npc_a', '字'.repeat(256)), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(exact.ok, true);
  // Sender is fixed npc_b even if a caller tries to smuggle another field.
  const smuggled = box.send({ ...cmd('u6', 'npc_c', 'hi'), sender: 'npc_a' } as MessageCommand, positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(smuggled.ok, true);
  assert.equal(unwrap(smuggled).to, 'npc_c');
});

test('bind is deep-copied and consumed once; later sends never mutate the bound text', () => {
  const box = createMailbox();
  box.send(cmd('b1', 'npc_a', 'first request'), positions('kitchen', 'kitchen', 'kitchen'));
  const ctx = unwrap(box.bindNext('npc_a', true));
  assert.equal(ctx.status, 'attached');
  assert.equal(ctx.bindSeq, 1);
  assert.deepEqual(ctx.messages, [{ sender: PLAYER_SENDER_ID, text: 'first request' }]);
  // A new message for the same NPC after bind does not alter the bound copy.
  box.send(cmd('b2', 'npc_a', 'second request'), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(ctx.messages[0].text, 'first request');
  // The first bind consumed the pending slot; the next bind takes the new one.
  const second = unwrap(box.bindNext('npc_a', true));
  assert.equal(second.bindSeq, 2);
  assert.deepEqual(second.messages, [{ sender: PLAYER_SENDER_ID, text: 'second request' }]);
  const empty = unwrap(box.bindNext('npc_a', true));
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.bindSeq, 3);
});

test('off arm binds at the same point but suppresses the text; receipt never claims understanding', () => {
  const box = createMailbox();
  box.send(cmd('o1', 'npc_c', 'take the food first'), positions('kitchen', 'kitchen', 'kitchen'));
  const ctx = unwrap(box.bindNext('npc_c', false));
  assert.equal(ctx.status, 'suppressed');
  assert.equal(ctx.enabled, false);
  assert.deepEqual(ctx.messages, [], 'off arm exposes nothing to the model');
  const receipt = box.status().lastReceipt;
  assert.equal(receipt?.status, 'suppressed');
  assert.equal(receipt?.text, 'take the food first', 'the suppressed text is only in the receipt for audit');
  assert.equal(box.status().pending.npc_c, undefined, 'off arm still consumes the pending slot');
  box.completeBind(ctx.bindSeq, 'failed');
  assert.equal(box.status().lastReceipt?.status, 'failed');
  box.completeBind(ctx.bindSeq, 'attempted');
  assert.equal(box.status().lastReceipt?.status, 'failed', 'a settled receipt is never rewritten');
});

test('restore of pending and consumed states: nothing re-binds or re-delivers', () => {
  const box = createMailbox();
  box.send(cmd('r1', 'npc_a', 'wait for me'), positions('kitchen', 'kitchen', 'kitchen'));
  const pendingSnapshot = JSON.parse(JSON.stringify(box.export())) as unknown;

  // Pending restore: the message is still pending, but restore itself binds nothing.
  const pendingBox = unwrap(restoreMailbox(pendingSnapshot));
  assert.equal(pendingBox.status().bindSeq, 0);
  assert.equal(pendingBox.status().pending.npc_a?.[0].text, 'wait for me');
  const ctx = unwrap(pendingBox.bindNext('npc_a', true));
  assert.deepEqual(ctx.messages, [{ sender: PLAYER_SENDER_ID, text: 'wait for me' }]);

  // Consumed restore: the same snapshot taken AFTER the bind has no pending
  // message, so a restart cannot deliver it a second time.
  const consumedBox = createMailbox();
  consumedBox.send(cmd('r2', 'npc_a', 'wait for me'), positions('kitchen', 'kitchen', 'kitchen'));
  const bind = unwrap(consumedBox.bindNext('npc_a', true));
  consumedBox.completeBind(bind.bindSeq, 'attempted');
  const consumed = unwrap(restoreMailbox(JSON.parse(JSON.stringify(consumedBox.export()))));
  assert.deepEqual(consumed.status().pending, {});
  assert.equal(consumed.status().bindSeq, 1);
  assert.equal(consumed.status().lastReceipt?.status, 'attempted');
  assert.deepEqual(unwrap(consumed.bindNext('npc_a', true)).messages, [], 'no re-delivery after restore');

  // Dedupe survives a restart: the same commandId cannot insert again.
  const again = consumed.send(cmd('r2', 'npc_a', 'wait for me'), positions('kitchen', 'kitchen', 'kitchen'));
  assert.equal(again.ok, true);
  assert.equal(unwrap(again).outcome, 'duplicate');
  assert.deepEqual(consumed.status().pending, {});
});

test('corrupt snapshots are rejected with issues', () => {
  const box = createMailbox();
  box.send(cmd('x1', 'npc_a', 'hi'), positions('kitchen', 'kitchen', 'kitchen'));
  const good = box.export();
  const bad = (mutate: (d: Record<string, unknown>) => void): void => {
    const data = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    mutate(data);
    const r = restoreMailbox(data);
    assert.equal(r.ok, false);
  };
  bad(d => { d.schema = 'frostecho.g06.checkpoint/1'; });
  bad(d => { d.sender = 'npc_a'; });
  bad(d => { d.messageSeq = -1; });
  bad(d => { (d.pending as Record<string, unknown[]>).npc_a = [{ seq: 9, commandId: 'x', sender: 'npc_b', text: 'hi', at: 't' }, { seq: 10, commandId: 'y', sender: 'npc_b', text: 'yo', at: 't' }]; });
  bad(d => { (d.pending as Record<string, unknown[]>).npc_a = [{ seq: 1, commandId: 'x', sender: 'npc_b', text: '', at: 't' }]; });
  bad(d => { d.receipts = [{ bindSeq: 99, actorId: 'npc_a', status: 'attached', seq: null, sender: null, text: null, at: 't' }]; });
  assert.equal(restoreMailbox(null).ok, false);
  assert.equal(restoreMailbox([]).ok, false);
});
