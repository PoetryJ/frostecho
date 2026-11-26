#!/usr/bin/env node
/**
 * R11 (H): the pre-registered four-arm four-day matrix, the D2 exit/new-pid
 * resume, the post-resume interference stories, and the full-state controls.
 *
 * Why a new file instead of editing scripts/r10/run-matrix.mjs: the R10 runner
 * is the frozen evidence of the R10 matrix. R11 needs a save that provably
 * contains active commitments + work bound to the same instance/revision,
 * interference that only fires AFTER the new pid resumes, per-instance
 * opportunity denominators, and a byte-level state comparator. Keeping both
 * runners lets O reproduce either round without rewriting history.
 *
 * Commands
 *   node scripts/r11/run-matrix.mjs --freeze [--handoff <r11-handoff>]
 *   node scripts/r11/run-matrix.mjs --exposure [--out artifacts/r11/matrix]
 *   node scripts/r11/run-matrix.mjs --matrix [--out artifacts/r11/matrix]
 *        [--seeds r11h-1,r11h-2] [--only base-raw,fulfil-conditional]
 *        [--base-head p --base-manifest p --fulfil-head p --fulfil-manifest p]
 *   node scripts/r11/run-matrix.mjs --phase start|resume|replay-continuous|
 *        replay-segmented-start|replay-segmented-end --arm <id> --seed <s> --out <dir>
 *   node scripts/r11/run-matrix.mjs --verify --out <gameDir>
 *   node scripts/r11/run-matrix.mjs --tamper --out <gameDir>
 *   node scripts/r11/run-matrix.mjs --regenerate --out artifacts/r11/matrix
 *
 * Exit codes are evidence and never move:
 *   10 commitment input missing   11 no active+bound checkpoint
 *   12 head artifact              13 head manifest
 *   14 renderer                    15 head sha
 *   16 scorer/binding              17 settlement
 *   18 replay/state compare        19 internal
 *   20 matrix incomplete           21 restore mismatch
 *   22 tamper not detected         23 interference not exposed (warning)
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.FROSTECHO_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const require = createRequire(import.meta.url);

// Deterministic ids must be installed before any compiled game module loads.
const { installDeterministicIds, setUuidContext, peekUuid } = await import('./lib/ids.mjs');
installDeterministicIds('r11h-boot');
const { captureState, compareStates, applyTamper, canonical, sha } = await import('./lib/state.mjs');
const { collectInstanceMetrics, METRIC_SPEC, gapSelfTest } = await import('./lib/metrics.mjs');

const mod = rel => require(join(ROOT, 'dist', rel));
const { R8Runtime } = mod('src/r7/integration/runtime.js');
const { GameplayLoop } = mod('src/gameplay-v2/loop.js');
const { createCommitmentBridge } = mod('src/r7/integration/commitment-bridge.js');
const { runStep } = mod('src/r7/integration/step.js');
const { referenceAgencyScorer } = mod('src/r7/agency/reference.js');
const { makeChoiceResult } = mod('src/decision/contracts.js');
const { encodingEnvelope } = mod('src/r7/ui/joint-scorer.js');
const { GOSPEL_PROFILE, absoluteMinute } = mod('src/r7/contracts.js');
const { RENDERER_ID } = mod('src/r7/jev/render.js');
const { runCouncilIfDue, notesFor } = mod('scripts/r8/playthrough.js');
const { TaskBoard } = mod('src/gameplay-v2/tasks.js');
const { CommitmentBoard } = mod('src/gameplay-v2/commitments.js');
const { CouncilBoard } = mod('src/council-v2/council.js');
const { ExperienceStore } = mod('src/memory/experience.js');
const { LongTermMemory } = mod('src/r7/memory/long-term-memory.js');
const { BUILDINGS, MAPS, findPath } = mod('src/spatial-v2/map.js');

const PROFILE = GOSPEL_PROFILE;
const PYTHON = process.env.FROSTECHO_PYTHON ?? '/data/home/user_00/frostecho-r7/.venv/bin/python';
const ENCODER = process.env.FROSTECHO_ENCODER ?? '/data2/model_weights/Qwen3.8-27B';
const HANDOFF = process.env.FROSTECHO_HANDOFF ?? '/data/home/user_00/frostecho-r7/workbench/r11-handoff';
/** O's frozen integration identity (read-only); recorded next to every game. */
const O_FREEZE_PATH = join(HANDOFF, 'H', 'FREEZE.json');
const O_FREEZE = existsSync(O_FREEZE_PATH) ? JSON.parse(readFileSync(O_FREEZE_PATH, 'utf8')) : null;
const oFreezeSha = () => (O_FREEZE ? shaFile(O_FREEZE_PATH) : null);

const EXIT = {
  ok: 0, commitmentInput: 10, noPendingWork: 11, headArtifact: 12, headManifest: 13,
  headRenderer: 14, headSha: 15, scorer: 16, settlement: 17, replay: 18, internal: 19,
  matrixIncomplete: 20, restore: 21, tamper: 22, notExposed: 23,
};

/* ------------------------------------------------------------------ *
 * One frozen experiment. Every arm, seed and process gets this file.  *
 * ------------------------------------------------------------------ */
const SAVE_FROM_MINUTE = 1920; // D2 08:00 absolute
/**
 * Compact post-resume schedule. The cancels fire while the D2 work is still in
 * flight (+10 min, before its 15-minute due point), the follow-up delegation
 * replaces the cancelled promises, the drain creates real contention for the
 * last unit, the explicit refusal answers the resulting source proposal, and
 * the restock is the visible lifting of that failure condition.
 */
const OFFSETS = {
  cancelHeard: 10, cancelUnheard: 10, drain: 20, followUp: 20,
  relay: 30, rejectChange: 40, restock: 60, watch: 480,
};
// State-triggered steps have no early fallback: they wait for the real
// precondition and record the wait instead of manufacturing the outcome.
const SCENARIO = {
  schema: 'frostecho.r11.matrix-scenario/1',
  profile: PROFILE.id,
  npcCount: 8,
  start: { day: PROFILE.startDay, minuteOfDay: PROFILE.startMinuteOfDay },
  end: { day: PROFILE.endDay, minuteOfDay: PROFILE.endMinuteOfDay },
  resources: { food: 130, firewood: 30, power: 30, medicine: 3 },
  /**
   * Initial world condition, identical for every arm/seed: the warehouse is
   * nearly empty and npc_07 is already standing in it. Both are declared here
   * (not discovered after the fact) so the shortage/contention stories have a
   * real, visible game condition instead of a forbidden early completion.
   */
  initialWorld: {
    warehouseFood: 2, npc07Location: 'warehouse',
    /** A well-rested, well-fed starting cohort (same for every arm). */
    npcs: { hunger: 100, stamina: 100, health: 100, san: 80, bodyTemp: 36.5 },
  },
  commitments: [
    { actorId: 'npc_01', goal: 'deliver-meal', verdict: 'accept' },
    { actorId: 'npc_02', goal: 'deliver-meal', verdict: 'accept' },
    { actorId: 'npc_03', goal: 'supply-warehouse', verdict: 'accept' },
    { actorId: 'npc_04', goal: 'supply-warehouse', verdict: 'accept' },
  ],
  deadlines: { initial: absoluteMinute(PROFILE, 3, 18 * 60), delegation: absoluteMinute(PROFILE, 3, 18 * 60) },
  /**
   * D2 gate: the save only happens at a round >= D2 08:00 that has an active
   * commitment AND a working intent bound to that exact instance/revision.
   * If a legal early completion leaves the board empty, a pre-designed
   * delegation is issued first (same template for every arm).
   */
  checkpoint: {
    fromAbsoluteMinute: SAVE_FROM_MINUTE,
    requireActiveCommitment: true,
    requireBoundWorkingIntent: true,
    /**
     * A legal early completion can empty the board before D2. Then — and only
     * then — the harness issues this pre-designed delegation (supply-warehouse:
     * a real multi-step chain, so it cannot finish inside the same hour). The
     * goal, deadline and cap are frozen here, not chosen after seeing results.
     */
    delegation: { fromAbsoluteMinute: 2040, goal: 'supply-warehouse',
      verdict: 'accept', deadlineDay: 3, maxPerRound: 2, maxTotal: 4,
      maxActive: 2, selection: 'least-fatigued idle promisor (stamina desc, hunger desc, id asc)' },
  },
  /**
   * Interference is a pre-registered function of the save clock: the save
   * happens first, the new pid resumes, and only then do these fire.
   */
  interference: {
    anchor: 'saveClock',
    schedule: [
      { id: 'cancel-heard', kind: 'cancel', mode: 'heard', afterSaveMinutes: OFFSETS.cancelHeard,
        reason: '玩家当面改主意' },
      { id: 'cancel-unheard', kind: 'cancel', mode: 'unheard', afterSaveMinutes: OFFSETS.cancelUnheard,
        reason: '玩家只对旁人说起' },
      { id: 'offer-follow-up', kind: 'follow-up', afterSaveMinutes: OFFSETS.followUp,
        note: 'pre-designed delegation, issued only if the board has room' },
      { id: 'drain-for-contention', kind: 'drain', afterSaveMinutes: OFFSETS.drain, leave: 1 },
      { id: 'relay-unheard', kind: 'relay', afterSaveMinutes: OFFSETS.relay },
      { id: 'reject-source-change', kind: 'reject-change', afterSaveMinutes: OFFSETS.rejectChange,
        trigger: 'open-change', deadlineMinutes: null,
        reason: '不同意改源，按原约定' },
      { id: 'lift-old-failure', kind: 'restock', afterSaveMinutes: OFFSETS.restock, amount: 2,
        trigger: 'after-reject', deadlineMinutes: null,
        source: 'player-resupply' },
      { id: 'watch', kind: 'watch', afterSaveMinutes: OFFSETS.watch },
    ],
    followUp: { goal: 'deliver-meal', targetActive: 2, targetDeliverMeal: 2,
      deadlineDay: 3, maxTotal: 4 },
    witness: 'npc_05',
    drainer: 'npc_07',
  },
  clock: { maxRounds: 1600, nightSkipFromMinute: PROFILE.nightSkipFromMinute,
    nightSkipToMinute: PROFILE.nightSkipToMinute },
  memory: { topK: 12, budgetTokens: 640 },
  replay: { mode: 'recorded-reselection', countsAsModelResult: false },
  idFactory: 'deterministic-state-context/1',
  exclusions: ['pid', 'wallClock', 'latencyMs', 'serviceResidency'],
  scripts: {
    council: 'dist/scripts/r8/playthrough.js runCouncilIfDue (reference council/1)',
    rescue: 'playthrough rescue dispatch on rescue_needed',
    night: 'playthrough night skip + routed walk home',
    referencePolicy: 'reference-rules/1 over the same candidate set (no runner-side auto-withdraw)',
    livePolicy: 'real scorer; no rule fallback',
  },
};
const SCENARIO_SHA = sha(SCENARIO);

const ARMS = [
  { id: 'base-raw', family: 'live', recipe: 'base', memory: 'raw-last12' },
  { id: 'base-conditional', family: 'live', recipe: 'base', memory: 'obligation-first' },
  { id: 'fulfil-raw', family: 'live', recipe: 'fulfil', memory: 'raw-last12' },
  { id: 'fulfil-conditional', family: 'live', recipe: 'fulfil', memory: 'obligation-first' },
  { id: 'reference-raw', family: 'reference', recipe: null, memory: 'raw-last12' },
  { id: 'reference-conditional', family: 'reference', recipe: null, memory: 'obligation-first' },
];
const LIVE_ARMS = ARMS.filter(arm => arm.family === 'live');
const PROBE_ARM = { id: 'probe-bridge-first', family: 'probe', recipe: null,
  memory: 'obligation-first' };
const REFERENCE_ARMS = ARMS.filter(arm => arm.family === 'reference');
const ACTIVE = new Set(['active', 'pending-change', 'suspended', 'proposed']);
const TERMINAL = new Set(['fulfilled', 'cancelled', 'declined', 'withdrawn']);

/* ------------------------------ helpers ------------------------------ */
const arg = key => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = key => process.argv.includes(key);
const sortDeep = value => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
};
const shaFile = path => sha(readFileSync(path));
const rel = path => path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const SOURCE = { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD') };
const round3 = value => typeof value === 'number' ? Number(value.toFixed(3)) : value;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
}
function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function shaMap(dir, skip = new Set(['summary.json'])) {
  const out = {};
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const name = rel(path).slice(rel(dir).length + 1);
      if (skip.has(name)) continue;
      out[name] = shaFile(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/* --------------------------- head preflight --------------------------- */
function headSpec(arm) {
  if (arm.recipe === 'base') {
    return { label: arg('--base-label') ?? 'r11-base',
      head: arg('--base-head') ?? 'artifacts/r11/heads/base/warm-17.safetensors',
      manifest: arg('--base-manifest') ?? 'artifacts/r11/heads/base/training-manifest.json' };
  }
  return { label: arg('--fulfil-label') ?? 'r11-fulfil',
    head: arg('--fulfil-head') ?? 'artifacts/r11/heads/fulfil/warm-17.safetensors',
    manifest: arg('--fulfil-manifest') ?? 'artifacts/r11/heads/fulfil/training-manifest.json' };
}

const ALLOWED_LABEL_SOURCES = ['reference-imitation', 'same-snapshot-branch-rollout'];

/**
 * Validate the head BEFORE a world exists. C's R11 manifest is the single
 * source of head/corpus/feature/renderer/memory/encoding identity; a missing
 * or tampered field is a recorded refusal, never a half-started game and never
 * a fallback to rules.
 */
function preflightHead(arm) {
  const spec = headSpec(arm);
  const headPath = resolve(ROOT, spec.head);
  const manifestPath = resolve(ROOT, spec.manifest);
  const rendererSource = join(ROOT, 'src/r7/jev/render.ts');
  const checks = {
    headPath: rel(headPath), manifestPath: rel(manifestPath), rendererId: RENDERER_ID,
    rendererSourceSha256: shaFile(rendererSource),
    headExists: existsSync(headPath), manifestExists: existsSync(manifestPath),
  };
  const refuse = (code, reason) => ({ ok: false, code, reason, ...checks });
  if (!checks.headExists) return refuse(EXIT.headArtifact, 'head_artifact_missing');
  if (!checks.manifestExists) return refuse(EXIT.headManifest, 'head_manifest_missing');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { return refuse(EXIT.headManifest, `head_manifest_unreadable:${error.message}`); }
  const schema = String(manifest.schema ?? '');
  const r11 = schema === 'frostecho.training-manifest/r11';
  const legacy = schema === 'frostecho.action-weak-experiment/1';
  if (!r11 && !legacy) return refuse(EXIT.headManifest, `unexpected_manifest_schema:${schema}`);
  checks.schema = schema;
  checks.labelSource = manifest.labelSource ?? null;
  checks.manifestSha256 = shaFile(manifestPath);
  checks.headSha256 = shaFile(headPath);
  checks.selectedCheckpointSha256 = manifest.selectedCheckpointSha256 ?? null;
  checks.selectedCheckpoint = manifest.selectedCheckpoint ?? null;
  checks.featureIdentityHash = manifest.featureIdentityHash ?? null;
  checks.manifestRendererSourceSha256 = manifest.featureIdentity?.rendererSourceSha256 ?? null;
  checks.dimension = manifest.featureIdentity?.dimension ?? null;
  checks.manifestMemoryPolicy = manifest.memoryPolicy ?? null;
  checks.armMemory = arm.memory;
  checks.encodingExecution = manifest.encodingExecution ?? null;
  checks.encodingQualification = manifest.encodingQualification ?? null;
  checks.training = manifest.training ?? null;
  checks.admitted = manifest.countsAsAdmitted ?? null;
  checks.experimental = manifest.experimental ?? null;
  checks.rendererId = manifest.featureIdentity?.rendererId ?? RENDERER_ID;
  if (r11 && !ALLOWED_LABEL_SOURCES.includes(checks.labelSource))
    return refuse(EXIT.headManifest, `label_source_not_allowed:${checks.labelSource}`);
  if (!r11 && typeof checks.labelSource !== 'string')
    return refuse(EXIT.headManifest, 'legacy_manifest_lacks_label_source');
  if (checks.experimental !== true || checks.admitted !== false)
    return refuse(EXIT.headManifest, 'manifest_is_not_the_experimental_weak_experiment');
  if (manifest.selectedCheckpointSha256 !== checks.headSha256)
    return refuse(EXIT.headSha, 'head_sha_differs_from_manifest');
  if (manifest.selectedCheckpoint && basename(headPath) !== manifest.selectedCheckpoint)
    return refuse(EXIT.headSha, `head_file_${basename(headPath)}_differs_from_manifest_${manifest.selectedCheckpoint}`);
  if (checks.dimension !== 5120) return refuse(EXIT.headManifest, 'head_dimension_not_5120');
  if (checks.manifestRendererSourceSha256 !== checks.rendererSourceSha256)
    return refuse(EXIT.headRenderer, 'head_was_trained_on_another_renderer');
  if (!checks.featureIdentityHash) return refuse(EXIT.headManifest, 'head_manifest_lacks_feature_identity_hash');
  if (checks.encodingExecution?.batchSize !== 1 || checks.encodingExecution?.padMultiple !== 8)
    return refuse(EXIT.headManifest, 'encoding_batch_or_pad_not_qualified');
  if (typeof checks.encodingQualification?.sha256 !== 'string' || checks.encodingQualification.sha256.length === 0)
    return refuse(EXIT.headManifest, 'encoding_qualification_missing');
  if (r11 && checks.manifestMemoryPolicy
    && checks.manifestMemoryPolicy !== 'conditional-experience' && checks.manifestMemoryPolicy !== 'any')
    return refuse(EXIT.headManifest, `manifest_memory_policy_not_compatible:${checks.manifestMemoryPolicy}`);
  checks.manifestBinding = {
    mode: r11 ? 'r11-manifest' : 'r10-legacy-binding',
    headSha256: checks.headSha256, featureIdentityHash: checks.featureIdentityHash,
    manifestSha256: checks.manifestSha256, rendererId: checks.rendererId,
    labelSource: checks.labelSource,
  };
  return { ok: true, code: EXIT.ok, ...checks };
}

/**
 * C owns the single manifest contract. If its validator is present in this
 * worktree it is the gate; H's local checks stay as a readable pre-diagnosis
 * and never override a refusal. Before O merges C's branch the gate records
 * `available:false` instead of silently pretending it ran.
 */
async function sharedManifestGate(preflight) {
  const path = join(ROOT, 'scripts/r11/manifest-validator.mjs');
  if (!existsSync(path)) return { available: false, validator: rel(path) };
  try {
    const mod = await import(pathToFileURL(path).href);
    const result = mod.validateManifestFile(resolve(ROOT, preflight.manifestPath), {
      headPath: resolve(ROOT, preflight.headPath),
      rendererSource: join(ROOT, 'src/r7/jev/render.ts'),
      memoryPolicy: 'conditional-experience',
      memorySelection: preflight.armMemory,
      memoryTokenBudget: SCENARIO.memory.budgetTokens,
    });
    return { available: true, validator: rel(path), ok: true, result };
  } catch (error) {
    return { available: true, validator: rel(path), ok: false,
      code: error.code ?? 'refusal', detail: error.message };
  }
}

/* --------------------- world, commitments, bindings --------------------- */
function applyInitialWorld(runtime) {
  const npc07 = runtime.world.npcs.npc_07;
  if (npc07) {
    npc07.location = SCENARIO.initialWorld.npc07Location;
    runtime.world.spatial ??= { positions: {}, stocks: { warehouse: { food: 0 } },
      carry: {}, closedCells: [], deliveredMeals: 0 };
    runtime.world.spatial.positions.npc_07 = { ...BUILDINGS.find(row => row.id === 'warehouse').door };
  }
  for (const npc of Object.values(runtime.world.npcs)) {
    for (const [key, value] of Object.entries(SCENARIO.initialWorld.npcs)) {
      if (typeof npc[key] === 'number') npc[key] = value;
    }
    if (npc.id !== 'npc_07') npc.location = npc.location;
  }
  runtime.world.spatial.stocks.warehouse.food = SCENARIO.initialWorld.warehouseFood;
}

function buildWorld(seed, { seedCommitments = true } = {}) {
  installDeterministicIds(seed);
  setUuidContext(`bootstrap:${seed}`);
  const runtime = R8Runtime.create({ seed, profile: PROFILE, npcCount: SCENARIO.npcCount,
    resources: SCENARIO.resources });
  applyInitialWorld(runtime);
  const play = new GameplayLoop(runtime.session);
  const bridge = createCommitmentBridge(runtime, play);
  const seeds = [];
  if (seedCommitments) {
    for (const entry of SCENARIO.commitments) {
      setUuidContext(`bootstrap:${seed}:commitment:${entry.actorId}`);
      const requested = play.requestCommitment(entry.actorId, entry.goal,
        { verdict: entry.verdict, deadline: SCENARIO.deadlines.initial });
      seeds.push({ ...entry, commitmentId: requested.commitment.commitmentId,
        taskId: requested.task?.taskId ?? null, status: requested.commitment.status,
        deadline: requested.commitment.deadline, origin: 'initial' });
    }
  }
  return { runtime, play, bridge, seeds };
}

function commitmentInputReport(world) {
  const rows = world.play.commitments.all();
  const perPromisor = SCENARIO.commitments.map(entry => {
    const view = world.bridge.view(entry.actorId);
    const goals = view.goals.filter(goal => goal?.source === 'legacy-commitment');
    const row = rows.find(item => item.promisorId === entry.actorId);
    return { actorId: entry.actorId, goal: entry.goal,
      commitmentId: row?.commitmentId ?? null, commitmentStatus: row?.status ?? null,
      goalsInInput: goals.length, candidatesInInput: view.candidates.length,
      taskActive: row?.taskId ? world.play.board.find(row.taskId)?.status ?? null : null };
  });
  const problems = [];
  if (rows.length !== SCENARIO.commitments.length)
    problems.push(`commitments=${rows.length}/${SCENARIO.commitments.length}`);
  for (const entry of perPromisor) {
    if (entry.goalsInInput === 0) problems.push(`no_goal_in_input:${entry.actorId}`);
    if (entry.commitmentStatus !== 'active') problems.push(`not_active:${entry.actorId}:${entry.commitmentStatus}`);
    if (entry.taskActive !== 'active') problems.push(`no_active_task:${entry.actorId}:${entry.taskActive}`);
  }
  return { passed: problems.length === 0, problems, perPromisor,
    commitments: rows.length, active: rows.filter(row => row.status === 'active').length };
}

function worldInit(runtime, world) {
  const snapshot = runtime.snapshot();
  return {
    seed: runtime.session.seed, profile: PROFILE.id, simTime: runtime.world.simTime,
    resources: snapshot.resources,
    spatial: runtime.world.spatial,
    npcs: Object.values(snapshot.npcs).map(npc => ({ id: npc.id, location: npc.location,
      alive: npc.alive, hunger: npc.hunger, stamina: npc.stamina, health: npc.health,
      san: npc.san, bodyTemp: npc.bodyTemp })).sort((a, b) => a.id.localeCompare(b.id)),
    commitments: world.seeds.map(item => ({ actorId: item.actorId, goal: item.goal,
      commitmentId: item.commitmentId, taskId: item.taskId, status: item.status,
      deadline: item.deadline })),
    memoryBudget: SCENARIO.memory.budgetTokens,
  };
}

function activeRows(play) {
  return play.commitments.all().filter(row => ACTIVE.has(row.status));
}
function workingIntents(runtime) {
  return [...runtime.intents.values()].filter(intent => intent.status === 'working');
}
function boundIntents(runtime, row) {
  return workingIntents(runtime).filter(intent => intent.commitmentId === row.commitmentId
    && (intent.commitmentRevision === null || intent.commitmentRevision === row.revision));
}
function checkpointState(runtime, play) {
  const active = activeRows(play).map(row => ({
    commitmentId: row.commitmentId, promisorId: row.promisorId, goal: row.goal,
    revision: row.revision, status: row.status, deadline: row.deadline,
    taskId: row.taskId, createdAt: row.createdAt,
    boundWorkingIntents: boundIntents(runtime, row).map(intent => ({
      intentId: intent.intentId, action: String(intent.candidate.parameters.action),
      startedAt: intent.startedAt, dueAt: intent.dueAt,
      commitmentId: intent.commitmentId, commitmentRevision: intent.commitmentRevision,
      generation: intent.generation, taskId: intent.taskId })),
  }));
  const working = workingIntents(runtime);
  return {
    at: runtime.world.simTime,
    activeCommitments: active.length,
    boundWorkingIntents: active.reduce((sum, row) => sum + row.boundWorkingIntents.length, 0),
    pending: working.length,
    commitments: active,
    intents: working.map(intent => ({ intentId: intent.intentId, actorId: intent.actorId,
      action: String(intent.candidate.parameters.action), startedAt: intent.startedAt,
      dueAt: intent.dueAt, commitmentId: intent.commitmentId,
      commitmentRevision: intent.commitmentRevision, taskId: intent.taskId,
      generation: intent.generation })),
    generations: Object.fromEntries([...runtime.session.generations.entries()].sort()),
  };
}

/* ------------------------------ scorers ------------------------------ */
class LiveScorer {
  constructor(command, { transcript, timeoutMs = 300000, binding = null } = {}) {
    this.command = command; this.transcript = transcript; this.timeoutMs = timeoutMs;
    this.binding = binding; this.child = null; this.pending = new Map(); this.pinned = null;
    this.identity = { mode: 'jev-experimental', scorerId: 'jev-joint-c/1',
      rendererId: RENDERER_ID, experimental: true, countsAsAdmitted: false };
    this.forwardCalls = 0; this.requests = 0; this.singleCandidateSkips = 0; this.timeouts = 0;
    this.ready = null; this.stderrBuffer = ''; this.serviceStartedAt = null;
    this.serviceClosedAt = null; this.servicePids = [];
    if (transcript) mkdirSync(dirname(transcript), { recursive: true });
  }

  record(value) {
    if (this.transcript) appendFileSync(this.transcript,
      JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', 'utf8');
  }

  start() {
    if (this.child) return this.child;
    const child = spawn(this.command[0], this.command.slice(1), { cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child; this.serviceStartedAt = new Date().toISOString();
    if (typeof child.pid === 'number') this.servicePids.push(child.pid);
    const fail = error => {
      for (const [id, row] of this.pending) {
        if (row.child !== child) continue;
        clearTimeout(row.timer); this.pending.delete(id); row.reject(error);
      }
    };
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const reply = JSON.parse(line);
        this.record({ event: 'score_reply', reply });
        const key = typeof reply.requestId === 'string' ? reply.requestId : undefined;
        const waiting = key ? this.pending.get(key) : undefined;
        if (!waiting) return;
        this.pending.delete(key); clearTimeout(waiting.timer); waiting.resolve(reply);
      } catch (error) { fail(new Error(`scorer_protocol:${error.message}`)); }
    });
    child.stderr.on('data', data => {
      const text = String(data);
      this.record({ event: 'scorer_stderr', text });
      this.stderrBuffer += text;
      const lines = this.stderrBuffer.split('\n');
      this.stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === 'ready') this.ready = parsed;
        } catch { /* diagnostics */ }
      }
    });
    child.on('error', error => { if (this.child === child) this.child = null; fail(error); });
    child.on('exit', code => {
      if (this.child === child) this.child = null;
      this.serviceClosedAt = new Date().toISOString();
      this.record({ event: 'scorer_exit', code });
      fail(new Error(`scorer_process_exited:${code}`));
    });
    this.record({ event: 'scorer_start', command: this.command, pid: child.pid ?? null });
    return child;
  }

  async score(request) {
    if (request.candidates.length === 1) {
      this.singleCandidateSkips += 1;
      return makeChoiceResult({ request, scorerId: 'single-candidate/1',
        scores: [{ candidateId: request.candidates[0].id, logit: 0 }],
        disposition: 'accept', selectedId: request.candidates[0].id,
        reason: 'deterministic sole candidate; no model call' });
    }
    if (this.pending.has(request.requestId)) throw new Error('duplicate_live_requestId');
    const envelope = encodingEnvelope(request, ROOT);
    this.requests += 1;
    this.record({ event: 'score_request', envelope });
    const reply = await new Promise((resolveReply, reject) => {
      const child = this.start();
      const timer = setTimeout(() => {
        this.timeouts += 1;
        this.record({ event: 'score_timeout', requestId: request.requestId });
        if (this.child === child) this.child = null;
        for (const [id, row] of this.pending) {
          if (row.child !== child) continue;
          clearTimeout(row.timer); this.pending.delete(id); row.reject(new Error('scorer_timeout'));
        }
        child.kill();
      }, this.timeoutMs);
      this.pending.set(request.requestId, { resolve: resolveReply, reject, timer, child });
      child.stdin.write(`${JSON.stringify(envelope)}\n`, error => {
        if (error) { clearTimeout(timer); this.pending.delete(request.requestId); reject(error); }
      });
    });
    if (reply.error) throw new Error(`scorer_error:${reply.error}`);
    if (reply.requestId !== request.requestId
      || reply.candidateSetHash !== request.candidateSetHash
      || reply.inputSha256 !== envelope.inputSha256)
      throw new Error('scorer_reply_does_not_bind_request');
    const identity = reply.identity;
    if (!identity || identity.mode !== 'jev-experimental' || identity.experimental !== true
      || identity.countsAsAdmitted !== false || identity.rendererId !== RENDERER_ID)
      throw new Error(`untrusted_experimental_scorer_identity:${identity?.rendererId}`);
    if (typeof identity.encoderForwardCalls === 'number')
      this.forwardCalls = Math.max(this.forwardCalls, identity.encoderForwardCalls);
    if (this.binding) {
      if (identity.headSha256 !== this.binding.headSha256)
        throw new Error(`head_sha_differs_from_manifest:${identity.headSha256}`);
      if (identity.featureIdentityHash !== this.binding.featureIdentityHash)
        throw new Error(`online_feature_identity_differs:${identity.featureIdentityHash}`);
      const manifestSeen = identity.trainingManifestSha256 ?? identity.manifestSha256 ?? null;
      if (manifestSeen === null)
        throw new Error('scorer_reply_lacks_manifest_sha256');
      if (manifestSeen !== this.binding.manifestSha256)
        throw new Error(`scorer_manifest_sha256_differs:${manifestSeen}`);
      if (identity.rendererId !== this.binding.rendererId)
        throw new Error(`renderer_differs:${identity.rendererId}`);
    }
    const counters = new Set(['requestsReceived', 'scoresSucceeded', 'requestsFailed',
      'encoderForwardCalls', 'encoderForwardAttempts']);
    const pinned = canonical(Object.entries(identity)
      .filter(([key]) => !counters.has(key)).sort(([a], [b]) => a.localeCompare(b)));
    if (this.pinned !== null && this.pinned !== pinned) throw new Error('scorer_identity_changed');
    this.pinned = pinned; this.identity = { ...identity };
    return makeChoiceResult({ request, scorerId: identity.scorerId, scores: reply.scores,
      selectedId: reply.selectedId ?? null, disposition: reply.disposition,
      reason: String(reply.reason ?? 'joint encoder score') });
  }

  close() {
    for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error('scorer_closed')); }
    this.pending.clear();
    const child = this.child; this.child = null;
    if (child) { child.stdin.end(); child.kill(); this.serviceClosedAt = new Date().toISOString(); }
  }

  stats() {
    const wall = this.serviceStartedAt
      ? (Date.parse(this.serviceClosedAt ?? new Date().toISOString()) - Date.parse(this.serviceStartedAt)) / 1000
      : 0;
    return { requests: this.requests, singleCandidateSkips: this.singleCandidateSkips,
      timeouts: this.timeouts, forwardCalls: this.forwardCalls,
      serviceWallSeconds: Math.max(0, wall), servicePids: [...this.servicePids],
      serviceStartedAt: this.serviceStartedAt, serviceClosedAt: this.serviceClosedAt,
      identity: this.identity };
  }
}

class ReplayScorer {
  constructor(rows) {
    this.byRequest = new Map(rows.map(row => [row.requestId, row]));
    this.byCandidateSet = new Map(rows.map(row => [`${row.actorId}|${row.candidateSetHash}`, row]));
    this.used = new Set(); this.mismatches = [];
    this.identity = { mode: 'reference', scorerId: 'r11-replay/1', rendererId: RENDERER_ID,
      experimental: false, countsAsAdmitted: false };
  }

  score(request) {
    const hit = this.byRequest.get(request.requestId)
      ?? this.byCandidateSet.get(`${request.actorId}|${request.candidateSetHash}`);
    if (hit) this.used.add(hit.requestId);
    if (!hit || hit.candidateSetHash !== request.candidateSetHash) {
      const nextUnused = [...this.byRequest.values()]
        .filter(row => !this.used.has(row.requestId)).slice(0, 4)
        .map(row => ({ requestId: row.requestId, actorId: row.actorId,
          candidateSetHash: row.candidateSetHash, at: row.at }));
      this.mismatches.push({ requestId: request.requestId, actorId: request.actorId,
        expected: hit?.candidateSetHash ?? null, actual: request.candidateSetHash,
        expectedCandidates: (hit?.candidates ?? []).map(candidate => candidate.id),
        actualCandidates: request.candidates.map(candidate => candidate.id),
        expectedParams: (hit?.candidates ?? []).map(candidate => [candidate.id,
          candidate.parameters.commitmentId ?? null, candidate.parameters.bridgeStep ?? null]),
        actualParams: request.candidates.map(candidate => [candidate.id,
          candidate.parameters.commitmentId ?? null, candidate.parameters.bridgeStep ?? null]),
        nextUnused, reason: hit ? 'candidate_set_changed' : 'request_not_recorded' });
      throw new Error(`replay_request_mismatch:${request.requestId}:`
        + `${hit ? 'candidate_set_changed' : 'not_recorded'}:next=`
        + nextUnused.map(row => `${row.requestId}/${row.actorId}`).join(','));
    }
    return makeChoiceResult({ request, scorerId: 'r11-replay/1',
      scores: request.candidates.map(candidate => ({ candidateId: candidate.id,
        logit: Number(candidate.id === hit.selectedId) })),
      disposition: hit.selectedId ? 'accept' : 'abstain',
      selectedId: hit.selectedId ?? null, reason: `replay:${hit.requestId}` });
  }

  stats() {
    return { recorded: this.byRequest.size, used: this.used.size,
      unused: this.byRequest.size - this.used.size, mismatches: this.mismatches };
  }
}

/**
 * Scenario-exposure probe (control only, never a model result): take the first
 * candidate the commitment bridge actually offered. It proves the world puts
 * the four stories in front of a decision maker; the reference arm is measured
 * separately on exactly the same offers.
 */
function bridgeFirstScorer() {
  const fallback = referenceAgencyScorer();
  return {
    identity: { ...fallback.identity, scorerId: 'r11-probe/bridge-first' },
    score(request) {
      const hit = request.candidates.find(candidate =>
        typeof candidate.parameters?.commitmentId === 'string');
      if (!hit) return fallback.score(request);
      return makeChoiceResult({ request, scorerId: 'r11-probe/bridge-first',
        scores: request.candidates.map(candidate => ({ candidateId: candidate.id,
          logit: candidate.id === hit.id ? 1 : 0 })),
        disposition: 'accept', selectedId: hit.id,
        reason: 'scenario probe: first bridge candidate' });
    },
  };
}

function scorerFor(arm, options) {
  if (arm.family === 'live') return new LiveScorer(options.command, options);
  if (arm.family === 'probe') return bridgeFirstScorer();
  return referenceAgencyScorer();
}

/* ------------------------------ loop ---------------------------------- */
function gameplayOn(runtime, path) {
  const read = suffix => readJson(`${path}.${suffix}.json`);
  const tasks = read('tasks');
  const commitments = read('commitments');
  const council = read('council');
  const experience = read('experience');
  const memoryDoc = read('long-term-memory');
  return new GameplayLoop(runtime.session,
    tasks ? TaskBoard.fromJSON(tasks) : new TaskBoard(),
    { ...(commitments ? { commitments: CommitmentBoard.fromJSON(commitments) } : {}),
      ...(council ? { council: CouncilBoard.fromJSON(council) } : {}),
      ...(experience ? { experience: ExperienceStore.fromJSON(experience) } : {}),
      ...(memoryDoc ? { longTermMemory: LongTermMemory.restore(memoryDoc.memory),
        decisionMemoryMode: memoryDoc.mode, decisionMemoryTokenBudget: memoryDoc.tokenBudget } : {}) });
}

function nextScheduledIntervention(ctx) {
  if (!['resume', 'continuous-resume', 'segmented-resume'].includes(ctx.phase)) return null;
  const pending = ctx.schedule.filter(entry => !entry.applied
    && entry.at > ctx.runtime.world.simTime);
  if (pending.length === 0) return null;
  return Math.min(...pending.map(entry => entry.at));
}

function advanceOneRound(ctx) {
  const { runtime } = ctx;
  const before = runtime.world.simTime;
  const snapshot = runtime.snapshot();
  const night = snapshot.minuteOfDay >= PROFILE.nightSkipFromMinute
    || snapshot.minuteOfDay < PROFILE.nightSkipToMinute;
  let to;
  if (night) {
    const dayStart = Math.floor(before / PROFILE.minutesPerDay) * PROFILE.minutesPerDay;
    // R11 fix (runner only): the R10 expression computed the NEXT day's 06:00
    // even at 04:00, so a night leg that stopped at 04:00 then jumped 24h and
    // skipped the D2 08:00 checkpoint window entirely. Wake is the next 06:00.
    const wake = snapshot.minuteOfDay < PROFILE.nightSkipToMinute
      ? dayStart + PROFILE.nightSkipToMinute
      : dayStart + PROFILE.minutesPerDay + PROFILE.nightSkipToMinute;
    to = Math.min(wake, before + 8 * 60);
    for (const actorId of runtime.context().actorIds) {
      const npc = runtime.world.npcs[actorId];
      if (!npc?.alive) continue;
      const home = actorId.endsWith('2') || actorId.endsWith('4') ? 'dorm-b' : 'dorm-a';
      if (npc.location === home) continue;
      if (runtime.legacyPosition(actorId)) {
        runtime.travelLegacyTo(actorId, home, `sleep-${before}-${actorId}`);
        continue;
      }
      const door = BUILDINGS.find(building => building.id === home)?.door;
      const from = runtime.world.spatial?.positions[actorId]
        ?? BUILDINGS.find(building => building.id === npc.location)?.door;
      if (!door || !from) continue;
      const closed = new Set(runtime.world.spatial?.closedCells ?? []);
      const path = findPath(MAPS.village, from, door, closed).path;
      if (!path || path.length === 0) continue;
      const result = runtime.session.submitWorldCommand({ commandId: `sleep-${before}-${actorId}`,
        type: 'travel', actorId, route: path, minutesPerTile: 2 });
      if (result.status === 'applied') runtime.recordCommitted(result.events);
    }
  } else {
    to = Math.floor(before / 60) * 60 + 60;
  }
  const interventionAt = nextScheduledIntervention(ctx);
  if (interventionAt !== null && interventionAt > before && interventionAt < to) to = interventionAt;
  if (snapshot.furnace.lit) ctx.furnaceLitHours += Math.max(0, to - before) / 60;
  const report = runtime.advanceWorld(to);
  if (process.env.R11_DEBUG) {
    console.error(`[debug-advance] ${before} -> ${to} (now ${runtime.world.simTime})`);
  }
  ctx.timeline.push(...report.domainEvents.map(event => ({ at: runtime.world.simTime,
    type: event.type, actorId: event.actorId })));
  if (!night) {
    for (const event of runtime.journal.slice(-report.domainEvents.length)) {
      if (event.type !== 'rescue_needed') continue;
      const rescuer = runtime.context().actorIds
        .filter(id => runtime.snapshot().npcs[id]?.alive)
        .sort((left, right) => runtime.snapshot().npcs[right].health
          - runtime.snapshot().npcs[left].health)[0];
      if (rescuer) runtime.dispatch('crises', 'rescue', rescuer, { victimId: event.payload.actorId });
    }
  }
  if (runtime.world.simTime === before) ctx.noProgressRounds += 1;
  ctx.resourceSamples.push(sampleResources(runtime, 'advance'));
  return { before, to, advanced: runtime.world.simTime !== before };
}

function sampleResources(runtime, reason) {
  const resources = runtime.snapshot().resources;
  return { at: runtime.world.simTime, reason,
    resources: { food: resources.food, firewood: resources.firewood, power: resources.power,
      medicine: resources.medicine } };
}

async function decideAll(ctx) {
  const { runtime } = ctx;
  const snapshot = runtime.snapshot();
  for (const actorId of runtime.context().actorIds) {
    // R11: the R10 runner force-withdrew every promise when a reference actor
    // was merely tired/hungry. That consumed the very interference this round
    // exists to measure (zero opportunity is not a zero violation). The
    // reference now chooses from the SAME candidate set as everyone else; the
    // bridge still offers `withdraw-commitment` at real survival extremes.
    setUuidContext(`decide:${ctx.seed}:${runtime.world.simTime}:${runtime.world.version}:${actorId}`);
    const result = await runStep(runtime, ctx.scorer, { actorIds: [actorId],
      mode: ctx.arm.family === 'live' ? 'jev-experimental' : 'reference',
      memorySelection: ctx.arm.memory, memoryPolicy: 'conditional-experience',
      memoryTokenBudget: SCENARIO.memory.budgetTokens, goalBridge: ctx.bridge,
      notes: id => notesFor(runtime, id, 'conditional-experience') });
    for (const record of result.records) {
      ctx.decisions.push({ ...record, seed: ctx.seed, arm: ctx.arm.id, phase: ctx.phase,
        policy: ctx.arm.family === 'live' ? 'model' : 'reference-rules',
        at: runtime.world.simTime, day: snapshot.day, minuteOfDay: snapshot.minuteOfDay });
    }
    if (runtime.ended) break;
  }
}

/* --------------------------- delegations --------------------------- */
function idlePromisors(ctx, count) {
  const active = new Set(activeRows(ctx.play).map(row => row.promisorId));
  const busy = new Set(workingIntents(ctx.runtime).map(intent => intent.actorId));
  const excluded = new Set([SCENARIO.interference.drainer, SCENARIO.interference.witness]);
  const rows = [];
  for (let index = 1; index <= SCENARIO.npcCount; index += 1) {
    const actorId = `npc_${String(index).padStart(2, '0')}`;
    const npc = ctx.runtime.world.npcs[actorId];
    if (!npc?.alive) continue;
    if (active.has(actorId) || busy.has(actorId) || excluded.has(actorId)) continue;
    // Only assign work to a resident who is not in immediate need. This is a
    // pre-registered, arm-independent condition (hunger >= 40, stamina >= 30,
    // health >= 40), not a peek at any model's preferences.
    const inNeed = npc.hunger < 40 || npc.stamina < 30 || npc.health < 40 ? 1 : 0;
    rows.push({ actorId, inNeed, atWarehouse: npc.location === 'warehouse' ? 1 : 0,
      stamina: npc.stamina, hunger: npc.hunger, bodyTemp: npc.bodyTemp ?? 36.5 });
  }
  // Pre-registered selection: able-bodied first, then a resident already at the
  // work site, then the least fatigued. Applied identically to every arm.
  rows.sort((left, right) => left.inNeed - right.inNeed
    || right.atWarehouse - left.atWarehouse
    || right.stamina - left.stamina || right.hunger - left.hunger
    || right.bodyTemp - left.bodyTemp || left.actorId.localeCompare(right.actorId));
  if (process.env.R11_DEBUG) {
    console.error('[debug-idle] at=' + ctx.runtime.world.simTime + ' '
      + JSON.stringify(rows.map(row => [row.actorId, row.atWarehouse, Math.round(row.stamina)])));
  }
  return rows.slice(0, count).map(row => row.actorId);
}

function delegate(ctx, actorId, origin, reason,
  goal = SCENARIO.checkpoint.delegation.goal) {
  if (ctx.delegations.some(row => row.origin === origin && row.promisorId === actorId)) return null;
  setUuidContext(`delegate:${ctx.seed}:${ctx.runtime.world.simTime}:${origin}:${actorId}`);
  const at = ctx.runtime.world.simTime;
  const requested = ctx.play.requestCommitment(actorId, goal,
    { verdict: 'accept', deadline: SCENARIO.deadlines.delegation,
      inputId: `delegate-${origin}-${ctx.seed}-${actorId}-${at}`, source: 'pre-registered-delegation' });
  if (process.env.R11_DEBUG) {
    console.error('[debug-delegate-row] ' + origin + ' ' + actorId + ' at=' + at
      + ' id=' + requested.commitment.commitmentId + ' status=' + requested.commitment.status);
  }
  const row = {
    commitmentId: requested.commitment.commitmentId, promisorId: actorId,
    goal, origin, at, reason,
    taskId: requested.task?.taskId ?? null, status: requested.commitment.status,
    deadline: requested.commitment.deadline,
  };
  ctx.delegations.push(row);
  return row;
}

function checkpointSatisfied(ctx) {
  const state = checkpointState(ctx.runtime, ctx.play);
  return state.activeCommitments > 0 && state.boundWorkingIntents > 0;
}

function applyStartEvents(ctx) {
  const clock = ctx.runtime.world.simTime;
  const config = SCENARIO.checkpoint.delegation;
  if (clock < config.fromAbsoluteMinute) return;
  if (checkpointSatisfied(ctx)) return;
  const delegated = ctx.delegations.filter(row => row.origin === 'checkpoint-delegation');
  if (delegated.length >= config.maxTotal) return;
  // A legal early completion emptied the board: use the pre-designed delegation
  // so the D2 save still contains a real promise and real work for it.
  const active = activeRows(ctx.play);
  const need = Math.min(config.maxPerRound, Math.max(0, config.maxActive - active.length));
  if (need <= 0) {
    if (process.env.R11_DEBUG) {
      console.error('[debug-delegate-skip] at=' + clock + ' active='
        + JSON.stringify(active.map(row => [row.promisorId, row.goal, row.status])));
    }
    return;
  }
  const chosen = idlePromisors(ctx, need);
  if (process.env.R11_DEBUG) {
    console.error(`[debug-delegate] at=${clock} chosen=${JSON.stringify(chosen)}`
      + ` delegated=${delegated.length} active=${active.length}`
      + ` working=${workingIntents(ctx.runtime).length}`);
  }
  for (const actorId of chosen) {
    const row = delegate(ctx, actorId, 'checkpoint-delegation', 'legal-early-completion');
    if (row && !ctx.checkpointDelegation) {
      ctx.checkpointDelegation = { at: clock, delegationIds: [] };
    }
    if (row) ctx.checkpointDelegation.delegationIds.push(row.commitmentId);
  }
}

/* --------------------------- interference --------------------------- */
function initialiseSchedule(ctx) {
  const saveClock = ctx.runtime.world.simTime;
  ctx.schedule = SCENARIO.interference.schedule.map(entry => ({
    ...entry, at: saveClock + entry.afterSaveMinutes,
    deadlineAt: typeof entry.deadlineMinutes === 'number'
      ? saveClock + entry.deadlineMinutes : null,
    applied: false, target: null, appliedAt: null, detail: null, waitedFor: null,
  }));
  ctx.rejectApplied = false;
}

function ensureFollowUps(ctx) {
  // Pre-designed follow-up delegations provide the remaining story
  // opportunities if the saved promises were cancelled or finished early.
  // Issued only to an idle, able-bodied promisor; capped and deterministic.
  const config = SCENARIO.interference.followUp;
  let guard = 0;
  while (guard < 6) {
    guard += 1;
    const active = activeRows(ctx.play);
    const deliver = active.filter(row => row.goal === 'deliver-meal');
    if (active.length >= config.targetActive && deliver.length >= config.targetDeliverMeal) break;
    if (ctx.delegations.filter(row => row.origin.startsWith('follow-up')).length >= config.maxTotal) break;
    const needDeliver = deliver.length < config.targetDeliverMeal;
    const chosen = idlePromisors(ctx, 1);
    if (chosen.length === 0) break;
    delegate(ctx, chosen[0], needDeliver ? 'follow-up-deliver' : 'follow-up',
      'post-save-opportunity', config.goal);
  }
}

function applyResumeStart(ctx) {
  // Before the first advance of the new pid: pre-designed follow-up delegations
  // provide the remaining story opportunities if the promises finished early.
  ensureFollowUps(ctx);
}

function pickCancelTargets(ctx) {
  const rows = activeRows(ctx.play).map(row => {
    const intents = boundIntents(ctx.runtime, row);
    const latestDue = intents.length ? Math.max(...intents.map(intent => intent.dueAt)) : -1;
    return { row, intents, latestDue };
  }).sort((a, b) => b.latestDue - a.latestDue
    || a.row.createdAt - b.row.createdAt || a.row.commitmentId.localeCompare(b.row.commitmentId));
  return rows;
}

function applyCancel(ctx, entry, row, witness) {
  const inFlight = boundIntents(ctx.runtime, row).map(intent => intent.intentId);
  const result = ctx.play.cancelCommitment(row.commitmentId, {
    heardBy: entry.mode === 'heard' ? [row.promisorId, witness] : [witness],
    reason: entry.reason,
  });
  // The bridge's cancel listener already revokes queued work inside
  // cancelCommitment; measure the result by the saved intent ids instead of
  // calling cancelForCommitment a second time (which would report 0).
  const cancelled = inFlight.filter(id => ctx.runtime.intents.get(id)?.status === 'cancelled');
  return { commitmentId: row.commitmentId, promisorId: row.promisorId, goal: row.goal,
    revision: row.revision, mode: entry.mode, status: result.commitment.status,
    heardBy: entry.mode === 'heard' ? [row.promisorId, witness] : [witness],
    inFlightAtCancel: inFlight.length, boundIntentsCancelled: cancelled.length,
    cancelledIntentIds: cancelled,
  };
}

function applyInterventions(ctx) {
  const now = ctx.runtime.world.simTime;
  const hasOpenChange = () => activeRows(ctx.play)
    .some(row => (row.changes ?? []).some(change => change.status === 'open'));
  for (const entry of ctx.schedule) {
    if (entry.applied || entry.at > now) continue;
    // State-triggered steps: the world decides when the precondition exists.
    // The frozen rule names the trigger and the latest fallback time; the
    // actual minute and the wait are recorded.
    if (entry.trigger === 'open-change' && !hasOpenChange()
      && (entry.deadlineAt === null || now < entry.deadlineAt)) {
      entry.waitedFor ??= now;
      continue;
    }
    if (entry.trigger === 'after-reject' && !ctx.rejectApplied
      && (entry.deadlineAt === null || now < entry.deadlineAt)) {
      entry.waitedFor ??= now;
      continue;
    }
    entry.applied = true;
    entry.appliedAt = now;
    entry.lateBy = now - entry.at;
    entry.waitedMinutes = entry.waitedFor === null || entry.waitedFor === undefined
      ? 0 : now - entry.waitedFor;
    try {
      if (entry.kind === 'cancel') {
        const targets = pickCancelTargets(ctx);
        const used = new Set((ctx.interferenceTargets?.cancel ?? []).map(row => row.commitmentId));
        const target = targets.find(row => !used.has(row.row.commitmentId))?.row ?? null;
        if (!target) { entry.detail = { applied: false, reason: 'no_active_instance' }; continue; }
        ctx.interferenceTargets.cancel.push(applyCancel(ctx, entry, target,
          SCENARIO.interference.witness));
        entry.target = { commitmentId: target.commitmentId };
        entry.detail = ctx.interferenceTargets.cancel.at(-1);
        continue;
      }
      if (entry.kind === 'relay') {
        const unheard = ctx.interferenceTargets.cancel.find(row => row.mode === 'unheard');
        if (!unheard) { entry.detail = { applied: false, reason: 'no_unheard_cancel' }; continue; }
        const relayed = ctx.play.relayCancellation(unheard.commitmentId, {
          tellerId: SCENARIO.interference.witness,
          audience: [unheard.promisorId, SCENARIO.interference.witness],
        });
        entry.target = { commitmentId: unheard.commitmentId };
        entry.detail = relayed ? { applied: true, told: relayed.told,
          from: SCENARIO.interference.witness } : { applied: false, reason: 'teller_never_heard' };
        continue;
      }
      if (entry.kind === 'follow-up') {
        const before = ctx.delegations.length;
        ensureFollowUps(ctx);
        const added = ctx.delegations.slice(before);
        entry.detail = { applied: added.length > 0, added };
        if (added.length > 0) entry.target = { commitments: added.map(row => row.commitmentId) };
        continue;
      }
      if (entry.kind === 'drain') {
        const stock = ctx.runtime.world.spatial?.stocks?.warehouse?.food ?? null;
        if (stock === null) { entry.detail = { applied: false, reason: 'no_spatial' }; continue; }
        const drainer = SCENARIO.interference.drainer;
        const amount = Math.max(0, stock - entry.leave);
        if (amount <= 0) {
          entry.detail = { applied: false, reason: 'already_at_or_below_leave', stock };
          ctx.interferenceTargets.contention = {
            at: now, stockBefore: stock, stockAfter: stock, targets: [] };
          continue;
        }
        const command = { commandId: `r11-drain-${ctx.seed}-${now}`,
          type: 'withdraw', actorId: drainer, place: 'warehouse', resource: 'food', amount };
        const result = ctx.runtime.session.submitWorldCommand(command);
        if (result.status === 'applied') ctx.runtime.recordCommitted(result.events);
        const after = ctx.runtime.world.spatial?.stocks?.warehouse?.food ?? null;
        const candidates = activeRows(ctx.play).filter(row => row.goal === 'deliver-meal')
          .sort((a, b) => a.createdAt - b.createdAt || a.commitmentId.localeCompare(b.commitmentId));
        ctx.interferenceTargets.contention = { at: now, stockBefore: stock, stockAfter: after,
          drainer, amount, status: result.status, reason: result.reason,
          targets: candidates.map(row => ({ commitmentId: row.commitmentId,
            promisorId: row.promisorId, goal: row.goal, outcome: 'pending' })) };
        entry.target = { stockBefore: stock, stockAfter: after };
        entry.detail = { applied: result.status === 'applied', amount, after };
        continue;
      }
      if (entry.kind === 'reject-change') {
        const rejected = [];
        for (const row of activeRows(ctx.play)) {
          const open = (row.changes ?? []).find(change => change.status === 'open');
          if (!open) continue;
          setUuidContext(`reject-change:${ctx.seed}:${now}:${row.commitmentId}`);
          const result = ctx.play.commitments.respondChange(row.commitmentId, open.changeId, 'reject',
            { at: now, reason: entry.reason, inputId: `r11-reject-${ctx.seed}-${row.commitmentId}` });
          ctx.runtime.session.ingestCommitmentEvent(result.event);
          rejected.push({ commitmentId: row.commitmentId, changeId: open.changeId,
            kind: open.kind, status: result.commitment.status,
            revision: result.commitment.revision });
        }
        entry.detail = { applied: rejected.length > 0, rejected };
        if (rejected.length > 0) {
          ctx.rejectApplied = true;
          entry.target = { commitments: rejected.map(row => row.commitmentId) };
        }
        continue;
      }
      if (entry.kind === 'restock') {
        const command = { commandId: `r11-restock-${ctx.seed}-${now}`,
          type: 'restock', amount: entry.amount, source: entry.source };
        const result = ctx.runtime.session.submitWorldCommand(command);
        if (result.status === 'applied') ctx.runtime.recordCommitted(result.events);
        entry.detail = { applied: result.status === 'applied', amount: entry.amount,
          observedBy: result.observedBy, status: result.status, reason: result.reason };
        entry.target = { observedBy: result.observedBy };
        continue;
      }
      if (entry.kind === 'watch') { entry.detail = { applied: true, note: 'observation only' }; }
    } catch (error) {
      entry.detail = { applied: false, error: error.message };
    }
  }
  finaliseContention(ctx);
}

function finaliseContention(ctx) {
  const contention = ctx.interferenceTargets.contention;
  if (!contention || contention.at === null) return;
  const receipts = ctx.runtime.committedEvents();
  for (const target of contention.targets ?? []) {
    const withdraw = receipts.filter(event => event.type === 'stock_withdrawn'
      && event.actorId === target.promisorId && event.simTime >= contention.at)
      .sort((a, b) => a.simTime - b.simTime)[0] ?? null;
    const shortage = receipts.filter(event => event.type === 'out_of_stock'
      && event.actorId === target.promisorId && event.simTime >= contention.at)
      .sort((a, b) => a.simTime - b.simTime)[0] ?? null;
    if (withdraw && shortage && shortage.simTime < withdraw.simTime) {
      target.outcome = 'lost-then-recovered';
      target.shortageEventId = shortage.eventId;
      target.shortageAt = shortage.simTime;
      target.recoveredEventId = withdraw.eventId;
      target.recoveredAt = withdraw.simTime;
      target.remainingAfter = withdraw.payload?.remaining ?? null;
    } else if (withdraw) {
      target.outcome = 'won';
      target.withdrawEventId = withdraw.eventId;
      target.at = withdraw.simTime;
      target.remainingAfter = withdraw.payload?.remaining ?? null;
    } else if (shortage) {
      target.outcome = 'lost-out-of-stock';
      target.shortageEventId = shortage.eventId;
      target.at = shortage.simTime;
    }
  }
}

/* ------------------------------ phases ------------------------------ */
function gameFiles(dir) {
  return {
    dir,
    preflight: join(dir, 'preflight.json'),
    commitmentInput: join(dir, 'commitment-input.json'),
    start: join(dir, 'd1-start.json'),
    save: join(dir, 'd2', 'session.json'),
    saveState: join(dir, 'd2', 'save-state.json'),
    saveManifest: join(dir, 'd2', 'save-manifest.json'),
    exitState: join(dir, 'd2-exit.json'),
    resumeLoad: join(dir, 'resume-load.json'),
    restoreCompare: join(dir, 'restore-compare.json'),
    decisionsStart: join(dir, 'decisions-start.jsonl'),
    decisionsResume: join(dir, 'decisions-resume.jsonl'),
    final: join(dir, 'final-state.json'),
    metrics: join(dir, 'metrics.json'),
    timeline: join(dir, 'resource-timeline.json'),
    interference: join(dir, 'interference.json'),
    delegates: join(dir, 'delegations.json'),
    phase: phase => join(dir, `phase-${phase}.json`),
    replayContinuous: join(dir, 'replay-continuous'),
    replaySegmented: join(dir, 'replay-segmented'),
    replay: join(dir, 'replay.json'),
    transcript: phase => join(dir, `scorer-${phase}.jsonl`),
    failure: join(dir, 'failure.json'),
  };
}

function phaseRecord(phase, ctx, extra = {}) {
  return { schema: 'frostecho.r11.matrix-phase/1', phase, pid: process.pid,
    arm: ctx.arm?.id ?? null, seed: ctx.seed ?? null, family: ctx.arm?.family ?? null,
    memorySelection: ctx.arm?.memory ?? null, scenarioSha: SCENARIO_SHA, source: SOURCE,
    at: new Date().toISOString(), cpuSeconds: Number(process.uptime().toFixed(3)), ...extra };
}

function scorerCommand(arm, dir) {
  const raw = arg('--scorer-command-json') ?? process.env.FROSTECHO_SCORER_COMMAND_JSON;
  if (raw) return JSON.parse(raw);
  const spec = headSpec(arm);
  const head = resolve(ROOT, spec.head);
  const manifestPath = resolve(ROOT, spec.manifest);
  let placement = 'auto';
  let gpus = '1';
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    placement = manifest.encodingExecution?.placement ?? 'auto';
    const recorded = manifest.featureIdentity?.physicalGpus;
    if (Array.isArray(recorded) && recorded.length > 0) gpus = recorded.join(',');
  }
  // R11: the service receives the SAME manifest the harness validated; every
  // reply must echo its sha256. There is no unbound diagnostic mode here.
  return [PYTHON, 'research/decision-choice/jev05/action/serve_joint.py',
    '--encoder', ENCODER, '--physical-gpus', process.env.FROSTECHO_PHYSICAL_GPUS ?? gpus,
    '--placement', process.env.FROSTECHO_PLACEMENT ?? placement,
    '--head', head, '--training-manifest', manifestPath, '--max-length', '2048',
    '--memory-policy', 'conditional-experience', '--output-dir', join(dir, 'scorer')];
}

async function phaseStart(arm, seed, dir) {
  const files = gameFiles(dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(dir, `${dir}.superseded-${stamp}`);
  }
  mkdirSync(dir, { recursive: true });
  const preflight = arm.family === 'live' ? preflightHead(arm) : { ok: true, code: 0,
    note: 'reference/probe arm has no model head', rendererId: RENDERER_ID,
    rendererSourceSha256: shaFile(join(ROOT, 'src/r7/jev/render.ts')) };
  if (preflight.ok && arm.family === 'live') {
    const shared = await sharedManifestGate({ ...preflight, armMemory: arm.memory });
    preflight.sharedManifest = shared;
    if (shared.available && !shared.ok) {
      preflight.ok = false;
      preflight.code = EXIT.headManifest;
      preflight.reason = `shared_manifest_refusal:${shared.code}`;
    }
  }
  preflight.arm = arm.id; preflight.seed = seed; preflight.family = arm.family;
  preflight.scenarioSha = SCENARIO_SHA;
  if (arm.family === 'live') preflight.command = scorerCommand(arm, dir);
  writeJson(files.preflight, preflight);
  if (!preflight.ok) {
    writeJson(files.phase('start'), phaseRecord('start', { arm, seed }, {
      exitCode: preflight.code, refused: preflight.reason }));
    console.error(`[${arm.id}/${seed}] refused: ${preflight.reason} (${preflight.code})`);
    return preflight.code;
  }

  const world = buildWorld(seed);
  const input = commitmentInputReport(world);
  writeJson(files.commitmentInput, { schema: 'frostecho.r11.matrix-commitment-input/1',
    scenarioSha: SCENARIO_SHA, arm: arm.id, seed, ...input });
  if (!input.passed) {
    writeJson(files.phase('start'), phaseRecord('start', { arm, seed }, {
      exitCode: EXIT.commitmentInput, refused: 'commitment_input_missing', problems: input.problems }));
    return EXIT.commitmentInput;
  }
  const ctx = ctxInit(world, { arm, seed, phase: 'start', dir });
  ctx.scorer = scorerFor(arm, { command: preflight.command,
    transcript: files.transcript('start'), binding: preflight.manifestBinding });
  const init = worldInit(world.runtime, world);
  writeJson(files.start, { schema: 'frostecho.r11.matrix-start/1', pid: process.pid,
    arm: arm.id, seed, family: arm.family, memorySelection: arm.memory,
    scenarioSha: SCENARIO_SHA, source: SOURCE,
    preflight: { headSha256: preflight.headSha256 ?? null,
      manifestSha256: preflight.manifestSha256 ?? null,
      featureIdentityHash: preflight.featureIdentityHash ?? null,
      labelSource: preflight.labelSource ?? null,
      manifestBinding: preflight.manifestBinding ?? null, rendererId: RENDERER_ID,
      rendererSourceSha256: preflight.rendererSourceSha256 },
    worldInitSha: sha(init), worldInit: init, commitments: world.seeds,
    deterministicIds: true });
  let outcome;
  try {
    outcome = await playGame(ctx, { stopAtCheckpoint: true });
  } catch (error) {
    writeJson(files.failure, { phase: 'start', error: error.message, pid: process.pid,
      countsAsModelResult: false, at: ctx.runtime.world.simTime,
      forwards: ctx.scorer?.forwardCalls ?? 0,
      serviceWallSeconds: ctx.scorer?.stats?.().serviceWallSeconds ?? null });
    writeJson(files.phase('start'), phaseRecord('start', ctx, {
      exitCode: EXIT.scorer, error: error.message }));
    ctx.scorer?.close?.();
    return EXIT.scorer;
  }
  ctx.scorerStats = ctx.scorer?.stats?.() ?? null;
  writeJsonl(files.decisionsStart, ctx.decisions);
  writeJson(files.delegates, { schema: 'frostecho.r11.delegations/1', rows: ctx.delegations,
    checkpointDelegation: ctx.checkpointDelegation });
  ctx.scorer?.close?.();
  if (outcome !== 'checkpoint') {
    writeJson(files.failure, { phase: 'start', error: outcome,
      reason: outcome === 'ended' ? 'game_ended_before_d2_checkpoint' : 'loop_guard',
      simTime: ctx.runtime.world.simTime, countsAsModelResult: false });
    writeJson(files.phase('start'), phaseRecord('start', ctx, {
      exitCode: EXIT.noPendingWork, outcome }));
    return EXIT.noPendingWork;
  }

  setUuidContext(`save:${seed}:${ctx.runtime.world.simTime}`);
  ctx.play.save(files.save);
  ctx.runtime.save(files.save);
  const state = checkpointState(ctx.runtime, ctx.play);
  const capture = captureState(ctx.runtime, ctx.play, {
    origin: 'd2-save', profileEnd: absoluteMinute(PROFILE, PROFILE.endDay, PROFILE.endMinuteOfDay),
    binding: { headSha256: preflight.headSha256 ?? null,
      manifestSha256: preflight.manifestSha256 ?? null, rendererId: RENDERER_ID },
    deterministicIds: true,
  });
  writeJson(files.saveState, capture);
  writeJson(files.saveManifest, {
    schema: 'frostecho.r11.save-manifest/1', at: ctx.runtime.world.simTime, pid: process.pid,
    arm: arm.id, seed, scenarioSha: SCENARIO_SHA, source: SOURCE,
    checkpoint: state, stateSha256: sha(capture),
    files: shaMap(join(dir, 'd2')),
    exclusions: SCENARIO.exclusions,
  });
  writeJson(files.exitState, { schema: 'frostecho.r11.matrix-d2-exit/1', pid: process.pid,
    arm: arm.id, seed, family: arm.family, memorySelection: arm.memory,
    scenarioSha: SCENARIO_SHA, simTime: ctx.runtime.world.simTime,
    headSha256: preflight.headSha256 ?? null, manifestSha256: preflight.manifestSha256 ?? null,
    inputSequence: ctx.runtime.session.inputSequence, checkpoint: state,
    delegations: ctx.delegations, exits: ctx.exits, decisions: ctx.decisions.length,
    decisionsSha256: shaFile(files.decisionsStart), stateSha256: sha(capture),
    nextClockTarget: nextClockTarget(ctx), countsAsModelResult: arm.family === 'live' });
  writeJson(files.phase('start'), phaseRecord('start', ctx, {
    exitCode: EXIT.ok, outcome, checkpoint: state, decisions: ctx.decisions.length,
    scorer: ctx.scorerStats }));
  console.log(`[${arm.id}/${seed}] D2 save at ${ctx.runtime.world.simTime}: `
    + `${state.activeCommitments} active, ${state.boundWorkingIntents} bound-working, `
    + `${state.pending} pending`);
  return EXIT.ok;
}

function ctxInit(world, { arm, seed, phase, dir }) {
  return {
    arm, seed, phase, dir, runtime: world.runtime, play: world.play, bridge: world.bridge,
    scorer: null, scorerStats: null, decisions: [], councilDecisions: [], exits: [],
    timeline: [], resourceSamples: [sampleResources(world.runtime, 'start')],
    delegations: [], checkpointDelegation: null, startDelegationRounds: 0,
    interferenceTargets: { cancel: [], contention: null }, schedule: [],
    rounds: 0, noProgressRounds: 0, furnaceLitHours: 0, checkpoint: null,
  };
}

function nextClockTarget(ctx) {
  const runtime = ctx.runtime;
  const before = runtime.world.simTime;
  const snapshot = runtime.snapshot();
  const night = snapshot.minuteOfDay >= PROFILE.nightSkipFromMinute
    || snapshot.minuteOfDay < PROFILE.nightSkipToMinute;
  let target;
  if (night) {
    const dayStart = Math.floor(before / PROFILE.minutesPerDay) * PROFILE.minutesPerDay;
    const wake = snapshot.minuteOfDay < PROFILE.nightSkipToMinute
      ? dayStart + PROFILE.nightSkipToMinute
      : dayStart + PROFILE.minutesPerDay + PROFILE.nightSkipToMinute;
    target = Math.min(wake, before + 8 * 60);
  } else {
    target = Math.floor(before / 60) * 60 + 60;
  }
  const interventionAt = nextScheduledIntervention(ctx);
  if (interventionAt !== null && interventionAt > before && interventionAt < target)
    target = interventionAt;
  return target;
}

async function playGame(ctx, { stopAtCheckpoint }) {
  const { runtime } = ctx;
  if (['resume', 'continuous-resume', 'segmented-resume'].includes(ctx.phase)) advanceOneRound(ctx);
  while (!runtime.ended && ctx.rounds < SCENARIO.clock.maxRounds) {
    ctx.rounds += 1;
    ctx.resourceSamples.push(sampleResources(runtime, 'round'));
    const councilMark = ctx.councilDecisions.length;
    runCouncilIfDue(runtime, ctx.councilDecisions, ctx.seed);
    for (const record of ctx.councilDecisions.slice(councilMark)) {
      ctx.decisions.push({ ...record, seed: ctx.seed, arm: ctx.arm.id, phase: ctx.phase,
        policy: 'council-reference', at: runtime.world.simTime,
        day: runtime.snapshot().day, minuteOfDay: runtime.snapshot().minuteOfDay });
    }
    setUuidContext(`council:${ctx.seed}:${runtime.world.simTime}:${runtime.world.version}`);
    if (ctx.phase === 'start' || ctx.phase === 'segmented-start') applyStartEvents(ctx);
    if (['resume', 'continuous-resume', 'segmented-resume'].includes(ctx.phase)) applyInterventions(ctx);
    if (process.env.R11_DEBUG && runtime.world.simTime >= 1800) {
      const active = activeRows(ctx.play);
      const working = workingIntents(runtime);
      const npcs = Object.values(runtime.world.npcs).map(npc => [npc.id,
        Math.round(npc.hunger), Math.round(npc.stamina), Number((npc.bodyTemp ?? 0).toFixed(1))]);
      console.error(`[debug-temp] at=${runtime.world.simTime} npcs=${JSON.stringify(npcs)}`);
      console.error(`[debug] at=${runtime.world.simTime} active=${active.length}`
        + ` working=${working.length} bound=${active.reduce((sum, row) => sum + boundIntents(runtime, row).length, 0)}`
        + ` rows=${JSON.stringify(active.map(row => [row.promisorId, row.goal, row.status, row.revision]))}`
        + ` work=${JSON.stringify(working.map(intent => [intent.actorId, String(intent.candidate.parameters.action), intent.commitmentId ? 'bound' : '-']))}`);
    }
    await decideAll(ctx);
    if ((ctx.phase === 'start' || ctx.phase === 'segmented-start') && stopAtCheckpoint) {
      const state = checkpointState(runtime, ctx.play);
      if (process.env.R11_DEBUG && state.at >= 1860) {
        console.error(`[debug-checkpoint] at=${state.at} active=${state.activeCommitments}`
          + ` bound=${state.boundWorkingIntents} pending=${state.pending}`);
      }
      if (state.at >= SCENARIO.checkpoint.fromAbsoluteMinute
        && state.activeCommitments > 0 && state.boundWorkingIntents > 0) {
        ctx.checkpoint = state;
        return 'checkpoint';
      }
    }
    if (runtime.ended) break;
    advanceOneRound(ctx);
  }
  if (!runtime.ended) return 'guard';
  return 'ended';
}

async function phaseResume(arm, seed, dir, { mode = 'resume' } = {}) {
  const files = gameFiles(dir);
  if (!existsSync(files.save)) {
    writeJson(files.failure, { phase: mode, error: 'd2_save_missing', countsAsModelResult: false });
    return EXIT.noPendingWork;
  }
  const exitState = readJson(files.exitState);
  const runtime = R8Runtime.load(files.save, PROFILE);
  const play = gameplayOn(runtime, files.save);
  setUuidContext(`resume-load:${seed}:${runtime.world.simTime}`);
  const bridge = createCommitmentBridge(runtime, play);
  const loaded = [...runtime.intents.values()];
  const pending = loaded.filter(intent => intent.status === 'working');
  const loadedCapture = captureState(runtime, play, {
    origin: 'd2-resume-load',
    profileEnd: absoluteMinute(PROFILE, PROFILE.endDay, PROFILE.endMinuteOfDay),
    binding: { headSha256: exitState?.headSha256 ?? null, manifestSha256: exitState?.manifestSha256 ?? null,
      rendererId: RENDERER_ID }, deterministicIds: true,
  });
  const savedCapture = readJson(files.saveState);
  const restore = savedCapture ? compareStates(savedCapture, loadedCapture) : null;
  writeJson(files.restoreCompare, { schema: 'frostecho.r11.restore-compare/1',
    phase: mode, pid: process.pid, savedPid: exitState?.pid ?? null,
    restoredFrom: rel(files.save), savedAt: exitState?.simTime ?? null,
    now: runtime.world.simTime, pendingIntents: pending.length,
    checkpoint: exitState?.checkpoint ?? null,
    compare: restore, exclusions: SCENARIO.exclusions });
  if (restore && !restore.equal) {
    writeJson(files.failure, { phase: mode, error: 'resume_state_mismatch',
      mismatch: restore.samples, countsAsModelResult: false });
    return EXIT.restore;
  }
  writeJson(files.resumeLoad, { schema: 'frostecho.r11.matrix-resume-load/1', pid: process.pid,
    phase: mode, simTime: runtime.world.simTime, savedSimTime: exitState?.simTime ?? null,
    inputSequence: runtime.session.inputSequence,
    savedInputSequence: exitState?.inputSequence ?? null, pendingIntents: pending.length,
    intents: loaded.map(intent => ({ intentId: intent.intentId, actorId: intent.actorId,
      status: intent.status, dueAt: intent.dueAt, commitmentId: intent.commitmentId,
      commitmentRevision: intent.commitmentRevision, generation: intent.generation })),
    generations: Object.fromEntries([...runtime.session.generations.entries()].sort()),
    legacySpatial: runtime.legacyPosition('npc_01') !== null,
    projectionReplays: [...runtime.intents.values()]
      .reduce((sum, intent) => sum + intent.projections.filter(claim => !claim.applied).length, 0) });

  const startDecisions = readJsonl(files.decisionsStart);
  const priorPreflight = readJson(files.preflight);
  const scorer = scorerFor(arm, { command: scorerCommand(arm, dir),
    transcript: files.transcript(mode), binding: priorPreflight?.manifestBinding ?? null });
  const ctx = ctxInit({ runtime, play, bridge }, { arm, seed, phase: mode, dir });
  ctx.scorer = scorer;
  ctx.checkpoint = exitState?.checkpoint ?? null;
  ctx.delegations = readJson(files.delegates)?.rows ?? [];
  ctx.checkpointDelegation = readJson(files.delegates)?.checkpointDelegation ?? null;
  initialiseSchedule(ctx);
  applyResumeStart(ctx);
  let outcome;
  try {
    outcome = await playGame(ctx, { stopAtCheckpoint: false });
  } catch (error) {
    writeJson(files.failure, { phase: mode, error: error.message, pid: process.pid,
      countsAsModelResult: false, at: ctx.runtime.world.simTime });
    writeJson(files.phase(mode), phaseRecord(mode, ctx, { exitCode: EXIT.scorer, error: error.message }));
    ctx.scorer?.close?.();
    return EXIT.scorer;
  }
  ctx.scorerStats = ctx.scorer?.stats?.() ?? null;
  if (mode === 'resume') writeJsonl(files.decisionsResume, ctx.decisions);
  ctx.scorer?.close?.();
  writeJson(files.interference, { schema: 'frostecho.r11.interference/1',
    saveClock: exitState?.simTime ?? null, schedule: ctx.schedule,
    starts: ctx.delegations.filter(row => row.origin !== 'initial'),
    stories: storyRows(ctx), targets: ctx.interferenceTargets });
  if (outcome !== 'ended') {
    writeJson(files.failure, { phase: mode, error: outcome,
      simTime: ctx.runtime.world.simTime, countsAsModelResult: false });
    writeJson(files.phase(mode), phaseRecord(mode, ctx, {
      exitCode: EXIT.noPendingWork, outcome }));
    return EXIT.noPendingWork;
  }

  const capture = captureState(ctx.runtime, ctx.play, {
    origin: `${mode}-final`,
    profileEnd: absoluteMinute(PROFILE, PROFILE.endDay, PROFILE.endMinuteOfDay),
    binding: { headSha256: priorPreflight?.headSha256 ?? null,
      manifestSha256: priorPreflight?.manifestSha256 ?? null, rendererId: RENDERER_ID },
    deterministicIds: true,
  });
  const final = { schema: 'frostecho.r11.matrix-final/1', pid: process.pid, arm: arm.id,
    seed, family: arm.family, memorySelection: arm.memory, scenarioSha: SCENARIO_SHA,
    source: SOURCE, simTime: ctx.runtime.world.simTime, ending: ctx.runtime.endingKind,
    stateSha256: sha(capture), state: capture, timeline: mergeTimeline(ctx.resourceSamples),
    pids: { start: exitState?.pid ?? null,
      resume: process.pid }, exits: ctx.exits,
    decisionCounts: { start: startDecisions.length, resume: ctx.decisions.length } };
  writeJson(files.final, final);

  const initialRows = [
    ...(readJson(files.start)?.commitments ?? []).map(row => ({ ...row, origin: 'initial' })),
    ...(readJson(files.delegates)?.rows ?? []),
    ...(exitState?.checkpoint?.commitments ?? []),
  ];
  const metrics = collectInstanceMetrics({
    initialCommitments: initialRows,
    saveActiveIds: (exitState?.checkpoint?.commitments ?? []).map(row => row.commitmentId),
    finalCommitments: ctx.play.commitments.all(), decisions: [...startDecisions, ...ctx.decisions],
    workLog: ctx.runtime.workLog, finalIntents: [...ctx.runtime.intents.values()],
    receipts: ctx.runtime.committedEvents(), memories: Object.fromEntries(
      [...ctx.runtime.session.memories.entries()].map(([id, store]) => [id, store.toJSON()])),
    timeline: mergeTimeline(ctx.resourceSamples), interference: { stories: storyRows(ctx) },
    delegations: ctx.delegations, clock: { start: SCENARIO.start, end: ctx.runtime.world.simTime },
    survivors: ctx.runtime.states.life.ending?.survivors
      ?? Object.values(ctx.runtime.world.npcs).filter(npc => npc.alive).length,
    ending: ctx.runtime.endingKind,
  });
  writeJson(files.timeline, { schema: 'frostecho.r11.resource-timeline/1',
    arm: arm.id, seed, samples: mergeTimeline(ctx.resourceSamples) });
  const gaps = gapSelfTest();
  metrics.resourceControls = gaps;
  const recon = reconciliation(metrics);
  writeJson(files.metrics, { ...metrics, reconciliation: recon });
  writeJson(files.phase(mode), phaseRecord(mode, ctx, {
    exitCode: recon.ok ? EXIT.ok : EXIT.settlement, reconciled: recon.ok,
    checks: recon.checks, decisions: ctx.decisions.length, scorer: ctx.scorerStats,
    realForwards: ctx.scorerStats?.forwardCalls ?? 0 }));
  console.log(`[${arm.id}/${seed}] D4 ${ctx.runtime.endingKind} `
    + `fulfilled=${metrics.primary.numerator}/${metrics.primary.denominator} `
    + `reconciled=${recon.ok} forwards=${ctx.scorerStats?.forwardCalls ?? 0}`);
  return recon.ok ? EXIT.ok : EXIT.settlement;
}

function mergeTimeline(samples) {
  const byAt = new Map();
  for (const row of samples) if (!byAt.has(row.at)) byAt.set(row.at, row);
  return [...byAt.values()].sort((a, b) => a.at - b.at);
}

function storyRows(ctx) {
  return ctx.schedule.map(entry => ({
    id: entry.id, kind: entry.kind, mode: entry.mode ?? null,
    at: entry.at, scheduledAt: entry.at, appliedAt: entry.appliedAt, lateBy: entry.lateBy ?? 0,
    target: entry.target, detail: entry.detail,
  })).concat(ctx.interferenceTargets.contention ? [{
    id: 'contention', kind: 'contention', scheduledAt: ctx.interferenceTargets.contention.at,
    appliedAt: ctx.interferenceTargets.contention.at,
    targets: ctx.interferenceTargets.contention.targets,
    stockBefore: ctx.interferenceTargets.contention.stockBefore,
    stockAfter: ctx.interferenceTargets.contention.stockAfter,
  }] : []);
}

function reconciliation(metrics) {
  const duplicate = metrics.duplicates.fulfilmentInstancesWithMultipleReceipts === 0
    && metrics.duplicates.receiptIdsUsedTwice.length === 0;
  const checks = {
    noDuplicateReceipt: duplicate,
    noUnauthorisedSourceAction: metrics.changes.unagreedSourceActions === 0,
    noLatePhysicalEffect: metrics.postCancel.latePhysicalEffects === 0,
    everyFulfilmentReceipted: metrics.obligations.every(row => !row.fulfilment.withoutReceipt),
    settlementsTerminalWithinEnd: (metrics.settlement.pendingWithinEnd ?? 0) === 0,
    resourceGapIntegrates: metrics.resourceControls.ok === true,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

/* ------------------------------ replay ------------------------------ */
function replaySourceRows(files, phase) {
  return phase === 'start' ? readJsonl(files.decisionsStart) : readJsonl(files.decisionsResume);
}

/**
 * Same-action replay. Continuous: one process, no exit, start+resume decisions.
 * Segmented: exactly the production split (save, exit, new pid).
 * Both are controls (`countsAsModelResult: false`).
 */
async function phaseReplayContinuous(arm, seed, dir) {
  const files = gameFiles(dir);
  const exitState = readJson(files.exitState);
  const savedCapture = readJson(files.saveState);
  const rows = [...readJsonl(files.decisionsStart), ...readJsonl(files.decisionsResume)];
  const outDir = files.replayContinuous;
  mkdirSync(outDir, { recursive: true });
  const world = buildWorld(seed);
  const ctx = ctxInit(world, { arm, seed, phase: 'continuous-start', dir: outDir });
  ctx.scorer = new ReplayScorer(rows);
  ctx.phase = 'continuous-start';
  // The replays must issue the same context strings as the recorded run.
  let boundaryChecked = false;
  let outcome;
  try {
    outcome = await (async () => {
      const { runtime } = ctx;
      while (!runtime.ended && ctx.rounds < SCENARIO.clock.maxRounds) {
        ctx.rounds += 1;
        const councilMark = ctx.councilDecisions.length;
        runCouncilIfDue(runtime, ctx.councilDecisions, ctx.seed);
        for (const record of ctx.councilDecisions.slice(councilMark)) {
          ctx.decisions.push({ ...record, phase: ctx.phase, at: runtime.world.simTime });
        }
        if (ctx.phase === 'continuous-start') applyStartEvents(ctx);
        if (ctx.phase === 'continuous-resume') applyInterventions(ctx);
        await decideAll(ctx);
        if (ctx.phase === 'continuous-start') {
          const state = checkpointState(runtime, ctx.play);
          if (state.at >= SCENARIO.checkpoint.fromAbsoluteMinute
            && state.activeCommitments > 0 && state.boundWorkingIntents > 0) {
            const capture = captureState(runtime, ctx.play, { origin: 'continuous-checkpoint' });
            const compare = savedCapture ? compareStates(savedCapture, capture) : null;
            writeJson(join(outDir, 'checkpoint-compare.json'), {
              schema: 'frostecho.r11.replay-checkpoint/1', at: runtime.world.simTime,
              savedAt: exitState?.simTime ?? null, compare });
            boundaryChecked = true;
            if (!compare || !compare.equal) return 'boundary-mismatch';
            ctx.checkpoint = state;
            ctx.phase = 'continuous-resume';
            ctx.delegations = readJson(files.delegates)?.rows ?? [];
            initialiseSchedule(ctx);
            applyResumeStart(ctx);
            advanceOneRound(ctx);
            continue;
          }
        }
        if (runtime.ended) break;
        advanceOneRound(ctx);
      }
      return runtime.ended ? 'ended' : 'guard';
    })();
  } catch (error) {
    writeJson(join(outDir, 'failure.json'), { error: error.message, phase: 'replay-continuous',
      scorer: ctx.scorer?.stats?.() ?? null,
      decisions: ctx.decisions.length, at: ctx.runtime.world.simTime });
    return EXIT.replay;
  }
  ctx.scorerStats = ctx.scorer.stats();
  const capture = captureState(ctx.runtime, ctx.play, { origin: 'continuous-final' });
  writeJson(join(outDir, 'final-state.json'), capture);
  writeJsonl(join(outDir, 'decisions.jsonl'), ctx.decisions);
  const original = readJson(files.final);
  const compare = original ? compareStates(original.state, capture) : null;
  writeJson(join(outDir, 'compare.json'), { schema: 'frostecho.r11.replay-compare/1',
    mode: 'continuous', countsAsModelResult: false, boundaryChecked, outcome,
    scorer: ctx.scorerStats, compare });
  writeJson(join(outDir, 'phase.json'), phaseRecord('replay-continuous', ctx, {
    exitCode: compare?.equal ? EXIT.ok : EXIT.replay, boundaryChecked,
    equivalent: Boolean(compare?.equal) }));
  return compare?.equal ? EXIT.ok : EXIT.replay;
}

async function phaseReplaySegmentedStart(arm, seed, dir) {
  const files = gameFiles(dir);
  const outDir = files.replaySegmented;
  mkdirSync(outDir, { recursive: true });
  const rows = readJsonl(files.decisionsStart);
  const world = buildWorld(seed);
  const ctx = ctxInit(world, { arm, seed, phase: 'segmented-start', dir: outDir });
  ctx.scorer = new ReplayScorer(rows);
  let outcome;
  try { outcome = await playGame(ctx, { stopAtCheckpoint: true }); }
  catch (error) {
    writeJson(join(outDir, 'failure.json'), { error: error.message, phase: 'segmented-start',
      scorer: ctx.scorer?.stats?.() ?? null, at: ctx.runtime.world.simTime,
      tail: ctx.decisions.slice(-12).map(record => ({ at: record.at,
        actorId: record.actorId, requestId: record.requestId,
        selectedId: record.selectedId, status: record.executionStatus,
        reason: record.reason, hash: record.candidateSetHash })) });
    return EXIT.replay;
  }
  ctx.scorerStats = ctx.scorer.stats();
  writeJsonl(join(outDir, 'decisions-start.jsonl'), ctx.decisions);
  if (outcome !== 'checkpoint') {
    writeJson(join(outDir, 'failure.json'), { error: 'replay_never_reached_checkpoint', outcome });
    return EXIT.replay;
  }
  ctx.play.save(join(outDir, 'd2', 'session.json'));
  ctx.runtime.save(join(outDir, 'd2', 'session.json'));
  writeJson(join(outDir, 'd2-exit.json'), { pid: process.pid, simTime: ctx.runtime.world.simTime,
    checkpoint: checkpointState(ctx.runtime, ctx.play),
    stateSha256: sha(captureState(ctx.runtime, ctx.play, { origin: 'segmented-save' })) });
  writeJson(join(outDir, 'phase.json'), phaseRecord('replay-segmented-start', ctx, {
    exitCode: EXIT.ok, at: ctx.runtime.world.simTime }));
  return EXIT.ok;
}

async function phaseReplaySegmentedEnd(arm, seed, dir) {
  const files = gameFiles(dir);
  const outDir = files.replaySegmented;
  const save = join(outDir, 'd2', 'session.json');
  if (!existsSync(save)) return EXIT.replay;
  const rows = readJsonl(files.decisionsResume);
  const original = readJson(files.final);
  const runtime = R8Runtime.load(save, PROFILE);
  const play = gameplayOn(runtime, save);
  const bridge = createCommitmentBridge(runtime, play);
  const ctx = ctxInit({ runtime, play, bridge }, { arm, seed, phase: 'segmented-resume', dir: outDir });
  ctx.scorer = new ReplayScorer(rows);
  ctx.delegations = readJson(files.delegates)?.rows ?? [];
  initialiseSchedule(ctx);
  applyResumeStart(ctx);
  let outcome;
  try { outcome = await playGame(ctx, { stopAtCheckpoint: false }); }
  catch (error) {
    writeJson(join(outDir, 'failure.json'), { error: error.message, phase: 'segmented-resume' });
    return EXIT.replay;
  }
  ctx.scorerStats = ctx.scorer.stats();
  const capture = captureState(ctx.runtime, ctx.play, { origin: 'segmented-final' });
  writeJson(join(outDir, 'final-state.json'), capture);
  writeJsonl(join(outDir, 'decisions-resume.jsonl'), ctx.decisions);
  const compare = original ? compareStates(original.state, capture) : null;
  writeJson(join(outDir, 'compare.json'), { schema: 'frostecho.r11.replay-compare/1',
    mode: 'segmented', countsAsModelResult: false, outcome, scorer: ctx.scorerStats, compare });
  writeJson(join(outDir, 'phase.json'), phaseRecord('replay-segmented-end', ctx, {
    exitCode: compare?.equal ? EXIT.ok : EXIT.replay, equivalent: Boolean(compare?.equal) }));
  return compare?.equal ? EXIT.ok : EXIT.replay;
}

/* --------------------------- game identity --------------------------- */
function gameIdentity({ arm, seed, dir, exits }) {
  const read = name => readJson(join(dir, name));
  const preflight = read('preflight.json');
  const metrics = read('metrics.json');
  const final = read('final-state.json');
  const exitState = read('d2-exit.json');
  const restore = read('restore-compare.json');
  const interference = read('interference.json');
  const replayContinuous = readJson(join(dir, 'replay-continuous', 'compare.json'));
  const replaySegmented = readJson(join(dir, 'replay-segmented', 'compare.json'));
  const phases = ['start', 'resume'].map(phase => read(`phase-${phase}.json`)).filter(Boolean);
  const forwards = phases.reduce((sum, phase) => sum + (phase.scorer?.forwardCalls ?? 0), 0);
  const gpuWall = phases.reduce((sum, phase) => sum + (phase.scorer?.serviceWallSeconds ?? 0), 0);
  // The source that actually ran this game, not the source that regenerated
  // the summary: phase-start / d1-start wrote it at run time.
  const runSource = read('d1-start.json')?.source ?? read('phase-start.json')?.source ?? SOURCE;
  const identity = {
    schema: 'frostecho.r11.matrix-game/1', arm: arm.id, family: arm.family, seed,
    recipe: arm.recipe, memorySelection: arm.memory,
    execution: arm.family === 'live' ? 'gpu' : 'cpu',
    memoryTokenBudget: SCENARIO.memory.budgetTokens, scenarioSha: SCENARIO_SHA, source: runSource,
    // Reproducibility bindings O asked for. `sourceCommit` is the commit that
    // actually ran; `freezeSourceCommit` is the integration tree O froze. They
    // differ until O merges this branch into the frozen tree, and both are
    // recorded instead of pretending they are the same.
    sourceCommit: runSource.head,
    freezeSha256: oFreezeSha(),
    freezeSourceCommit: O_FREEZE?.sourceCommit ?? null,
    rendererBuildSha256: O_FREEZE?.renderer?.buildSha256 ?? null,
    manifestSha256: preflight?.manifestSha256 ?? null,
    exits, pids: { start: read('phase-start.json')?.pid ?? null,
      resume: read('phase-resume.json')?.pid ?? null,
      services: phases.flatMap(phase => phase.scorer?.servicePids ?? []) },
    head: preflight ? { headPath: preflight.headPath ?? null,
      headSha256: preflight.headSha256 ?? null, manifestPath: preflight.manifestPath ?? null,
      manifestSha256: preflight.manifestSha256 ?? null, labelSource: preflight.labelSource ?? null,
      featureIdentityHash: preflight.featureIdentityHash ?? null,
      rendererId: preflight.rendererId ?? null,
      rendererSourceSha256: preflight.rendererSourceSha256 ?? null,
      ok: preflight.ok, reason: preflight.reason ?? null } : null,
    save: exitState ? { at: exitState.simTime, stateSha256: exitState.stateSha256,
      activeCommitments: exitState.checkpoint?.activeCommitments ?? 0,
      boundWorkingIntents: exitState.checkpoint?.boundWorkingIntents ?? 0,
      pending: exitState.checkpoint?.pending ?? 0 } : null,
    restore: restore ? { equal: restore.compare?.equal ?? false,
      diffs: restore.compare?.diffs ?? null, savedPid: restore.savedPid, pid: restore.pid } : null,
    interference: interference ? { saveClock: interference.saveClock,
      stories: interference.stories.map(row => ({ id: row.id, at: row.appliedAt,
        lateBy: row.lateBy, target: row.target })) } : null,
    replay: { continuous: replayContinuous?.compare
      ? { equal: replayContinuous.compare.equal, diffs: replayContinuous.compare.diffs } : null,
      segmented: replaySegmented?.compare
        ? { equal: replaySegmented.compare.equal, diffs: replaySegmented.compare.diffs } : null,
      countsAsModelResult: false },
    final: final ? { simTime: final.simTime, ending: final.ending,
      stateSha256: final.stateSha256 } : null,
    metrics: metrics ? {
      decisions: phases.reduce((sum, phase) => sum + (phase.decisions ?? 0), 0),
      realForwards: forwards, gpuWallSeconds: round3(gpuWall),
      primary: metrics.primary, counts: metrics.counts,
      postCancel: metrics.postCancel, changes: metrics.changes,
      duplicateReceipts: metrics.duplicates, settlement: metrics.settlement,
      workHours: metrics.work.hours, survivors: metrics.survivors, ending: metrics.ending,
      resources: { final: metrics.resources.final, inventoryHours: metrics.resources.inventoryHours,
        gapHours: metrics.resources.gapHours },
      exposure: metrics.exposure, reconciled: metrics.reconciliation?.ok ?? null,
    } : null,
    evidenceSha256: null, gameSha256: null,
  };
  identity.evidenceSha256 = sha(shaMap(dir));
  identity.gameSha256 = sha(identity);
  return identity;
}

/* ------------------------------ verify ------------------------------ */
function verifyGame(dir) {
  const files = gameFiles(dir);
  const exitState = readJson(files.exitState);
  const saveManifest = readJson(files.saveManifest);
  const restore = readJson(files.restoreCompare);
  const interfere = readJson(files.interference);
  const metrics = readJson(files.metrics);
  const rc = readJson(join(files.replayContinuous, 'compare.json'));
  const rs = readJson(join(files.replaySegmented, 'compare.json'));
  const phaseStart = readJson(files.phase('start'));
  const phaseResume = readJson(files.phase('resume'));
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });

  check('D2 save has an active commitment', (exitState?.checkpoint?.activeCommitments ?? 0) > 0,
    { active: exitState?.checkpoint?.activeCommitments ?? null });
  check('D2 save has work bound to the same instance AND revision',
    (exitState?.checkpoint?.boundWorkingIntents ?? 0) > 0
    && (exitState?.checkpoint?.commitments ?? []).some(row => row.boundWorkingIntents.length > 0
      && row.boundWorkingIntents.every(intent => intent.commitmentId === row.commitmentId
        && intent.commitmentRevision === row.revision)),
    { bound: exitState?.checkpoint?.boundWorkingIntents ?? null });
  check('the save is a real file set with hashes', Boolean(saveManifest?.files
    && Object.keys(saveManifest.files).length >= 6),
  { files: Object.keys(saveManifest?.files ?? {}).length });
  check('the resume ran in a NEW pid', phaseStart?.pid && phaseResume?.pid
    && phaseStart.pid !== phaseResume.pid,
  { start: phaseStart?.pid ?? null, resume: phaseResume?.pid ?? null });
  check('restore equals the saved full state (world/map/tasks/commitments/memory/work/'
    + 'generations/receipts/rng)',
  restore?.compare?.equal === true, { diffs: restore?.compare?.diffs ?? null,
    categories: restore?.compare?.categories ?? null });
  check('interference fired only AFTER the save clock', interfere
    ? interfere.stories.every(row => row.appliedAt === null || row.appliedAt >= interfere.saveClock)
    : false, { saveClock: interfere?.saveClock ?? null });
  const cancelStories = interfere?.stories?.filter(row => row.kind === 'cancel') ?? [];
  check('both cancel modes were offered (heard and unheard)', cancelStories.length === 2
    && cancelStories.every(row => row.detail?.applied !== false),
  cancelStories.map(row => ({ id: row.id, mode: row.mode, detail: row.detail })));
  check('the unheard cancellation had a real relay opportunity',
    (interfere?.stories ?? []).some(row => row.kind === 'relay' && row.detail?.applied === true),
  (interfere?.stories ?? []).find(row => row.kind === 'relay')?.detail ?? null);
  // Story exposure is measured, not a harness failure: a policy that never
  // gives the world a chance to answer is a real (not_exposed) outcome. It is
  // reported separately and never turned into a zero-violation score.
  const exposure = [
    { name: 'a source change was proposed and the beneficiary refused it',
      passed: (interfere?.stories ?? []).some(row => row.kind === 'reject-change'
        && (row.detail?.rejected?.length ?? 0) > 0),
      detail: (interfere?.stories ?? []).find(row => row.kind === 'reject-change')?.detail ?? null },
    { name: 'the old failure condition was lifted by a witnessed restock',
      passed: (interfere?.stories ?? []).some(row => row.kind === 'restock'
        && row.detail?.applied === true && (row.detail?.observedBy?.length ?? 0) > 0),
      detail: (interfere?.stories ?? []).find(row => row.kind === 'restock')?.detail ?? null },
    { name: 'two commitments contended for the last unit',
      passed: (interfere?.targets?.contention?.targets?.length ?? 0) >= 2,
      detail: interfere?.targets?.contention ?? null },
  ];
  check('continuous same-action replay equals the main final state',
    rc?.compare?.equal === true, { diffs: rc?.compare?.diffs ?? null });
  check('segmented same-action replay equals the main final state',
    rs?.compare?.equal === true, { diffs: rs?.compare?.diffs ?? null });
  check('metrics were recomputed from the complete logs', Boolean(metrics?.settlement
    && metrics?.obligations && metrics.resourceControls?.ok),
  { obligations: metrics?.obligations?.length ?? null,
    intents: metrics?.settlement?.intents ?? null });
  const report = { schema: 'frostecho.r11.verify-d2/1', generatedAt: new Date().toISOString(),
    source: SOURCE, scenarioSha: SCENARIO_SHA, inputs: { dir: rel(dir), save: rel(files.save) },
    checks, exposure, ok: checks.every(row => row.passed),
    exposed: exposure.every(row => row.passed) };
  writeJson(join(dir, 'verify-d2.json'), report);
  return report;
}

function tamperGame(dir) {
  const files = gameFiles(dir);
  const original = readJson(files.saveState);
  const final = readJson(files.final);
  const results = [];
  const run = (state, label) => {
    for (const [name, category] of Object.entries({
      'commitment-reference': 'commitment', 'map-position': 'map', 'memory-source': 'memory',
      'travel-leg': 'work', receipt: 'receipt',
    })) {
      const { mutated, detail } = applyTamper(name, state);
      const compare = compareStates(state, mutated);
      results.push({ name, label, category, mutatedPath: detail.path,
        detected: !compare.equal, diffs: compare.diffs,
        categories: compare.categories, sample: compare.samples[0] ?? null,
        categoryDetected: (compare.categories[category] ?? 0) > 0 });
    }
  };
  if (original) run(original, 'd2-save');
  if (final?.state) run(final.state, 'd4-final');
  const report = { schema: 'frostecho.r11.tamper/1', generatedAt: new Date().toISOString(),
    source: SOURCE, scenarioSha: SCENARIO_SHA, dir: rel(dir),
    exclusions: SCENARIO.exclusions, results,
    ok: results.length >= 10 && results.every(row => row.detected && row.categoryDetected) };
  writeJson(join(dir, 'tamper.json'), report);
  return report;
}

/* ------------------------------ matrix ------------------------------ */
async function runGame(arm, seed, out, overrides) {
  const dir = join(out, arm.family === 'reference' ? 'reference'
    : arm.family === 'probe' ? 'probe' : 'arms', arm.id, seed);
  mkdirSync(dir, { recursive: true });
  console.log(`[${arm.id}/${seed}] start`);
  const start = runPhaseChild('start', arm, seed, dir, overrides);
  let resume = null, continuous = null, segStart = null, segEnd = null;
  if (start === 0) {
    console.log(`[${arm.id}/${seed}] resume`);
    resume = runPhaseChild('resume', arm, seed, dir, overrides);
  }
  if (resume === 0) {
    console.log(`[${arm.id}/${seed}] replay continuous`);
    continuous = runPhaseChild('replay-continuous', arm, seed, dir, overrides);
    console.log(`[${arm.id}/${seed}] replay segmented`);
    segStart = runPhaseChild('replay-segmented-start', arm, seed, dir, overrides);
    if (segStart === 0) segEnd = runPhaseChild('replay-segmented-end', arm, seed, dir, overrides);
  }
  const exits = { start, resume, continuous, segmentedStart: segStart, segmentedEnd: segEnd };
  const verify = resume === 0 ? verifyGame(dir) : null;
  const tamper = resume === 0 ? tamperGame(dir) : null;
  const identity = gameIdentity({ arm, seed, dir, exits });
  const status = start !== 0 ? `failed:start:${start}`
    : resume !== 0 ? `failed:resume:${resume}`
      : continuous !== 0 ? `failed:replay-continuous:${continuous}`
        : segStart !== 0 ? `failed:replay-segmented-start:${segStart}`
          : segEnd !== 0 ? `failed:replay-segmented-end:${segEnd}` : 'completed';
  writeJson(join(dir, 'summary.json'), { ...identity, status,
    verify: verify?.ok ?? null, exposed: verify?.exposed ?? null,
    tamper: tamper?.ok ?? null });
  return { ...identity, status, dir: rel(dir), verifyOk: verify?.ok ?? null,
    exposed: verify?.exposed ?? null, tamperOk: tamper?.ok ?? null };
}

function runPhaseChild(phase, arm, seed, dir, overrides) {
  // Each phase is a new process: the D2 exit/new pid is not simulated.
  const args = [fileURLToPath(import.meta.url), '--phase', phase, '--arm', arm.id,
    '--seed', seed, '--out', dir, ...overrides];
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, FROSTECHO_REPO: ROOT } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.stdout.log`), result.stdout ?? '', 'utf8');
  writeFileSync(join(dir, `phase-${phase}.stderr.log`), result.stderr ?? '', 'utf8');
  return result.status ?? EXIT.internal;
}

async function matrix() {
  const out = resolve(arg('--out') ?? 'artifacts/r11/matrix');
  mkdirSync(out, { recursive: true });
  const seeds = (arg('--seeds') ?? 'r11h-1,r11h-2').split(',').map(value => value.trim()).filter(Boolean);
  if (seeds.length !== 2) throw new Error('the matrix runs exactly two fresh seeds');
  if (seeds.some(seed => /^r10/.test(seed))) throw new Error('R11 needs two seeds never used by R10');
  writeJson(join(out, 'scenario.json'), { ...SCENARIO, scenarioSha: SCENARIO_SHA });
  writeJson(join(out, 'metric-spec.json'), METRIC_SPEC);
  writeJson(join(out, 'matrix-spec.json'), { schema: 'frostecho.r11.matrix-spec/1',
    generatedAt: new Date().toISOString(), source: SOURCE, scenarioSha: SCENARIO_SHA,
    freeze: { path: O_FREEZE_PATH, sha256: oFreezeSha(),
      sourceCommit: O_FREEZE?.sourceCommit ?? null,
      rendererBuildSha256: O_FREEZE?.renderer?.buildSha256 ?? null }, seeds,
    arms: ARMS.map(arm => ({ ...arm, head: arm.recipe ? headSpec(arm) : null })),
    liveGames: LIVE_ARMS.length * seeds.length, referenceGames: REFERENCE_ARMS.length * seeds.length,
    memoryBudgetTokens: SCENARIO.memory.budgetTokens,
    note: 'live arms refuse to start when head/manifest/renderer/feature identity is missing; '
      + 'they never fall back to rules or replay' });

  const overrides = [];
  for (const key of ['--base-head', '--base-manifest', '--base-label', '--fulfil-head',
    '--fulfil-manifest', '--fulfil-label', '--scorer-command-json']) {
    if (arg(key) !== undefined) overrides.push(key, arg(key));
  }
  const controlDir = join(out, 'controls');
  const positive = probe(true, join(controlDir, 'positive'));
  const negative = probe(false, join(controlDir, 'negative'));
  const only = (arg('--only') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const liveArms = only.length ? LIVE_ARMS.filter(arm => only.includes(arm.id)) : LIVE_ARMS;
  const referenceArms = only.length ? REFERENCE_ARMS.filter(arm => only.includes(arm.id)) : REFERENCE_ARMS;
  if (only.length && liveArms.length === 0 && referenceArms.length === 0)
    throw new Error(`--only matched no arm: ${only.join(',')}`);

  const rows = [];
  for (const seed of seeds) {
    // Per seed: all four live arms first (the O protocol), reference after.
    for (const arm of liveArms) rows.push(await runGame(arm, seed, out, overrides));
    for (const arm of referenceArms) rows.push(await runGame(arm, seed, out, overrides));
  }

  const priorPath = join(out, 'matrix-table.json');
  const prior = readJson(priorPath);
  const replaced = new Set(rows.map(row => `${row.arm}|${row.seed}`));
  const merged = [...(prior?.rows ?? []).filter(row => !replaced.has(`${row.arm}|${row.seed}`)), ...rows];
  merged.sort((left, right) => (ARMS.findIndex(arm => arm.id === left.arm)
    - ARMS.findIndex(arm => arm.id === right.arm))
    || (seeds.indexOf(left.seed) - seeds.indexOf(right.seed)));
  const checks = matrixChecks(merged, { positive, negative, seeds });
  const table = { schema: 'frostecho.r11.matrix-table/1', generatedAt: new Date().toISOString(),
    source: SOURCE, scenarioSha: SCENARIO_SHA, seeds,
    mode: arg('--mode') ?? 'auto',
    memoryBudgetTokens: SCENARIO.memory.budgetTokens,
    checks, rows: merged };
  writeJson(priorPath, table);
  writeFileSync(join(out, 'MATRIX.md'), matrixMarkdown(table), 'utf8');
  const instances = [];
  for (const row of merged) {
    const metrics = readJson(join(ROOT, row.dir, 'metrics.json'));
    for (const instance of metrics?.obligations ?? []) {
      instances.push({ arm: row.arm, seed: row.seed, status: row.status, ...instance });
    }
  }
  writeJsonl(join(out, 'INSTANCES.jsonl'), instances);
  console.log(JSON.stringify({ out: rel(out), checks,
    completed: merged.filter(row => row.status === 'completed').length,
    failed: merged.filter(row => row.status !== 'completed').length }, null, 2));
  const ok = merged.every(row => row.status === 'completed')
    && checks.scenarioIdentical && checks.worldInitIdenticalPerSeed && checks.pairedSeedCoverage
    && checks.commitmentInputPositiveControl && checks.commitmentInputNegativeControl;
  return ok ? EXIT.ok : EXIT.matrixIncomplete;
}

function probe(seedCommitments, dir) {
  mkdirSync(dir, { recursive: true });
  const world = buildWorld('probe-commitment-input', { seedCommitments });
  const input = commitmentInputReport(world);
  writeJson(join(dir, 'commitment-input.json'), {
    schema: 'frostecho.r11.matrix-commitment-input/1', scenarioSha: SCENARIO_SHA,
    probe: seedCommitments ? 'positive' : 'negative',
    expectedExit: seedCommitments ? EXIT.ok : EXIT.commitmentInput, ...input });
  const code = input.passed ? EXIT.ok : EXIT.commitmentInput;
  console.log(JSON.stringify({ probe: seedCommitments ? 'positive' : 'negative',
    passed: input.passed, exitCode: code, problems: input.problems }));
  return code;
}

function matrixChecks(rows, { positive, negative, seeds }) {
  const seedGroups = {};
  for (const row of rows.filter(entry => entry.family === 'reference')) {
    const path = join(ROOT, row.dir, 'd1-start.json');
    if (!existsSync(path)) continue;
    const start = readJson(path);
    (seedGroups[row.seed] ??= new Set()).add(start.worldInitSha);
  }
  const pairs = seeds.map(seed => {
    const recipes = ['base', 'fulfil'];
    return recipes.every(recipe => ['raw', 'conditional'].every(memory =>
      rows.some(row => row.seed === seed && row.recipe === recipe
        && row.memorySelection === (memory === 'raw' ? 'raw-last12' : 'obligation-first')
        && row.status === 'completed')));
  });
  return {
    scenarioIdentical: rows.every(row => row.scenarioSha === SCENARIO_SHA),
    worldInitIdenticalPerSeed: Object.values(seedGroups).every(set => set.size === 1),
    memoryBudgetIdentical: rows.every(row => row.memoryTokenBudget === SCENARIO.memory.budgetTokens),
    commitmentInputPositiveControl: positive === EXIT.ok,
    commitmentInputNegativeControl: negative === EXIT.commitmentInput,
    liveArmsStarted: rows.filter(row => row.family === 'live' && row.exits.start === 0).length,
    liveArmsRefusedAtPreflight: rows.filter(row => row.family === 'live'
      && row.exits.start !== 0 && row.head?.ok === false).length,
    liveArmsFailedAfterStart: rows.filter(row => row.family === 'live'
      && row.exits.start !== 0 && row.head?.ok === true).length,
    referenceGamesCompleted: rows.filter(row => row.family === 'reference'
      && row.status === 'completed').length,
    resumeUsedNewProcess: rows.filter(row => row.exits.resume === 0)
      .every(row => row.pids.start && row.pids.resume && row.pids.start !== row.pids.resume),
    saveHadBoundWork: rows.filter(row => row.exits.resume === 0)
      .every(row => (row.save?.boundWorkingIntents ?? 0) > 0),
    restoreEqual: rows.filter(row => row.exits.resume === 0).every(row => row.restore?.equal),
    replayContinuousEqual: rows.filter(row => row.exits.continuous === 0)
      .every(row => row.replay.continuous?.equal),
    replaySegmentedEqual: rows.filter(row => row.exits.segmentedEnd === 0)
      .every(row => row.replay.segmented?.equal),
    tamperDetected: rows.filter(row => row.tamperOk !== null).every(row => row.tamperOk),
    pairedSeedCoverage: pairs.every(Boolean),
    realForwards: rows.reduce((sum, row) => sum + (row.metrics?.realForwards ?? 0), 0),
    gpuWallSeconds: round3(rows.reduce((sum, row) => sum + (row.metrics?.gpuWallSeconds ?? 0), 0)),
  };
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(digits);
  return String(value);
}

function matrixMarkdown(table) {
  const lines = [];
  lines.push('# R11 four-arm matrix — base/fulfil x raw/conditional x 2 unseen seeds');
  lines.push('');
  lines.push(`scenario \`${table.scenarioSha.slice(0, 16)}\` · source \`${table.source.head.slice(0, 7)}\``
    + ` · budget ${table.memoryBudgetTokens} · seeds ${table.seeds.join(' / ')}`);
  lines.push('');
  lines.push('| game | arm | seed | status | save clock | active@save | bound work@save | fulfil | overdue | exit | post-cancel | unagreed | survivors | gap h (food) | fwd | game SHA |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of table.rows) {
    const m = row.metrics ?? {};
    const primary = m.primary ?? {};
    lines.push(`| ${row.dir} | ${row.arm} | ${row.seed} | ${row.status} | `
      + `${fmt(row.save?.at)} | ${fmt(row.save?.activeCommitments)} | ${fmt(row.save?.boundWorkingIntents)} | `
      + `${fmt(primary.numerator)}/${fmt(primary.denominator)} | ${fmt(m.counts?.overdue)} | `
      + `${fmt(m.counts?.authorisedExit)} | ${fmt(m.postCancel?.latePhysicalEffects)} | `
      + `${fmt(m.changes?.unagreedSourceActions)} | ${fmt(m.survivors)} | `
      + `${fmt(m.resources?.gapHours?.food, 1)} | `
      + `${row.family === 'live' ? fmt(m.realForwards ?? 0) : '0 (rule)'} | `
      + `${row.gameSha256.slice(0, 12)} |`);
  }
  lines.push('');
  lines.push('`exit` is the authorised exit count; `post-cancel` counts late physical effects '
    + '(receipts) after a cancellation, not rejected attempts. Replay and fallback are separate '
    + 'controls and are not model results.');
  lines.push('');
  lines.push('## Per-seed paired differences (fulfil − base)');
  lines.push('');
  const at = (seed, recipe, memory) => table.rows.find(row => row.seed === seed
    && row.recipe === recipe && row.memorySelection === memory && row.status === 'completed');
  for (const seed of table.seeds) {
    for (const memory of ['raw-last12', 'obligation-first']) {
      const base = at(seed, 'base', memory);
      const fulfil = at(seed, 'fulfil', memory);
      if (!base || !fulfil) { lines.push(`- ${seed} · ${memory}: incomplete pair`); continue; }
      const delta = (left, right) => (left ?? null) === null || (right ?? null) === null ? null
        : Number((left - right).toFixed(3));
      lines.push(`- ${seed} · ${memory}: fulfil ${fmt(fulfil.metrics.primary.numerator)}/`
        + `${fmt(fulfil.metrics.primary.denominator)} vs base `
        + `${fmt(base.metrics.primary.numerator)}/${fmt(base.metrics.primary.denominator)} `
        + `(delta ${fmt(delta(fulfil.metrics.primary.value, base.metrics.primary.value), 3)}); `
        + `late ${fmt(fulfil.metrics.postCancel.latePhysicalEffects)} vs `
        + `${fmt(base.metrics.postCancel.latePhysicalEffects)}; gap ${fmt(fulfil.metrics.resources.gapHours.food, 1)}`
        + ` vs ${fmt(base.metrics.resources.gapHours.food, 1)} h`);
    }
  }
  lines.push('');
  lines.push('Reference note: the reference arm has no model head; its rows are controls on the '
    + 'same scenario and story schedule. A legal early completion is recorded as `not_exposed` '
    + 'and the pre-designed delegation provides the opportunity; no arm is credited with a '
    + 'zero-violation result on a zero opportunity.');
  lines.push('');
  lines.push('## Resources — final inventory hours vs four-day gap hours');
  lines.push('');
  lines.push('| game | inventory h (food / firewood / power) | gap h (food / firewood / power) |');
  lines.push('| --- | --- | --- |');
  for (const row of table.rows) {
    const inv = row.metrics?.resources?.inventoryHours ?? null;
    const gap = row.metrics?.resources?.gapHours ?? null;
    const fmt3 = value => value === null || value === undefined ? '—' : fmt(value, 1);
    lines.push(`| ${row.dir} | ${inv ? `${fmt3(inv.food)} / ${fmt3(inv.firewood)} / ${fmt3(inv.power)}` : '—'} `
      + `| ${gap ? `${fmt3(gap.food)} / ${fmt3(gap.firewood)} / ${fmt3(gap.power)}` : '—'} |`);
  }
  lines.push('');
  lines.push('checks: ' + Object.entries(table.checks)
    .map(([key, value]) => `${key}=${value}`).join(' · '));
  return `${lines.join('\n')}\n`;
}

/**
 * Rebuild metrics.json from the persisted evidence (complete decisions,
 * workLog, receipts, memories, timeline). Never touches the game itself.
 */
function recomputeMetrics(dir) {
  const files = gameFiles(dir);
  const exit = readJson(files.exitState);
  const delegates = readJson(files.delegates)?.rows ?? [];
  const startRows = (readJson(files.start)?.commitments ?? [])
    .map(row => ({ ...row, origin: 'initial' }));
  const decisions = [...readJsonl(files.decisionsStart), ...readJsonl(files.decisionsResume)];
  const final = readJson(files.final);
  if (!final?.state) throw new Error(`no final-state.json in ${dir}`);
  const state = final.state;
  const survivors = state.domains?.life?.ending?.survivors
    ?? Object.values(state.world?.npcs ?? {}).filter(npc => npc.alive).length;
  const metrics = collectInstanceMetrics({
    initialCommitments: [...startRows, ...delegates, ...(exit?.checkpoint?.commitments ?? [])],
    saveActiveIds: (exit?.checkpoint?.commitments ?? []).map(row => row.commitmentId),
    finalCommitments: state.commitments?.commitments ?? [],
    decisions, workLog: state.workLog ?? [], finalIntents: state.intents ?? [],
    receipts: state.receipts ?? [], memories: state.memories ?? {},
    timeline: (readJson(files.final)?.timeline ?? readJson(files.timeline)?.samples ?? []),
    interference: readJson(files.interference) ?? { stories: [] },
    delegations: delegates,
    clock: { start: SCENARIO.start, end: state.clock?.simTime ?? 0 },
    survivors, ending: state.clock?.endingKind ?? null,
  });
  metrics.resourceControls = gapSelfTest();
  const reconciliationReport = reconciliation(metrics);
  writeJson(files.metrics, { ...metrics, reconciliation: reconciliationReport });
  console.log(JSON.stringify({ dir: rel(dir), primary: metrics.primary,
    reconciled: reconciliationReport.ok }, null, 2));
  return EXIT.ok;
}

/* --------------------------- D2 human view --------------------------- */
function d2Report(dir) {
  const files = gameFiles(dir);
  const exit = readJson(files.exitState);
  const manifest = readJson(files.saveManifest);
  const load = readJson(files.resumeLoad);
  const phaseStart = readJson(files.phase('start'));
  const phaseResume = readJson(files.phase('resume'));
  if (!exit) throw new Error(`no D2 exit state in ${dir}`);
  const lines = [];
  lines.push(`# D2 save / new-pid resume — ${exit.arm} / ${exit.seed}`);
  lines.push('');
  lines.push(`save clock **${exit.simTime}** (D${Math.floor(exit.simTime / 1440) + 1} `
    + `${String(Math.floor((exit.simTime % 1440) / 60)).padStart(2, '0')}:`
    + `${String(exit.simTime % 60).padStart(2, '0')}) · pid start **${exit.pid}** · `
    + `pid resume **${load?.pid ?? '—'}** · state SHA \`${exit.stateSha256.slice(0, 16)}\``);
  lines.push('');
  lines.push('## Active commitments and their bound in-flight work');
  lines.push('');
  lines.push('| promisor | goal | commitment id | revision | status | deadline | working intent ids bound to this instance+revision |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of exit.checkpoint.commitments) {
    const intents = row.boundWorkingIntents.map(intent =>
      `${intent.intentId} (${intent.action} ${intent.startedAt}→${intent.dueAt}, r${intent.commitmentRevision}, g${intent.generation})`);
    lines.push(`| ${row.promisorId} | ${row.goal} | \`${row.commitmentId}\` | ${row.revision} | ${row.status} | ${row.deadline ?? '—'} | `
      + `${intents.length ? intents.join('<br>') : '—'} |`);
  }
  lines.push('');
  lines.push(`Bound-working count **${exit.checkpoint.boundWorkingIntents}** · `
    + `all pending intents **${exit.checkpoint.pending}** · `
    + `active commitments **${exit.checkpoint.activeCommitments}**`);
  lines.push('');
  lines.push('## Save files');
  lines.push('');
  lines.push('| file | sha256 |');
  lines.push('| --- | --- |');
  for (const [name, hash] of Object.entries(manifest?.files ?? {})) {
    lines.push(`| ${name} | \`${hash}\` |`);
  }
  lines.push('');
  lines.push('## Resume evidence');
  lines.push('');
  lines.push(`- restored from: \`${rel(files.save)}\``);
  lines.push(`- new pid: ${load?.pid ?? '—'} (start pid ${exit.pid})`);
  lines.push(`- full-state restore compare: ${readJson(files.restoreCompare)?.compare?.equal
    ? 'equal' : 'DIFFERS'}`);
  lines.push(`- resume phase exit: ${phaseResume?.exitCode ?? '—'}; start phase exit: ${phaseStart?.exitCode ?? '—'}`);
  lines.push('');
  const text = `${lines.join('\n')}\n`;
  writeFileSync(join(dir, 'D2-SAVE.md'), text, 'utf8');
  console.log(text);
  return EXIT.ok;
}

/**
 * Rebuild summary.json / matrix-table.json from the evidence already on disk,
 * e.g. after --recompute changed metrics.json. Gameplay is not touched.
 */
function regenerate() {
  const out = resolve(arg('--out') ?? 'artifacts/r11/matrix');
  const table = readJson(join(out, 'matrix-table.json'));
  if (!table) throw new Error(`no matrix-table.json in ${out}`);
  const rows = [];
  for (const prior of table.rows) {
    const arm = ARMS.find(entry => entry.id === prior.arm)
      ?? (prior.arm === PROBE_ARM.id ? PROBE_ARM : null);
    if (!arm) { rows.push(prior); continue; }
    const dir = resolve(ROOT, prior.dir);
    const exits = prior.exits ?? { start: null, resume: null, continuous: null,
      segmentedStart: null, segmentedEnd: null };
    const identity = gameIdentity({ arm, seed: prior.seed, dir, exits });
    const verify = readJson(join(dir, 'verify-d2.json'));
    writeJson(join(dir, 'summary.json'), { ...identity, status: prior.status,
      verify: verify?.ok ?? null, exposed: verify?.exposed ?? null,
      tamper: readJson(join(dir, 'tamper.json'))?.ok ?? null });
    rows.push({ ...identity, status: prior.status, dir: prior.dir,
      verifyOk: verify?.ok ?? null, exposed: verify?.exposed ?? null,
      tamperOk: readJson(join(dir, 'tamper.json'))?.ok ?? null });
  }
  const seeds = table.seeds;
  const checks = matrixChecks(rows, { positive: EXIT.ok, negative: EXIT.commitmentInput, seeds });
  const next = { ...table, generatedAt: new Date().toISOString(), rows, checks };
  writeJson(join(out, 'matrix-table.json'), next);
  writeFileSync(join(out, 'MATRIX.md'), matrixMarkdown(next), 'utf8');
  const instances = [];
  for (const row of rows) {
    const metrics = readJson(join(ROOT, row.dir, 'metrics.json'));
    for (const instance of metrics?.obligations ?? []) {
      instances.push({ arm: row.arm, seed: row.seed, status: row.status, ...instance });
    }
  }
  writeJsonl(join(out, 'INSTANCES.jsonl'), instances);
  console.log(JSON.stringify({ rows: rows.length, checks }, null, 2));
  return EXIT.ok;
}

/* ------------------------------ freeze ------------------------------ */
function freeze() {
  const out = resolve(arg('--out') ?? 'artifacts/r11/matrix');
  mkdirSync(out, { recursive: true });
  const preregistration = {
    schema: 'frostecho.r11.preregistration/1',
    generatedAt: new Date().toISOString(),
    source: SOURCE, scenarioSha: SCENARIO_SHA, metricSpecSha: sha(METRIC_SPEC),
    seeds: ['r11h-1', 'r11h-2'],
    seedJustification: 'neither seed appears in any R10 arm directory or artifact',
    commonInitialWorld: {
      rule: 'same seed -> same createWorldV2 state + same initial resources + same '
        + 'warehouse stock + same npc_07 location + same deterministic ids',
      hash: 'd1-start.json.worldInitSha, identical for every arm of a seed',
    },
    arms: ARMS.map(arm => ({ id: arm.id, recipe: arm.recipe, memory: arm.memory,
      family: arm.family })),
    primaryMetric: METRIC_SPEC.primary,
    secondaryMetrics: METRIC_SPEC.secondary,
    opportunityRule: {
      cancelHeard: 'an active instance at saveClock + 60 min',
      cancelUnheard: 'a second active instance at saveClock + 60 min',
      relay: 'the unheard instance still active at saveClock + 90 min',
      change: 'an open alt-source change created by a real out_of_stock after the drain',
      restock: 'the warehouse restock at saveClock + 240 min; exposure = the promisor '
        + 'witnessed it (location-scoped engine memory)',
      contention: '>=2 active deliver-meal instances when the warehouse is drained to 1',
      notExposed: 'null / not_exposed, never a zero',
    },
    interferenceRule: 'absolute world minutes = saveClock + the frozen offsets '
      + `${JSON.stringify(OFFSETS)}; the save itself is at the first round >= D2 08:00 with `
      + '>=1 active commitment and >=1 working intent bound to that instance and revision',
    checkpointDelegation: SCENARIO.checkpoint.delegation,
    followUpDelegation: SCENARIO.interference.followUp,
    replayControls: ['continuous same-action replay', 'segmented same-action replay'],
    fullStateComponents: ['world', 'map cells/roads/stocks/carry', 'tasks', 'commitments+refs',
      'memories+provenance+relations', 'domains', 'intents/work progress/generations',
      'receipts', 'rng (seed+version+next draws)'],
    exclusions: SCENARIO.exclusions,
    budgetNote: 'inherits the project 10 GPU-hour ledger; this freeze does not open a new pot',
  };
  writeJson(join(out, 'scenario.json'), { ...SCENARIO, scenarioSha: SCENARIO_SHA });
  writeJson(join(out, 'metric-spec.json'), METRIC_SPEC);
  writeJson(join(out, 'preregistration.json'), preregistration);
  mkdirSync(join(HANDOFF, 'H'), { recursive: true });
  writeJson(join(HANDOFF, 'H', 'SCENARIO-FREEZE.json'), {
    schema: 'frostecho.r11.scenario-freeze/1', scenario: { ...SCENARIO, scenarioSha: SCENARIO_SHA },
    metricSpec: METRIC_SPEC, preregistration,
  });
  console.log(JSON.stringify({ scenarioSha: SCENARIO_SHA, metricSpecSha: preregistration.metricSpecSha,
    files: [rel(join(out, 'scenario.json')), rel(join(out, 'metric-spec.json')),
      rel(join(out, 'preregistration.json')), join(HANDOFF, 'H', 'SCENARIO-FREEZE.json')] }, null, 2));
  return EXIT.ok;
}

/* ------------------------------ exposure ------------------------------ */
async function exposure() {
  const out = resolve(arg('--out') ?? 'artifacts/r11/matrix');
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const seed of (arg('--seeds') ?? 'r11h-1,r11h-2').split(',').filter(Boolean)) {
    for (const arm of [PROBE_ARM, ...REFERENCE_ARMS]) {
      const row = await runGame(arm, seed, join(out, 'exposure'), []);
      results.push({ seed, arm: arm.id, status: row.status, save: row.save, restore: row.restore,
        interference: row.interference, replay: row.replay, verifyOk: row.verifyOk,
        tamperOk: row.tamperOk, dir: row.dir,
        primary: row.metrics?.primary ?? null, exposure: row.metrics?.exposure ?? null });
    }
  }
  const report = { schema: 'frostecho.r11.exposure/1', generatedAt: new Date().toISOString(),
    source: SOURCE, scenarioSha: SCENARIO_SHA, gapSelfTest: gapSelfTest(), results,
    ok: results.length === 6 && results.every(row => row.status === 'completed'
      && row.save.boundWorkingIntents > 0 && row.restore?.equal && row.verifyOk && row.tamperOk)
      && results.filter(row => row.arm === 'probe-bridge-first').every(row =>
        row.exposed === true
        && row.exposure?.changeOpportunities > 0 && row.exposure?.contentionOpportunities >= 2
        && row.exposure?.restockWitnessed > 0),
    note: 'the probe proves the scenario offers all four stories; the reference rows record '
      + 'what the reference policy actually took, with not_exposed kept as null' };
  writeJson(join(out, 'exposure.json'), report);
  console.log(JSON.stringify({ ok: report.ok, results: results.map(row => ({
    seed: row.seed, status: row.status, save: row.save, restore: row.restore?.equal,
    verify: row.verifyOk, tamper: row.tamperOk, primary: row.primary })) }, null, 2));
  return report.ok ? EXIT.ok : EXIT.matrixIncomplete;
}

/**
 * Rebuild exposure.json from the games already on disk, using the current
 * verifier. The games themselves are never rerun or edited.
 */
function exposureSummary() {
  const out = resolve(arg('--out') ?? 'artifacts/r11/matrix');
  const root = join(out, 'exposure');
  const results = [];
  const walk = family => {
    const base = join(root, family);
    if (!existsSync(base)) return;
    for (const arm of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!arm.isDirectory() || arm.name.includes('.superseded-')) continue;
      const armDir = join(base, arm.name);
      for (const seed of readdirSync(armDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!seed.isDirectory() || seed.name.includes('.superseded-')) continue;
        const dir = join(armDir, seed.name);
        const verify = verifyGame(dir);
        const summary = readJson(join(dir, 'summary.json')) ?? {};
        const metrics = readJson(join(dir, 'metrics.json')) ?? {};
        const continuous = readJson(join(dir, 'replay-continuous', 'compare.json'));
        const segmented = readJson(join(dir, 'replay-segmented', 'compare.json'));
        results.push({ seed: seed.name, arm: arm.name, status: summary.status ?? null,
          save: summary.save ?? null, restore: summary.restore ?? null,
          verifyOk: verify.ok, exposed: verify.exposed,
          verification: verify.checks.map(row => [row.name, row.passed]),
          exposureChecks: verify.exposure.map(row => [row.name, row.passed]),
          tamperOk: readJson(join(dir, 'tamper.json'))?.ok ?? null,
          replay: { continuous: continuous?.compare?.equal ?? null,
            segmented: segmented?.compare?.equal ?? null },
          dir: rel(dir),
          primary: metrics.primary ?? null, exposure: metrics.exposure ?? null });
      }
    }
  };
  walk('probe');
  walk('reference');
  const report = { schema: 'frostecho.r11.exposure/1', generatedAt: new Date().toISOString(),
    source: SOURCE, scenarioSha: SCENARIO_SHA, gapSelfTest: gapSelfTest(), results,
    ok: results.length === 6 && results.every(row => row.status === 'completed'
      && row.save?.boundWorkingIntents > 0 && row.restore?.equal && row.verifyOk && row.tamperOk)
      && results.filter(row => row.arm === 'probe-bridge-first').every(row =>
        row.exposed === true
        && row.exposure?.changeOpportunities > 0 && row.exposure?.contentionOpportunities >= 2
        && row.exposure?.restockWitnessed > 0),
    note: 'the probe proves the scenario offers all four stories; the reference rows record '
      + 'what the reference policy actually took, with not_exposed kept as null' };
  writeJson(join(out, 'exposure.json'), report);
  console.log(JSON.stringify({ ok: report.ok, results: results.map(row => ({
    seed: row.seed, arm: row.arm, status: row.status, verify: row.verifyOk,
    exposed: row.exposed, tamper: row.tamperOk, restore: row.restore?.equal,
    replay: row.replay })) }, null, 2));
  return report.ok ? EXIT.ok : EXIT.matrixIncomplete;
}

/* ------------------------------- main ------------------------------- */
async function main() {
  if (flag('--diagnostic-unbound')) {
    console.error('--diagnostic-unbound is not implemented in H: an unbound diagnostic '
      + 'reply cannot execute an action and must never be counted as a model arm. '
      + 'Use --scorer-command-json for an explicitly labelled control instead.');
    return EXIT.internal;
  }
  if (flag('--freeze')) return freeze();
  if (flag('--exposure')) return exposure();
  if (flag('--matrix')) return matrix();
  if (flag('--exposure-summary')) return exposureSummary();
  if (flag('--regenerate')) return regenerate();
  if (flag('--probe-game')) {
    const seed = arg('--seed');
    if (!seed) throw new Error('--probe-game needs --seed');
    const row = await runGame(PROBE_ARM, seed, join(resolve(arg('--out') ?? 'artifacts/r11/matrix'), 'exposure'), []);
    return row.status === 'completed' ? EXIT.ok : EXIT.matrixIncomplete;
  }
  if (flag('--verify')) {
    if (!arg('--out')) throw new Error('--verify needs --out <gameDir>');
    const report = verifyGame(resolve(arg('--out')));
    console.log(JSON.stringify({ ok: report.ok, failed: report.checks
      .filter(row => !row.passed).map(row => row.name) }, null, 2));
    return report.ok ? EXIT.ok : EXIT.replay;
  }
  if (flag('--recompute')) {
    if (!arg('--out')) throw new Error('--recompute needs --out <gameDir>');
    return recomputeMetrics(resolve(arg('--out')));
  }
  if (flag('--d2-report')) {
    if (!arg('--out')) throw new Error('--d2-report needs --out <gameDir>');
    return d2Report(resolve(arg('--out')));
  }
  if (flag('--tamper')) {
    if (!arg('--out')) throw new Error('--tamper needs --out <gameDir>');
    const report = tamperGame(resolve(arg('--out')));
    console.log(JSON.stringify({ ok: report.ok, results: report.results
      .map(row => [row.label, row.name, row.detected, row.categoryDetected]) }, null, 2));
    return report.ok ? EXIT.ok : EXIT.tamper;
  }
  const phase = arg('--phase');
  const armId = arg('--arm');
  const seed = arg('--seed');
  const out = arg('--out');
  if (!phase || !armId || !seed || !out) {
    console.error('need --freeze|--exposure|--matrix|--verify|--tamper or '
      + '--phase start|resume|replay-continuous|replay-segmented-start|replay-segmented-end '
      + '--arm <id> --seed <seed> --out <dir>');
    return EXIT.internal;
  }
  const arm = ARMS.find(entry => entry.id === armId)
    ?? (armId === PROBE_ARM.id ? PROBE_ARM : undefined);
  if (!arm) { console.error(`unknown arm ${armId}`); return EXIT.internal; }
  installDeterministicIds(seed);
  if (phase === 'start') return phaseStart(arm, seed, resolve(out));
  if (phase === 'resume') return phaseResume(arm, seed, resolve(out), { mode: 'resume' });
  if (phase === 'replay-continuous') return phaseReplayContinuous(arm, seed, resolve(out));
  if (phase === 'replay-segmented-start') return phaseReplaySegmentedStart(arm, seed, resolve(out));
  if (phase === 'replay-segmented-end') return phaseReplaySegmentedEnd(arm, seed, resolve(out));
  console.error(`unknown phase ${phase}`);
  return EXIT.internal;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error);
  process.exitCode = EXIT.internal;
});
