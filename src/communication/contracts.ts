/**
 * G07 frozen contracts — player → one local NPC, opt-in, data-only.
 *
 * A message is a bounded local request, never authority: it cannot name the
 * sender, change the world, wake a waiting/satisfied NPC, refresh a budget or
 * alter the actor's move/eat/stop permissions. The mailbox is pure state (no
 * HTTP); the provider decorator binds a deep-copied context at the exact
 * moment a real decide() is about to happen; the game never reads it.
 *
 * Ownership: A implements src/communication/mailbox.ts against these types;
 * B implements src/communication/provider.ts plus the optional prompt entry in
 * the HTTP adapter; C implements src/communication/checkpoint.ts and
 * scripts/play-g07.ts; D consumes only.
 */
import type { GameCheckpoint } from '../persistence/contracts';

export const G07_CHECKPOINT_SCHEMA = 'frostecho.g07.checkpoint/1' as const;
export const G07_MAILBOX_SCHEMA = 'frostecho.g07.mailbox/1' as const;

/** The player is always npc_b; sender is fixed by the system, never by input. */
export const PLAYER_SENDER_ID = 'npc_b' as const;
export const MAX_MESSAGE_CODEPOINTS = 256;
/** At most one pending message per NPC. */
export const MAX_PENDING_PER_NPC = 1;

export type MessageMode = 'off' | 'on';

export type MessageErrorCode =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_RECIPIENT'
  | 'NOT_LOCAL'
  | 'BLANK'
  | 'TOO_LONG'
  | 'QUEUE_FULL'
  | 'CONFLICT'
  | 'SCHEMA_MISMATCH'
  | 'INVALID_SNAPSHOT';

export type MessageResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MessageErrorCode; issues?: string[] };

export function messageOk<T>(value: T): MessageResult<T> {
  return { ok: true, value };
}

export function messageFail<T = never>(code: MessageErrorCode, ...issues: string[]): MessageResult<T> {
  return { ok: false, code, ...(issues.length > 0 ? { issues } : {}) };
}

/** Player intent as submitted: to + text. sender is implied npc_b. */
export interface MessageCommand {
  commandId: string;
  /** Target NPC id (npc_a / npc_c in the frozen world). */
  to: string;
  text: string;
}

/** What the model is allowed to see: minimal content, no ids, no labels. */
export interface PlayerMessageView {
  sender: string;
  text: string;
}

/** Receipt states — mechanics only, never "the NPC understood". */
export type MessageDeliveryStatus = 'suppressed' | 'attached' | 'attempted' | 'failed';

export interface MailboxReceipt {
  commandId: string;
  to: string;
  /** Monotonic message sequence assigned at send time (1-based). */
  seq: number;
  at: string;
  /** duplicate for a repeated identical commandId; new for a fresh send. */
  outcome: 'new' | 'duplicate';
}

/** One bind = one decide attempt for one actor. */
export interface DecisionMessageContext {
  bindSeq: number;
  actorId: string;
  enabled: boolean;
  /** 'suppressed' (off arm) or 'attached' (on arm); both consume pending. */
  status: 'suppressed' | 'attached';
  /** Deep copy; empty on the off arm. */
  messages: PlayerMessageView[];
}

export interface BindReceipt {
  bindSeq: number;
  actorId: string;
  status: MessageDeliveryStatus;
  /** Consumed messages (deep copy) at bind time. */
  seq: number | null;
  sender: string | null;
  text: string | null;
  at: string;
}

export interface PendingMessage {
  seq: number;
  commandId: string;
  sender: string;
  text: string;
  at: string;
}

/** Serializable mailbox; restore re-attaches state but binds/decides nothing. */
export interface MailboxSnapshot {
  schema: typeof G07_MAILBOX_SCHEMA;
  sender: typeof PLAYER_SENDER_ID;
  messageSeq: number;
  bindSeq: number;
  pending: Record<string, PendingMessage[]>;
  /** commandId → original command, so a repeated send never inserts a second copy. */
  dedupe: Record<string, { to: string; text: string; seq: number; at: string }>;
  receipts: BindReceipt[];
}

/** Read-only status for CLI/evidence. */
export interface MailboxStatusView {
  sender: string;
  messageSeq: number;
  bindSeq: number;
  pending: Record<string, { seq: number; text: string }[]>;
  lastReceipt: BindReceipt | null;
}

export interface Mailbox {
  /** Only ledger state changes: no world, session, cursor or budget effect. */
  send(command: MessageCommand, localPositions: Readonly<Record<string, string>>): MessageResult<MailboxReceipt>;
  /** Called by the provider decorator right before a real decide(); consumes pending. */
  bindNext(actorId: string, enabled: boolean): MessageResult<DecisionMessageContext>;
  /** After the attempt settles: attempted / failed kept on the same receipt, never retried. */
  completeBind(bindSeq: number, outcome: 'attempted' | 'failed'): void;
  export(): MailboxSnapshot;
  status(): MailboxStatusView;
}

/* ------------------------------------------------------------------ */
/* Provider decorator (B)                                              */
/* ------------------------------------------------------------------ */

export interface MessageProviderOptions {
  enabled: boolean;
  /** Which actor this provider instance decides for (injected by the game). */
  actorId: string;
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/* Checkpoint envelope (C)                                             */
/* ------------------------------------------------------------------ */

/** G07 slot file: G06 game checkpoint + mailbox + mode, .g07.json. */
export interface G07Envelope {
  schema: typeof G07_CHECKPOINT_SCHEMA;
  game: GameCheckpoint;
  communication: MailboxSnapshot;
  messageMode: MessageMode;
}
