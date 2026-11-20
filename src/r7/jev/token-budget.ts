/**
 * ONE billing module for the memory window and for the encode side.
 *
 * Two numbers are reported side by side and never mixed:
 *  - `units`   — the BUDGET unit, produced by a deterministic `TokenCounter`
 *                (default `utf8-bytes/3-ceil/1`: ceil(UTF-8 bytes / 3)). This
 *                is an ESTIMATE: it needs no tokenizer, no locale and no
 *                network, so the budget is reproducible on any machine;
 *  - `encoder` — the real tokenizer of the model that receives the text, with
 *                its own id. It is attached by the encode side (`StepOptions.
 *                encoder`) and reported as `null/'not-attached'` when no real
 *                encoder is running. The estimate is never renamed to
 *                "token" and never substituted for the encoder's count.
 *
 * R11: a single record may no longer be admitted whole. `fitFact` trims ONE
 * fact — deterministically, largest readable variant first — until the line
 * fits the budget it is offered, and reports what was cut. A trimmed line keeps
 * its source (`[player_statement]`), both clocks (`知于`/`发生于`), the commitment
 * instance and revision, the revocation wording carried by `kind`, and a
 * traceable pointer (`eventId` + SHA-256 of the untruncated payload) so the
 * original can be found and verified in the store.
 */
import { createHash } from 'node:crypto';
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

/**
 * The real tokenizer on the encode side. Deliberately a DIFFERENT type from
 * `TokenCounter`: the budget and the model must not be able to borrow each
 * other's number by accident.
 */
export interface MemoryEncoderPort {
  id: string;
  count(text: string): number;
}

export function resolveMemoryEncoder(encoder?: MemoryEncoderPort | null): MemoryEncoderPort | null {
  if (encoder === undefined || encoder === null) return null;
  if (typeof encoder.id !== 'string' || encoder.id.length === 0)
    throw new Error('memory encoder: id must be a non-empty string');
  if (typeof encoder.count !== 'function')
    throw new Error('memory encoder: count must be a function');
  return encoder;
}

/** Honest name of what `units` measures: an estimate, not a tokenizer count. */
export const MEMORY_UNIT_KIND = 'estimated-token';
/** Version of the projection rule (selection + trimming + reporting). */
export const MEMORY_PROJECTION_ID = 'memory-projection/2';

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

/** UTF-8 bytes of a string; the "bytes before encoding" number of the evidence. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable JSON (sorted keys) for hashing a payload across processes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/**
 * `omitted` means the record did not enter the window at all (even its pointer
 * line was too long, or the budget was 0); the trim record still names it.
 */
export type MemoryTrimLevel = 'text-trim' | 'fields-dropped' | 'pointer-only' | 'omitted';

/** What a trimmed record still proves, and what it lost. */
export interface MemoryTruncationRecord {
  /** Record-level pointer: the event id the fact was built from. */
  pointer: string;
  /** SHA-256 of the UNTRUNCATED payload (sorted keys): find + verify the original. */
  originalSha256: string;
  kind: string;
  source: string;
  occurredAt: number | null;
  level: MemoryTrimLevel;
  /** Characters of free text kept / dropped (0/0 when no free text existed). */
  keptTextChars: number;
  omittedTextChars: number;
  /** Payload fields removed entirely at this level. */
  droppedFields: string[];
  /** `sourceEventIds` entries beyond the first, folded into a count. */
  omittedEvidenceIds: number;
}

export interface FittedFact {
  fact: ObservedFact;
  /** null means the record was admitted whole; no marker in the text. */
  truncation: MemoryTruncationRecord | null;
  units: number;
}

/**
 * Free-text fields: the only payload values that are safe to cut without
 * destroying identity. Ids, times, amounts and status are never cut by
 * `text-trim`; they only disappear at `fields-dropped` (and are reported).
 */
const FREE_TEXT_KEYS = ['text', 'note', 'reason', 'message', 'detail', 'explanation',
  'description', 'terms', 'summary', 'outcome', 'verdict'] as const;

/** Kept in priority order when a record has to fall back to its identity. */
const CRITICAL_KEYS = ['occurredAt', 'authority', 'speakerId', 'commitmentId', 'revision',
  'status', 'taskId', 'legacyTaskId', 'promiseId', 'fromId', 'toId',
  'place', 'resource', 'amount', 'remaining', 'total', 'heardBy', 'toldBy'] as const;

const TRIM_CAPS = [256, 128, 64, 32, 16, 8, 4] as const;

function payloadOf(fact: ObservedFact): Record<string, unknown> {
  return fact.payload && typeof fact.payload === 'object' && !Array.isArray(fact.payload)
    ? fact.payload as Record<string, unknown> : { value: fact.payload ?? null };
}

function freeTextStats(payload: Record<string, unknown>): { chars: number; present: boolean } {
  let chars = 0;
  let present = false;
  for (const key of FREE_TEXT_KEYS) {
    const value = payload[key];
    if (typeof value !== 'string') continue;
    present = true;
    chars += value.length;
  }
  return { chars, present };
}

function capEvidenceIds(value: unknown): { value: unknown; omitted: number } {
  if (!Array.isArray(value) || value.length <= 1) return { value, omitted: 0 };
  return { value: [value[0]], omitted: value.length - 1 };
}

function trimFreeText(base: Record<string, unknown>, cap: number):
  { payload: Record<string, unknown>; kept: number; omitted: number; dropped: string[] } {
  const payload = { ...base };
  let kept = 0;
  let omitted = 0;
  const dropped: string[] = [];
  for (const key of FREE_TEXT_KEYS) {
    const value = payload[key];
    if (typeof value !== 'string') continue;
    if (value.length <= cap) { kept += value.length; continue; }
    if (cap === 0) {
      delete payload[key];
      dropped.push(key);
      omitted += value.length;
      continue;
    }
    payload[key] = `${value.slice(0, cap)}…[+${value.length - cap}字]`;
    kept += cap;
    omitted += value.length - cap;
  }
  return { payload, kept, omitted, dropped };
}

function criticalOnly(base: Record<string, unknown>):
  { payload: Record<string, unknown>; dropped: string[] } {
  const payload: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const key of CRITICAL_KEYS) {
    if (base[key] !== undefined) payload[key] = base[key];
  }
  for (const key of Object.keys(base)) {
    if (CRITICAL_KEYS.includes(key as typeof CRITICAL_KEYS[number])) continue;
    if (key === 'sourceEventIds' || key === 'truncated' || key === 'originalSha256'
      || key === 'omittedChars' || key === 'pointer') continue;
    dropped.push(key);
  }
  return { payload, dropped };
}

/**
 * The deterministic ladder a single record descends until it fits: full text →
 * shorter free text → identity fields only → pointer only. Each rung carries
 * the trim record that the evidence reports; the text itself always says it was
 * trimmed (`truncated:true` plus `omittedChars`) so the model is never shown a
 * silently shortened promise.
 */
export function factVariants(fact: ObservedFact):
  { fact: ObservedFact; truncation: MemoryTruncationRecord | null }[] {
  const original = payloadOf(fact);
  const originalSha256 = sha256Of(canonicalJson(original));
  const pointer = fact.eventId;
  const stats = freeTextStats(original);
  const capped = capEvidenceIds(original.sourceEventIds);
  const base: Record<string, unknown> = { ...original };
  if (capped.omitted > 0) base.sourceEventIds = capped.value;
  const record = (level: MemoryTrimLevel, kept: number, omitted: number,
    dropped: string[]): MemoryTruncationRecord => ({
    pointer, originalSha256, kind: fact.kind, source: fact.source,
    occurredAt: typeof original.occurredAt === 'number' ? original.occurredAt : null,
    level, keptTextChars: kept, omittedTextChars: omitted,
    droppedFields: [...dropped],
    omittedEvidenceIds: capped.omitted,
  });
  const withPayload = (payload: Record<string, unknown>): ObservedFact => ({ ...fact, payload });
  const variants: { fact: ObservedFact; truncation: MemoryTruncationRecord | null }[] = [];
  // Rung 0: the record as it was stored.
  variants.push({ fact, truncation: null });
  // Rung 1: free text progressively shortened, identity untouched.
  for (const cap of TRIM_CAPS) {
    const trimmed = trimFreeText(base, cap);
    variants.push({ fact: withPayload({
      ...trimmed.payload, truncated: true, omittedChars: trimmed.omitted }),
      truncation: record('text-trim', trimmed.kept, trimmed.omitted, trimmed.dropped) });
  }
  // Rung 2: no free text at all, identity + pointer + full payload hash.
  {
    const trimmed = trimFreeText(base, 0);
    variants.push({ fact: withPayload({
      ...trimmed.payload, pointer, originalSha256, truncated: true, omittedChars: trimmed.omitted }),
      truncation: record('fields-dropped', 0, trimmed.omitted, trimmed.dropped) });
  }
  // Rung 3: critical identity fields only, pointer + hash prefix.
  {
    const critical = criticalOnly(base);
    variants.push({ fact: withPayload({
      ...critical.payload, pointer, originalSha256: originalSha256.slice(0, 16),
      truncated: true, omittedChars: stats.chars }),
      truncation: record('fields-dropped', 0, stats.chars, critical.dropped) });
  }
  // Rung 4: the identity fields the requirement names, dropped ONE AT A TIME
  // from the least essential end until the line fits. Every rung keeps the
  // pointer and the truncation marker; `droppedFields` records what was shed, so
  // a hard 64-unit budget reports "revision omitted" instead of silently
  // rewriting the promise.
  {
    const ladder = ['occurredAt', 'commitmentId', 'revision', 'status']
      .filter(key => base[key] !== undefined);
    const droppedByPrefix = criticalOnly(base).dropped;
    for (let take = ladder.length; take >= 0; take -= 1) {
      const minimal: Record<string, unknown> = {};
      for (const key of ladder.slice(0, take)) minimal[key] = base[key];
      const omitted = ladder.slice(take);
      variants.push({ fact: withPayload({
        ...minimal, pointer, truncated: true }),
        truncation: record('pointer-only', 0, stats.chars, [...droppedByPrefix, ...omitted]) });
    }
  }
  return variants;
}

/**
 * The largest variant of ONE fact that fits `cap` units IN THE BLOCK, i.e. the
 * count of `renderMemoryBlock([...base, variant])`. Charging the block (not the
 * line) matters: `ceil` is not additive, so a joined block can cost one unit
 * more than the sum of its lines.
 *
 * `null` means even the pointer line is too long: the caller must then omit the
 * record and report it, never silently exceed the budget.
 */
export function fitFact(fact: ObservedFact, cap: number, counter: TokenCounter,
  base: readonly ObservedFact[] = []): FittedFact | null {
  if (cap < 1) return null;
  for (const variant of factVariants(fact)) {
    const units = counter.count(renderMemoryBlock([...base, variant.fact]));
    if (units <= cap) return { fact: variant.fact, truncation: variant.truncation, units };
  }
  return null;
}

/**
 * The compact identity line a record can always fall back to. Used to RESERVE
 * room for lower-priority records, so one long promise cannot take the whole
 * window. The returned line may still be longer than the caller's cap; the
 * caller must compare `units`.
 */
export function compactFact(fact: ObservedFact, counter: TokenCounter): FittedFact {
  const variants = factVariants(fact);
  const variant = variants[variants.length - 1];
  return { fact: variant.fact, truncation: variant.truncation,
    units: counter.count(renderMemoryLine(variant.fact)) };
}
