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
import { RULES, type Location } from '../src/types';
import type { ActionSet } from '../src/temporal/contracts';
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

export interface G08VerifyResult {
  ok: boolean;
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
 * Read-only cross-check of a finished G08 batch: plan order, per-episode
 * prompt axis (allowedActions / wait line / playerMessages), one chat request
 * per completed episode, timeout wiring at every layer, wait deadline = 1 at
 * simTime 0, template identity across all arms, and the frozen sampling.
 * Never re-runs the model and never rewrites evidence.
 */
export function verifyG08Batch(batchDir: string): G08VerifyResult {
  const issues: string[] = [];
  const configurationIssues: string[] = [];
  const planPath = join(batchDir, 'plan.json');
  const summaryPath = join(batchDir, 'summary.json');
  if (!existsSync(planPath)) {
    return {
      ok: false, issues: ['plan.json is missing'], configurationIssues,
      behaviorAndCostOk: false, configurationConsistent: false,
      stats: { planned: G08_PLAN.length, completed: 0, failed: 0, notRun: G08_PLAN.length, chatRequests: 0, mode: null, cells: [] },
    };
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

  const episodes = new Map<string, G08EpisodeRecord>();
  const episodeDir = join(batchDir, 'episodes');
  for (const name of jsonFilesIn(episodeDir)) {
    const record = readJson<G08EpisodeRecord>(join(episodeDir, name));
    episodes.set(record.plan.episodeId, record);
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
  for (const entry of G08_PLAN) {
    const record = episodes.get(entry.episodeId) ?? null;
    const status = statuses.get(entry.episodeId) ?? null;
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

    // Prompt evidence: the capability axis must be visible in the real request.
    const promptText = record.http[0]?.request.body.messages !== undefined
      ? String(((record.http[0].request.body.messages as { content?: string }[])[0]?.content) ?? '')
      : '';
    if (record.outcome === 'completed') {
      for (const issue of promptIssuesFor(entry, promptText === '' ? null : promptText)) {
        issues.push(`${entry.episodeId}: ${issue}`);
      }
      templates.add(stripG08PromptData(promptText));
      if (record.http.length !== 1) {
        issues.push(`${entry.episodeId}: expected exactly 1 chat request, found ${record.http.length}`);
      }
      const usage = /"total_tokens"\s*:\s*(\d+)/.exec(record.http[0]?.response.raw ?? '');
      if (usage === null) issues.push(`${entry.episodeId}: the response carries no token usage`);
      const decision = record.decision as G07Decision | null;
      if (decision === null || decision.providerCalls !== 1) {
        issues.push(`${entry.episodeId}: provider accounting does not show exactly 1 call`);
      }
      if (record.replayMatches !== true) {
        issues.push(`${entry.episodeId}: the engine replay does not match the recorded commands`);
      }
      if (record.behavior !== null) {
        const behavior = record.behavior;
        if (behavior.actionSet !== entry.actionSet) {
          issues.push(`${entry.episodeId}: behavior actionSet does not match the plan`);
        }
        if (behavior.wait.accepted && entry.actionSet !== 'timed_wait') {
          issues.push(`${entry.episodeId}: wait was accepted on the legacy axis`);
        }
        if (behavior.wait.accepted) {
          // The frozen start is simTime 0, so the deadline is exactly 1.
          if (behavior.wait.wakeAtSimTime !== 1) {
            issues.push(`${entry.episodeId}: wait deadline ${String(behavior.wait.wakeAtSimTime)} is not simTime 0 + 1`);
          }
        }
        cells.push({
          episodeId: entry.episodeId, actionSet: entry.actionSet, arm: entry.arm,
          outcome: record.outcome,
          npcAction: behavior.npcAction === null || typeof behavior.npcAction === 'string'
            ? behavior.npcAction
            : behavior.npcAction.type,
          npcAte: behavior.npcAte,
          playerAte: behavior.playerEatCommand?.status === 'accepted',
          waitAccepted: behavior.wait.accepted,
          wakeAtSimTime: behavior.wait.wakeAtSimTime,
          totalTokens: usage === null ? null : Number(usage[1]),
        });
        continue;
      }
    }
    cells.push({
      episodeId: entry.episodeId, actionSet: entry.actionSet, arm: entry.arm,
      outcome: record.outcome, npcAction: null, npcAte: null, playerAte: null,
      waitAccepted: false, wakeAtSimTime: null, totalTokens: null,
    });
  }

  if (templates.size > 1) {
    issues.push(`the ${templates.size} arms do not share one G08 template (after stripping the axis data lines)`);
  }

  if (summary !== null && summary.schema !== G08_SUMMARY_SCHEMA) {
    // The G08 summary reuses the G07 shape; a foreign schema is a finding, not a crash.
    configurationIssues.push(`summary schema ${String(summary.schema)} is not the expected ${G08_SUMMARY_SCHEMA}`);
  }

  const completed = cells.filter(c => c.outcome === 'completed').length;
  const failed = cells.filter(c => c.outcome !== 'completed' && c.outcome !== 'not_run').length;
  const notRun = cells.filter(c => c.outcome === 'not_run').length;
  const behaviorAndCostOk = issues.length === 0;
  const configurationConsistent = configurationIssues.length === 0;
  return {
    ok: behaviorAndCostOk && configurationConsistent,
    issues, configurationIssues, behaviorAndCostOk, configurationConsistent,
    stats: { planned: G08_PLAN.length, completed, failed, notRun, chatRequests, mode: summary?.mode ?? null, cells },
  };
}
