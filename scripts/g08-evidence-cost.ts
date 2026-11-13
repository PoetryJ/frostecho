/**
 * G08 closeout worker B — ledger → derived costs.
 *
 * Everything here is recomputed from the raw batch directory: attempt
 * begins/finishes/blocked records, the HTTP exchanges captured on the episode
 * records, the episode records themselves and the status files. It NEVER reads
 * `summary.json` — the summary is what must be checked against this
 * derivation, not a source of truth.
 *
 * Latency convention: the sum of `finish.elapsedMs` over the attempts of an
 * episode (attempt wall time). HTTP record timestamps are metadata only and
 * are never used as a correctness signal.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { G07_TIMEOUT_MS, type G07EpisodeStatusFile } from './g07-eval-lib';
import type {
  LedgerCellCost, LedgerCounts, LedgerDerivation, LedgerEpisodeCost, LedgerPairDelta,
} from './g08-evidence-contracts';

interface RawEpisodeRecord {
  plan?: { episodeId?: unknown; actionSet?: unknown; arm?: unknown };
  outcome?: unknown;
  attempts?: { attemptId?: unknown }[];
  http?: { response?: { raw?: unknown } }[];
}

interface RawAttemptBegin {
  attemptId?: unknown;
  episodeId?: unknown;
  at?: unknown;
}

interface RawAttemptFinish {
  attemptId?: unknown;
  outcome?: unknown;
  elapsedMs?: unknown;
  usage?: { total_tokens?: unknown } | null;
}

/** The four experiment cells, in plan order. */
const CELLS = [
  { cell: 'legacy-off', actionSet: 'legacy', arm: 'off' },
  { cell: 'legacy-on', actionSet: 'legacy', arm: 'on' },
  { cell: 'timed_wait-off', actionSet: 'timed_wait', arm: 'off' },
  { cell: 'timed_wait-on', actionSet: 'timed_wait', arm: 'on' },
] as const;

const PAIRS = [
  { pair: 'legacy-r1', off: 'g08-r1-legacy-off', on: 'g08-r1-legacy-on' },
  { pair: 'timed_wait-r1', off: 'g08-r1-timed_wait-off', on: 'g08-r1-timed_wait-on' },
  { pair: 'legacy-r2', off: 'g08-r2-legacy-off', on: 'g08-r2-legacy-on' },
  { pair: 'timed_wait-r2', off: 'g08-r2-timed_wait-off', on: 'g08-r2-timed_wait-on' },
] as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function jsonFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort();
}

/** usage.total_tokens of one captured response, or null when unreadable. */
function responseTokens(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as { usage?: { total_tokens?: unknown } };
    return typeof parsed.usage?.total_tokens === 'number' ? parsed.usage.total_tokens : null;
  } catch {
    return null;
  }
}

function sumOrUnknown(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

/**
 * Derive the whole-batch cost ledger. `limit` is the frozen chat budget the
 * batch was run under (the plan records it).
 */
export function deriveLedgerCosts(batchDir: string): LedgerDerivation {
  const issues: string[] = [];
  const planPath = join(batchDir, 'plan.json');
  const plan = existsSync(planPath)
    ? readJson<{ plan?: { episodeId?: string; actionSet?: string; arm?: string }[]; hardChatLimit?: number }>(planPath)
    : null;
  const planned = plan?.plan ?? [];
  const limit = typeof plan?.hardChatLimit === 'number' ? plan.hardChatLimit : 8;

  /* --- read every raw file ---------------------------------------- */
  const episodes = new Map<string, RawEpisodeRecord>();
  const duplicateEpisodes: string[] = [];
  for (const name of jsonFilesIn(join(batchDir, 'episodes'))) {
    const record = readJson<RawEpisodeRecord>(join(batchDir, 'episodes', name));
    const id = record?.plan?.episodeId;
    if (typeof id !== 'string') {
      issues.push(`episode file ${name} carries no plan.episodeId`);
      continue;
    }
    if (episodes.has(id)) duplicateEpisodes.push(id);
    episodes.set(id, record);
  }
  if (duplicateEpisodes.length > 0) {
    issues.push(`duplicate episode records on disk for ${duplicateEpisodes.join(', ')}`);
  }

  const statuses = new Map<string, G07EpisodeStatusFile>();
  for (const name of jsonFilesIn(join(batchDir, 'status'))) {
    const status = readJson<G07EpisodeStatusFile>(join(batchDir, 'status', name));
    if (typeof status?.episodeId === 'string') statuses.set(status.episodeId, status);
  }

  const attemptDir = join(batchDir, 'attempts');
  const begins = new Map<string, { file: string; begin: RawAttemptBegin }>();
  const finishes = new Map<string, RawAttemptFinish>();
  let blocked = 0;
  for (const name of jsonFilesIn(attemptDir)) {
    if (name.endsWith('.begin.json')) {
      const begin = readJson<RawAttemptBegin>(join(attemptDir, name));
      const id = begin?.attemptId;
      if (typeof id !== 'string') {
        issues.push(`attempt begin ${name} carries no attemptId`);
        continue;
      }
      if (begins.has(id)) issues.push(`duplicate attempt begin for ${id}`);
      begins.set(id, { file: name, begin });
    } else if (name.endsWith('.finish.json')) {
      const finish = readJson<RawAttemptFinish>(join(attemptDir, name));
      const id = finish?.attemptId;
      if (typeof id !== 'string') {
        issues.push(`attempt finish ${name} carries no attemptId`);
        continue;
      }
      if (finishes.has(id)) issues.push(`duplicate attempt finish for ${id}`);
      finishes.set(id, finish);
    } else if (name.startsWith('blocked-')) {
      blocked += 1;
    }
  }

  /* --- 1:1 linkage ------------------------------------------------ */
  for (const attemptId of finishes.keys()) {
    if (!begins.has(attemptId)) issues.push(`attempt finish ${attemptId} has no matching begin (orphan)`);
  }
  let unresolved = 0;
  for (const [attemptId] of begins) {
    if (!finishes.has(attemptId)) unresolved += 1;
  }
  if (begins.size > limit) {
    issues.push(`the ledger holds ${begins.size} chat requests, over the frozen budget ${limit}`);
  }
  const chatRequests = begins.size;

  /* --- per-episode costs ------------------------------------------ */
  const perEpisode: LedgerEpisodeCost[] = [];
  const byId = new Map<string, LedgerEpisodeCost>();
  for (const entry of planned) {
    const id = String(entry.episodeId);
    const record = episodes.get(id) ?? null;
    const status = statuses.get(id) ?? null;
    const actionSet = (entry.actionSet === 'timed_wait' ? 'timed_wait' : 'legacy');
    const arm = (entry.arm === 'on' ? 'on' : 'off');
    if (record === null) {
      const outcome = status?.outcome ?? 'not_run';
      if (status !== null && status.status !== 'not_run') {
        issues.push(`${id}: the status file says ${status.status} but no episode record was written`);
      }
      const cost: LedgerEpisodeCost = {
        episodeId: id, actionSet, arm, outcome,
        requests: 0, begins: 0, finishes: 0, totalTokens: null, usageUnknown: false, latencyMs: null,
      };
      perEpisode.push(cost);
      byId.set(id, cost);
      continue;
    }

    const http = Array.isArray(record.http) ? record.http : [];
    const tokenValues = http.map(exchange => responseTokens(exchange?.response?.raw));

    const attemptIds = (Array.isArray(record.attempts) ? record.attempts : [])
      .map(attempt => attempt?.attemptId)
      .filter((value): value is string => typeof value === 'string');
    const episodeFinishes = attemptIds.map(attemptId => finishes.get(attemptId) ?? null);
    const finishStates = episodeFinishes.filter((finish): finish is RawAttemptFinish => finish !== null);
    // A begin without a finish spent its chat call but its outcome is unknown:
    // charge the begin conservatively and keep the usage explicitly unknown.
    const anyUnresolved = finishStates.length !== attemptIds.length;
    const usageUnknown = anyUnresolved || tokenValues.some(value => value === null);
    const totalTokens = anyUnresolved ? null : (tokenValues.length === 0 ? 0 : sumOrUnknown(tokenValues));
    // The record must name exactly the begins the ledger holds for it.
    for (const attemptId of attemptIds) {
      if (!begins.has(attemptId)) issues.push(`${id}: the episode record names attempt ${attemptId}, the ledger has no begin for it`);
      const begin = begins.get(attemptId)?.begin;
      if (begin !== undefined && begin.episodeId !== id) {
        issues.push(`${id}: attempt ${attemptId} belongs to episode ${JSON.stringify(begin.episodeId)} in the ledger`);
      }
    }
    for (const [attemptId, entry] of begins) {
      if (entry.begin.episodeId === id && !attemptIds.includes(attemptId)) {
        issues.push(`${id}: the ledger has attempt ${attemptId} for this episode but the episode record does not name it`);
      }
    }
    const latencies = episodeFinishes.map(finish => (finish !== null && typeof finish.elapsedMs === 'number' ? finish.elapsedMs : null));
    const latencyMs = latencies.length === 0 ? null : sumOrUnknown(latencies);
    // A finished attempt's own usage must agree with the raw response body.
    for (const finish of episodeFinishes) {
      if (finish === null) continue;
      const finishedTokens = typeof finish.usage?.total_tokens === 'number' ? finish.usage.total_tokens : null;
      const fromRaw = tokenValues.length === 1 ? tokenValues[0]! : null;
      if (finishedTokens !== null && fromRaw !== null && finishedTokens !== fromRaw) {
        issues.push(`${id}: the attempt finish usage ${finishedTokens} disagrees with the raw response ${fromRaw}`);
      }
    }
    if (http.length !== attemptIds.length) {
      issues.push(`${id}: the record holds ${http.length} HTTP exchange(s) but ${attemptIds.length} attempt(s)`);
    }
    if (record.outcome === 'completed' && finishStates.some(finish => finish.outcome !== 'success')) {
      issues.push(`${id}: a completed episode holds an attempt that did not succeed`);
    }
    if (record.outcome === 'completed' && finishStates.length !== attemptIds.length) {
      issues.push(`${id}: a completed episode holds an attempt without a finish record`);
    }

    const cost: LedgerEpisodeCost = {
      episodeId: id, actionSet, arm,
      outcome: typeof record.outcome === 'string' ? record.outcome : 'unknown',
      requests: http.length,
      begins: attemptIds.length,
      finishes: finishStates.length,
      totalTokens,
      usageUnknown,
      latencyMs,
    };
    perEpisode.push(cost);
    byId.set(id, cost);
  }

  /* --- orphan ledger entries -------------------------------------- */
  const plannedIds = new Set(planned.map(entry => String(entry.episodeId)));
  for (const [, entry] of begins) {
    if (typeof entry.begin.episodeId === 'string' && !plannedIds.has(entry.begin.episodeId)) {
      issues.push(`attempt ${String(entry.begin.attemptId)} belongs to unknown episode ${entry.begin.episodeId}`);
    }
  }

  /* --- counts ------------------------------------------------------ */
  const completed = perEpisode.filter(cost => cost.outcome === 'completed').length;
  const notRun = perEpisode.filter(cost => cost.outcome === 'not_run').length;
  const failed = perEpisode.length - completed - notRun;
  // Every begin is one spent chat call. An attempt that began but never
  // finished still consumed the call, so spent charges begins (conservative)
  // and finishes only ever mean completion.
  const spent = perEpisode.reduce((sum, cost) => sum + cost.begins, 0);
  const counts: LedgerCounts = {
    planned: planned.length,
    completed,
    failed,
    notRun,
    chatRequests,
    spent,
    blocked,
    unresolved,
    usageUnknown: perEpisode.filter(cost => cost.usageUnknown).length,
  };
  if (completed > 0 && chatRequests < completed) {
    issues.push(`the ledger has ${chatRequests} chat request(s) for ${completed} completed episodes`);
  }
  if (unresolved > 0) {
    issues.push(`the ledger holds ${unresolved} attempt begin(s) without a finish record`);
  }

  /* --- four cells, both repetitions -------------------------------- */
  const cells: LedgerCellCost[] = CELLS.map(cell => {
    const members = perEpisode.filter(cost => cost.actionSet === cell.actionSet && cost.arm === cell.arm);
    const tokens = members.map(cost => cost.totalTokens);
    const latencies = members.map(cost => cost.latencyMs);
    return {
      cell: cell.cell,
      episodes: members.map(cost => cost.episodeId),
      requests: members.reduce((sum, cost) => sum + cost.requests, 0),
      totalTokens: tokens.some(value => value === null) ? null : tokens.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      usageUnknown: members.some(cost => cost.usageUnknown),
      latencyMs: latencies.some(value => value === null) ? null : latencies.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    };
  });
  const cellCompleteness = CELLS.map(cell => {
    const members = perEpisode.filter(cost => cost.actionSet === cell.actionSet && cost.arm === cell.arm);
    return members.length;
  });
  if (planned.length > 0 && cellCompleteness.some(count => count !== 2)) {
    issues.push(`the four cells do not each hold two repetitions: ${cellCompleteness.join('/')}`);
  }

  /* --- four message pairs ------------------------------------------ */
  const pairs: LedgerPairDelta[] = PAIRS.map(pair => {
    const off = byId.get(pair.off) ?? null;
    const on = byId.get(pair.on) ?? null;
    const offTokens = off?.totalTokens ?? null;
    const onTokens = on?.totalTokens ?? null;
    return {
      pair: pair.pair,
      offEpisode: off?.episodeId ?? null,
      onEpisode: on?.episodeId ?? null,
      offTokens,
      onTokens,
      delta: offTokens === null || onTokens === null ? null : onTokens - offTokens,
    };
  });

  /* --- whole-batch token sum -------------------------------------- */
  const knownTokenSum = perEpisode.reduce((sum, cost) => sum + (cost.totalTokens ?? 0), 0);

  /* --- what the summary must say ---------------------------------- */
  const expectation: Record<string, unknown> = {
    totals: { planned: counts.planned, completed, failed, notRun },
    chatRequests: counts.chatRequests,
    gateSpent: counts.spent,
    gateBlocked: counts.blocked,
    hardChatLimit: limit,
    tokens: perEpisode.map(cost => ({ episodeId: cost.episodeId, totalTokens: cost.totalTokens })),
    costs: {
      schema: 'frostecho.g08.eval.costs/1',
      counts,
      knownTokenSum,
      usageUnknown: counts.usageUnknown,
      episodes: perEpisode,
      cells,
      pairs,
    },
  };

  return { issues, counts, episodes: perEpisode, cells, pairs, knownTokenSum, expectation };
}

/** The timeout every layer must agree on (imported so B stays self-contained). */
export const LEDGER_TIMEOUT_MS = G07_TIMEOUT_MS;
