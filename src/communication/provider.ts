/**
 * G07 worker B — Provider decorator that binds the mailbox at decide time.
 *
 * Composition (frozen): session/actor pre-checks → batch budget / attempt
 * begin → MessageProvider.bindNext → underlying provider. It sits INSIDE the
 * budgeted provider, so a decided call that never reaches the model (goal
 * reached, budget exhausted, blocked) never binds or consumes a message.
 *
 * It forwards the abort signal untouched, forwards consumeTransport so the
 * runner keeps its normal evidence path, and rethrows the provider's own error
 * unchanged. It never edits the actor, the parsed action or the world.
 *
 * Off arm: still binds (same moment, same receipt) with enabled=false, so the
 * underlying prompt sees playerMessages: []; the text is recorded only in the
 * audit receipt. On arm: the bound deep copy is attached.
 */
import type { DecideInput, Provider, TransportRecord } from '../agent/contracts';
import type { Mailbox } from './contracts';

export function createMessageProvider(inner: Provider, mailbox: Mailbox, options: {
  enabled: boolean;
  actorId: string;
}): Provider {
  let slot: TransportRecord | null = null;
  return {
    async decide(input: DecideInput, signal: AbortSignal): Promise<string> {
      const bound = mailbox.bindNext(options.actorId, options.enabled);
      if (!bound.ok) {
        // A structural failure must be visible, not silently swallowed into an
        // apparently normal decision.
        throw new Error(`mailbox bind failed for ${options.actorId}: ${bound.code}`);
      }
      const context = bound.value;
      const decorated: DecideInput = { ...input, playerMessages: context.messages };
      try {
        const raw = await inner.decide(decorated, signal);
        mailbox.completeBind(context.bindSeq, 'attempted');
        return raw;
      } catch (err) {
        mailbox.completeBind(context.bindSeq, 'failed');
        throw err;
      }
    },
    consumeTransport(): TransportRecord | null {
      slot = inner.consumeTransport?.() ?? null;
      return slot;
    },
  };
}
