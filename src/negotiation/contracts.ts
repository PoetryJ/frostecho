/**
 * G09-R1 goal-choice — the frozen contract shared by every worker.
 * OWNED BY THE MAIN AGENT: workers import it but never edit it.
 *
 * Corrected to the ORIGINAL contract (handoff/20261104-g09-goal-choice/
 * CONTRACTS.txt + this package's spec-lock.json):
 *   - the player's request is the same S1 in BOTH arms; only the candidate
 *     goals differ, so self_only is a control, never an autonomous refusal;
 *   - the deadline is ENGINE LOGICAL TIME (createdAtSimTime + 1), never a
 *     provider round;
 *   - fulfilment is judged from authoritative commands after the acceptance
 *     sequence and before the expiry: an NPC eat first is violated forever,
 *     a later player eat cannot repair it, and an old player eat cannot
 *     fulfil a new request;
 *   - the goal decision is NOT a world command, and no host identifier
 *     (request id, episode id, arm label) may enter the model input.
 */
export const G09_REQUEST_SCHEMA = 'frostecho.g09.goal-request/2';
export const G09_BINDING_SCHEMA = 'frostecho.g09.goal-binding/2';
/**
 * /3 (G10): goal.parseOk is the STRICT parse of the wire answer (a legal
 * feed_self is true without a binding); /2 records used `binding !== null`,
 * which is documented and still readable.
 */
export const G09_EPISODE_SCHEMA = 'frostecho.g09.episode/3';
/** The pre-G10 episode schema, still readable for legacy batches. */
export const G09_EPISODE_SCHEMA_V2 = 'frostecho.g09.episode/2';
export const G09_PLAN_SCHEMA = 'frostecho.g09.plan/2';
export const G09_SUMMARY_SCHEMA = 'frostecho.g09.summary/2';
export const G09_SESSION_SCHEMA = 'frostecho.g09.session/2';
/** G10 adds optional application metadata (goalMode/providerKind/fixtureId). */
export const G09_CHECKPOINT_SCHEMA = 'frostecho.g09.checkpoint/3';
export const G09_CHECKPOINT_SCHEMA_V2 = 'frostecho.g09.checkpoint/2';
export const G09_CAMPAIGN_SCHEMA = 'frostecho.g09.campaign/1';

/* ------------------------------------------------------------------ */
/* Frozen experiment axes                                              */
/* ------------------------------------------------------------------ */

export const GOAL_CHOICES = ['feed_self', 'yield_once'] as const;
export type GoalChoiceId = (typeof GOAL_CHOICES)[number];

/** self_only is the CONTROL arm: same request, only candidate goals differ. */
export type GoalArm = 'self_only' | 'choice';
export const GOAL_ARMS: readonly GoalArm[] = ['self_only', 'choice'];

export const G09_SATIETY_LEVELS = [40, 60] as const;
export type SatietyLevel = (typeof G09_SATIETY_LEVELS)[number];

/** The ORIGINAL frozen S1 — identical in both arms. */
export const G09_REQUEST_TEXT = '请把最后一份食物留给我，你先不要吃。';
export const S1_TEXT = G09_REQUEST_TEXT;

/** Candidate goals per arm (the ONLY variable between arms). */
export const G09_ALLOWED_GOALS: Readonly<Record<GoalArm, readonly GoalChoiceId[]>> = {
  self_only: ['feed_self'],
  choice: ['feed_self', 'yield_once'],
};

/** Whole-task chat cap: 8 episodes × 2 phases. */
export const G09_HARD_CHAT_LIMIT = 16;
/** The frozen client timeout of the experiment (package EXECUTION: 120000). */
export const G09_TIMEOUT_MS = 120_000;
/** goalMode is negotiated for both arms of the experiment. */
export const G09_GOAL_MODE = 'negotiated' as const;

/* ------------------------------------------------------------------ */
/* Structured request (logical-time deadlines, single terminal state)  */
/* ------------------------------------------------------------------ */

export type GoalRequestStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';

/** The authoritative outcome of an ACCEPTED request. Terminal and monotonic. */
export type GoalOutcome = 'fulfilled' | 'violated' | 'failed' | 'expired' | 'cancelled' | 'pending';

export interface GoalRequestDecision {
  goal: GoalChoiceId;
  /** Provider round that produced the answer (call accounting only). */
  round: number;
  /** Authoritative simTime at which the answer was received. */
  decidedAtSimTime: number;
  raw: string;
}

export interface GoalRequestSnapshot {
  schema: typeof G09_REQUEST_SCHEMA;
  requestId: string;
  episodeId: string;
  from: 'player';
  to: string;
  kind: 'yield_once';
  text: string;
  options: readonly GoalChoiceId[];
  /** Engine.simTime at creation. */
  createdAtSimTime: number;
  /** createdAtSimTime + 1. Acceptance never extends it. */
  expiresAtSimTime: number;
  status: GoalRequestStatus;
  decision: GoalRequestDecision | null;
  /** Commands at or before this seq are never evidence for this request. */
  acceptedAfterSeq: number | null;
  /** The highest authoritative command seq already turned into state. */
  lastProcessedSeq: number;
  /** Terminal fulfilment outcome (monotonic once set). */
  outcome: GoalOutcome;
  /** Why the request failed/expired/was cancelled. */
  outcomeReason: string | null;
}

export interface GoalBinding {
  schema: typeof G09_BINDING_SCHEMA;
  episodeId: string;
  requestId: string;
  goal: GoalChoiceId;
  /** Provider round of the decision (accounting only, never a deadline). */
  decidedRound: number;
  decidedAtSimTime: number;
  /** The request's original deadline, carried verbatim. */
  expiresAtSimTime: number;
  /** Command seq boundary at acceptance. */
  acceptedAfterSeq: number;
  raw: string;
}

/* ------------------------------------------------------------------ */
/* Shared strict goal parser (one implementation)                      */
/* ------------------------------------------------------------------ */

function countKey(raw: string, key: string): number {
  return (raw.match(new RegExp(`"${key}"\\s*:`, 'g')) ?? []).length;
}

export type G09GoalParse = { ok: true; goal: GoalChoiceId } | { ok: false; error: string };

/**
 * The ONLY legal phase-1 answer is the exact one-key object
 * {"goal":"<member of the candidates>"} — duplicated keys, extra keys,
 * wrappers and unknown values are all invalid with no repair/fallback.
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
  if (typeof record.goal !== 'string') return { ok: false, error: '"goal" must be a string' };
  if (!(allowed as readonly string[]).includes(record.goal)) {
    return { ok: false, error: `"goal" must be one of ${allowed.join('|')}` };
  }
  return { ok: true, goal: record.goal as GoalChoiceId };
}

/* ------------------------------------------------------------------ */
/* Authoritative fulfilment rule                                       */
/* ------------------------------------------------------------------ */

export type FulfillmentVerdict = 'fulfilled' | 'violated' | 'not_applicable' | 'undetermined';

export interface FulfillmentEvidence {
  goal: GoalChoiceId;
  /** The NPC consumed the food before the player's attempt resolved. */
  npcAteBeforePlayer: boolean;
  /** The player's eat attempt succeeded. */
  playerAte: boolean;
}

export interface GoalFulfillment {
  verdict: FulfillmentVerdict;
  evidence: FulfillmentEvidence;
}

/**
 * Frozen rule. An NPC eat first is a breach the moment it happens: a later
 * player eat can never repair it. Acceptance without any outcome is
 * undetermined, never fulfilled.
 */
export function fulfilmentVerdict(evidence: FulfillmentEvidence): FulfillmentVerdict {
  if (evidence.goal !== 'yield_once') return 'not_applicable';
  if (evidence.npcAteBeforePlayer) return 'violated';
  if (evidence.playerAte) return 'fulfilled';
  return 'undetermined';
}

/* ------------------------------------------------------------------ */
/* Frozen prompts (one template, only the candidate data differs)      */
/* ------------------------------------------------------------------ */

export interface GoalPromptContext {
  actorId: string;
  location: string;
  simTime: number;
  selfSatiety: number;
  foodKitchen: number;
  /** The frozen request text; identical in both arms. */
  text: string;
  options: readonly GoalChoiceId[];
  /** Host-only fields: accepted for compatibility, never rendered. */
  playerId?: string;
  playerSatiety?: number;
  arm?: GoalArm;
  requestId?: string;
  episodeId?: string;
  deadlineAfterRound?: number;
  createdAtSimTime?: number;
  expiresAtSimTime?: number;
  observation?: { id: string; location: string; hunger: number; foodHere: number; reachable?: readonly string[] };
}

/**
 * ONE template for both arms. Exactly one explicit candidate data line; no
 * other NPC attributes, no host request/episode ids, no arm or group labels.
 */
export function renderGoalChoicePrompt(ctx: GoalPromptContext): string {
  const lines = [
    `你是 ${ctx.actorId}，位于${ctx.location}。当前逻辑时间 ${ctx.simTime}。`,
    `你的饱食度：${ctx.selfSatiety}。你所在位置的剩余食物：${ctx.foodKitchen}。`,
    `玩家说：“${ctx.text}”`,
    '请从候选目标中选择一个，只回复一个 JSON 对象，不要输出任何其他内容。',
    `candidateGoals: ${JSON.stringify([...ctx.options])}`,
  ];
  return lines.join('\n');
}

/** The frozen context line the action prompt carries once a binding exists. */
export function goalChoiceLine(binding: { goal: GoalChoiceId; requestId?: string | null }): string {
  if (binding.goal === 'yield_once') {
    return '你已选择的目标：yield_once（把这份食物让给玩家，直到请求到期）。';
  }
  return '你已选择的目标：feed_self（先满足自己的饱食）。';
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

/* ------------------------------------------------------------------ */
/* Goal evaluation (feed_self = hunger; yield_once = the request)      */
/* ------------------------------------------------------------------ */

export interface GoalEvaluation {
  goal: GoalChoiceId;
  achieved: boolean;
  /** Which authority decided it: the world hunger rule or the request. */
  basis: 'hunger' | 'request';
  /** The request outcome when basis is 'request'. */
  outcome: GoalOutcome | null;
  detail: string;
}

export const G09_HUNGER_GOAL_AT_LEAST = 70;
