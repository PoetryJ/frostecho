/**
 * G07 worker A — bounded player→NPC mailbox (pure state, no HTTP, no world).
 *
 * Invariants: sender is always npc_b; only a local target accepts a message;
 * text is 1..256 Unicode codepoints after trimming; at most one pending
 * message per NPC; a commandId is deduplicated by content (same content →
 * duplicate, different content → conflict, never a second insert). send()
 * touches only mailbox state — no world, session, cursor or budget effect.
 *
 * bindNext() is the single consumption point: it increments a unique bind
 * sequence, takes a deep copy of the pending message and clears it. The off
 * arm records a suppressed receipt with an empty view; the on arm exposes
 * exactly {sender, text}. completeBind() later rewrites the same receipt to
 * attempted/failed — never above "attempted", never a claim of understanding,
 * and never an automatic retry.
 */
import {
  MAX_MESSAGE_CODEPOINTS, MAX_PENDING_PER_NPC, PLAYER_SENDER_ID,
  messageFail, messageOk,
  type BindReceipt, type DecisionMessageContext, type Mailbox, type MailboxReceipt, type MailboxSnapshot,
  type MailboxStatusView, type MessageCommand, type MessageDeliveryStatus, type MessageResult, type PendingMessage,
} from './contracts';

const RECEIPT_STATUSES: readonly MessageDeliveryStatus[] = ['suppressed', 'attached', 'attempted', 'failed'];

let seqCounter = 0;
function commandIdFallback(): string {
  seqCounter += 1;
  return `say-${Date.now()}-${seqCounter}`;
}

function codepointLength(text: string): number {
  return Array.from(text).length;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class MailboxImpl implements Mailbox {
  private messageSeq = 0;
  private bindSeq = 0;
  private pending: Record<string, PendingMessage[]> = {};
  private readonly dedupe = new Map<string, { to: string; text: string; seq: number; at: string }>();
  private readonly receipts: BindReceipt[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  send(command: MessageCommand, localPositions: Readonly<Record<string, string>>): MessageResult<MailboxReceipt> {
    if (!isPlainObject(command)) return messageFail('INVALID_COMMAND', 'command must be an object');
    const to = (command as { to?: unknown }).to;
    const rawText = (command as { text?: unknown }).text;
    const commandId = (command as { commandId?: unknown }).commandId;
    if (!isNonEmptyString(to)) return messageFail('UNKNOWN_RECIPIENT', 'to must be a non-empty actor id');
    if (typeof rawText !== 'string') return messageFail('INVALID_COMMAND', 'text must be a string');
    const id = isNonEmptyString(commandId) ? commandId : commandIdFallback();
    const text = rawText.trim();
    if (text.length === 0) return messageFail('BLANK', 'text is empty after trimming');
    if (codepointLength(text) > MAX_MESSAGE_CODEPOINTS) {
      return messageFail('TOO_LONG', `text has ${codepointLength(text)} codepoints; the limit is ${MAX_MESSAGE_CODEPOINTS}`);
    }
    if (!isPlainObject(localPositions)) return messageFail('INVALID_COMMAND', 'localPositions must be an object');
    const positions = localPositions as Record<string, string>;
    if (!isNonEmptyString(positions[to])) return messageFail('UNKNOWN_RECIPIENT', `unknown recipient ${JSON.stringify(to)}`);
    const playerAt = positions[PLAYER_SENDER_ID];
    if (!isNonEmptyString(playerAt)) return messageFail('INVALID_COMMAND', 'player position is not readable from the authoritative world');
    if (positions[to] !== playerAt) {
      return messageFail('NOT_LOCAL', `${to} is not at the player's location`);
    }

    const previous = this.dedupe.get(id);
    if (previous !== undefined) {
      if (previous.to === to && previous.text === text) {
        return messageOk({ commandId: id, to, seq: previous.seq, at: previous.at, outcome: 'duplicate' });
      }
      return messageFail('CONFLICT', `commandId ${JSON.stringify(id)} was already used with different content`);
    }
    const queue = this.pending[to] ?? [];
    if (queue.length >= MAX_PENDING_PER_NPC) {
      return messageFail('QUEUE_FULL', `${to} already has ${queue.length} pending message(s)`);
    }
    this.messageSeq += 1;
    const at = new Date(this.now()).toISOString();
    const pending: PendingMessage = { seq: this.messageSeq, commandId: id, sender: PLAYER_SENDER_ID, text, at };
    this.pending[to] = [...queue, pending];
    this.dedupe.set(id, { to, text, seq: this.messageSeq, at });
    return messageOk({ commandId: id, to, seq: this.messageSeq, at, outcome: 'new' });
  }

  bindNext(actorId: string, enabled: boolean): MessageResult<DecisionMessageContext> {
    if (!isNonEmptyString(actorId)) return messageFail('INVALID_COMMAND', 'actorId must be a non-empty string');
    if (typeof enabled !== 'boolean') return messageFail('INVALID_COMMAND', 'enabled must be a boolean');
    const queue = this.pending[actorId] ?? [];
    const taken = queue.length > 0 ? queue[0] : null;
    this.pending[actorId] = [];
    this.bindSeq += 1;
    const status: 'suppressed' | 'attached' = enabled ? 'attached' : 'suppressed';
    const at = new Date(this.now()).toISOString();
    this.receipts.push({
      bindSeq: this.bindSeq,
      actorId,
      status,
      seq: taken?.seq ?? null,
      sender: taken?.sender ?? null,
      text: taken?.text ?? null,
      at,
    });
    return messageOk({
      bindSeq: this.bindSeq,
      actorId,
      enabled,
      status,
      // Deep copy: later sends can never mutate text already bound to a call.
      messages: enabled && taken !== null ? [{ sender: taken.sender, text: taken.text }] : [],
    });
  }

  completeBind(bindSeq: number, outcome: 'attempted' | 'failed'): void {
    for (let i = this.receipts.length - 1; i >= 0; i -= 1) {
      const receipt = this.receipts[i];
      if (receipt.bindSeq !== bindSeq) continue;
      // Only escalate from the bind state; never rewrite an already settled receipt.
      if (receipt.status === 'suppressed' || receipt.status === 'attached') receipt.status = outcome;
      return;
    }
  }

  export(): MailboxSnapshot {
    const pending: Record<string, PendingMessage[]> = {};
    for (const [actorId, list] of Object.entries(this.pending)) {
      if (list.length > 0) pending[actorId] = list.map(message => ({ ...message }));
    }
    const dedupe: MailboxSnapshot['dedupe'] = {};
    for (const [id, value] of this.dedupe.entries()) dedupe[id] = { ...value };
    return {
      schema: 'frostecho.g07.mailbox/1',
      sender: PLAYER_SENDER_ID,
      messageSeq: this.messageSeq,
      bindSeq: this.bindSeq,
      pending,
      dedupe,
      receipts: this.receipts.map(receipt => ({ ...receipt })),
    };
  }

  status(): MailboxStatusView {
    const pending: Record<string, { seq: number; text: string }[]> = {};
    for (const [actorId, list] of Object.entries(this.pending)) {
      if (list.length > 0) pending[actorId] = list.map(message => ({ seq: message.seq, text: message.text }));
    }
    const lastReceipt = this.receipts.length > 0 ? { ...this.receipts[this.receipts.length - 1] } : null;
    return { sender: PLAYER_SENDER_ID, messageSeq: this.messageSeq, bindSeq: this.bindSeq, pending, lastReceipt };
  }

  /** Test/restore hook: replace internals with a validated snapshot. */
  load(snapshot: MailboxSnapshot): void {
    this.messageSeq = snapshot.messageSeq;
    this.bindSeq = snapshot.bindSeq;
    this.pending = {};
    for (const [actorId, list] of Object.entries(snapshot.pending)) this.pending[actorId] = list.map(m => ({ ...m }));
    this.dedupe.clear();
    for (const [id, value] of Object.entries(snapshot.dedupe)) this.dedupe.set(id, { ...value });
    this.receipts.length = 0;
    this.receipts.push(...snapshot.receipts.map(r => ({ ...r })));
  }
}

export function createMailbox(now: () => number = Date.now): Mailbox {
  return new MailboxImpl(now);
}

/** Restore from a snapshot: validates everything, binds nothing, decides nothing. */
export function restoreMailbox(data: unknown, now: () => number = Date.now): MessageResult<Mailbox> {
  if (!isPlainObject(data)) return messageFail('INVALID_SNAPSHOT', 'mailbox snapshot must be an object');
  if (data.schema !== 'frostecho.g07.mailbox/1') {
    return messageFail('SCHEMA_MISMATCH', `schema ${JSON.stringify(data.schema)} is not frostecho.g07.mailbox/1`);
  }
  const issues: string[] = [];
  if (data.sender !== PLAYER_SENDER_ID) issues.push(`sender must be ${PLAYER_SENDER_ID}`);
  const messageSeq = data.messageSeq;
  const bindSeq = data.bindSeq;
  if (typeof messageSeq !== 'number' || !Number.isSafeInteger(messageSeq) || messageSeq < 0) issues.push('messageSeq must be a non-negative integer');
  if (typeof bindSeq !== 'number' || !Number.isSafeInteger(bindSeq) || bindSeq < 0) issues.push('bindSeq must be a non-negative integer');
  const limit = typeof messageSeq === 'number' ? messageSeq : 0;
  const pending = data.pending;
  const pendingOut: Record<string, PendingMessage[]> = {};
  if (!isPlainObject(pending)) {
    issues.push('pending must be an object');
  } else {
    for (const [actorId, list] of Object.entries(pending)) {
      if (typeof actorId !== 'string' || actorId.length === 0) { issues.push('pending keys must be actor ids'); continue; }
      if (!Array.isArray(list)) { issues.push(`pending[${actorId}] must be an array`); continue; }
      if (list.length > MAX_PENDING_PER_NPC) issues.push(`pending[${actorId}] exceeds ${MAX_PENDING_PER_NPC} message(s)`);
      const cleaned: PendingMessage[] = [];
      list.forEach((message, index) => {
        const label = `pending[${actorId}][${index}]`;
        if (!isPlainObject(message)) { issues.push(`${label} must be an object`); return; }
        if (message.sender !== PLAYER_SENDER_ID) issues.push(`${label}.sender must be ${PLAYER_SENDER_ID}`);
        if (!isNonEmptyString(message.commandId)) issues.push(`${label}.commandId must be a non-empty string`);
        if (typeof message.text !== 'string' || message.text.trim().length === 0
          || codepointLength(message.text.trim()) > MAX_MESSAGE_CODEPOINTS) {
          issues.push(`${label}.text must be 1..${MAX_MESSAGE_CODEPOINTS} codepoints`);
        }
        if (typeof message.seq !== 'number' || !Number.isSafeInteger(message.seq) || message.seq < 1 || message.seq > limit) {
          issues.push(`${label}.seq is outside 1..${limit}`);
        }
        if (typeof message.at !== 'string') issues.push(`${label}.at must be a string`);
        cleaned.push({
          seq: message.seq as number,
          commandId: message.commandId as string,
          sender: PLAYER_SENDER_ID,
          text: (message.text as string) ?? '',
          at: message.at as string,
        });
      });
      pendingOut[actorId] = cleaned;
    }
  }
  const dedupe = data.dedupe;
  const dedupeOut: MailboxSnapshot['dedupe'] = {};
  if (!isPlainObject(dedupe)) {
    issues.push('dedupe must be an object');
  } else {
    for (const [id, value] of Object.entries(dedupe)) {
      if (!isPlainObject(value)) { issues.push(`dedupe[${id}] must be an object`); continue; }
      if (!isNonEmptyString(value.to)) issues.push(`dedupe[${id}].to must be a non-empty string`);
      if (typeof value.text !== 'string') issues.push(`dedupe[${id}].text must be a string`);
      if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > limit) {
        issues.push(`dedupe[${id}].seq is outside 1..${limit}`);
      }
      if (typeof value.at !== 'string') issues.push(`dedupe[${id}].at must be a string`);
      dedupeOut[id] = { to: value.to as string, text: value.text as string, seq: value.seq as number, at: value.at as string };
    }
  }
  const receipts = data.receipts;
  const receiptsOut: BindReceipt[] = [];
  if (!Array.isArray(receipts)) {
    issues.push('receipts must be an array');
  } else {
    const bindLimit = typeof bindSeq === 'number' ? bindSeq : 0;
    receipts.forEach((receipt, index) => {
      const label = `receipts[${index}]`;
      if (!isPlainObject(receipt)) { issues.push(`${label} must be an object`); return; }
      if (!RECEIPT_STATUSES.includes(receipt.status as MessageDeliveryStatus)) issues.push(`${label}.status unknown`);
      if (typeof receipt.bindSeq !== 'number' || !Number.isSafeInteger(receipt.bindSeq)
        || receipt.bindSeq < 1 || receipt.bindSeq > bindLimit) issues.push(`${label}.bindSeq is outside 1..${bindLimit}`);
      if (!isNonEmptyString(receipt.actorId)) issues.push(`${label}.actorId must be a non-empty string`);
      if (receipt.seq !== null && (typeof receipt.seq !== 'number' || !Number.isSafeInteger(receipt.seq))) issues.push(`${label}.seq must be null or an integer`);
      if (receipt.sender !== null && receipt.sender !== PLAYER_SENDER_ID) issues.push(`${label}.sender must be null or ${PLAYER_SENDER_ID}`);
      if (receipt.text !== null && typeof receipt.text !== 'string') issues.push(`${label}.text must be null or a string`);
      if (typeof receipt.at !== 'string') issues.push(`${label}.at must be a string`);
      receiptsOut.push({
        bindSeq: receipt.bindSeq as number,
        actorId: receipt.actorId as string,
        status: receipt.status as MessageDeliveryStatus,
        seq: (receipt.seq as number | null) ?? null,
        sender: (receipt.sender as string | null) ?? null,
        text: (receipt.text as string | null) ?? null,
        at: receipt.at as string,
      });
    });
  }
  if (issues.length > 0) return messageFail('INVALID_SNAPSHOT', ...issues);
  const mailbox = new MailboxImpl(now);
  mailbox.load({
    schema: 'frostecho.g07.mailbox/1',
    sender: PLAYER_SENDER_ID,
    messageSeq: messageSeq as number,
    bindSeq: bindSeq as number,
    pending: pendingOut,
    dedupe: dedupeOut,
    receipts: receiptsOut,
  });
  return messageOk(mailbox);
}
