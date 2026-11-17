/**
 * G05-live workstream A — the per-request chat budget.
 *
 * reserve() is synchronous and never refunds: JavaScript's single thread makes
 * the check-and-increment atomic even when several decide() calls interleave,
 * so two callers can never both spend the last slot. A denial is classified
 * apart from transport errors: no request is sent, nothing is submitted, and
 * the runner records the turn as an interrupted decision attempt. Session (5)
 * and per-actor episode (10) budgets are untouched and still bind first.
 */
import type { Provider, TransportRecord } from '../agent/contracts';
import { ProviderTransportError } from '../agent/providers/http';
import type {
  AttemptRequestConfig, LiveAttemptFinish, LiveAttemptOutcome, LiveBlockedRecord, BudgetReservation, LiveAttemptHooks,
} from './live-contracts';

export class ChatBudgetGate {
  private spentCount = 0;
  private blockedCount = 0;
  private seqCount = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`chat budget limit must be a finite non-negative integer, got ${String(limit)}`);
    }
  }

  /** Synchronous spend. Failed and timed-out requests keep their slot. */
  reserve(): BudgetReservation {
    if (this.spentCount >= this.limit) {
      this.blockedCount += 1;
      return { ok: false, code: 'CHAT_BUDGET_EXHAUSTED' };
    }
    this.spentCount += 1;
    this.seqCount += 1;
    return { ok: true, attemptId: `att-${String(this.seqCount).padStart(4, '0')}` };
  }

  get spent(): number {
    return this.spentCount;
  }

  get blocked(): number {
    return this.blockedCount;
  }
}

/** A local denial — no HTTP happened and no command may run. */
export class BudgetBlockedError extends Error {
  readonly code = 'CHAT_BUDGET_EXHAUSTED' as const;
  constructor() {
    super('chat budget exhausted');
    this.name = 'BudgetBlockedError';
  }
}

function outcomeOf(err: unknown, transport: TransportRecord | null): { outcome: LiveAttemptOutcome; status: number | null; error: string | null } {
  if (err instanceof BudgetBlockedError) return { outcome: 'aborted', status: null, error: 'chat budget exhausted' };
  if (transport !== null) {
    // The HTTP adapter already classified this attempt on its transport record.
    if (transport.error === 'timeout') return { outcome: 'timeout', status: transport.status, error: 'timeout' };
    if (typeof transport.error === 'string' && transport.error.startsWith('http ')) {
      return { outcome: 'http_error', status: transport.status, error: transport.error };
    }
    if (typeof transport.error === 'string' && transport.error.startsWith('network error')) {
      return { outcome: 'network_error', status: null, error: transport.error };
    }
    if (transport.error !== null) return { outcome: 'parse_error', status: transport.status, error: transport.error };
    // No recorded error but a rejection: treat as a parse/content failure.
    return { outcome: 'parse_error', status: transport.status, error: err instanceof Error ? err.message : 'provider error' };
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { outcome: 'timeout', status: null, error: 'timeout' };
  }
  return {
    outcome: err instanceof ProviderTransportError ? 'http_error' : 'network_error',
    status: err instanceof ProviderTransportError ? err.status ?? null : null,
    error: err instanceof Error ? err.message : 'provider error',
  };
}

export interface BudgetedProviderOptions {
  gate: ChatBudgetGate;
  hooks: LiveAttemptHooks;
  /** Immutable per-batch sampling snapshot recorded with every attempt. */
  requestConfig: AttemptRequestConfig;
  episodeId: string;
  actorId: string;
  /** Cycle ordinal, supplied by the provider factory (one provider per cycle). */
  cycle: number;
  /** The real HTTP provider; never a reference provider. */
  inner: Provider;
  now?: () => number;
}

/**
 * Wraps an HTTP provider with reserve → persist-begin → HTTP → persist-finish.
 * If the begin write fails, the error propagates before any request is sent
 * (the reserved slot stays spent — no refunds). consumeTransport forwards the
 * inner adapter's record so the runner keeps its normal evidence path.
 */
export function createBudgetedProvider(options: BudgetedProviderOptions): Provider {
  const now = options.now ?? Date.now;
  let round = 0;
  let slot: TransportRecord | null = null;
  return {
    async decide(input, signal) {
      const reservation = options.gate.reserve();
      if (!reservation.ok) {
        options.hooks.recordBlocked({
          seq: 0,
          at: new Date(now()).toISOString(),
          episodeId: options.episodeId,
          actorId: options.actorId,
          cycle: options.cycle,
          round: round + 1,
          code: reservation.code,
        });
        throw new BudgetBlockedError();
      }
      round += 1;
      const attemptId = reservation.attemptId;
      const seq = Number(attemptId.slice(4));
      // Durable begin BEFORE the request. A write failure stops the attempt.
      options.hooks.beginAttempt({
        attemptId,
        seq,
        episodeId: options.episodeId,
        actorId: options.actorId,
        cycle: options.cycle,
        round,
        at: new Date(now()).toISOString(),
        requestConfig: options.requestConfig,
      });
      const started = now();
      try {
        const raw = await options.inner.decide(input, signal);
        const transport = options.inner.consumeTransport?.() ?? null;
        slot = transport;
        options.hooks.finishAttempt({
          attemptId,
          at: new Date(now()).toISOString(),
          outcome: 'success',
          status: transport?.status ?? null,
          error: null,
          usage: transport?.usage ?? null,
          elapsedMs: Math.max(0, now() - started),
        });
        return raw;
      } catch (err) {
        const transport = options.inner.consumeTransport?.() ?? null;
        slot = transport;
        const classified = outcomeOf(err, transport);
        options.hooks.finishAttempt({
          attemptId,
          at: new Date(now()).toISOString(),
          outcome: classified.outcome,
          status: classified.status,
          error: classified.error,
          usage: transport?.usage ?? null,
          elapsedMs: Math.max(0, now() - started),
        });
        throw err;
      }
    },
    consumeTransport() {
      const current = slot;
      slot = null;
      return current;
    },
  };
}
