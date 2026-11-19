/**
 * ONE token counter for the memory budget and for the encode side.
 *
 * Before this module the bounded memory was charged with a private
 * per-character heuristic (`estimateTokens`) against a hand-written copy of the
 * fact line. That copy always billed `发生于` and never billed the renderer's
 * `-` placeholder, so the budget and the bytes the model actually received were
 * two different numbers. A budget that does not measure the text it governs is
 * not a budget.
 *
 * Here the counter and the block builder live together:
 *  - `step.ts` bills `renderMemoryBlock(facts)` with the same counter object it
 *    records in the step evidence;
 *  - `scorer-client.ts` reports `count(rendered memory segment)` in the
 *    envelope it sends to the model service, so the encode side and the budget
 *    side are the same caliber by construction;
 *  - both are replaceable: passing another `TokenCounter` changes both sides at
 *    once instead of letting them drift apart.
 *
 * The default is a deterministic byte estimator: 3 UTF-8 bytes per token (one
 * CJK character, three ASCII characters). It needs no tokenizer download, no
 * locale and no network, so the number is reproducible on any machine.
 */
import type { ObservedFact } from '../../decision/contracts';

export interface TokenCounter {
  /** Stable id, recorded next to every number so a count is never ambiguous. */
  id: string;
  count(text: string): number;
}

export const BYTE_COUNTER_ID = 'utf8-bytes/3-ceil/1';

export const byteTokenCounter: TokenCounter = {
  id: BYTE_COUNTER_ID,
  count: (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
};

/** A caller-supplied counter is validated once, then used everywhere. */
export function resolveTokenCounter(counter?: TokenCounter): TokenCounter {
  if (counter === undefined) return byteTokenCounter;
  if (typeof counter.id !== 'string' || counter.id.length === 0)
    throw new Error('token counter: id must be a non-empty string');
  if (typeof counter.count !== 'function')
    throw new Error('token counter: count must be a function');
  return counter;
}

/** Same scalar formatting the renderer uses; a byte-exact copy is required. */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '?';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * One memory fact exactly as `renderRequest` writes it. Kept byte-identical to
 * `src/r7/jev/render.ts` on purpose: unlike the renderer it never trims to 12
 * facts, so the caller decides the window and this only formats a line.
 */
export function renderMemoryLine(fact: ObservedFact): string {
  const payload = fact.payload as Record<string, unknown>;
  const occurredAt = payload?.occurredAt ?? null;
  const subjects = fact.subjectIds.length > 0 ? fact.subjectIds.join(',') : '-';
  return `- [${fact.source}] ${fact.kind} 知于${fact.simTime}`
    + `${occurredAt === null ? '' : ` 发生于${scalarText(occurredAt)}`}`
    + ` 关于${subjects} ${JSON.stringify(fact.payload)}`;
}

/** The block the renderer embeds after `\n记忆:\n`. No header, no trailing NL. */
export function renderMemoryBlock(facts: readonly ObservedFact[]): string {
  return facts.map(renderMemoryLine).join('\n');
}

/** The full memory segment as it appears in the joint text. */
export function renderMemorySegment(facts: readonly ObservedFact[]): string {
  return `\n记忆:\n${renderMemoryBlock(facts)}`;
}
