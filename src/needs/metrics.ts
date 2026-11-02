/**
 * G05-live workstream C — cost totals rebuilt from the durable attempt ledger.
 *
 * usage is summed per actual request (the old bug counted only the first one).
 * A request that was sent but whose usage is missing/partial stays an
 * usageUnknownCount entry and forces totalTokens = null: an incomplete total is
 * never reported as a confident number. decisionAttempts come from the saved
 * episode records (turns flagged providerCalled), httpAttempts from the ledger,
 * budgetBlocked from denial records — three separate counts, never derived
 * from mode flags or providerCalls alone.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptLedger } from './batch-store';
import type { LiveAttemptFinish, LiveAttemptOutcome } from './live-contracts';

export interface CostTotals {
  /** Provider decisions the runner actually attempted (episode records). */
  decisionAttempts: number;
  /** Requests that were sent (finished with any outcome). */
  httpAttempts: number;
  /** begin without finish — crash or kill during a request. Conservatively spent. */
  unresolvedAttempts: number;
  /** Local denials; no request was sent. */
  budgetBlocked: number;
  byOutcome: Record<LiveAttemptOutcome, number>;
  knownTokenSum: number;
  usageUnknownCount: number;
  /** null when any request lacks (complete) usage. */
  totalTokens: number | null;
  latencyMsSum: number;
}

type TurnCarrier = { cycles?: Record<string, { turns?: { providerCalled?: boolean }[] }[]> };

export function decisionAttemptsOfRecords(batchDir: string): number {
  const episodesDir = join(batchDir, 'episodes');
  if (!existsSync(episodesDir)) return 0;
  let total = 0;
  for (const name of readdirSync(episodesDir)) {
    const file = join(episodesDir, name, 'game.json');
    if (!existsSync(file)) continue;
    const record = JSON.parse(readFileSync(file, 'utf8')) as TurnCarrier;
    for (const list of Object.values(record.cycles ?? {})) {
      for (const cycle of list ?? []) {
        for (const turn of cycle.turns ?? []) {
          if (turn.providerCalled === true) total += 1;
        }
      }
    }
  }
  return total;
}

export function httpCallsOfRecords(batchDir: string): number {
  const episodesDir = join(batchDir, 'episodes');
  if (!existsSync(episodesDir)) return 0;
  let total = 0;
  for (const name of readdirSync(episodesDir)) {
    const file = join(episodesDir, name, 'game.json');
    if (!existsSync(file)) continue;
    const record = JSON.parse(readFileSync(file, 'utf8')) as { cycles?: Record<string, { turns?: { step?: { transport?: unknown } }[] }[]> };
    for (const list of Object.values(record.cycles ?? {})) {
      for (const cycle of list ?? []) {
        for (const turn of cycle.turns ?? []) {
          if (turn.step?.transport !== undefined && turn.step.transport !== null) total += 1;
        }
      }
    }
  }
  return total;
}

function usageTotalOf(usage: LiveAttemptFinish['usage']): number | null {
  if (usage === null) return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  if (typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
    return usage.prompt_tokens + usage.completion_tokens;
  }
  return null;
}

export function sumAttempts(ledger: AttemptLedger): Pick<CostTotals, 'httpAttempts' | 'unresolvedAttempts' | 'budgetBlocked' | 'byOutcome' | 'knownTokenSum' | 'usageUnknownCount' | 'totalTokens' | 'latencyMsSum'> {
  const finished = new Map(ledger.finishes.map(f => [f.attemptId, f]));
  const byOutcome: Record<LiveAttemptOutcome, number> = {
    success: 0, http_error: 0, network_error: 0, timeout: 0, parse_error: 0, aborted: 0,
  };
  let knownTokenSum = 0;
  let usageUnknownCount = 0;
  let latencyMsSum = 0;
  let sawUnknown = false;
  let httpAttempts = 0;
  for (const begin of ledger.begins) {
    const finish = finished.get(begin.attemptId);
    if (finish === undefined) continue; // unresolved, counted separately
    httpAttempts += 1;
    byOutcome[finish.outcome] += 1;
    latencyMsSum += Math.max(0, Math.round(finish.elapsedMs));
    const tokens = usageTotalOf(finish.usage);
    if (tokens === null) {
      usageUnknownCount += 1;
      sawUnknown = true;
    } else {
      knownTokenSum += tokens;
    }
  }
  return {
    httpAttempts,
    unresolvedAttempts: ledger.begins.filter(b => !finished.has(b.attemptId)).length,
    budgetBlocked: ledger.blocked.length,
    byOutcome,
    knownTokenSum,
    usageUnknownCount,
    totalTokens: sawUnknown ? null : knownTokenSum,
    latencyMsSum,
  };
}

export function costTotalsOf(batchDir: string, ledger: AttemptLedger): CostTotals {
  return {
    decisionAttempts: decisionAttemptsOfRecords(batchDir),
    ...sumAttempts(ledger),
  };
}
