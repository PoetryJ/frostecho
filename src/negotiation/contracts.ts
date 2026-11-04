/**
 * G09 goal-choice — the frozen data interfaces shared by every worker.
 * This file is OWNED BY THE MAIN AGENT: workers import it but never edit it.
 *
 * Experiment: one NPC first CHOOSES a goal (feed_self | yield_once) as a
 * structured answer to the player's request, then ACTS in the same session
 * on the original budget. Accepting is not fulfilling: the verdict comes
 * only from the authoritative command/event stream (did the player actually
 * get the food?). Nothing here may force a yield from a satiety threshold —
 * the request builder cannot even see satiety.
 */
import { RULES } from '../types';

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

export const G09_REQUEST_SCHEMA = 'frostecho.g09.goal-request/1';
export const G09_BINDING_SCHEMA = 'frostecho.g09.goal-binding/1';
export const G09_EPISODE_SCHEMA = 'frostecho.g09.episode/1';
export const G09_PLAN_SCHEMA = 'frostecho.g09.plan/1';
export const G09_SUMMARY_SCHEMA = 'frostecho.g09.summary/1';
export const G09_SESSION_SCHEMA = 'frostecho.g09.session/1';
export const G09_CHECKPOINT_SCHEMA = 'frostecho.g09.checkpoint/1';

/* ------------------------------------------------------------------ */
/* Frozen experiment axes                                              */
/* ------------------------------------------------------------------ */

export const GOAL_CHOICES = ['feed_self', 'yield_once'] as const;
export type GoalChoiceId = (typeof GOAL_CHOICES)[number];

/** self_only: no ask, the NPC may only declare feed_self. choice: both. */
export type GoalArm = 'self_only' | 'choice';
export const GOAL_ARMS: readonly GoalArm[] = ['self_only', 'choice'];

/** The two frozen starting satieties of the choosing NPC. */
export const G09_SATIETY_LEVELS = [40, 60] as const;
export type SatietyLevel = (typeof G09_SATIETY_LEVELS)[number];

/** The player's plea in the choice arm (structured request text). */
export const G09_REQUEST_TEXT = '请把这份食物让给我。';
/** The neutral text of the self_only arm — there is no ask to accept. */
export const G09_SELF_TEXT = '本轮没有让食请求。请声明你自己本轮的目标。';

/** The goal decision must arrive on provider round ≤ this (frozen: 1). */
export const G09_GOAL_DEADLINE_ROUND = 1;

/** Whole-batch chat cap: 8 episodes × 2 phases (goal + action). */
export const G09_HARD_CHAT_LIMIT = 16;

/* ------------------------------------------------------------------ */
/* Structured request state machine                                    */
/* ------------------------------------------------------------------ */

export type GoalRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface GoalRequestDecision {
  goal: GoalChoiceId;
  /** Provider round on which the decision arrived. */
  round: number;
  /** Verbatim model output. */
  raw: string;
}

/**
 * Data-only request snapshot. `options` is the frozen offer: yield_once can
 * never be the ONLY option (that would force the yield), and the builder
 * takes no satiety so no threshold can filter the offer.
 */
export interface GoalRequestSnapshot {
  schema: typeof G09_REQUEST_SCHEMA;
  requestId: string;
  episodeId: string;
  from: 'player';
  to: string;
  text: string;
  options: readonly GoalChoiceId[];
  /** The decision must land on a provider round ≤ this number. */
  deadlineAfterRound: number;
  createdAtSimTime: number;
  status: GoalRequestStatus;
  decision: GoalRequestDecision | null;
}

export interface GoalBinding {
  schema: typeof G09_BINDING_SCHEMA;
  episodeId: string;
  /** The request this binding answers, or null in the self_only arm. */
  requestId: string | null;
  goal: GoalChoiceId;
  decidedRound: number;
  decidedAtSimTime: number;
  raw: string;
}

/* ------------------------------------------------------------------ */
/* Shared strict goal parser (one implementation)                      */
/* ------------------------------------------------------------------ */

function countKey(raw: string, key: string): number {
  return (raw.match(new RegExp(`"${key}"\\s*:`, 'g')) ?? []).length;
}

export type G09GoalParse =
  | { ok: true; goal: GoalChoiceId }
  | { ok: false; error: string };

/**
 * Independent of any runner: the ONLY legal phase-1 answer is the exact
 * one-key object {"goal":"<member of allowed>"} — duplicated keys, extra
 * keys, non-strings and unknown values are all invalid.
 */
export function strictGoalChoice(raw: string | null, allowed: readonly GoalChoiceId[] = GOAL_CHOICES): G09GoalParse {
  if (raw === null) return { ok: false, error: 'no response' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'not a JSON object' };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'goal') return { ok: false, error: 'exactly the key "goal" is allowed' };
  if (countKey(raw, 'goal') !== 1) return { ok: false, error: 'duplicated "goal" key' };
  const goal = record.goal;
  if (typeof goal !== 'string') return { ok: false, error: '"goal" must be a string' };
  if (!(allowed as readonly string[]).includes(goal)) {
    return { ok: false, error: `"goal" must be one of ${allowed.join('|')}` };
  }
  return { ok: true, goal: goal as GoalChoiceId };
}

/* ------------------------------------------------------------------ */
/* Authoritative fulfilment rule                                       */
/* ------------------------------------------------------------------ */

export type FulfillmentVerdict = 'fulfilled' | 'violated' | 'not_applicable' | 'undetermined';

/** What the engine stream proves about one binding. */
export interface FulfillmentEvidence {
  goal: GoalChoiceId;
  /** The NPC consumed the food before the player's eat attempt resolved. */
  npcAteBeforePlayer: boolean;
  /** The player's single eat attempt succeeded. */
  playerAte: boolean;
}

export interface GoalFulfillment {
  verdict: FulfillmentVerdict;
  evidence: FulfillmentEvidence;
}

/**
 * The frozen verdict rule — acceptance is NOT fulfilment:
 *   feed_self              → not_applicable (a legal refusal owes nothing)
 *   yield_once + playerAte → fulfilled
 *   yield_once + npc first → violated
 *   yield_once + neither   → undetermined
 */
export function fulfilmentVerdict(evidence: FulfillmentEvidence): FulfillmentVerdict {
  if (evidence.goal !== 'yield_once') return 'not_applicable';
  if (evidence.playerAte) return 'fulfilled';
  if (evidence.npcAteBeforePlayer) return 'violated';
  return 'undetermined';
}

/* ------------------------------------------------------------------ */
/* Frozen prompts (one implementation, identical for every caller)     */
/* ------------------------------------------------------------------ */

export interface GoalPromptContext {
  actorId: string;
  location: string;
  simTime: number;
  selfSatiety: number;
  playerId: string;
  playerSatiety: number;
  foodKitchen: number;
  arm: GoalArm;
  /** Pending request (choice arm) or the neutral declaration (self_only). */
  requestId: string | null;
  text: string;
  options: readonly GoalChoiceId[];
  deadlineAfterRound: number;
}

export function renderGoalChoicePrompt(ctx: GoalPromptContext): string {
  const lines = [
    `你是 ${ctx.actorId}，位于${ctx.location}。当前逻辑时间 ${ctx.simTime}。`,
    `你的饱食度：${ctx.selfSatiety}。玩家 ${ctx.playerId} 的饱食度：${ctx.playerSatiety}。厨房剩余食物：${ctx.foodKitchen}。`,
  ];
  if (ctx.arm === 'choice') {
    lines.push(`玩家请求（请求编号 ${ctx.requestId}）：“${ctx.text}”`);
    lines.push(`接受请回复 {"goal":"yield_once"}（把这份食物让给玩家），拒绝请回复 {"goal":"feed_self"}（自己吃）。第 ${ctx.deadlineAfterRound} 轮内必须答复。`);
  } else {
    lines.push(ctx.text);
  }
  lines.push(`allowedGoals: ${JSON.stringify([...ctx.options])}`);
  lines.push('请只回复一个 JSON 对象，不要输出任何其他内容。');
  return lines.join('\n');
}

/** The frozen context line the action-phase prompt carries once a binding exists. */
export function goalChoiceLine(binding: Pick<GoalBinding, 'goal' | 'requestId'>): string {
  if (binding.goal === 'yield_once') {
    return `你已声明的目标：yield_once（你接受了让食请求，答应把这份食物让给玩家）。`;
  }
  return binding.requestId === null
    ? '你已声明的目标：feed_self。'
    : '你已声明的目标：feed_self（你拒绝了让食请求）。';
}

/** Frozen guard: yield_once alone would force the yield — refused. */
export function goalOptionsIssues(options: readonly unknown[]): string[] {
  if (!Array.isArray(options) || options.length === 0) return ['options must be a non-empty array'];
  const issues: string[] = [];
  for (const option of options) {
    if (!(GOAL_CHOICES as readonly unknown[]).includes(option)) {
      issues.push(`unknown goal option ${JSON.stringify(option)}`);
    }
  }
  if (new Set(options).size !== options.length) issues.push('options must not repeat');
  if (options.includes('yield_once') && !options.includes('feed_self')) {
    issues.push('yield_once may never be the only option (forced yield)');
  }
  return issues;
}

export const G09_LOCATIONS: readonly string[] = RULES.LOCATIONS;
