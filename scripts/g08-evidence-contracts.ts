/**
 * G08 closeout — the small frozen data interfaces shared by the evidence
 * workers and the main wiring. This file is OWNED BY THE MAIN AGENT: workers
 * import it but never edit it.
 *
 * Design rule: everything here is derived FROM RAW MATERIALS ONLY. Nothing in
 * this file may read `summary.json`, and nothing may trust a recorded flag.
 */
import type { ActionSet } from '../src/temporal/contracts';
import type { ReactiveRecord } from '../src/reactive/contracts';
import { RULES, type Location } from '../src/types';

/* ------------------------------------------------------------------ */
/* Shared strict action parser (one implementation)                    */
/* ------------------------------------------------------------------ */

export interface StrictG08Action {
  type: 'move' | 'eat' | 'stop' | 'wait';
  to?: Location;
}

export type G08ParseOutcome = StrictG08Action | 'invalid_output' | null;

function countKey(raw: string, key: string): number {
  return (raw.match(new RegExp(`"${key}"\\s*:`, 'g')) ?? []).length;
}

/** Independent of the runner's parser: wait is legal ONLY with the exact one-key object. */
export function strictG08Action(raw: string | null): G08ParseOutcome {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'invalid_output';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid_output';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const type = record.type;
  if (typeof type !== 'string') return 'invalid_output';
  if (countKey(raw, 'type') !== 1) return 'invalid_output';
  if (keys.includes('to') && countKey(raw, 'to') !== 1) return 'invalid_output';
  if (type === 'eat' || type === 'stop' || type === 'wait') {
    if (keys.some(key => key !== 'type')) return 'invalid_output';
    return { type };
  }
  if (type === 'move') {
    if (keys.some(key => key !== 'type' && key !== 'to')) return 'invalid_output';
    const to = record.to;
    if (typeof to !== 'string' || !(RULES.LOCATIONS as readonly string[]).includes(to)) return 'invalid_output';
    return { type: 'move', to: to as Location };
  }
  return 'invalid_output';
}

/* ------------------------------------------------------------------ */
/* A: world causal chain                                               */
/* ------------------------------------------------------------------ */

/**
 * The narrow re-execution input: any G07/G08 episode record can be structured
 * into it without `as unknown as` gymnastics. `snapshot` is exactly the slice
 * an Engine needs to rebuild the world.
 */
export interface ReexecutionInput {
  plan: { episodeId: string };
  snapshot: Pick<ReactiveRecord, 'initialState' | 'commands' | 'events' | 'finalState'>;
}

/** The capability axis of one experiment slot. */
export type EvidenceActionSet = ActionSet;

/** The slice of an episode record the world audit reads. */
export interface WorldAuditRecord {
  plan: { episodeId: string };
  /** The frozen experiment initial state, as recorded separately. */
  initialState: unknown;
  snapshot: Pick<ReactiveRecord, 'initialState' | 'finalState' | 'commands' | 'events' | 'actors' | 'wakeAtSimTime'>;
  http: { request: { body: Record<string, unknown> }; response: { status: number; raw: string } }[];
  /** The recorded behavior — compared against, never trusted. */
  behavior: unknown;
  outcome: string;
}

export interface WorldAuditEntry {
  episodeId: string;
  actionSet: EvidenceActionSet;
}

/** Behavior re-derived from the re-executed command ledger and final state. */
export interface DerivedBehavior {
  actionSet: EvidenceActionSet;
  /** The action the raw response parsed to ('eat' | 'move' | 'stop' | 'wait'). */
  npcAction: string | null;
  npcAte: boolean;
  /** Status of the player's single eat attempt, or null when none ran. */
  playerEatStatus: string | null;
  /** Set on the timed_wait axis when npc_a is paused after the decision. */
  waitAccepted: boolean;
  waitDeadline: number | null;
  /** npc_a actor state at snapshot time ('active' | 'timed_wait' | ...). */
  npcState: string | null;
  /** npc_a provider calls recorded for the episode. */
  providerCalls: number;
}

export interface WorldAudit {
  issues: string[];
  /** Null when the record is too broken to derive anything. */
  derivedBehavior: DerivedBehavior | null;
}

/* ------------------------------------------------------------------ */
/* B: ledger → derived costs                                           */
/* ------------------------------------------------------------------ */

export interface LedgerEpisodeCost {
  episodeId: string;
  actionSet: EvidenceActionSet;
  arm: 'off' | 'on';
  outcome: string;
  /** HTTP exchanges recorded on this episode record. */
  requests: number;
  /** Attempt begins/finishes observed in the ledger for this episode. */
  begins: number;
  finishes: number;
  /** Sum of raw response usage.total_tokens; null when any response is unknown. */
  totalTokens: number | null;
  usageUnknown: boolean;
  /** Wall time of the finished attempts, summed; null when any attempt lacks one. */
  latencyMs: number | null;
}

/** One of the four experiment cells (both repetitions). */
export interface LedgerCellCost {
  cell: string;
  episodes: string[];
  requests: number;
  totalTokens: number | null;
  usageUnknown: boolean;
  latencyMs: number | null;
}

/** One messages-on/off pair inside a repetition (or across both). */
export interface LedgerPairDelta {
  pair: string;
  offEpisode: string | null;
  onEpisode: string | null;
  offTokens: number | null;
  onTokens: number | null;
  /** on − off; null when either side is unknown. */
  delta: number | null;
}

export interface LedgerCounts {
  planned: number;
  completed: number;
  failed: number;
  notRun: number;
  /** Attempt begins actually observed (each one is one chat request). */
  chatRequests: number;
  /** Attempt begins attributed to a completed episode's request. */
  spent: number;
  /** Blocked records written to the ledger. */
  blocked: number;
  /** Begins without a matching finish. */
  unresolved: number;
  /** Episodes with at least one response whose usage cannot be read. */
  usageUnknown: number;
}

export interface LedgerDerivation {
  issues: string[];
  counts: LedgerCounts;
  episodes: LedgerEpisodeCost[];
  cells: LedgerCellCost[];
  pairs: LedgerPairDelta[];
  /** Whole-batch token sum over the KNOWN part only. */
  knownTokenSum: number;
  /** Summary fields this derivation can prove; the summary must match them. */
  expectation: Record<string, unknown>;
}
