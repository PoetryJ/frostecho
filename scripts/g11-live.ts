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
 *   run      orchestrator: precheck GET, then serial W1/W2 prefix+suffix children
 *   verify   read-only derivation from the disk records (run slots, campaign)
 *
 * Exit codes
 *   0  both goal paths truly triggered AND authoritative results reached
 *   1  not_triggered / goal_not_reached / budget_exhausted / technical failure
 *   2  config or same-name-dir error, ZERO POST spent
 *   3  offline_ready: the service precheck failed (no POST beyond the GET)
 *
 * Budget: every provider call still goes through the campaign reserve; this
 * driver only refuses to START a step when the scene already used its share
 * (maxPostsPerScene) or the campaign is exhausted.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createG10Runtime, loadG10Runtime, type G10Runtime } from '../src/application/adapters';
import { createApplicationController } from '../src/application/session';
import { parseInput } from '../src/application/commands';
import type { AppCommand, ApplicationController, AppView } from '../src/application/contracts';
import { ACTIVE_GOAL_PROMPT_VERSION } from '../src/agent/active-goal-prompt';
import { campaignCounts, loadCampaign } from '../src/eval/campaign-budget';
import { campaignJsonPath } from '../src/application/budget-binding';

const PLAN_SCHEMA = 'frostecho.g11-live.plan/1';
const SCENE_SCHEMA = 'frostecho.g11-live.scene/1';
const SCENES = ['W1', 'W2'] as const;
type Scene = (typeof SCENES)[number];
/** Slot/directory names are lowercased: the save-slot regex rejects capitals. */
const sceneDir = (scene: Scene): string => scene.toLowerCase();

interface Plan {
  schema: typeof PLAN_SCHEMA;
  createdAt: string;
  sourceCommit: string | null;
  promptVersion: string;
  config: { goals: 'negotiated'; candidates: 'choice'; satiety: 40; needPolicy: 'recurring'; actionSet: 'timed_wait' };
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
  console.error('usage: g11-live <prepare|prefix|suffix|run|verify> --batch DIR --campaign DIR --http URL --model M [--limit N]');
  process.exit(2);
}

function parseCli(argv: string[]): { mode: string; batch: string; campaign: string; http: string; model: string; limit: number; scene: Scene | null } {
  const out = { mode: argv[0] ?? '', batch: '', campaign: '', http: '', model: '', limit: 8, scene: null as Scene | null };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1] ?? '';
    if (flag === '--batch') out.batch = value;
    else if (flag === '--campaign') out.campaign = value;
    else if (flag === '--http') out.http = value;
    else if (flag === '--model') out.model = value;
    else if (flag === '--scene') {
      if (value !== 'W1' && value !== 'W2') usage(`--scene must be W1 or W2, got ${JSON.stringify(value)}`);
      out.scene = value;
    } else if (flag === '--limit') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) usage('--limit must be a positive integer');
      out.limit = parsed;
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

function cmdPrepare(batchDir: string, campaignDir: string, http: string, model: string, limit: number): number {
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
    authorization: { totalPosts: limit, maxPostsPerScene: Math.min(4, limit), scenes: [...SCENES] },
    service: { http, model },
    campaignDir: resolve(campaignDir),
    batchDir: resolve(batchDir),
  };
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  emit({ mode: 'prepare', planPath, sourceCommit: commit, promptVersion: plan.promptVersion, limit });
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
/* prefix: request -> goal step -> wait step -> save -> quit           */
/* ------------------------------------------------------------------ */

async function cmdPrefix(plan: Plan, scene: Scene): Promise<number> {
  const root = join(plan.batchDir, sceneDir(scene));
  const slot = `${sceneDir(scene)}-prefix`;
  const ledgerExists = existsSync(campaignJsonPath(plan.campaignDir));
  const built = createG10Runtime({
    root, slot, goals: plan.config.goals, candidates: plan.config.candidates, satiety: plan.config.satiety,
    fixture: null, live: true, http: plan.service.http, model: plan.service.model,
    campaign: plan.campaignDir, campaignLimit: ledgerExists ? null : plan.authorization.totalPosts,
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
  const slotPath = join(plan.batchDir, sceneDir(scene), `${sceneDir(scene)}-wait.g09.json`);
  if (!existsSync(slotPath)) {
    emit({ mode: 'suffix', scene, classification: 'config_error', reasons: [`no pre-close slot at ${slotPath}`] });
    return 2;
  }
  const built = loadG10Runtime(slotPath, {
    live: true, model: plan.service.model, fixture: null,
    http: plan.service.http, campaign: plan.campaignDir, campaignLimit: null,
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

interface ChildOutcome { code: number | null; stdout: string; stderr: string }

function runChild(mode: 'prefix' | 'suffix', scene: Scene, plan: Plan): Promise<ChildOutcome> {
  const self = join(__dirname, 'g11-live.js');
  const child = spawn(process.execPath, [self, mode, '--scene', scene, '--batch', plan.batchDir, '--campaign', plan.campaignDir, '--http', plan.service.http, '--model', plan.service.model], { cwd: process.cwd() });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  return new Promise(resolve => {
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function childJson(outcome: ChildOutcome): Record<string, unknown> {
  for (const line of outcome.stdout.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.mode !== undefined) return parsed;
    } catch { /* keep scanning */ }
  }
  return { classification: 'unknown', reasons: [`child produced no JSON; exit ${String(outcome.code)}; stderr tail: ${outcome.stderr.slice(-400)}`], raw: outcome.stdout.slice(-600) };
}

async function cmdRun(plan: Plan): Promise<number> {
  for (const scene of SCENES) {
    if (existsSync(join(plan.batchDir, `scene-${scene}.json`))) {
      fail(`scene-${scene}.json already exists: this batch was already run (no re-spend)`);
    }
  }
  // Service precheck: ONE GET, counted separately, no smoke chat.
  let precheck = 'ok';
  try {
    const origin = new URL(plan.service.http).origin;
    const response = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) precheck = `HTTP ${String(response.status)}`;
  } catch (error) {
    precheck = error instanceof Error ? error.message : String(error);
  }
  if (precheck !== 'ok') {
    const path = join(plan.batchDir, 'offline-ready.json');
    writeFileSync(path, `${JSON.stringify({ schema: 'frostecho.g11-live.offline-ready/1', at: new Date().toISOString(), reason: precheck }, null, 2)}\n`);
    emit({ mode: 'run', classification: 'offline_ready', reasons: [precheck], path });
    return 3;
  }

  let exit = 0;
  const summary: Record<string, unknown> = { mode: 'run', precheckGet: 1, scenes: {} as Record<string, unknown> };
  for (const scene of SCENES) {
    const prefixOutcome = await runChild('prefix', scene, plan);
    const prefix = childJson(prefixOutcome);
    const sceneSummary: Record<string, unknown> = { prefix, suffix: null, overall: 'not_run' };
    if (prefixOutcome.code === 2) {
      // A child config error (same-name dir, bad baseline, bad plan) is exit 2
      // at the batch level too, with ZERO posts spent.
      sceneSummary.overall = String(prefix.classification ?? 'config_error');
      (summary.scenes as Record<string, unknown>)[scene] = sceneSummary;
      writeFileSync(join(plan.batchDir, `scene-${scene}.json`), `${JSON.stringify({ schema: SCENE_SCHEMA, at: new Date().toISOString(), ...sceneSummary }, null, 2)}\n`);
      emit(summary);
      return 2;
    }
    if (prefixOutcome.code === 0 && prefix.classification === 'goal_triggered') {
      const suffixOutcome = await runChild('suffix', scene, plan);
      const suffix = childJson(suffixOutcome);
      sceneSummary.suffix = suffix;
      if (suffixOutcome.code === 2) {
        sceneSummary.overall = String(suffix.classification ?? 'config_error');
        (summary.scenes as Record<string, unknown>)[scene] = sceneSummary;
        writeFileSync(join(plan.batchDir, `scene-${scene}.json`), `${JSON.stringify({ schema: SCENE_SCHEMA, at: new Date().toISOString(), ...sceneSummary }, null, 2)}\n`);
        emit(summary);
        return 2;
      }
      sceneSummary.overall = suffixOutcome.code === 0 && (suffix.classification === 'fulfilled' || suffix.classification === 'expired')
        ? 'success'
        : suffix.classification ?? 'technical_failure';
      if (sceneSummary.overall !== 'success') exit = 1;
    } else {
      sceneSummary.overall = String(prefix.classification ?? 'technical_failure');
      exit = 1;
    }
    (summary.scenes as Record<string, unknown>)[scene] = sceneSummary;
    writeFileSync(join(plan.batchDir, `scene-${scene}.json`), `${JSON.stringify({ schema: SCENE_SCHEMA, at: new Date().toISOString(), ...sceneSummary }, null, 2)}\n`);
    if (exit !== 0) {
      // Any scene failure stops the batch: later scenes stay not_run, zero cost.
      emit(summary);
      return exit;
    }
  }
  emit(summary);
  return exit;
}

/* ------------------------------------------------------------------ */
/* verify: read-only derivation from the disk records                  */
/* ------------------------------------------------------------------ */

interface WireLike { attemptId: string; phase: string; status: number | null; usage: { total_tokens: number | null } | null }
interface RecordLike {
  path: string;
  slot: string;
  scene: Scene;
  lineage: { baseCommit: string | null; parentSlot: string | null };
  wire: WireLike[];
  meta: { episodeId: string; providerKind: string; model: string | null };
  campaign: { campaignId: string; jsonPath: string; spentBefore: number; spentAfter: number; limit: number } | null;
}

function readRecord(path: string, scene: Scene): RecordLike | { error: string } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      payload: { lineage: RecordLike['lineage']; wire: WireLike[]; meta: RecordLike['meta']; campaign: RecordLike['campaign'] };
    };
    return { path, scene, slot: basename(path).replace(/\.run\.json$/, ''), lineage: raw.payload.lineage, wire: raw.payload.wire ?? [], meta: raw.payload.meta, campaign: raw.payload.campaign };
  } catch (error) {
    return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function cmdVerify(plan: Plan): number {
  const problems: string[] = [];
  const ledgerPath = campaignJsonPath(plan.campaignDir);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
    limit: number; spent: number;
    attempts: { attemptId: string; batch: string; episodeId: string; totalTokens: number | null; state: string }[];
  };
  const records: RecordLike[] = [];
  for (const scene of SCENES) {
    const dir = join(plan.batchDir, sceneDir(scene));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(name => name.endsWith('.run.json')).sort()) {
      const record = readRecord(join(dir, name), scene);
      if ('error' in record) problems.push(record.error);
      else records.push(record);
    }
  }

  // 1. Every reserve became exactly one wire record; no attempt counted twice.
  const wireIds = records.flatMap(record => record.wire.map(entry => entry.attemptId));
  const ledgerIds = ledger.attempts.map(attempt => attempt.attemptId);
  const duplicateWire = wireIds.filter((id, index) => wireIds.indexOf(id) !== index);
  if (duplicateWire.length > 0) problems.push(`wire attemptIds counted more than once: ${[...new Set(duplicateWire)].join(', ')}`);
  const missingWire = ledgerIds.filter(id => !wireIds.includes(id));
  if (missingWire.length > 0) problems.push(`ledger attempts with no wire record: ${missingWire.join(', ')}`);
  const orphanWire = wireIds.filter(id => !ledgerIds.includes(id));
  if (orphanWire.length > 0) problems.push(`wire records absent from the ledger: ${orphanWire.join(', ')}`);
  if (ledger.spent !== ledgerIds.length) problems.push(`ledger spent ${ledger.spent} but ${ledgerIds.length} attempts exist`);

  // 2. Cost aggregated by UNIQUE attemptId, once; ANY missing usage keeps the
  // grand total unknown (null) — an incomplete total is never reported as a
  // confident number (same invariant as src/needs/metrics.ts).
  const costByAttempt = new Map<string, number | null>();
  for (const attempt of ledger.attempts) costByAttempt.set(attempt.attemptId, attempt.totalTokens);
  const usageNull: string[] = [];
  let totalCost = 0;
  for (const [id, tokens] of costByAttempt) {
    if (tokens === null || tokens === undefined) usageNull.push(id);
    else totalCost += tokens;
  }
  const uniqueCost: number | null = usageNull.length === 0 ? totalCost : null;
  const wireUsageMismatch = records.flatMap(record => record.wire.filter(entry => {
    const ledgerTokens = costByAttempt.get(entry.attemptId) ?? null;
    const wireTokens = entry.usage?.total_tokens ?? null;
    return ledgerTokens !== wireTokens;
  }));
  if (wireUsageMismatch.length > 0) problems.push(`wire usage differs from the ledger for ${wireUsageMismatch.map(entry => entry.attemptId).join(', ')}`);

  // 3. Lineage: the suffix restored from the pre-close slot of ITS scene.
  for (const record of records) {
    const isSuffix = record.slot.endsWith('-wait-run');
    if (isSuffix) {
      const expected = join(plan.batchDir, sceneDir(record.scene), `${sceneDir(record.scene)}-wait.g09.json`);
      if (record.lineage.parentSlot !== expected) problems.push(`${record.slot}: parentSlot ${record.lineage.parentSlot} != ${expected}`);
      if (!existsSync(expected)) problems.push(`${record.slot}: parent slot ${expected} is missing`);
    } else if (record.lineage.parentSlot !== null) {
      problems.push(`${record.slot}: prefix parentSlot ${record.lineage.parentSlot} should be null`);
    }
  }

  // 4. Per-scene POST share and the campaign ceiling.
  const perScene = new Map<string, number>();
  for (const scene of SCENES) perScene.set(scene, records.filter(record => record.scene === scene).reduce((sum, record) => sum + record.wire.length, 0));
  for (const [scene, posts] of perScene) {
    if (posts > plan.authorization.maxPostsPerScene) problems.push(`${scene}: ${posts} posts > share ${plan.authorization.maxPostsPerScene}`);
  }
  if (wireIds.length > plan.authorization.totalPosts) problems.push(`${wireIds.length} total posts > authorization ${plan.authorization.totalPosts}`);
  if (ledger.limit !== plan.authorization.totalPosts) problems.push(`ledger limit ${ledger.limit} != plan ${plan.authorization.totalPosts}`);

  // 5. Slots: recorded hashes still match the files on disk.
  for (const scene of SCENES) {
    const scenePath = join(plan.batchDir, `scene-${scene}.json`);
    if (!existsSync(scenePath)) continue;
    const sceneJson = JSON.parse(readFileSync(scenePath, 'utf8')) as { prefix: { slotPath: string | null; slotSha256: string | null }; suffix: { slotSha256: string | null } | null };
    const recorded = sceneJson.prefix.slotSha256 ?? sceneJson.suffix?.slotSha256 ?? null;
    const slotPath = sceneJson.prefix.slotPath;
    if (recorded === null || slotPath === null) { problems.push(`scene-${scene}: no slot hash recorded`); continue; }
    if (!existsSync(slotPath)) { problems.push(`scene-${scene}: slot ${slotPath} is missing`); continue; }
    const current = sha256(slotPath);
    if (current.hash !== recorded) problems.push(`scene-${scene}: slot hash ${current.hash.slice(0, 12)} != recorded ${recorded.slice(0, 12)}`);
  }

  // 6. Scenes after a stop stay not_run at ZERO cost.
  const sceneOrder: Scene[] = [...SCENES];
  const stopped = sceneOrder.find(scene => {
    const path = join(plan.batchDir, `scene-${scene}.json`);
    return existsSync(path) && (JSON.parse(readFileSync(path, 'utf8')) as { overall: string }).overall !== 'success';
  });
  if (stopped !== undefined) {
    const index = sceneOrder.indexOf(stopped);
    for (const later of sceneOrder.slice(index + 1)) {
      const posts = perScene.get(later) ?? 0;
      if (posts !== 0) problems.push(`${later}: ran ${posts} posts although ${stopped} already failed`);
    }
  }

  const classification = SCENES.map(scene => {
    const path = join(plan.batchDir, `scene-${scene}.json`);
    const json = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { overall: string; prefix: { classification: string; modelChoice: { goal: string | null; action: string | null } } | null; suffix: { classification: string } | null }) : null;
    return { scene, overall: json?.overall ?? 'not_run', prefix: json?.prefix?.classification ?? '-', suffix: json?.suffix?.classification ?? '-', posts: perScene.get(scene) ?? 0, modelGoal: json?.prefix?.modelChoice?.goal ?? null };
  });
  const report = {
    schema: 'frostecho.g11-live.verify/1',
    at: new Date().toISOString(),
    ledger: { limit: ledger.limit, spent: ledger.spent, attempts: ledgerIds.length, uniqueCost, usageNull: usageNull.length },
    posts: { total: wireIds.length, perScene: Object.fromEntries(perScene) },
    classification,
    problems,
  };
  writeFileSync(join(plan.batchDir, 'verify.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.table(classification);
  console.log(JSON.stringify({ mode: 'verify', problems, ledger: report.ledger }));
  return problems.length === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(argv: string[]): Promise<number> {
  const args = parseCli(argv);
  if (args.mode === 'prepare') return cmdPrepare(args.batch, args.campaign, args.http, args.model, args.limit);
  if (args.mode === 'verify') {
    if (!existsSync(args.batch)) fail(`no batch dir ${args.batch}`);
    return cmdVerify(readPlan(args.batch));
  }
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
