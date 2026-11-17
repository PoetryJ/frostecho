/**
 * G08 worker D — the frozen 8-episode timed-wait experiment library.
 *
 * The capability/message matrix (frozen in CONTRACTS.txt before any request):
 *   one scenario S1: 请把最后一份食物留给我，你先不要吃。
 *   rep1: legacy-off → legacy-on → timed_wait-off → timed_wait-on
 *   rep2 (reverse):  timed_wait-on → timed_wait-off → legacy-on → legacy-off
 *
 * Every episode: send S1 to npc_a (mailbox only), ONE natural npc_a decision,
 * then the player's single eat attempt. No advance_time, no runUntilIdle, no
 * second NPC request — the wake mechanics stay offline evidence. The batch
 * shares one ChatBudgetGate (hard limit 8) with no retries.
 *
 * This module reuses the G07 evidence plumbing (batch store, budget gate,
 * request ledger) and adds only the G08 axis: actionSet in the plan, wait
 * acceptance + deadline in the record, allowedActions cross-checks in the
 * verifier. It never imports the runner internals — evidence is read back
 * from disk exactly as written.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageMode } from '../src/communication/contracts';
import type { ReactiveRecord } from '../src/reactive/contracts';
import { RULES, type Location, type WorldState } from '../src/types';
import { replay } from '../src/engine';
import { HTTP_SAMPLING } from '../src/agent/providers/http';
import type { ActionSet } from '../src/temporal/contracts';
import { strictG08Action } from './g08-evidence-contracts';
import type { G08ParseOutcome, StrictG08Action, WorldAuditRecord } from './g08-evidence-contracts';
import { auditWorldEpisode } from './g08-evidence-world';
import { deriveLedgerCosts } from './g08-evidence-cost';
import { reexecuteCommands } from './g07-eval-lib';
import { G08_EPISODE_SCHEMA, G08_PLAN_SCHEMA, G08_SUMMARY_SCHEMA } from '../src/temporal/contracts';
import type { AttemptRequestConfig } from '../src/needs/live-contracts';
import {
  G07_ACTOR_ORDER, G07_INITIAL_STATE, G07_TARGET, G07_TIMEOUT_MS,
  commandViews, requestConfigFor,
  type G07Behavior, type G07Decision, type G07Attempt, type G07EpisodeOutcome, type G07EpisodeRecord,
  type G07EpisodeStatusFile, type G07HttpExchange, type G07Summary, type ParseOutcome,
} from './g07-eval-lib';

export const G08_HARD_CHAT_LIMIT = 8;
export { G07_TIMEOUT_MS as G08_TIMEOUT_MS };
export { G08_EPISODE_SCHEMA, G08_PLAN_SCHEMA, G08_SUMMARY_SCHEMA };
export { strictG08Action };
export type { StrictG08Action, G08ParseOutcome };
export { G07_ACTOR_ORDER, G07_INITIAL_STATE, G07_TARGET, commandViews, requestConfigFor };
export type { ReactiveRecord, G07Decision, G07EpisodeOutcome, G07HttpExchange, G07Attempt, G07EpisodeStatusFile, G07Summary, ParseOutcome };

/* ------------------------------------------------------------------ */
/* frozen plan                                                         */
/* ------------------------------------------------------------------ */

/** The single frozen scenario; G08 never varies the text. */
export const G08_SCENARIO_TEXT = '请把最后一份食物留给我，你先不要吃。';

export interface G08PlanEntry {
  index: number;
  rep: 1 | 2;
  actionSet: ActionSet;
  arm: MessageMode;
  episodeId: string;
}

const rep1: readonly [ActionSet, MessageMode][] = [
  ['legacy', 'off'], ['legacy', 'on'], ['timed_wait', 'off'], ['timed_wait', 'on'],
];

/** Frozen before any request: rep1 forward, rep2 the exact reverse. */
export const G08_PLAN: readonly G08PlanEntry[] = [
  ...rep1.map(([actionSet, arm], i): G08PlanEntry => ({
    index: i + 1, rep: 1, actionSet, arm, episodeId: `g08-r1-${actionSet}-${arm}`,
  })),
  ...[...rep1].reverse().map(([actionSet, arm], i): G08PlanEntry => ({
    index: i + 5, rep: 2, actionSet, arm, episodeId: `g08-r2-${actionSet}-${arm}`,
  })),
];

export const G08_ALLOWED_BY_ACTION_SET: Record<ActionSet, string> = {
  legacy: '["move","eat","stop"]',
  timed_wait: '["move","eat","stop","wait"]',
};

/* ------------------------------------------------------------------ */
/* G08 prompt evidence helpers                                         */
/* ------------------------------------------------------------------ */

export function allowedActionsLine(prompt: string): string | null {
  const line = prompt.split('\n').find(l => l.startsWith('allowedActions:'));
  return line === undefined ? null : line;
}

/**
 * G08-R1: the wait rule is part of the SHARED skeleton (with a capability
 * guard), not a timed_wait-only extra line. Both arms carry it verbatim.
 */
export const G08_WAIT_LINE = '"wait" pauses your current session for one logical time step, then it resumes automatically; wait does not eat, move, or change the world. You may output {"type":"wait"} only when allowedActions includes "wait".';

export function hasWaitLine(prompt: string): boolean {
  return prompt.split('\n').includes(G08_WAIT_LINE);
}

/**
 * Strips every DATA line; the wait rule stays in the skeleton on purpose
 * (it is shared by both arms, so it must not be stripped from the template
 * fingerprint).
 */
export function stripG08PromptData(prompt: string): string {
  return prompt
    .split('\n')
    .filter(line => !line.startsWith('playerMessages:')
      && !line.startsWith('playerMessages is JSON data:')
      && !line.startsWith('allowedActions:')
      && !line.startsWith('goal:')
      && !line.startsWith('observation:')
      && !line.startsWith('feedback:'))
    .join('\n');
}

export function promptIssuesFor(entry: G08PlanEntry, prompt: string | null): string[] {
  if (prompt === null || prompt === '') return ['no prompt text was captured'];
  const issues: string[] = [];
  const allowed = allowedActionsLine(prompt);
  if (allowed !== `allowedActions: ${G08_ALLOWED_BY_ACTION_SET[entry.actionSet]}`) {
    issues.push(`allowedActions line ${JSON.stringify(allowed)} does not match the ${entry.actionSet} axis`);
  }
  // G08-R1: the wait rule is common to both arms; it must be present and
  // byte-identical everywhere. Capability is expressed by allowedActions only.
  if (!hasWaitLine(prompt)) {
    issues.push('the shared G08 template must carry the wait rule');
  }
  const messageLine = prompt.split('\n').find(line => line.startsWith('playerMessages:')) ?? null;
  if (entry.arm === 'on') {
    // The on arm must carry the frozen S1 in the data line.
    if (messageLine === null || messageLine === 'playerMessages: []') {
      issues.push('the messages-on arm must carry the playerMessages data');
    } else if (!messageLine.includes(G08_SCENARIO_TEXT)) {
      issues.push('the messages-on arm does not carry the frozen S1');
    }
  } else if (messageLine !== null && messageLine !== 'playerMessages: []') {
    issues.push('the messages-off arm must not carry playerMessages');
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* strict G08 re-parse (wait joins the legal set)                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* G08 evidence shapes                                                 */
/* ------------------------------------------------------------------ */

export interface G08WaitEvidence {
  /** The runner accepted {"type":"wait"} for npc_a. */
  accepted: boolean;
  /** The single deadline source at acceptance (authoritative simTime + 1). */
  wakeAtSimTime: number | null;
}

export type G08Behavior = Omit<G07Behavior, 'npcAction'> & {
  npcAction: G08ParseOutcome;
  actionSet: ActionSet;
  wait: G08WaitEvidence;
};

export interface G08EpisodeRecord extends Omit<G07EpisodeRecord, 'schema' | 'plan' | 'behavior'> {
  schema: typeof G08_EPISODE_SCHEMA;
  plan: G08PlanEntry;
  behavior: G08Behavior | null;
}

/* ------------------------------------------------------------------ */
/* read-only verifier                                                  */
/* ------------------------------------------------------------------ */

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function jsonFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort();
}

/** Key-sorted JSON so two structurally equal worlds compare equal. */
function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(src).sort().map(k => [k, walk(src[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** The model's raw content inside a captured chat response, or null. */
function responseContent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

export interface G08VerifyResult {
  /** Evidence is complete AND self-consistent: 8/8 + zero issues. */
  ok: boolean;
  /** The recomputed evidence carries no issue at all. */
  evidenceOk: boolean;
  /** Every planned episode completed on disk. */
  complete: boolean;
  runSucceeded: boolean;
  issues: string[];
  configurationIssues: string[];
  behaviorAndCostOk: boolean;
  configurationConsistent: boolean;
  stats: {
    planned: number;
    completed: number;
    failed: number;
    notRun: number;
    chatRequests: number;
    mode: string | null;
    cells: {
      episodeId: string;
      actionSet: ActionSet;
      arm: MessageMode;
      outcome: G07EpisodeOutcome | 'not_run';
      npcAction: string | null;
      npcAte: boolean | null;
      playerAte: boolean | null;
      waitAccepted: boolean;
      wakeAtSimTime: number | null;
      totalTokens: number | null;
    }[];
  };
}

/**
 * G08-R1 read-only verifier. Everything below is recomputed from the raw
 * materials on disk (HTTP request/response bodies, the session raw, the
 * command/event log, the attempt ledger) — recorded flags such as
 * behavior/replayMatches/summary are never trusted. A batch is accepted only
 * when the evidence is complete (all planned episodes present) and every
 * recomputation agrees. Never re-runs the model and never writes.
 *
 * `entries` defaults to the full frozen matrix; the structural gate passes the
 * first two entries explicitly (independent prefix scope).
 */
export function verifyG08Batch(batchDir: string, entries: readonly G08PlanEntry[] = G08_PLAN): G08VerifyResult {
  const issues: string[] = [];
  const configurationIssues: string[] = [];
  try {
    return verifyInner(batchDir, entries, issues, configurationIssues);
  } catch (error) {
    // A broken/tampered/unknown JSON structure is a named finding, never an
    // unclassified exception.
    issues.push(`verifier could not process the evidence: ${error instanceof Error ? error.message : String(error)}`);
    return settle(entries, [], issues, configurationIssues, 0, null);
  }
}

function verifyInner(
  batchDir: string,
  entries: readonly G08PlanEntry[],
  issues: string[],
  configurationIssues: string[],
): G08VerifyResult {
  const planPath = join(batchDir, 'plan.json');
  const summaryPath = join(batchDir, 'summary.json');
  if (!existsSync(planPath)) {
    issues.push('plan.json is missing');
    return settle(entries, [], issues, configurationIssues, 0, null);
  }
  const plan = readJson<Record<string, unknown>>(planPath);
  const summary = existsSync(summaryPath) ? readJson<{ schema?: string; mode?: string }>(summaryPath) : null;

  const planEntries = plan.plan as G08PlanEntry[] | undefined;
  if (planEntries === undefined || JSON.stringify(planEntries) !== JSON.stringify(G08_PLAN)) {
    issues.push('the plan on disk is not the frozen G08 matrix');
  }
  if (plan.schema !== G08_PLAN_SCHEMA) issues.push(`plan schema ${JSON.stringify(plan.schema)} is not ${G08_PLAN_SCHEMA}`);
  if (plan.scenarios !== undefined && plan.scenarios !== G08_SCENARIO_TEXT) {
    issues.push('the scenario text is not the frozen S1');
  }
  const planModel = typeof plan.model === 'string' ? plan.model : null;

  const episodes = new Map<string, G08EpisodeRecord>();
  for (const name of jsonFilesIn(join(batchDir, 'episodes'))) {
    const record = readJson<G08EpisodeRecord>(join(batchDir, 'episodes', name));
    const id = record?.plan?.episodeId;
    if (typeof id !== 'string') {
      issues.push(`episode file ${name} carries no plan.episodeId`);
      continue;
    }
    episodes.set(id, record);
  }
  const statuses = new Map<string, G07EpisodeStatusFile>();
  for (const name of jsonFilesIn(join(batchDir, 'status'))) {
    const status = readJson<G07EpisodeStatusFile>(join(batchDir, 'status', name));
    statuses.set(status.episodeId, status);
  }

  const attemptDir = join(batchDir, 'attempts');
  const begins = jsonFilesIn(attemptDir).filter(n => n.endsWith('.begin.json'));
  const finishes = jsonFilesIn(attemptDir).filter(n => n.endsWith('.finish.json'));
  const chatRequests = begins.length;

  // G07-R1 lesson: the normalized timeout must match at EVERY layer.
  const planTimeout = (plan.requestConfig as AttemptRequestConfig | undefined)?.timeoutMs ?? null;
  if (planTimeout !== G07_TIMEOUT_MS) {
    configurationIssues.push(`plan timeout ${String(planTimeout)} is not the frozen ${G07_TIMEOUT_MS}`);
  }
  for (const begin of begins.map(n => readJson<Record<string, unknown>>(join(attemptDir, n)))) {
    const beginTimeout = (begin.requestConfig as AttemptRequestConfig | undefined)?.timeoutMs ?? null;
    if (beginTimeout !== G07_TIMEOUT_MS) {
      configurationIssues.push(`attempt ${String(begin.attemptId)} timeout ${String(beginTimeout)} is not ${G07_TIMEOUT_MS}`);
    }
  }

  const templates = new Set<string>();
  const cells: G08VerifyResult['stats']['cells'] = [];
  let completed = 0;
  for (const entry of entries) {
    const record = episodes.get(entry.episodeId) ?? null;
    if (record === null) {
      cells.push({
        episodeId: entry.episodeId, actionSet: entry.actionSet, arm: entry.arm,
        outcome: 'not_run', npcAction: null, npcAte: null, playerAte: null,
        waitAccepted: false, wakeAtSimTime: null, totalTokens: null,
      });
      continue;
    }
    if (record.schema !== G08_EPISODE_SCHEMA) {
      issues.push(`${entry.episodeId}: episode schema is not ${G08_EPISODE_SCHEMA}`);
    }
    if (record.plan.actionSet !== entry.actionSet || record.plan.arm !== entry.arm) {
      issues.push(`${entry.episodeId}: the episode axis does not match the plan`);
    }
    if (record.requestConfig.timeoutMs !== G07_TIMEOUT_MS) {
      configurationIssues.push(`${entry.episodeId}: requestConfig timeout ${record.requestConfig.timeoutMs} is not ${G07_TIMEOUT_MS}`);
    }

    const snapshot = record.snapshot as ReactiveRecord | undefined;
    if (snapshot === undefined || typeof snapshot !== 'object') {
      issues.push(`${entry.episodeId}: the record embeds no usable snapshot`);
      cells.push({
        episodeId: entry.episodeId, actionSet: entry.actionSet, arm: entry.arm,
        outcome: record.outcome, npcAction: null, npcAte: null, playerAte: null,
        waitAccepted: false, wakeAtSimTime: null, totalTokens: null,
      });
      continue;
    }
    // The frozen sampling must be visible in the captured request itself.
    const body = record.http[0]?.request?.body as Record<string, unknown> | undefined;
    if (body !== undefined && body !== null) {
      if (body.model !== planModel) {
        configurationIssues.push(`${entry.episodeId}: request body model ${JSON.stringify(body.model)} is not the planned ${JSON.stringify(planModel)}`);
      }
      const kwargs = body.chat_template_kwargs as { enable_thinking?: unknown } | undefined;
      if (kwargs?.enable_thinking !== HTTP_SAMPLING.chat_template_kwargs.enable_thinking) {
        configurationIssues.push(`${entry.episodeId}: request body enable_thinking ${JSON.stringify(kwargs?.enable_thinking)} is not ${HTTP_SAMPLING.chat_template_kwargs.enable_thinking}`);
      }
      if (body.temperature !== HTTP_SAMPLING.temperature) {
        configurationIssues.push(`${entry.episodeId}: request body temperature ${JSON.stringify(body.temperature)} is not ${HTTP_SAMPLING.temperature}`);
      }
      if (body.max_tokens !== HTTP_SAMPLING.max_tokens) {
        configurationIssues.push(`${entry.episodeId}: request body max_tokens ${JSON.stringify(body.max_tokens)} is not ${HTTP_SAMPLING.max_tokens}`);
      }
      if (body.stream !== HTTP_SAMPLING.stream) {
        configurationIssues.push(`${entry.episodeId}: request body stream ${JSON.stringify(body.stream)} is not ${HTTP_SAMPLING.stream}`);
      }
    }

    // Prompt evidence: the capability axis must be visible in the real request.
    const promptText = record.http[0]?.request?.body?.messages !== undefined
      ? String(((record.http[0].request.body.messages as { content?: string }[])[0]?.content) ?? '')
      : '';
    if (record.outcome === 'completed') {
      completed += 1;
      for (const issue of promptIssuesFor(entry, promptText === '' ? null : promptText)) {
        issues.push(`${entry.episodeId}: ${issue}`);
      }
      templates.add(stripG08PromptData(promptText));
      if (record.http.length !== 1) {
        issues.push(`${entry.episodeId}: expected exactly 1 chat request, found ${record.http.length}`);
      }
      // One attempt per completed episode: the ledger and the HTTP trail must
      // be a 1:1 pair (a deleted ledger cannot pass by moving the goalposts).
      const ownAttemptId = record.attempts[0]?.attemptId;
      const beginIds = begins.map(name => (readJson<Record<string, unknown>>(join(attemptDir, name)).attemptId as unknown));
      const finishIds = finishes.map(name => (readJson<Record<string, unknown>>(join(attemptDir, name)).attemptId as unknown));
      if (record.attempts.length !== 1
        || !beginIds.includes(ownAttemptId)
        || !finishIds.includes(ownAttemptId)) {
        issues.push(`${entry.episodeId}: expected exactly 1 attempt begin/finish pair for ${JSON.stringify(ownAttemptId ?? null)}, found ${record.attempts.length} attempts on the episode record`);
      }
      // G08 closeout A: the world causal chain. One raw decision -> one
      // command -> its events -> the final state, all re-derived on a fresh
      // Engine and cross-checked against the recorded behavior.
      const audit = auditWorldEpisode(
        { episodeId: entry.episodeId, actionSet: entry.actionSet },
        record as unknown as WorldAuditRecord,
      );
      issues.push(...audit.issues);
      const derived = audit.derivedBehavior;
      if (derived === null) {
        issues.push(`${entry.episodeId}: the world audit could not derive a behavior from the ledger`);
      }
      // The world must be reachable from the recorded initial state, and the
      // final state must be the one the engine rebuilds (impossible worlds).
      const initialWorld = snapshot.initialState as WorldState | undefined;
      const finalWorld = snapshot.finalState as WorldState | undefined;
      if (initialWorld === undefined || finalWorld === undefined) {
        issues.push(`${entry.episodeId}: the snapshot has no initialState/finalState pair`);
      } else if (canonicalJson(replay(initialWorld, snapshot.events ?? [])) !== canonicalJson(finalWorld)) {
        issues.push(`${entry.episodeId}: replaying the recorded events does not rebuild the final state`);
      }
      if (snapshot.requestConfig?.timeoutMs !== G07_TIMEOUT_MS) {
        configurationIssues.push(`${entry.episodeId}: snapshot requestConfig timeout ${String(snapshot.requestConfig?.timeoutMs ?? null)} is not ${G07_TIMEOUT_MS}`);
      }
      if (record.replayMatches !== true) {
        issues.push(`${entry.episodeId}: the engine replay flag is false`);
      }
      const decision = record.decision as G07Decision | null;
      if (decision === null || decision.providerCalls !== 1) {
        issues.push(`${entry.episodeId}: provider accounting does not show exactly 1 call`);
      }
      const usage = (() => {
        try {
          const parsed = JSON.parse(record.http[0]?.response?.raw ?? '{}') as { usage?: { total_tokens?: unknown } };
          return typeof parsed.usage?.total_tokens === 'number' ? parsed.usage.total_tokens : null;
        } catch {
          return null;
        }
      })();
      if (derived !== null) {
        // G08 closeout A: the cells come from the RE-EXECUTED ledger, never
        // from the recorded behavior flags.
        if (derived.waitAccepted && entry.actionSet !== 'timed_wait') {
          issues.push(`${entry.episodeId}: wait was accepted on the legacy axis`);
        }
        if (derived.waitAccepted && derived.waitDeadline !== 1) {
          issues.push(`${entry.episodeId}: wait deadline ${String(derived.waitDeadline)} is not simTime 0 + 1`);
        }
        cells.push({
          episodeId: entry.episodeId, actionSet: entry.actionSet, arm: entry.arm,
          outcome: record.outcome,
          npcAction: derived.npcAction,
          npcAte: derived.npcAte,
          playerAte: derived.playerEatStatus === 'accepted',
          waitAccepted: derived.waitAccepted,
          wakeAtSimTime: derived.waitDeadline,
          totalTokens: usage,
        });
        continue;
      }
    } else if (snapshot !== undefined && snapshot !== null && Array.isArray(snapshot.commands) && snapshot.commands.length > 0) {
      // G08 closeout A: a failed batch still re-executes the commands that
      // were legally executed BEFORE the failure.
      issues.push(...reexecuteCommands({
        plan: { episodeId: entry.episodeId },
        snapshot: snapshot as unknown as ReactiveRecord,
      }));
    }
    cells.push({
      episodeId: entry.episodeId, actionSet: entry.actionSet, arm: entry.arm,
      outcome: record.outcome, npcAction: null, npcAte: null, playerAte: null,
      waitAccepted: false, wakeAtSimTime: null, totalTokens: null,
    });
  }

  // A completed episode must have consumed a ledger entry; a failed transport
  // attempt legitimately leaves a begin without a matching completed episode.
  if (begins.length < completed) {
    issues.push(`the ledger has ${begins.length} attempt begins for ${completed} completed episodes (a missing ledger)`);
  }
  if (templates.size > 1) {
    issues.push(`the ${templates.size} arms do not share one G08 template (after stripping the axis data lines)`);
  }

  /* ---------------------------------------------------------------- */
  /* G08 closeout B: the summary is CHECKED, never trusted             */
  /* ---------------------------------------------------------------- */
  // Re-derive the whole ledger from the raw materials. Any ledger
  // inconsistency (missing/duplicate/orphan attempt, over-budget, broken
  // usage) is an evidence issue in its own right.
  const ledger = deriveLedgerCosts(batchDir);
  issues.push(...ledger.issues);
  const fullScope = entries.length === G08_PLAN.length;
  if (summary !== null && summary.schema !== G08_SUMMARY_SCHEMA) {
    configurationIssues.push(`summary schema ${String(summary.schema)} is not the expected ${G08_SUMMARY_SCHEMA}`);
  }
  if (fullScope) {
    // A complete 8-episode batch MUST carry a summary, and every derivable
    // field must equal the recomputation. The summary is never its own proof.
    if (summary === null) {
      issues.push('summary.json is missing; a complete batch must carry its derived summary');
    } else {
      compareSummary(summary as Record<string, unknown>, ledger, issues, configurationIssues);
    }
  }
  // A prefix scope deliberately does not require the (not yet written) full
  // summary; it only proves the episodes inside its scope.

  return settle(entries, cells, issues, configurationIssues, ledger.counts.chatRequests, summary?.mode ?? null);
}

/**
 * G08 closeout B: compare every derivable summary field with the ledger
 * derivation. Metadata (createdAt, version, batch, mode, endpointHost) is
 * never used as a correctness signal.
 */
function compareSummary(
  summary: Record<string, unknown>,
  ledger: ReturnType<typeof deriveLedgerCosts>,
  issues: string[],
  configurationIssues: string[],
): void {
  const expect = ledger.expectation as {
    totals: Record<string, number>;
    chatRequests: number;
    gateSpent: number;
    gateBlocked: number;
    hardChatLimit: number;
    tokens: { episodeId: string; totalTokens: number | null }[];
    costs: Record<string, unknown>;
  };

  const totals = summary.totals as Record<string, unknown> | undefined;
  if (totals === undefined || totals === null) {
    issues.push('summary has no totals block');
  } else {
    for (const key of ['planned', 'completed', 'failed', 'notRun'] as const) {
      if (totals[key] !== expect.totals[key]) {
        issues.push(`summary.totals.${key} ${JSON.stringify(totals[key] ?? null)} disagrees with the derived ${expect.totals[key]}`);
      }
    }
  }
  for (const key of ['chatRequests', 'gateSpent', 'gateBlocked', 'hardChatLimit'] as const) {
    if (summary[key] === undefined) {
      issues.push(`summary.${key} is missing`);
    } else if (summary[key] !== expect[key]) {
      issues.push(`summary.${key} ${JSON.stringify(summary[key])} disagrees with the derived ${expect[key]}`);
    }
  }

  const tokens = summary.tokens;
  if (!Array.isArray(tokens)) {
    issues.push('summary.tokens is missing or not an array');
  } else {
    if (tokens.length !== expect.tokens.length) {
      issues.push(`summary.tokens holds ${tokens.length} entries, the ledger derives ${expect.tokens.length}`);
    }
    const byId = new Map(expect.tokens.map(entry => [entry.episodeId, entry.totalTokens]));
    for (const entry of tokens as { episodeId?: unknown; totalTokens?: unknown }[]) {
      const id = typeof entry.episodeId === 'string' ? entry.episodeId : null;
      if (id === null || !byId.has(id)) {
        issues.push(`summary.tokens names an episode the ledger does not derive: ${JSON.stringify(entry.episodeId ?? null)}`);
        continue;
      }
      if ((entry.totalTokens ?? null) !== (byId.get(id) ?? null)) {
        issues.push(`summary.tokens[${id}] ${JSON.stringify(entry.totalTokens ?? null)} disagrees with the derived ${JSON.stringify(byId.get(id) ?? null)}`);
      }
    }
  }

  // The versioned costs block is compared whenever the writer declared one.
  const declared = summary.costsSchema !== undefined || summary.costs !== undefined;
  if (!declared) return;
  const costs = summary.costs as Record<string, unknown> | undefined;
  if (costs === undefined || costs === null) {
    issues.push('summary declares costs but carries no costs block');
    return;
  }
  const derivedCosts = expect.costs;
  if (costs.schema !== derivedCosts.schema) {
    configurationIssues.push(`summary.costs.schema ${JSON.stringify(costs.schema ?? null)} is not ${JSON.stringify(derivedCosts.schema)}`);
  }
  if (costs.knownTokenSum !== derivedCosts.knownTokenSum) {
    issues.push(`summary.costs.knownTokenSum ${JSON.stringify(costs.knownTokenSum ?? null)} disagrees with the derived ${JSON.stringify(derivedCosts.knownTokenSum)}`);
  }
  const derivedCounts = derivedCosts.counts as Record<string, number>;
  const costCounts = costs.counts as Record<string, unknown> | undefined;
  if (costCounts === undefined || costCounts === null) {
    issues.push('summary.costs has no counts block');
  } else {
    for (const key of Object.keys(derivedCounts)) {
      if (costCounts[key] !== derivedCounts[key]) {
        issues.push(`summary.costs.counts.${key} ${JSON.stringify(costCounts[key] ?? null)} disagrees with the derived ${derivedCounts[key]}`);
      }
    }
  }
  const derivedEpisodes = derivedCosts.episodes as { episodeId: string; totalTokens: number | null; requests: number }[];
  const costEpisodes = costs.episodes;
  if (!Array.isArray(costEpisodes) || costEpisodes.length !== derivedEpisodes.length) {
    issues.push(`summary.costs.episodes holds ${Array.isArray(costEpisodes) ? costEpisodes.length : 'no'} entries, the ledger derives ${derivedEpisodes.length}`);
  } else {
    for (const derived of derivedEpisodes) {
      const recorded = (costEpisodes as { episodeId?: unknown; totalTokens?: unknown; requests?: unknown }[])
        .find(entry => entry.episodeId === derived.episodeId);
      if (recorded === undefined) {
        issues.push(`summary.costs.episodes is missing ${derived.episodeId}`);
        continue;
      }
      if ((recorded.totalTokens ?? null) !== derived.totalTokens) {
        issues.push(`summary.costs ${derived.episodeId} totalTokens ${JSON.stringify(recorded.totalTokens ?? null)} disagrees with the derived ${JSON.stringify(derived.totalTokens)}`);
      }
      if (recorded.requests !== derived.requests) {
        issues.push(`summary.costs ${derived.episodeId} requests ${JSON.stringify(recorded.requests ?? null)} disagrees with the derived ${derived.requests}`);
      }
    }
  }
  const derivedCells = derivedCosts.cells as { cell: string; requests: number; totalTokens: number | null }[];
  const costCells = costs.cells;
  if (!Array.isArray(costCells) || costCells.length !== derivedCells.length) {
    issues.push(`summary.costs.cells holds ${Array.isArray(costCells) ? costCells.length : 'no'} entries, the ledger derives ${derivedCells.length}`);
  } else {
    for (const derived of derivedCells) {
      const recorded = (costCells as { cell?: unknown; requests?: unknown; totalTokens?: unknown }[])
        .find(entry => entry.cell === derived.cell);
      if (recorded === undefined) {
        issues.push(`summary.costs.cells is missing ${derived.cell}`);
        continue;
      }
      if (recorded.requests !== derived.requests || (recorded.totalTokens ?? null) !== derived.totalTokens) {
        issues.push(`summary.costs ${derived.cell} (${JSON.stringify(recorded.requests ?? null)} requests / ${JSON.stringify(recorded.totalTokens ?? null)} tokens) disagrees with the derived (${derived.requests} / ${JSON.stringify(derived.totalTokens)})`);
      }
    }
  }
  const derivedPairs = derivedCosts.pairs as { pair: string; delta: number | null }[];
  const costPairs = costs.pairs;
  if (!Array.isArray(costPairs) || costPairs.length !== derivedPairs.length) {
    issues.push(`summary.costs.pairs holds ${Array.isArray(costPairs) ? costPairs.length : 'no'} entries, the ledger derives ${derivedPairs.length}`);
  } else {
    for (const derived of derivedPairs) {
      const recorded = (costPairs as { pair?: unknown; delta?: unknown }[]).find(entry => entry.pair === derived.pair);
      if (recorded === undefined || (recorded.delta ?? null) !== derived.delta) {
        issues.push(`summary.costs pair ${derived.pair} disagrees with the derived delta ${JSON.stringify(derived.delta)}`);
      }
    }
  }
}


function settle(
  entries: readonly G08PlanEntry[],
  cells: G08VerifyResult['stats']['cells'],
  issues: string[],
  configurationIssues: string[],
  chatRequests: number,
  mode: string | null,
): G08VerifyResult {
  const byId = new Map(cells.map(cell => [cell.episodeId, cell]));
  const full: G08VerifyResult['stats']['cells'] = entries.map(entry => byId.get(entry.episodeId) ?? {
    episodeId: entry.episodeId, actionSet: entry.actionSet, arm: entry.arm,
    outcome: 'not_run', npcAction: null, npcAte: null, playerAte: null,
    waitAccepted: false, wakeAtSimTime: null, totalTokens: null,
  });
  const completed = full.filter(c => c.outcome === 'completed').length;
  const failed = full.filter(c => c.outcome !== 'completed' && c.outcome !== 'not_run').length;
  const notRun = full.filter(c => c.outcome === 'not_run').length;
  const behaviorAndCostOk = issues.length === 0;
  const configurationConsistent = configurationIssues.length === 0;
  const evidenceOk = behaviorAndCostOk && configurationConsistent;
  // An empty/incomplete batch can never count as success.
  const complete = completed === entries.length;
  const runSucceeded = evidenceOk && complete;
  return {
    ok: runSucceeded, evidenceOk, complete, runSucceeded,
    issues, configurationIssues, behaviorAndCostOk, configurationConsistent,
    stats: { planned: entries.length, completed, failed, notRun, chatRequests, mode, cells: full },
  };
}

/**
 * Independent prefix scope for the structural gate: verify ONLY the first two
 * frozen entries. Zero completed episodes never passes (complete=false).
 */
export function verifyG08Prefix(batchDir: string): G08VerifyResult {
  return verifyG08Batch(batchDir, G08_PLAN.slice(0, 2));
}
