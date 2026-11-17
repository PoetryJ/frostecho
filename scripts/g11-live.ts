/**
 * G11-live — the thin, read-heavy driver for the REAL W1/W2 closeout.
 *
 * It owns no game, ledger or save system of its own: every run reuses the real
 * application path (parseInput -> ApplicationController.execute/view), the real
 * createG10Runtime/loadG10Runtime adapters, the real ports (save / failure /
 * run record) and the real provider. The children run in separate Node
 * processes so the restored suffix is a TRUE cross-process continuation.
 *
 * Modes
 *   prepare  write batch/plan.json exclusively (refuses an existing plan)
 *   prefix   one scene: request -> step(goal) -> step(action=wait) -> save -> quit
 *   suffix   a NEW process: load the pre-close slot -> world inputs -> 2 steps
 *   run      orchestrator: preflight -> exclusive start -> serial W1/W2 children
 *   verify   read-only derivation through worker A's verifier (no writes)
 *
 * One-shot orchestration (run): every invocation takes its OWN exclusive
 * preflight record (GET /health + GET /v1/models, no chat request). A batch may
 * start exactly once: run-start.json is created with `wx` and any earlier start
 * marker or spent attempt refuses before the network. plan.json and the
 * historical offline-ready.json are never rewritten.
 *
 * Watchdog: each phase may legally wait 2 x the single-request timeout plus a
 * settle margin, so the kill deadline is DERIVED (2 x 120000 + 30000 = 270000
 * in production) instead of the old fixed 180000 that beheaded a legal phase.
 *
 * Exit codes
 *   0  both goal paths truly triggered AND worker A's gate is ok
 *   1  not_triggered / goal_not_reached / technical failure / evidence gate closed
 *   2  config, same-name-dir, already-started or already-charged, ZERO POST
 *   3  offline_ready: the two preflight GETs failed (no POST beyond them)
 *
 * Budget: every provider call still goes through the campaign reserve; this
 * driver only refuses to START a step when the scene already used its share
 * (maxPostsPerScene) or the campaign is exhausted.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createG10Runtime, loadG10Runtime, type G10Runtime } from '../src/application/adapters';
import { createApplicationController } from '../src/application/session';
import { parseInput } from '../src/application/commands';
import type { AppCommand, ApplicationController, AppView } from '../src/application/contracts';
import { ACTIVE_GOAL_PROMPT_VERSION } from '../src/agent/active-goal-prompt';
import { HTTP_SAMPLING } from '../src/agent/providers/http';
import { campaignCounts, loadCampaign } from '../src/eval/campaign-budget';
import { campaignJsonPath } from '../src/application/budget-binding';
import { HEALTH_TIMEOUT_MS, checkLlmHealth } from '../src/eval/health';
import { G09_TIMEOUT_MS } from '../src/negotiation/contracts';
import { G11_SCENES, g11Ok, type G11VerifyResult } from './g11-live-contracts';
import { verifyG11Batch } from './g11-live-verify';

const PLAN_SCHEMA = 'frostecho.g11-live.plan/1';
const SCENE_SCHEMA = 'frostecho.g11-live.scene/1';
const PREFLIGHT_SCHEMA = 'frostecho.g11-live.preflight/1';
const RUN_START_SCHEMA = 'frostecho.g11-live.run-start/1';
const SCENES = ['W1', 'W2'] as const;
type Scene = (typeof SCENES)[number];
/** Slot/directory names are lowercased: the save-slot regex rejects capitals. */
const sceneDir = (scene: Scene): string => scene.toLowerCase();
/** Each phase sends at most goal+action; the suffix sends the two resumed eats. */
const REQUESTS_PER_PHASE = 2;
/** Production settle margin on top of the legal per-request budget. */
const WATCHDOG_SETTLE_MS = 30_000;

/**
 * The per-phase kill deadline is DERIVED from the frozen per-request timeout.
 * Tests inject shorter values through the two env knobs; production leaves them
 * unset, so the deadline is exactly 2 x 120000 + 30000. The effective values are
 * written into run-start.json so any deviation is auditable.
 */
interface Watchdog {
  requestMs: number;
  settleMs: number;
  requestsPerPhase: number;
  phaseMs: number;
  source: 'default' | 'injected';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const text = raw?.trim() ?? '';
  if (text.length === 0) return fallback;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function watchdogOf(env: NodeJS.ProcessEnv): Watchdog {
  const requestMs = positiveInt(env.FROSTECHO_G11_REQUEST_TIMEOUT_MS, G09_TIMEOUT_MS);
  const settleMs = positiveInt(env.FROSTECHO_G11_WATCHDOG_SETTLE_MS, WATCHDOG_SETTLE_MS);
  return {
    requestMs,
    settleMs,
    requestsPerPhase: REQUESTS_PER_PHASE,
    phaseMs: REQUESTS_PER_PHASE * requestMs + settleMs,
    source: requestMs === G09_TIMEOUT_MS && settleMs === WATCHDOG_SETTLE_MS ? 'default' : 'injected',
  };
}

interface Plan {
  schema: typeof PLAN_SCHEMA;
  createdAt: string;
  sourceCommit: string | null;
  promptVersion: string;
  config: { goals: 'negotiated'; candidates: 'choice'; satiety: 40; needPolicy: 'recurring'; actionSet: 'timed_wait' };
  /** Opt-in, frozen at prepare; absent keeps every old plan's on/on bytes. */
  actionThinking?: boolean;
  authorization: { totalPosts: number; maxPostsPerScene: number; scenes: readonly Scene[] };
  service: { http: string; model: string };
  campaignDir: string;
  batchDir: string;
}

interface StepOutcome {
  line: string;
  ok: boolean;
  code: string;
  detail: string | undefined;
  advanced: number | undefined;
  view: AppView;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function usage(message: string | null): never {
  if (message !== null) console.error(message);
  console.error('usage: g11-live <prepare|prefix|suffix|run|verify> --batch DIR --campaign DIR --http URL --model M [--limit N] [--out FILE] [--action-thinking on|off]');
  process.exit(2);
}

function parseCli(argv: string[]): { mode: string; batch: string; campaign: string; http: string; model: string; limit: number; out: string | null; scene: Scene | null; actionThinking: boolean | undefined } {
  const out = { mode: argv[0] ?? '', batch: '', campaign: '', http: '', model: '', limit: 8, out: null as string | null, scene: null as Scene | null, actionThinking: undefined as boolean | undefined };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1] ?? '';
    if (flag === '--batch') out.batch = value;
    else if (flag === '--campaign') out.campaign = value;
    else if (flag === '--http') out.http = value;
    else if (flag === '--model') out.model = value;
    else if (flag === '--out') out.out = value.length === 0 ? null : value;
    else if (flag === '--scene') {
      if (value !== 'W1' && value !== 'W2') usage(`--scene must be W1 or W2, got ${JSON.stringify(value)}`);
      out.scene = value;
    } else if (flag === '--limit') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) usage('--limit must be a positive integer');
      out.limit = parsed;
    } else if (flag === '--action-thinking') {
      if (value !== 'on' && value !== 'off') usage(`--action-thinking must be on|off, got ${JSON.stringify(value)}`);
      out.actionThinking = value === 'on';
    } else usage(`unknown argument ${JSON.stringify(flag)}`);
  }
  if (out.batch.length === 0 || out.campaign.length === 0) usage('--batch and --campaign are required');
  if (out.mode !== 'verify' && (out.http.length === 0 || out.model.length === 0)) usage('--http and --model are required');
  if ((out.mode === 'prefix' || out.mode === 'suffix') && out.scene === null) usage(`${out.mode} requires --scene W1|W2`);
  return out;
}

function readPlan(batchDir: string): Plan {
  const path = join(batchDir, 'plan.json');
  if (!existsSync(path)) fail(`no plan at ${path}: run prepare first`);
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
    if (plan.schema !== PLAN_SCHEMA) fail(`plan schema ${plan.schema} is not ${PLAN_SCHEMA}`);
    return plan;
  } catch (error) {
    fail(`cannot read plan ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(path: string): { hash: string; bytes: number } {
  const raw = readFileSync(path);
  return { hash: createHash('sha256').update(raw).digest('hex'), bytes: raw.byteLength };
}

function spentOf(campaignDir: string): number {
  try {
    return campaignCounts(loadCampaign(campaignDir)).spent;
  } catch {
    return -1;
  }
}

/** One parsed input executed through the REAL controller; the view comes back. */
async function exec(controller: ApplicationController, line: string): Promise<StepOutcome> {
  const parsed = parseInput(line);
  if (!parsed.ok) return { line, ok: false, code: 'BAD_INPUT', detail: parsed.message, advanced: undefined, view: controller.view() };
  const result = await controller.execute(parsed.command as AppCommand);
  return {
    line,
    ok: result.ok,
    code: result.code,
    detail: result.detail,
    advanced: result.advanced,
    view: controller.view(),
  };
}

function npc(view: AppView, actorId: string): AppView['npcs'][number] {
  // sessionsOf lists EVERY cycle per actor; the LAST entry is the active one.
  const entries = view.npcs.filter(candidate => candidate.actorId === actorId);
  const entry = entries.at(-1);
  if (entry === undefined) throw new Error(`no npc ${actorId} in view`);
  return entry;
}

function requestOf(view: AppView, actorId: string): { status: string; outcome: string } | null {
  const request = npc(view, actorId).request;
  return request === null ? null : { status: request.status, outcome: request.outcome };
}

function emit(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

/* ------------------------------------------------------------------ */
/* prepare                                                             */
/* ------------------------------------------------------------------ */

function cmdPrepare(batchDir: string, campaignDir: string, http: string, model: string, limit: number, actionThinking: boolean | undefined): number {
  const planPath = join(batchDir, 'plan.json');
  if (existsSync(planPath)) fail(`plan already exists at ${planPath}; a re-run would spend real budget`);
  if (existsSync(join(batchDir, 'W1')) || existsSync(join(batchDir, 'W2'))) {
    fail(`batch dir ${batchDir} already holds scene directories; refusing to mix runs`);
  }
  const commit = process.env.FROSTECHO_COMMIT ?? null;
  const plan: Plan = {
    schema: PLAN_SCHEMA,
    createdAt: new Date().toISOString(),
    sourceCommit: commit,
    promptVersion: ACTIVE_GOAL_PROMPT_VERSION,
    config: { goals: 'negotiated', candidates: 'choice', satiety: 40, needPolicy: 'recurring', actionSet: 'timed_wait' },
    // Serialized only when the experiment asked for it; an absent key means
    // "goal value for every phase", exactly like every historical plan.
    ...(actionThinking !== undefined ? { actionThinking } : {}),
    authorization: { totalPosts: limit, maxPostsPerScene: Math.min(4, limit), scenes: [...SCENES] },
    service: { http, model },
    campaignDir: resolve(campaignDir),
    batchDir: resolve(batchDir),
  };
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  emit({
    mode: 'prepare', planPath, sourceCommit: commit, promptVersion: plan.promptVersion, limit,
    ...(plan.actionThinking !== undefined ? { actionThinking: plan.actionThinking } : {}),
  });
  return 0;
}

/* ------------------------------------------------------------------ */
/* shared scene state                                                  */
/* ------------------------------------------------------------------ */

interface SceneResult {
  scene: Scene;
  phase: 'prefix' | 'suffix';
  classification: string;
  reasons: string[];
  posts: number;
  sceneStartSpent: number;
  endSpent: number;
  slotPath: string | null;
  slotSha256: string | null;
  slotBytes: number | null;
  runRecordPath: string | null;
  finalizeOk: boolean;
  modelChoice: { goal: string | null; action: string | null };
}

async function finalize(controller: ApplicationController): Promise<{ ok: boolean; recordPath: string | null }> {
  const final = await controller.finalize();
  for (const failure of final.failures) {
    console.error(JSON.stringify({ level: 'failure', code: failure.code, message: failure.message, evidencePath: failure.evidencePath }));
  }
  for (const error of final.errors) {
    console.error(JSON.stringify({ level: 'finalize-error', code: error.code, message: error.message }));
  }
  return { ok: final.ok, recordPath: final.recordPath };
}

/** Refuse to START a step when the scene share or the campaign is spent. */
function budgetGuard(campaignDir: string, sceneStartSpent: number, maxPostsPerScene: number, scene: Scene, step: string): string | null {
  const spent = spentOf(campaignDir);
  if (spent < 0) return `${scene}/${step}: campaign ledger unreadable`;
  const delta = spent - sceneStartSpent;
  if (delta >= maxPostsPerScene) return `${scene}/${step}: scene share ${delta}/${maxPostsPerScene} already spent (campaign spent ${spent})`;
  return null;
}

/* ------------------------------------------------------------------ */
/* preflight and the one-shot start marker                             */
/* ------------------------------------------------------------------ */

/** `wx` creation, numbered: concurrent invocations never overwrite one record. */
function writeExclusive(dir: string, prefix: string, payload: unknown): string {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  for (let sequence = 1; sequence <= 999; sequence += 1) {
    const path = join(dir, `${prefix}-${String(sequence).padStart(3, '0')}.json`);
    try {
      writeFileSync(path, text, { flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`no free exclusive ${prefix} record name in ${dir}`);
}

interface PreflightReport {
  schema: typeof PREFLIGHT_SCHEMA;
  at: string;
  batchDir: string;
  campaignDir: string;
  http: string;
  model: string;
  health: { url: string; status: number | null; ok: boolean; error: string | null };
  models: { path: string; status: number | null; ok: boolean; modelMatch: boolean; served: string[]; error: string | null };
  chatRequests: 0;
  gets: 2;
  ok: boolean;
}

/**
 * Two GETs and nothing else: /health must answer 2xx AND /v1/models must list
 * the frozen model. No chat request, no ledger, no provider is created here.
 */
async function preflight(plan: Plan): Promise<PreflightReport> {
  const at = new Date().toISOString();
  const origin = new URL(plan.service.http).origin;
  const healthUrl = `${origin}/health`;
  let status: number | null = null;
  let healthOk = false;
  let healthError: string | null = null;
  try {
    const response = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    status = response.status;
    healthOk = response.ok;
    if (!response.ok) healthError = `http ${String(response.status)}`;
    else await response.text();
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
  }
  const models = await checkLlmHealth({ url: plan.service.http, model: plan.service.model }, { timeoutMs: HEALTH_TIMEOUT_MS });
  return {
    schema: PREFLIGHT_SCHEMA,
    at,
    batchDir: plan.batchDir,
    campaignDir: plan.campaignDir,
    http: plan.service.http,
    model: plan.service.model,
    health: { url: healthUrl, status, ok: healthOk, error: healthError },
    models: {
      path: models.modelsUrlPath,
      status: models.status,
      ok: models.ok,
      modelMatch: models.modelMatch,
      served: models.models,
      error: models.error,
    },
    chatRequests: 0,
    gets: 2,
    ok: healthOk && models.ok,
  };
}

function codeHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The batch may start exactly once across processes: `wx` on run-start.json.
 * The record freezes the actual code HEAD, the original plan bytes and every
 * effective setting, so a later reader can prove what was authorized.
 */
function writeRunStart(plan: Plan, preflightPath: string, watchdog: Watchdog, spentBefore: number): string {
  const planPath = join(plan.batchDir, 'plan.json');
  const record = {
    schema: RUN_START_SCHEMA,
    at: new Date().toISOString(),
    batchDir: plan.batchDir,
    campaignDir: plan.campaignDir,
    codeHead: codeHead(),
    planPath,
    planSha256: sha256(planPath).hash,
    planBytes: sha256(planPath).bytes,
    preflightPath,
    authorization: plan.authorization,
    effective: {
      http: plan.service.http,
      model: plan.service.model,
      promptVersion: plan.promptVersion,
      config: plan.config,
      sampling: {
        temperature: HTTP_SAMPLING.temperature,
        maxTokens: HTTP_SAMPLING.max_tokens,
        stream: HTTP_SAMPLING.stream,
        thinking: true,
        ...(plan.actionThinking !== undefined ? { actionThinking: plan.actionThinking } : {}),
      },
      requestTimeoutMs: watchdog.requestMs,
      watchdog: { requestsPerPhase: watchdog.requestsPerPhase, settleMs: watchdog.settleMs, phaseMs: watchdog.phaseMs, source: watchdog.source },
    },
    sceneOrder: [...SCENES],
    campaignSpentBefore: spentBefore,
  };
  const path = join(plan.batchDir, 'run-start.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return path;
}

/* ------------------------------------------------------------------ */
/* prefix: request -> goal step -> wait step -> save -> quit           */
/* ------------------------------------------------------------------ */

async function cmdPrefix(plan: Plan, scene: Scene): Promise<number> {
  // A phase may only run under the one-shot start marker written by `run`; a
  // hand-invoked phase must not be able to spend outside the frozen batch start.
  const startPath = join(plan.batchDir, 'run-start.json');
  if (!existsSync(startPath)) {
    emit({ mode: 'prefix', scene, classification: 'config_error', reasons: [`no run-start marker at ${startPath}: only run mode may start a scene`] });
    return 2;
  }
  const root = join(plan.batchDir, sceneDir(scene));
  const slot = `${sceneDir(scene)}-prefix`;
  const ledgerExists = existsSync(campaignJsonPath(plan.campaignDir));
  const built = createG10Runtime({
    root, slot, goals: plan.config.goals, candidates: plan.config.candidates, satiety: plan.config.satiety,
    fixture: null, live: true, http: plan.service.http, model: plan.service.model,
    campaign: plan.campaignDir, campaignLimit: ledgerExists ? null : plan.authorization.totalPosts,
    ...(plan.actionThinking !== undefined ? { actionThinking: plan.actionThinking } : {}),
  });
  if (!built.ok) {
    emit({ mode: 'prefix', scene, classification: 'config_error', reasons: built.issues ?? [] });
    return 2;
  }
  const runtime: G10Runtime = built.value;
  const controller = createApplicationController({
    game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot,
    meta: runtime.meta, ports: runtime.ports,
  });
  const sceneStartSpent = spentOf(plan.campaignDir);
  // G11-live: the SCENE baseline (prefix start) is persisted so the suffix
  // process guards the whole scene's share, not just its own phase (LIVE.md).
  const basePath = join(root, 'scene-base.json');
  if (existsSync(basePath)) {
    emit({ mode: 'prefix', scene, classification: 'config_error', reasons: [`scene baseline ${basePath} already exists`] });
    return 2;
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(basePath, `${JSON.stringify({ schema: 'frostecho.g11-live.scene-base/1', scene, sceneStartSpent }, null, 2)}\n`, { flag: 'wx' });
  const result: SceneResult = {
    scene, phase: 'prefix', classification: 'technical_failure', reasons: [], posts: 0,
    sceneStartSpent, endSpent: sceneStartSpent, slotPath: null, slotSha256: null, slotBytes: null,
    runRecordPath: null, finalizeOk: false, modelChoice: { goal: null, action: null },
  };
  /** Finalize (run record + failure evidence), classify, ALWAYS emit JSON. */
  const stopWith = async (classification: string, reason: string): Promise<number> => {
    const final = await finalize(controller);
    result.runRecordPath = final.recordPath;
    result.finalizeOk = final.ok;
    result.endSpent = Math.max(spentOf(plan.campaignDir), result.endSpent);
    result.posts = result.endSpent - sceneStartSpent;
    result.classification = classification;
    result.reasons.push(reason);
    emit({ mode: 'prefix', ...result });
    return 1;
  };

  const request = await exec(controller, `request npc_a yield_once`);
  if (!request.ok) return stopWith('not_triggered', `${scene}/request rejected: ${request.code} ${request.detail ?? ''}`);

  const goal = await exec(controller, 'run 1');
  result.endSpent = spentOf(plan.campaignDir);
  result.posts = result.endSpent - sceneStartSpent;
  if (!goal.ok) return stopWith('technical_failure', `${scene}/goal step failed: ${goal.code} ${goal.detail ?? ''}`);
  if (goal.advanced !== 1) return stopWith('not_triggered', `${scene}/goal step advanced ${goal.advanced ?? 0}, not 1`);
  const afterGoal = npc(goal.view, 'npc_a');
  result.modelChoice.goal = afterGoal.selectedGoal;
  if (requestOf(goal.view, 'npc_a')?.status === 'declined') {
    return stopWith('not_triggered', `${scene}: the model DECLINED cooperation (feed_self)`);
  }
  if (afterGoal.selectedGoal !== 'yield_once' || afterGoal.selectedGoalBasis !== 'session_binding') {
    return stopWith('not_triggered', `${scene}: the model chose ${String(afterGoal.selectedGoal)}, not the yield path`);
  }

  const guard = budgetGuard(plan.campaignDir, sceneStartSpent, plan.authorization.maxPostsPerScene, scene, 'action');
  if (guard !== null) return stopWith('goal_not_reached', guard);
  const action = await exec(controller, 'run 1');
  result.endSpent = spentOf(plan.campaignDir);
  result.posts = result.endSpent - sceneStartSpent;
  if (!action.ok) return stopWith('technical_failure', `${scene}/action step failed: ${action.code} ${action.detail ?? ''}`);
  const afterAction = npc(action.view, 'npc_a');
  result.modelChoice.action = afterAction.status === 'waiting_time' ? 'wait' : afterAction.status;
  if (afterAction.status !== 'waiting_time' || afterAction.wakeAtSimTime !== 1) {
    return stopWith('not_triggered', `${scene}: no legal wait — session status ${afterAction.status}, wake ${String(afterAction.wakeAtSimTime)}`);
  }
  const requestAfterAction = requestOf(action.view, 'npc_a');
  if (requestAfterAction?.status !== 'accepted' || requestAfterAction.outcome !== 'pending') {
    return stopWith('not_triggered', `${scene}: request not accepted/pending after the wait (${JSON.stringify(requestAfterAction)})`);
  }

  const save = await exec(controller, `save ${sceneDir(scene)}-wait`);
  if (!save.ok || save.view.savedPath === null) {
    return stopWith('technical_failure', `${scene}: save refused: ${save.code} ${save.detail ?? ''}`);
  }
  result.slotPath = save.view.savedPath;
  const before = sha256(result.slotPath);
  result.slotSha256 = before.hash;
  result.slotBytes = before.bytes;

  await exec(controller, 'quit');
  const final = await finalize(controller);
  result.runRecordPath = final.recordPath;
  result.finalizeOk = final.ok;
  result.endSpent = spentOf(plan.campaignDir);
  result.posts = result.endSpent - sceneStartSpent;
  const after = sha256(result.slotPath);
  if (after.hash !== before.hash) {
    result.classification = 'technical_failure';
    result.reasons.push(`${scene}: the saved slot changed during quit (${before.hash.slice(0, 12)} -> ${after.hash.slice(0, 12)})`);
    emit({ mode: 'prefix', ...result });
    return 1;
  }
  if (!final.ok) {
    result.classification = 'technical_failure';
    result.reasons.push(`${scene}: finalize failed (run record ${final.recordPath === null ? 'missing' : final.recordPath})`);
    emit({ mode: 'prefix', ...result });
    return 1;
  }
  result.classification = 'goal_triggered';
  emit({ mode: 'prefix', ...result });
  return 0;
}

/* ------------------------------------------------------------------ */
/* suffix: NEW process, load the pre-close slot, then finish the scene */
/* ------------------------------------------------------------------ */

async function cmdSuffix(plan: Plan, scene: Scene): Promise<number> {
  const startPath = join(plan.batchDir, 'run-start.json');
  if (!existsSync(startPath)) {
    emit({ mode: 'suffix', scene, classification: 'config_error', reasons: [`no run-start marker at ${startPath}: only run mode may continue a scene`] });
    return 2;
  }
  const slotPath = join(plan.batchDir, sceneDir(scene), `${sceneDir(scene)}-wait.g09.json`);
  if (!existsSync(slotPath)) {
    emit({ mode: 'suffix', scene, classification: 'config_error', reasons: [`no pre-close slot at ${slotPath}`] });
    return 2;
  }
  const built = loadG10Runtime(slotPath, {
    live: true, model: plan.service.model, fixture: null,
    http: plan.service.http, campaign: plan.campaignDir, campaignLimit: null,
    // Explicit only when the plan freezes it: a mismatch with the saved slot
    // is refused with zero POST and zero writes to the original slot.
    ...(plan.actionThinking !== undefined ? { actionThinking: plan.actionThinking } : {}),
  });
  if (!built.ok) {
    emit({ mode: 'suffix', scene, classification: 'config_error', reasons: built.issues ?? [] });
    return 2;
  }
  const runtime: G10Runtime = built.value;
  const controller = createApplicationController({
    game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot,
    meta: runtime.meta, ports: runtime.ports,
  });
  // G11-live: the SCENE baseline written by the prefix governs the budget
  // guard for the WHOLE scene (prefix + suffix); the phase-local start only
  // measures this phase's own posts.
  const basePath = join(plan.batchDir, sceneDir(scene), 'scene-base.json');
  if (!existsSync(basePath)) {
    emit({ mode: 'suffix', scene, classification: 'config_error', reasons: [`no scene baseline at ${basePath}: the prefix must run first`] });
    return 2;
  }
  let sceneBase: number;
  try {
    const parsed = JSON.parse(readFileSync(basePath, 'utf8')) as { scene: Scene; sceneStartSpent: number };
    if (parsed.scene !== scene || !Number.isInteger(parsed.sceneStartSpent) || parsed.sceneStartSpent < 0) throw new Error('bad scene baseline');
    sceneBase = parsed.sceneStartSpent;
  } catch (error) {
    emit({ mode: 'suffix', scene, classification: 'config_error', reasons: [`${basePath}: ${error instanceof Error ? error.message : String(error)}`] });
    return 2;
  }
  const phaseStartSpent = spentOf(plan.campaignDir);
  const sceneStartSpent = sceneBase;
  const result: SceneResult = {
    scene, phase: 'suffix', classification: 'technical_failure', reasons: [], posts: 0,
    sceneStartSpent, endSpent: phaseStartSpent, slotPath, slotSha256: null, slotBytes: null,
    runRecordPath: null, finalizeOk: false, modelChoice: { goal: 'yield_once', action: null },
  };
  /** Finalize, classify, ALWAYS emit JSON. */
  const stopWith = async (classification: string, reason: string): Promise<number> => {
    const final = await finalize(controller);
    result.runRecordPath = final.recordPath;
    result.finalizeOk = final.ok;
    result.endSpent = Math.max(spentOf(plan.campaignDir), result.endSpent);
    result.posts = Math.max(result.endSpent - phaseStartSpent, 0);
    result.classification = classification;
    result.reasons.push(reason);
    emit({ mode: 'suffix', ...result });
    return 1;
  };

  // The restore itself must be free: no call, no submit, old promise intact.
  const initial = controller.view();
  const actor = npc(initial, 'npc_a');
  if (runtime.loadInfo !== null && runtime.loadInfo.calls !== 0) return stopWith('technical_failure', `${scene}: restore reported ${runtime.loadInfo.calls} calls`);
  if (initial.budget.episodeCalls !== 2) return stopWith('technical_failure', `${scene}: restored episode calls ${initial.budget.episodeCalls}, not 2`);
  if (actor.status !== 'waiting_time' || actor.wakeAtSimTime !== 1) {
    return stopWith('technical_failure', `${scene}: restored session ${actor.status}, wake ${String(actor.wakeAtSimTime)}`);
  }
  if (actor.selectedGoal !== 'yield_once' || actor.selectedGoalBasis !== 'session_binding') {
    return stopWith('technical_failure', `${scene}: restored goal ${String(actor.selectedGoal)} (${actor.selectedGoalBasis})`);
  }
  if (initial.simTime !== 0) return stopWith('technical_failure', `${scene}: restored simTime ${initial.simTime}, not 0`);
  const initialRequest = requestOf(initial, 'npc_a');
  if (initialRequest?.status !== 'accepted' || initialRequest.outcome !== 'pending') {
    return stopWith('technical_failure', `${scene}: restored request ${JSON.stringify(initialRequest)}`);
  }
  const slotBefore = sha256(slotPath);
  result.slotSha256 = slotBefore.hash;
  result.slotBytes = slotBefore.bytes;

  if (scene === 'W1') {
    const eat = await exec(controller, 'player eat');
    if (!eat.ok) return stopWith('technical_failure', `W1/player eat failed: ${eat.code} ${eat.detail ?? ''}`);
    const fulfilled = requestOf(eat.view, 'npc_a');
    if (fulfilled?.outcome !== 'fulfilled') {
      return stopWith('not_triggered', `W1: the player ate but the request is ${JSON.stringify(fulfilled)}`);
    }
  }

  const time = await exec(controller, 'world time 1');
  if (!time.ok) return stopWith('technical_failure', `${scene}/world time failed: ${time.code} ${time.detail ?? ''}`);
  const settled = requestOf(time.view, 'npc_a');
  const expected = scene === 'W1' ? 'fulfilled' : 'expired';
  if (settled?.outcome !== expected) {
    return stopWith('goal_not_reached', `${scene}: authoritative outcome ${JSON.stringify(settled)}, expected ${expected}`);
  }

  const restock = await exec(controller, `world restock kitchen ${scene === 'W1' ? 2 : 1}`);
  if (!restock.ok) return stopWith('technical_failure', `${scene}/restock failed: ${restock.code}`);

  for (const index of [1, 2]) {
    const guard = budgetGuard(plan.campaignDir, sceneStartSpent, plan.authorization.maxPostsPerScene, scene, `step${index}`);
    if (guard !== null) return stopWith('goal_not_reached', guard);
    const step = await exec(controller, 'run 1');
    result.endSpent = spentOf(plan.campaignDir);
    result.posts = Math.max(result.endSpent - phaseStartSpent, 0);
    if (!step.ok) return stopWith('technical_failure', `${scene}/step${index} failed: ${step.code} ${step.detail ?? ''}`);
    if (step.advanced !== 1) return stopWith('goal_not_reached', `${scene}/step${index} advanced ${step.advanced ?? 0}, not 1`);
    const after = npc(step.view, 'npc_a');
    if (after.selectedGoalBasis !== 'ordinary_hunger_need') {
      return stopWith('goal_not_reached', `${scene}/step${index}: the continuation is ${after.selectedGoalBasis}, not an ordinary need cycle`);
    }
    // providerCalls is the CONTINUATION cycle's own count: 1 after the first
    // eat, 2 after the second. The old promise session keeps its own 2.
    if (after.providerCalls !== index) {
      return stopWith('technical_failure', `${scene}/step${index}: continuation provider calls ${after.providerCalls}, expected ${index}`);
    }
    if (index === 2) {
      if (after.hungerNeedSatisfied !== true || step.view.food.kitchen !== 0) {
        return stopWith('goal_not_reached', `W-final: hunger need ${String(after.hungerNeedSatisfied)}, kitchen ${step.view.food.kitchen}`);
      }
      result.modelChoice.action = 'resume_eat';
    }
  }

  await exec(controller, 'quit');
  const final = await finalize(controller);
  result.runRecordPath = final.recordPath;
  result.finalizeOk = final.ok;
  const slotAfter = sha256(slotPath);
  if (slotAfter.hash !== slotBefore.hash) {
    result.classification = 'technical_failure';
    result.reasons.push(`${scene}: the pre-close slot changed during the suffix run`);
    emit({ mode: 'suffix', ...result });
    return 1;
  }
  if (!final.ok) {
    result.classification = 'technical_failure';
    result.reasons.push(`${scene}: finalize failed`);
    emit({ mode: 'suffix', ...result });
    return 1;
  }
  result.classification = scene === 'W1' ? 'fulfilled' : 'expired';
  emit({ mode: 'suffix', ...result });
  return 0;
}

/* ------------------------------------------------------------------ */
/* run: the serial orchestrator (the ONLY mode the main agent runs)    */
/* ------------------------------------------------------------------ */

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  killedByWatchdog: boolean;
  watchdogMs: number;
  spawnError: string | null;
  stdout: string;
  stderr: string;
}

/**
 * One child phase. The kill deadline is DERIVED (2 legal requests + settle),
 * never a fixed 180s: two 100s requests are legal and must survive. On a kill
 * the child's already-written records and its exit facts are kept, and the
 * caller stops the batch — nothing is retried.
 */
function runChild(mode: 'prefix' | 'suffix', scene: Scene, plan: Plan, watchdog: Watchdog): Promise<ChildOutcome> {
  const self = join(__dirname, 'g11-live.js');
  const child = spawn(process.execPath, [self, mode, '--scene', scene, '--batch', plan.batchDir, '--campaign', plan.campaignDir, '--http', plan.service.http, '--model', plan.service.model], { cwd: process.cwd() });
  let stdout = '';
  let stderr = '';
  let killedByWatchdog = false;
  let spawnError: string | null = null;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => { spawnError = error instanceof Error ? error.message : String(error); });
  const timer = setTimeout(() => { killedByWatchdog = true; child.kill('SIGKILL'); }, watchdog.phaseMs);
  return new Promise(resolve => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, killedByWatchdog, watchdogMs: watchdog.phaseMs, spawnError, stdout, stderr });
    });
  });
}

/** Exit facts are part of the evidence: a killed or unparseable child still names why. */
function childExit(outcome: ChildOutcome): Record<string, unknown> {
  return {
    code: outcome.code,
    signal: outcome.signal,
    killedByWatchdog: outcome.killedByWatchdog,
    watchdogMs: outcome.watchdogMs,
    spawnError: outcome.spawnError,
    stderrTail: outcome.stderr.slice(-600),
  };
}

function childJson(outcome: ChildOutcome): Record<string, unknown> {
  for (const line of outcome.stdout.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.mode !== undefined) return parsed;
    } catch { /* keep scanning */ }
  }
  const cause = outcome.killedByWatchdog
    ? `phase killed by the derived watchdog after ${String(outcome.watchdogMs)}ms`
    : `child produced no JSON; exit ${String(outcome.code)} signal ${String(outcome.signal)}`;
  return {
    classification: 'technical_failure',
    reasons: [`${cause}${outcome.spawnError === null ? '' : `; spawn ${outcome.spawnError}`}; stderr tail: ${outcome.stderr.slice(-400)}`],
    raw: outcome.stdout.slice(-600),
  };
}

async function cmdRun(plan: Plan): Promise<number> {
  const watchdog = watchdogOf(process.env);
  // One shot across processes. The marker is created with `wx` only AFTER the
  // preflight; an existing marker or any already-charged attempt refuses here,
  // before the network, so a crash or a second shell cannot double-start.
  if (existsSync(join(plan.batchDir, 'run-start.json'))) {
    fail(`run-start.json already exists in ${plan.batchDir}: this batch was already started (no re-spend)`);
  }
  const spentBefore = spentOf(plan.campaignDir);
  if (spentBefore > 0) fail(`campaign ${plan.campaignDir} already spent ${String(spentBefore)} attempts: refusing a second start`);
  /** No ledger yet means provably zero spent (the guard above closed the rest). */
  const chargedSoFar = spentBefore < 0 ? 0 : spentBefore;
  for (const scene of SCENES) {
    if (existsSync(join(plan.batchDir, `scene-${scene}.json`))) {
      fail(`scene-${scene}.json already exists: this batch was already run (no re-spend)`);
    }
  }

  // Every invocation keeps its OWN exclusive preflight record; the historical
  // plan.json and offline-ready.json bytes are never rewritten.
  const report = await preflight(plan);
  const preflightPath = writeExclusive(plan.batchDir, 'preflight', report);
  if (!report.ok) {
    const reasons = [
      report.health.ok ? null : `GET ${report.health.url}: ${report.health.error ?? 'failed'}`,
      report.models.ok ? null : `GET ${report.models.path}: ${report.models.error ?? 'failed'}`,
    ].filter((reason): reason is string => reason !== null);
    emit({ mode: 'run', classification: 'offline_ready', reasons, preflightPath, gets: report.gets, chatRequests: 0, posts: 0 });
    return 3;
  }

  try {
    writeRunStart(plan, preflightPath, watchdog, chargedSoFar);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fail(`${join(plan.batchDir, 'run-start.json')} appeared concurrently: another process owns this start (no re-spend)`);
    }
    throw error;
  }

  let exit = 0;
  const summary: Record<string, unknown> = {
    mode: 'run',
    preflightPath,
    preflightGets: report.gets,
    watchdog: { requestMs: watchdog.requestMs, settleMs: watchdog.settleMs, phaseMs: watchdog.phaseMs, source: watchdog.source },
    scenes: {} as Record<string, unknown>,
  };
  const writeScene = (scene: Scene, sceneSummary: Record<string, unknown>): void => {
    (summary.scenes as Record<string, unknown>)[scene] = sceneSummary;
    writeFileSync(join(plan.batchDir, `scene-${scene}.json`), `${JSON.stringify({ schema: SCENE_SCHEMA, at: new Date().toISOString(), ...sceneSummary }, null, 2)}\n`);
  };
  /** One exit path: the batch-level code must agree with the evidence gate. */
  const finish = (code: number): number => {
    let gate: G11VerifyResult | null = null;
    try {
      gate = verifyG11Batch({ batchDir: plan.batchDir, campaignDir: plan.campaignDir, model: plan.service.model });
    } catch (error) {
      summary.verifyError = error instanceof Error ? error.message : String(error);
    }
    if (gate !== null) {
      summary.verify = {
        schema: gate.schema,
        evidenceOk: gate.evidenceOk,
        complete: gate.complete,
        ok: gate.ok,
        classification: gate.classification,
        issues: gate.issues,
        expectations: gate.expectations,
        costs: gate.costs,
      };
      if (code === 0 && !g11Ok(gate)) {
        summary.overall = 'evidence_gate_closed';
        emit(summary);
        return 1;
      }
    }
    emit(summary);
    return code;
  };

  for (const scene of SCENES) {
    const prefixOutcome = await runChild('prefix', scene, plan, watchdog);
    const prefix = childJson(prefixOutcome);
    const sceneSummary: Record<string, unknown> = {
      prefix,
      suffix: null,
      overall: 'not_run',
      exit: { prefix: childExit(prefixOutcome), suffix: null as Record<string, unknown> | null },
    };
    if (prefixOutcome.code === 2) {
      // A child config error (same-name dir, bad baseline, bad plan) is exit 2
      // at the batch level too, with ZERO posts spent.
      sceneSummary.overall = String(prefix.classification ?? 'config_error');
      writeScene(scene, sceneSummary);
      return finish(2);
    }
    if (prefixOutcome.code === 0 && prefix.classification === 'goal_triggered') {
      const suffixOutcome = await runChild('suffix', scene, plan, watchdog);
      const suffix = childJson(suffixOutcome);
      sceneSummary.suffix = suffix;
      (sceneSummary.exit as Record<string, unknown>).suffix = childExit(suffixOutcome);
      if (suffixOutcome.code === 2) {
        sceneSummary.overall = String(suffix.classification ?? 'config_error');
        writeScene(scene, sceneSummary);
        return finish(2);
      }
      sceneSummary.overall = suffixOutcome.code === 0 && (suffix.classification === 'fulfilled' || suffix.classification === 'expired')
        ? 'success'
        : suffix.classification ?? 'technical_failure';
      if (sceneSummary.overall !== 'success') exit = 1;
    } else {
      sceneSummary.overall = String(prefix.classification ?? 'technical_failure');
      exit = 1;
    }
    writeScene(scene, sceneSummary);
    if (exit !== 0) {
      // Any scene failure stops the batch: later scenes stay not_run, zero cost.
      return finish(exit);
    }
  }
  return finish(exit);
}

/* ------------------------------------------------------------------ */
/* verify: read-only derivation from the disk records                  */
/* ------------------------------------------------------------------ */

/**
 * Verify is worker A's read-only derivation: no HTTP, no ledger creation and no
 * file writes unless the caller passes --out (used to store the handoff copy).
 * Exit 0 only when the ONE gate holds: evidenceOk && complete.
 */
function cmdVerify(plan: Plan, batchDir: string, campaignDir: string, out: string | null): number {
  // The EVIDENCE ROOTS are what the caller names, never the paths recorded in
  // plan.json: a copy that was moved must be verified where it now lives, not
  // silently re-verified at its origin.
  const result = verifyG11Batch({
    batchDir,
    campaignDir,
    model: plan.service.model,
  });
  if (out !== null) {
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.table(result.scenes.map(scene => ({
    scene: scene.scene, status: scene.status, posts: scene.posts, outcome: scene.outcome,
    prefix: scene.prefix, suffix: scene.suffix, slotHashOk: scene.slotHashOk,
  })));
  emit({ ...result });
  if (!g11Ok(result)) {
    for (const issue of result.issues.slice(0, 20)) console.error(issue);
    return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(argv: string[]): Promise<number> {
  const args = parseCli(argv);
  if (args.mode !== 'prepare' && args.actionThinking !== undefined) {
    usage('--action-thinking is frozen by prepare; run/prefix/suffix must use the plan');
  }
  if (args.mode === 'prepare') return cmdPrepare(args.batch, args.campaign, args.http, args.model, args.limit, args.actionThinking);
  if (!existsSync(args.batch)) fail(`no batch dir ${args.batch}`);
  if (args.mode === 'verify') return cmdVerify(readPlan(args.batch), args.batch, args.campaign, args.out);
  const plan = readPlan(args.batch);
  if (resolve(args.campaign) !== resolve(plan.campaignDir)) fail(`--campaign ${args.campaign} differs from the plan ${plan.campaignDir}`);
  if (args.mode === 'prefix') return cmdPrefix(plan, args.scene!);
  if (args.mode === 'suffix') return cmdSuffix(plan, args.scene!);
  if (args.mode === 'run') return cmdRun(plan);
  usage(`unknown mode ${JSON.stringify(args.mode)}`);
}

void main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
