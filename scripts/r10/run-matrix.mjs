#!/usr/bin/env node
/**
 * R10 (H): the eight-game matrix and its evidence.
 *
 *   2 heads (old / new) x 2 memory fills (raw / conditional) x 2 fresh seeds
 *   = 8 live games, plus a CPU reference arm on the SAME two seeds and the SAME
 *   scenario. Every game is one four-day run (D1 08:00 -> D4 18:00). At D2, as
 *   soon as real unfinished work exists, the game saves, the process exits, and
 *   a NEW process restores the save and runs to D4. Same-action replay is a
 *   separate control and is never counted as a model result.
 *
 * The world, the candidate layer and the scripted events are one frozen
 * `SCENARIO` (hash written next to every game). The memory token budget is 640
 * for every arm; only the selection rule differs.
 *
 * Hard gates (a failure is recorded, never replaced by rules or replay):
 *   - no commitment input  -> exit 10 and the game refuses to start;
 *   - live head missing    -> exit 12;
 *   - live head manifest   -> exit 13 / SHA 15 / renderer 14;
 *   - scorer failure       -> exit 16;
 *   - unsettled/duplicate/unauthorised settlement -> exit 17;
 *   - replay differs       -> exit 18.
 *
 * Commands
 *   node scripts/r10/run-matrix.mjs --matrix [--out artifacts/r10/matrix]
 *   node scripts/r10/run-matrix.mjs --phase start|resume|replay \
 *        --arm <armId> --seed <seed> --out <gameDir>
 *   node scripts/r10/run-matrix.mjs --probe-commitment-input --out <dir>
 *   node scripts/r10/run-matrix.mjs --probe-missing-commitments --out <dir>
 *
 * Optional overrides: --seeds a,b  --old-head/--old-manifest
 *                     --new-head/--new-manifest  --scorer-command-json
 */
import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.FROSTECHO_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const require = createRequire(import.meta.url);
const mod = rel => require(join(ROOT, 'dist', rel));

const { R8Runtime } = mod('src/r7/integration/runtime.js');
const { GameplayLoop } = mod('src/gameplay-v2/loop.js');
const { createCommitmentBridge } = mod('src/r7/integration/commitment-bridge.js');
const { runStep } = mod('src/r7/integration/step.js');
const { referenceAgencyScorer } = mod('src/r7/agency/reference.js');
const { makeChoiceResult } = mod('src/decision/contracts.js');
const { encodingEnvelope } = mod('src/r7/ui/joint-scorer.js');
const { GOSPEL_PROFILE } = mod('src/r7/contracts.js');
const { RENDERER_ID } = mod('src/r7/jev/render.js');
const { runCouncilIfDue, notesFor } = mod('scripts/r8/playthrough.js');
const { TaskBoard } = mod('src/gameplay-v2/tasks.js');
const { CommitmentBoard } = mod('src/gameplay-v2/commitments.js');
const { CouncilBoard } = mod('src/council-v2/council.js');
const { ExperienceStore } = mod('src/memory/experience.js');
const { BUILDINGS, MAPS, findPath } = mod('src/spatial-v2/map.js');

const PROFILE = GOSPEL_PROFILE;
const PYTHON = process.env.FROSTECHO_PYTHON ?? '/data/home/user_00/frostecho-r7/.venv/bin/python';
const ENCODER = process.env.FROSTECHO_ENCODER ?? '/data2/model_weights/Qwen3.8-27B';

/** Process exit codes. They are part of the evidence, so they never move. */
const EXIT = {
  ok: 0,
  commitmentInput: 10,
  noPendingWork: 11,
  headArtifact: 12,
  headManifest: 13,
  headRenderer: 14,
  headSha: 15,
  scorer: 16,
  settlement: 17,
  replay: 18,
  internal: 19,
  matrixIncomplete: 20,
};

/* ------------------------------------------------------------------ *
 * One frozen experiment script. Every arm gets exactly this document. *
 * ------------------------------------------------------------------ */
const SCENARIO = {
  schema: 'frostecho.r10.matrix-scenario/1',
  profile: PROFILE.id,
  npcCount: 8,
  startDay: PROFILE.startDay,
  startMinuteOfDay: PROFILE.startMinuteOfDay,
  endDay: PROFILE.endDay,
  endMinuteOfDay: PROFILE.endMinuteOfDay,
  resources: { food: 130, firewood: 30, power: 30, medicine: 3 },
  commitments: [
    { actorId: 'npc_01', goal: 'deliver-meal', verdict: 'accept' },
    { actorId: 'npc_02', goal: 'deliver-meal', verdict: 'accept' },
    { actorId: 'npc_03', goal: 'supply-warehouse', verdict: 'accept' },
    { actorId: 'npc_04', goal: 'supply-warehouse', verdict: 'accept' },
  ],
  /** One scripted D2 interference, identical for every arm. */
  interference: {
    once: true,
    fromDay: 2,
    cancel: { index: 0, heardBy: ['npc_02'], reason: '玩家改主意' },
    change: { index: 1, kind: 'alt-source', reason: 'warehouse-empty',
      terms: { source: 'gather', reason: '先采集再交付' } },
  },
  /** Save only after real unfinished work exists, at/after D2 08:00. */
  checkpoint: { fromAbsoluteMinute: 1920, requirePendingWork: true },
  clock: {
    hourStepMinutes: 60,
    nightSkipFromMinute: PROFILE.nightSkipFromMinute,
    nightSkipToMinute: PROFILE.nightSkipToMinute,
    maxRounds: 1200,
  },
  memory: { topK: 12, budgetTokens: 640 },
  scripts: {
    council: 'dist/scripts/r8/playthrough.js runCouncilIfDue (reference council/1)',
    rescue: 'playthrough rescue dispatch on rescue_needed',
    night: 'playthrough night skip + routed walk home',
    referencePolicy: 'reference-rules/1 + survival-exit (reference arm only)',
    livePolicy: 'real scorer; no rule fallback',
    replay: 'recorded reselection, control only, excluded from results',
  },
};

const ARMS = [
  { id: 'old-raw', family: 'live', head: 'old', memory: 'raw-last12' },
  { id: 'old-conditional', family: 'live', head: 'old', memory: 'obligation-first' },
  { id: 'new-raw', family: 'live', head: 'new', memory: 'raw-last12' },
  { id: 'new-conditional', family: 'live', head: 'new', memory: 'obligation-first' },
  { id: 'reference-raw', family: 'reference', head: null, memory: 'raw-last12' },
  { id: 'reference-conditional', family: 'reference', head: null, memory: 'obligation-first' },
];
const LIVE_ARMS = ARMS.filter(arm => arm.family === 'live');
const REFERENCE_ARMS = ARMS.filter(arm => arm.family === 'reference');

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
const canonical = value => JSON.stringify(sortDeep(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const shaFile = path => sha(readFileSync(path));
const hex = (text, length = 16) => sha(text).slice(0, length);
const rel = path => path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const SOURCE = { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD') };
const SCENARIO_SHA = sha(canonical(SCENARIO));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
}
function shaMap(dir, skip = new Set(['summary.json', 'game-sha256.json'])) {
  const out = {};
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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
  if (arm.head === 'old') {
    return {
      label: 'old-r9-v3-warm17',
      head: arg('--old-head') ?? 'artifacts/r9/trained-v3/warm-17.safetensors',
      manifest: arg('--old-manifest') ?? 'artifacts/r9/trained-v3/selected.json',
    };
  }
  return {
    label: 'new-r10-joint-c-action-2',
    head: arg('--new-head') ?? 'artifacts/r10/heads/warm-17/warm-17.safetensors',
    manifest: arg('--new-manifest') ?? 'artifacts/r10/heads/warm-17/selected.json',
  };
}

/**
 * Validate the head BEFORE the world is built. The python service repeats the
 * manifest/SHA/feature checks; this gate exists so a missing or stale head is a
 * recorded refusal instead of a half-started game.
 */
function preflightHead(arm) {
  const spec = headSpec(arm);
  const headPath = resolve(ROOT, spec.head);
  const manifestPath = resolve(ROOT, spec.manifest);
  const rendererSource = join(ROOT, 'src/r7/jev/render.ts');
  const checks = {
    headPath: rel(headPath), manifestPath: rel(manifestPath),
    rendererId: RENDERER_ID,
    rendererSourceSha256: shaFile(rendererSource),
    headExists: existsSync(headPath),
    manifestExists: existsSync(manifestPath),
  };
  const refuse = (code, reason) => ({ ok: false, code, reason, ...checks });
  if (!checks.headExists) return refuse(EXIT.headArtifact, 'head_artifact_missing');
  if (!checks.manifestExists) return refuse(EXIT.headManifest, 'head_manifest_missing');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return refuse(EXIT.headManifest, `head_manifest_unreadable:${error.message}`);
  }
  const shapeOk = manifest.schema === 'frostecho.action-weak-experiment/1'
    && manifest.experimental === true && manifest.countsAsAdmitted === false
    && manifest.calibrated === false && manifest.researchTrainReady === false
    && manifest.mayTrainOnJev === false
    // serve_joint.py only accepts labelSource "reference-imitation"; R10 heads
    // use a different (still unadmitted) label source, so the label source is
    // recorded here and bound by this harness instead of being silently lost.
    && typeof manifest.labelSource === 'string' && manifest.labelSource.length > 0
    && manifest.encodingExecution?.batchSize === 1
    && manifest.encodingExecution?.padMultiple === 8
    && typeof manifest.encodingQualification?.sha256 === 'string';
  if (!shapeOk) return refuse(EXIT.headManifest, 'head_manifest_not_the_weak_experiment');
  const headSha = shaFile(headPath);
  checks.headSha256 = headSha;
  checks.manifestSha256 = shaFile(manifestPath);
  checks.manifestSelectedSha256 = manifest.selectedCheckpointSha256 ?? null;
  checks.manifestSelectedCheckpoint = manifest.selectedCheckpoint ?? null;
  checks.manifestRendererSourceSha256 = manifest.featureIdentity?.rendererSourceSha256 ?? null;
  checks.manifestDimension = manifest.featureIdentity?.dimension ?? null;
  checks.labelSource = manifest.labelSource;
  checks.manifestFeatureIdentityHash = manifest.featureIdentityHash ?? null;
  checks.placement = manifest.encodingExecution?.placement ?? 'auto';
  checks.physicalGpus = Array.isArray(manifest.featureIdentity?.physicalGpus)
    ? manifest.featureIdentity.physicalGpus : [1];
  if (manifest.selectedCheckpointSha256 !== headSha) return refuse(EXIT.headSha, 'head_sha_differs_from_manifest');
  if (manifest.selectedCheckpoint && basename(headPath) !== manifest.selectedCheckpoint)
    return refuse(EXIT.headSha, `head_file_${basename(headPath)}_differs_from_manifest_${manifest.selectedCheckpoint}`);
  if (manifest.featureIdentity?.dimension !== 5120) return refuse(EXIT.headManifest, 'head_dimension_not_5120');
  if (checks.manifestRendererSourceSha256 !== checks.rendererSourceSha256)
    return refuse(EXIT.headRenderer, 'head_was_trained_on_another_renderer');
  if (!checks.manifestFeatureIdentityHash) return refuse(EXIT.headManifest, 'head_manifest_lacks_feature_identity_hash');
  checks.manifestBinding = {
    reason: manifest.labelSource === 'reference-imitation' ? null
      : `serve_joint.py accepts only labelSource "reference-imitation"; this head is "${manifest.labelSource}". `
        + 'The harness passes the same head without --training-manifest and verifies headSha256, '
        + 'featureIdentityHash and rendererId on every reply.',
    headSha256: headSha, featureIdentityHash: checks.manifestFeatureIdentityHash,
    labelSource: manifest.labelSource,
  };
  return { ok: true, code: EXIT.ok, ...checks };
}

/* --------------------- commitment input gate --------------------- */
function buildWorld(seed, { seedCommitments = true } = {}) {
  const runtime = R8Runtime.create({ seed, profile: PROFILE,
    npcCount: SCENARIO.npcCount, resources: SCENARIO.resources });
  const play = new GameplayLoop(runtime.session);
  const bridge = createCommitmentBridge(runtime, play);
  const seeds = [];
  if (seedCommitments) {
    for (const entry of SCENARIO.commitments) {
      const requested = play.requestCommitment(entry.actorId, entry.goal, { verdict: entry.verdict });
      seeds.push({ ...entry, commitmentId: requested.commitment.commitmentId,
        taskId: requested.task?.taskId ?? null, status: requested.commitment.status });
    }
  }
  return { runtime, play, bridge, seeds };
}

/**
 * The experiment refuses to start when no commitment input reaches the model.
 * This is a positive check: four promisors, four live goals, four tasks.
 */
function commitmentInputReport(world) {
  const rows = world.play.commitments.all();
  const perPromisor = SCENARIO.commitments.map(entry => {
    const view = world.bridge.view(entry.actorId);
    const goals = view.goals.filter(goal => goal?.source === 'legacy-commitment');
    const row = rows.find(item => item.promisorId === entry.actorId);
    return {
      actorId: entry.actorId, goal: entry.goal,
      commitmentId: row?.commitmentId ?? null,
      commitmentStatus: row?.status ?? null,
      goalsInInput: goals.length,
      candidatesInInput: view.candidates.length,
      taskActive: row?.taskId ? world.play.board.find(row.taskId)?.status ?? null : null,
    };
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

/* ----------------------------- world hashes ----------------------------- */
function worldInit(runtime, world) {
  const snapshot = runtime.snapshot();
  return {
    seed: runtime.session.seed, profile: PROFILE.id, simTime: runtime.world.simTime,
    resources: snapshot.resources,
    npcs: Object.values(snapshot.npcs).map(npc => ({ id: npc.id, location: npc.location,
      alive: npc.alive, hunger: npc.hunger, stamina: npc.stamina, health: npc.health,
      san: npc.san, bodyTemp: npc.bodyTemp })).sort((a, b) => a.id.localeCompare(b.id)),
    commitments: world.seeds.map(item => ({ actorId: item.actorId, goal: item.goal,
      status: item.status, taskId: item.taskId })),
    memoryBudget: SCENARIO.memory.budgetTokens,
  };
}

/** Deterministic end-state fingerprint; the replay control must reproduce it. */
function fingerprint(runtime, play) {
  const snapshot = runtime.snapshot();
  return {
    simTime: runtime.world.simTime, version: runtime.world.version,
    ended: runtime.ended, ending: runtime.endingKind,
    resources: snapshot.resources, furnace: snapshot.furnace, machines: snapshot.machines,
    npcs: Object.values(snapshot.npcs).map(npc => ({ id: npc.id, location: npc.location,
      alive: npc.alive, hunger: npc.hunger, stamina: npc.stamina, health: npc.health,
      san: npc.san, bodyTemp: npc.bodyTemp })).sort((a, b) => a.id.localeCompare(b.id)),
    commitments: play.commitments.all().map(row => ({
      commitmentId: row.commitmentId, promisorId: row.promisorId, goal: row.goal,
      status: row.status, revision: row.revision, deadline: row.deadline,
      conditions: row.conditions, evidence: row.evidenceEventIds,
      changes: row.changes.map(change => ({ kind: change.kind, status: change.status,
        proposedRevision: change.proposedRevision, terms: change.terms })),
    })).sort((a, b) => a.commitmentId.localeCompare(b.commitmentId)),
    tasks: play.board.toJSON().map(task => ({ taskId: task.taskId, type: task.type,
      status: task.status, actorId: task.actorId, commitmentId: task.commitmentId }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    intents: [...runtime.intents.values()].map(intent => ({
      intentId: intent.intentId, actorId: intent.actorId, status: intent.status,
      startedAt: intent.startedAt, dueAt: intent.dueAt, settledAt: intent.settledAt,
      receiptIds: intent.receiptIds, failureReason: intent.failureReason,
      commitmentId: intent.commitmentId, commitmentRevision: intent.commitmentRevision,
      taskId: intent.taskId,
    })).sort((a, b) => a.intentId.localeCompare(b.intentId)),
    receipts: runtime.committedEvents().map(event => ({ eventId: event.eventId,
      type: event.type, actorId: event.actorId, simTime: event.simTime,
      amount: event.payload.amount ?? null, to: event.payload.to ?? null,
      place: event.payload.place ?? null }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
    workLog: runtime.workLog.map(entry => ({ intentId: entry.intentId, status: entry.status,
      eventIds: entry.eventIds })).sort((a, b) => a.intentId.localeCompare(b.intentId)),
  };
}

/* ------------------------------ scorers ------------------------------ */
class LiveScorer {
  constructor(command, { transcript, timeoutMs = 300000, binding = null } = {}) {
    this.command = command;
    this.transcript = transcript;
    this.timeoutMs = timeoutMs;
    this.binding = binding;
    this.child = null;
    this.pending = new Map();
    this.pinned = null;
    this.identity = { mode: 'jev-experimental', scorerId: 'jev-joint-c/1',
      rendererId: RENDERER_ID, experimental: true, countsAsAdmitted: false };
    this.forwardCalls = 0;
    this.requests = 0;
    this.singleCandidateSkips = 0;
    this.timeouts = 0;
    this.ready = null;
    this.stderrBuffer = '';
    this.serviceStartedAt = null;
    this.serviceClosedAt = null;
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
    this.child = child;
    this.serviceStartedAt = new Date().toISOString();
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
        } catch { /* diagnostics, not JSONL */ }
      }
    });
    child.on('error', error => { if (this.child === child) this.child = null; fail(error); });
    child.on('exit', code => {
      if (this.child === child) this.child = null;
      this.serviceClosedAt = new Date().toISOString();
      this.record({ event: 'scorer_exit', code });
      fail(new Error(`scorer_process_exited:${code}`));
    });
    this.record({ event: 'scorer_start', command: this.command });
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
          clearTimeout(row.timer); this.pending.delete(id);
          row.reject(new Error('scorer_timeout'));
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
    // Count the forward that already happened before a binding refusal is raised:
    // the encoder really ran, and that cost must stay in the evidence.
    if (typeof identity.encoderForwardCalls === 'number')
      this.forwardCalls = Math.max(this.forwardCalls, identity.encoderForwardCalls);
    if (this.binding) {
      // The head's own manifest is not passed to serve_joint (it would reject
      // a non-imitation label source), so the same technical binding is
      // enforced here: exact head bytes, exact online feature identity, and no
      // manifest the service could have substituted.
      if (identity.headSha256 !== this.binding.headSha256)
        throw new Error(`head_sha_differs_from_manifest:${identity.headSha256}`);
      if (identity.featureIdentityHash !== this.binding.featureIdentityHash)
        throw new Error(`online_feature_identity_differs:${identity.featureIdentityHash}`);
      if (identity.trainingManifestSha256)
        throw new Error('scorer_loaded_an_unexpected_manifest');
      if (identity.rendererId !== this.binding.rendererId)
        throw new Error(`renderer_differs:${identity.rendererId}`);
    }
    const counters = new Set(['requestsReceived', 'scoresSucceeded', 'requestsFailed',
      'encoderForwardCalls', 'encoderForwardAttempts']);
    const pinned = canonical(Object.entries(identity)
      .filter(([key]) => !counters.has(key)).sort(([a], [b]) => a.localeCompare(b)));
    if (this.pinned !== null && this.pinned !== pinned)
      throw new Error('scorer_identity_changed');
    this.pinned = pinned;
    this.identity = { ...identity };
    return makeChoiceResult({ request, scorerId: identity.scorerId,
      scores: reply.scores, selectedId: reply.selectedId ?? null,
      disposition: reply.disposition, reason: String(reply.reason ?? 'joint encoder score') });
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
      serviceWallSeconds: Math.max(0, wall), identity: this.identity };
  }
}

class ReplayScorer {
  constructor(rows) {
    this.byRequest = new Map(rows.map(row => [row.requestId, row]));
    this.byCandidateSet = new Map(rows.map(row => [`${row.actorId}|${row.candidateSetHash}`, row]));
    this.used = new Set();
    this.mismatches = [];
    this.identity = { mode: 'reference', scorerId: 'r10-replay/1', rendererId: RENDERER_ID,
      experimental: false, countsAsAdmitted: false };
  }

  score(request) {
    const hit = this.byRequest.get(request.requestId)
      ?? this.byCandidateSet.get(`${request.actorId}|${request.candidateSetHash}`);
    if (hit) this.used.add(hit.requestId);
    if (!hit || hit.candidateSetHash !== request.candidateSetHash
      || (hit.inputSha256 && hit.inputSha256 !== sha(JSON.stringify(request)))) {
      this.mismatches.push({ requestId: request.requestId, actorId: request.actorId,
        expected: hit?.candidateSetHash ?? null, actual: request.candidateSetHash,
        reason: hit ? 'candidate_set_or_input_changed' : 'request_not_recorded' });
      throw new Error(`replay_request_mismatch:${request.requestId}`);
    }
    return makeChoiceResult({ request, scorerId: 'r10-replay/1',
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

/* ------------------------------ clock ------------------------------ */
function gameplayOn(runtime, path) {
  const read = suffix => {
    const file = `${path}.${suffix}.json`;
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const tasks = read('tasks'), commitments = read('commitments');
  const council = read('council'), experience = read('experience');
  return new GameplayLoop(runtime.session,
    tasks ? TaskBoard.fromJSON(tasks) : new TaskBoard(),
    { ...(commitments ? { commitments: CommitmentBoard.fromJSON(commitments) } : {}),
      ...(council ? { council: CouncilBoard.fromJSON(council) } : {}),
      ...(experience ? { experience: ExperienceStore.fromJSON(experience) } : {}) });
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
    const wake = dayStart + PROFILE.minutesPerDay + PROFILE.nightSkipToMinute;
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
      const route = findPath(MAPS.village, from, door, closed).path;
      if (!route || route.length === 0) continue;
      const result = runtime.session.submitWorldCommand({ commandId: `sleep-${before}-${actorId}`,
        type: 'travel', actorId, route, minutesPerTile: 2 });
      if (result.status === 'applied') runtime.recordCommitted(result.events);
    }
  } else {
    to = Math.floor(before / (SCENARIO.clock.hourStepMinutes)) * SCENARIO.clock.hourStepMinutes
      + SCENARIO.clock.hourStepMinutes;
  }
  if (snapshot.furnace.lit) ctx.furnaceLitHours += Math.max(0, to - before) / 60;
  const report = runtime.advanceWorld(to);
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
  return { before, to, advanced: runtime.world.simTime !== before };
}

function decisionsSince(ctx, count) {
  return ctx.decisions.slice(count);
}

async function decideAll(ctx) {
  const { runtime } = ctx;
  const snapshot = runtime.snapshot();
  for (const actorId of runtime.context().actorIds) {
    if (ctx.arm.family === 'reference') {
      // The frozen reference baseline is allowed an explicit, recorded exit;
      // a live arm only gets the same candidate and must choose it itself.
      const npc = runtime.world.npcs[actorId];
      const danger = npc?.alive && (npc.hunger < 45 || npc.stamina < 35
        || (npc.bodyTemp ?? 36.5) < 35.9);
      if (danger) {
        for (const row of ctx.play.commitments.all()) {
          if (row.promisorId !== actorId || row.status !== 'active') continue;
          const exited = ctx.play.withdrawCommitment(row.commitmentId,
            { reason: 'survival-exit', inputId: `exit-${row.commitmentId}-${runtime.world.simTime}` });
          ctx.exits.push({ commitmentId: row.commitmentId, actorId,
            at: runtime.world.simTime, status: exited.commitment.status,
            hunger: Math.round(npc.hunger), stamina: Math.round(npc.stamina) });
        }
      }
    }
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

function checkpointState(ctx) {
  const working = [...ctx.runtime.intents.values()].filter(intent => intent.status === 'working');
  return {
    at: ctx.runtime.world.simTime, pending: working.length,
    commitmentBound: working.filter(intent => intent.commitmentId).length,
    intents: working.map(intent => ({ intentId: intent.intentId, actorId: intent.actorId,
      action: String(intent.candidate.parameters.action), startedAt: intent.startedAt,
      dueAt: intent.dueAt, commitmentId: intent.commitmentId,
      commitmentRevision: intent.commitmentRevision, taskId: intent.taskId })),
  };
}

async function playGame(ctx, { fromCheckpoint }) {
  const { runtime } = ctx;
  if (fromCheckpoint) advanceOneRound(ctx);
  while (!runtime.ended && ctx.rounds < SCENARIO.clock.maxRounds) {
    ctx.rounds += 1;
    const councilMark = ctx.councilDecisions.length;
    runCouncilIfDue(runtime, ctx.councilDecisions, ctx.seed);
    for (const record of ctx.councilDecisions.slice(councilMark)) {
      ctx.decisions.push({ ...record, seed: ctx.seed, arm: ctx.arm.id, phase: ctx.phase,
        policy: 'council-reference', at: runtime.world.simTime,
        day: runtime.snapshot().day, minuteOfDay: runtime.snapshot().minuteOfDay });
    }
    if (!ctx.interferenceApplied && runtime.snapshot().day >= SCENARIO.interference.fromDay) {
      ctx.interferenceApplied = true;
      const rows = ctx.play.commitments.all().filter(row => row.status === 'active');
      const cancelled = rows[SCENARIO.interference.cancel.index];
      const changed = rows[SCENARIO.interference.change.index];
      ctx.interference = {
        at: runtime.world.simTime, activeRows: rows.length,
        cancel: cancelled ? (() => {
          const result = ctx.play.cancelCommitment(cancelled.commitmentId,
            { heardBy: SCENARIO.interference.cancel.heardBy,
              reason: SCENARIO.interference.cancel.reason });
          return { commitmentId: cancelled.commitmentId, status: result.commitment.status,
            heardBy: SCENARIO.interference.cancel.heardBy };
        })() : null,
        change: changed ? (() => {
          const proposed = ctx.play.commitments.proposeChange(changed.commitmentId, {
            kind: SCENARIO.interference.change.kind,
            reason: SCENARIO.interference.change.reason,
            terms: SCENARIO.interference.change.terms,
            at: runtime.world.simTime, evidenceEventIds: [] });
          runtime.session.ingestCommitmentEvent(proposed.event);
          return { commitmentId: changed.commitmentId, status: proposed.commitment.status };
        })() : null,
      };
    }
    await decideAll(ctx);
    if (ctx.phase === 'start') {
      const state = checkpointState(ctx);
      if (state.pending > 0 && state.at >= SCENARIO.checkpoint.fromAbsoluteMinute) {
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

/* ------------------------------ metrics ------------------------------ */
function collectMetrics(ctx) {
  const { runtime, play, decisions } = ctx;
  const rows = play.commitments.all();
  const receipts = runtime.committedEvents();
  const intents = [...runtime.intents.values()];
  const fulfilmentType = row => row.goal === 'deliver-meal' ? 'meal_delivered' : 'stock_deposited';
  const evidenceOf = row => row.evidenceEventIds.map(id => receipts.find(event => event.eventId === id))
    .filter(Boolean);
  const verifiedFulfilment = row => evidenceOf(row).filter(event => event.type === fulfilmentType(row)
    && event.actorId === row.promisorId
    && Number(event.payload.amount) >= 1
    && (row.goal === 'deliver-meal' ? event.payload.to === 'kitchen'
      : event.payload.place === 'warehouse'));

  const fulfilled = rows.filter(row => row.status === 'fulfilled');
  const fulfilledVerified = fulfilled.filter(row => verifiedFulfilment(row).length >= 1);
  const fulfilledWithoutReceipt = fulfilled.length - fulfilledVerified.length;

  const withdrawals = rows.filter(row => row.status === 'withdrawn');
  const withdrawalRecorded = withdrawals.filter(row => {
    const records = runtime.session.memories.get(row.promisorId)?.toJSON().records ?? [];
    return records.some(record => record.kind === 'commitment_withdrawn'
      && String(record.payload?.commitmentId) === row.commitmentId);
  });

  const cancelled = rows.filter(row => row.status === 'cancelled');
  const lateEffects = [];
  const lateReceipts = [];
  for (const row of cancelled) {
    const cancelAt = row.updatedAt;
    for (const intent of intents) {
      if (intent.commitmentId !== row.commitmentId) continue;
      if (intent.status !== 'applied') continue;
      if ((intent.settledAt ?? -1) <= cancelAt) continue;
      lateEffects.push({ commitmentId: row.commitmentId, intentId: intent.intentId,
        action: String(intent.candidate.parameters.action), settledAt: intent.settledAt,
        cancelAt, receiptIds: intent.receiptIds });
    }
    const records = runtime.session.memories.get(row.promisorId)?.toJSON().records ?? [];
    for (const record of records) {
      if (record.kind !== 'commitment_action_committed') continue;
      if (String(record.payload?.commitmentId) !== row.commitmentId) continue;
      if (record.observedAt <= cancelAt) continue;
      for (const id of record.sourceEventIds) {
        const event = runtime.committedEvent(id);
        if (event) lateReceipts.push({ commitmentId: row.commitmentId, eventId: id,
          type: event.type, simTime: event.simTime, cancelAt });
      }
    }
  }

  const unauthorisedChanges = [];
  for (const row of rows) {
    const accepted = row.changes.filter(change => change.status === 'accepted');
    if (row.revision !== 1 + accepted.length)
      unauthorisedChanges.push({ commitmentId: row.commitmentId, field: 'revision',
        revision: row.revision, acceptedChanges: accepted.length });
    const declaredSources = row.conditions.filter(condition => condition.startsWith('source:'));
    for (const condition of declaredSources) {
      const source = condition.slice('source:'.length);
      if (!accepted.some(change => change.kind === 'alt-source' && change.terms?.source === source))
        unauthorisedChanges.push({ commitmentId: row.commitmentId, field: 'conditions',
          value: condition, acceptedChanges: accepted.length });
    }
    if (row.deadline !== null && !accepted.some(change => change.kind === 'defer'
      && change.terms?.until === row.deadline))
      unauthorisedChanges.push({ commitmentId: row.commitmentId, field: 'deadline',
        value: row.deadline, acceptedChanges: accepted.length });
  }

  const duplicateReceipts = [];
  for (const row of fulfilled) {
    const evidence = verifiedFulfilment(row);
    if (evidence.length > 1) duplicateReceipts.push({ commitmentId: row.commitmentId,
      receipts: evidence.map(event => event.eventId) });
  }
  const duplicateFulfilAttempts = rows.flatMap(row => {
    const records = runtime.session.memories.get(row.promisorId)?.toJSON().records ?? [];
    return records.filter(record => record.kind === 'commitment_response_ignored'
      && record.payload?.reason === 'already_fulfilled'
      && String(record.payload?.commitmentId) === row.commitmentId);
  }).length;

  const deadlineTimeouts = rows.filter(row => row.deadline !== null
    && runtime.world.simTime > row.deadline && row.status !== 'fulfilled').length;

  const byIntentStatus = {};
  for (const intent of intents) byIntentStatus[intent.status] = (byIntentStatus[intent.status] ?? 0) + 1;
  // A revoked authorisation is a legitimate terminal state, not a settlement
  // failure; refusals and unresolved work are the failures that must be counted.
  const settlementFailures = intents.filter(intent => intent.status === 'rejected'
    || intent.status === 'unresolved')
    .map(intent => ({ intentId: intent.intentId, actorId: intent.actorId,
      action: String(intent.candidate.parameters.action), status: intent.status,
      reason: intent.failureReason }));
  const cancelledIntents = intents.filter(intent => intent.status === 'cancelled').length;
  const workMinutes = intents.filter(intent => intent.status === 'applied')
    .reduce((sum, intent) => sum + Math.max(0, intent.dueAt - intent.startedAt), 0);

  const byDecision = {};
  for (const record of decisions) {
    const key = String(record.executionStatus ?? 'none');
    byDecision[key] = (byDecision[key] ?? 0) + 1;
  }
  const policy = { council: 0, model: 0, reference: 0 };
  for (const record of decisions) {
    if (record.policy === 'council-reference') policy.council += 1;
    else if (record.policy === 'model') policy.model += 1;
    else policy.reference += 1;
  }
  const memories = decisions.filter(record => typeof record.memoryBudget === 'number');
  const memory = {
    budgetTokens: SCENARIO.memory.budgetTokens,
    decisionsWithMemory: memories.length,
    minBudget: memories.length ? Math.min(...memories.map(record => record.memoryBudget)) : null,
    maxBudget: memories.length ? Math.max(...memories.map(record => record.memoryBudget)) : null,
    maxKept: memories.length ? Math.max(...memories.map(record => record.memoryKept ?? 0)) : null,
    totalTokens: memories.reduce((sum, record) => sum + (record.memoryTokens ?? 0), 0),
  };

  const crisis = {};
  for (const event of runtime.journal) {
    if (!String(event.type).startsWith('crisis') && event.type !== 'rescue_needed') continue;
    crisis[event.type] = (crisis[event.type] ?? 0) + 1;
  }
  const snapshot = runtime.snapshot();
  const alive = Object.values(snapshot.npcs).filter(npc => npc.alive).length;
  const life = runtime.states.life;
  const ending = life.ending;
  // `runtime.intents` is pruned to the most recent records, so an early
  // working decision can lose its intent while its settlement is still in the
  // work log (which keeps every completed item). Match the deterministic
  // command id against both, never against the surviving intents alone.
  const terminalIntentIds = new Set([
    ...intents.filter(intent => intent.status !== 'working').map(intent => intent.intentId),
    ...runtime.workLog.filter(item => item.status !== 'working').map(item => item.intentId),
  ]);
  const unsettled = decisions.filter(record => record.executionStatus === 'working')
    .filter(record => !terminalIntentIds.has(`${record.actorId}-r8-${record.worldVersion}`))
    .map(record => ({ actorId: record.actorId, selectedId: record.selectedId,
      requestId: record.requestId,
      intentId: `${record.actorId}-r8-${record.worldVersion}` }));
  const pendingBeyondEnd = intents.filter(intent => intent.status === 'working'
    && intent.dueAt > PROFILE.endDay * PROFILE.minutesPerDay + PROFILE.endMinuteOfDay);

  return {
    decisions: decisions.length,
    decisionStates: byDecision,
    decisionsByPolicy: policy,
    modelDecisions: policy.model,
    busySkips: byDecision.busy ?? 0,
    staleSkips: byDecision.stale ?? 0,
    abstained: byDecision.abstained ?? 0,
    rejectedAtExecution: byDecision.rejected ?? 0,
    realFulfilment: { fulfilled: fulfilled.length, verified: fulfilledVerified.length,
      withoutReceipt: fulfilledWithoutReceipt,
      byGoal: rows.filter(row => row.status === 'fulfilled')
        .map(row => ({ promisorId: row.promisorId, goal: row.goal })) },
    authorisedExit: { withdrawn: withdrawals.length, recorded: withdrawalRecorded.length,
      reasons: withdrawals.map(row => ({ promisorId: row.promisorId,
        reason: runtime.session.memories.get(row.promisorId)?.toJSON().records
          .filter(record => record.kind === 'commitment_withdrawn'
            && String(record.payload?.commitmentId) === row.commitmentId)
          .map(record => record.payload?.reason ?? null).at(-1) ?? null })) },
    deadlineTimeouts,
    cancelled: cancelled.length,
    effectsAfterCancel: { cancelled: cancelled.length, lateAppliedIntents: lateEffects.length,
      lateReceipts: lateReceipts.length, lateEffects, lateReceiptDetails: lateReceipts },
    unauthorisedChanges,
    duplicateReceipts: { duplicates: duplicateReceipts.length, instances: duplicateReceipts,
      duplicateFulfilAttempts },
    settlement: { intents: intents.length, byStatus: byIntentStatus,
      failures: settlementFailures.length, failureList: settlementFailures,
      cancelledIntents,
      unsettledDecisions: unsettled.length, unsettled,
      pendingBeyondEnd: pendingBeyondEnd.length },
    noProgressRounds: ctx.noProgressRounds,
    loopRounds: ctx.rounds,
    survivors: ending?.survivors ?? alive,
    alive,
    ending: ending?.kind ?? null,
    elapsedMinutes: runtime.elapsed(),
    resources: snapshot.resources,
    resourceCoverageHours: { food: snapshot.resources.food / 7.2,
      firewood: snapshot.resources.firewood / 1, power: snapshot.resources.power / 2 },
    furnaceLitHours: Number(ctx.furnaceLitHours.toFixed(2)),
    workHours: Number((workMinutes / 60).toFixed(3)),
    crises: crisis,
    memory,
    scorer: ctx.scorerStats,
  };
}

function reconciliation(metrics) {
  const checks = {
    noUnsettledDecision: metrics.settlement.unsettledDecisions === 0,
    noPendingIntent: metrics.settlement.byStatus.working === undefined
      || metrics.settlement.byStatus.working === metrics.settlement.pendingBeyondEnd,
    allFulfilmentReceipted: metrics.realFulfilment.withoutReceipt === 0,
    noLateCancelEffect: metrics.effectsAfterCancel.lateAppliedIntents === 0
      && metrics.effectsAfterCancel.lateReceipts === 0,
    noUnauthorisedChange: metrics.unauthorisedChanges.length === 0,
    noDuplicateReceipt: metrics.duplicateReceipts.duplicates === 0,
    noProgressLoopClosed: metrics.noProgressRounds === 0,
  };
  return { checks, reconciled: Object.values(checks).every(Boolean) };
}

/* ------------------------------ phases ------------------------------ */
function gameFiles(dir) {
  return {
    dir,
    preflight: join(dir, 'preflight.json'),
    commitmentInput: join(dir, 'commitment-input.json'),
    start: join(dir, 'd1-start.json'),
    save: join(dir, 'd2', 'session.json'),
    exitState: join(dir, 'd2-exit.json'),
    resumeLoad: join(dir, 'resume-load.json'),
    decisionsStart: join(dir, 'decisions-start.jsonl'),
    decisionsResume: join(dir, 'decisions-resume.jsonl'),
    final: join(dir, 'final-state.json'),
    metrics: join(dir, 'metrics.json'),
    phase: phase => join(dir, `phase-${phase}.json`),
    replay: join(dir, 'replay.json'),
    transcript: phase => join(dir, `scorer-${phase}.jsonl`),
    failure: join(dir, 'failure.json'),
  };
}

function phaseRecord(phase, ctx, extra = {}) {
  return { schema: 'frostecho.r10.matrix-phase/1', phase, pid: process.pid,
    arm: ctx.arm?.id ?? null, seed: ctx.seed ?? null, family: ctx.arm?.family ?? null,
    memorySelection: ctx.arm?.memory ?? null, scenarioSha: SCENARIO_SHA,
    source: SOURCE, at: new Date().toISOString(), ...extra };
}

async function phaseStart(arm, seed, dir) {
  const files = gameFiles(dir);
  // Never delete evidence (and the IDE safe-delete shim cannot write /.Trash):
  // a rerun moves the old directory aside instead of removing it.
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(dir, `${dir}.superseded-${stamp}`);
  }
  mkdirSync(dir, { recursive: true });
  const preflight = arm.family === 'live' ? preflightHead(arm) : { ok: true, code: 0,
    note: 'reference arm has no model head', rendererId: RENDERER_ID };
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
  writeJson(files.commitmentInput, { schema: 'frostecho.r10.matrix-commitment-input/1',
    scenarioSha: SCENARIO_SHA, arm: arm.id, seed, ...input });
  if (!input.passed) {
    writeJson(files.phase('start'), phaseRecord('start', { arm, seed }, {
      exitCode: EXIT.commitmentInput, refused: 'commitment_input_missing', problems: input.problems }));
    console.error(`[${arm.id}/${seed}] refused: commitment input missing ${input.problems.join(',')}`);
    return EXIT.commitmentInput;
  }

  const ctx = { arm, seed, phase: 'start', runtime: world.runtime, play: world.play,
    bridge: world.bridge, scorer: arm.family === 'live'
      ? new LiveScorer(preflight.command, { transcript: files.transcript('start'),
        binding: { headSha256: preflight.headSha256,
          featureIdentityHash: preflight.manifestFeatureIdentityHash,
          rendererId: RENDERER_ID, labelSource: preflight.labelSource } })
      : referenceAgencyScorer(),
    decisions: [], councilDecisions: [], exits: [], timeline: [],
    interference: null, interferenceApplied: false, checkpoint: null,
    rounds: 0, noProgressRounds: 0, furnaceLitHours: 0, scorerStats: null };
  const init = worldInit(world.runtime, world);
  writeJson(files.start, { schema: 'frostecho.r10.matrix-start/1', pid: process.pid,
    arm: arm.id, seed, family: arm.family, memorySelection: arm.memory,
    scenarioSha: SCENARIO_SHA, source: SOURCE,
    preflight: { headSha256: preflight.headSha256 ?? null,
      manifestSha256: preflight.manifestSha256 ?? null,
      featureIdentityHash: preflight.manifestFeatureIdentityHash ?? null,
      labelSource: preflight.labelSource ?? null,
      manifestBinding: preflight.manifestBinding ?? null,
      rendererId: RENDERER_ID,
      rendererSourceSha256: preflight.rendererSourceSha256 ?? shaFile(join(ROOT, 'src/r7/jev/render.ts')) },
    worldInitSha: sha(canonical(init)), worldInit: init,
    commitments: world.seeds });
  let outcome;
  try {
    outcome = await playGame(ctx, { fromCheckpoint: false });
  } catch (error) {
    const spec = headSpec(arm);
    const manifestPath = resolve(ROOT, spec.manifest);
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
    const ready = ctx.scorer?.ready ?? null;
    const expected = manifest?.featureIdentity ?? null;
    const actual = ready?.featureIdentity ?? null;
    const bindingDiff = {};
    if (expected && actual) {
      for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const left = JSON.stringify(expected[key]);
        const right = JSON.stringify(actual[key]);
        if (left !== right) bindingDiff[key] = { manifest: expected[key], runtime: actual[key] };
      }
    }
    writeJson(files.failure, { phase: 'start', error: error.message, pid: process.pid,
      countsAsModelResult: false, at: ctx.runtime.world.simTime,
      forwards: ctx.scorer?.forwardCalls ?? 0,
      serviceWallSeconds: ctx.scorer?.stats?.().serviceWallSeconds ?? null,
      manifest: manifest ? { path: rel(manifestPath), sha256: shaFile(manifestPath),
        featureIdentityHash: manifest.featureIdentityHash ?? null,
        labelSource: manifest.labelSource ?? null } : null,
      runtimeIdentity: ready ? { identity: ready.identity,
        featureIdentity: ready.featureIdentity, encoder: ready.encoder } : null,
      bindingDiff });
    writeJson(files.phase('start'), phaseRecord('start', ctx, {
      exitCode: EXIT.scorer, error: error.message,
      forwards: ctx.scorer?.forwardCalls ?? 0 }));
    ctx.scorer?.close?.();
    return EXIT.scorer;
  }
  ctx.scorerStats = ctx.scorer?.stats?.() ?? null;
  writeJsonl(files.decisionsStart, ctx.decisions);
  ctx.scorer?.close?.();
  if (outcome !== 'checkpoint') {
    writeJson(files.failure, { phase: 'start', error: outcome,
      reason: outcome === 'ended' ? 'game_ended_before_d2_checkpoint' : 'loop_guard',
      simTime: ctx.runtime.world.simTime, countsAsModelResult: false });
    writeJson(files.phase('start'), phaseRecord('start', ctx, {
      exitCode: EXIT.noPendingWork, outcome }));
    return EXIT.noPendingWork;
  }

  ctx.play.save(files.save);
  ctx.runtime.save(files.save);
  const state = checkpointState(ctx);
  const fp = fingerprint(ctx.runtime, ctx.play);
  writeJson(files.exitState, { schema: 'frostecho.r10.matrix-d2-exit/1',
    pid: process.pid, arm: arm.id, seed, family: arm.family,
    memorySelection: arm.memory, scenarioSha: SCENARIO_SHA,
    simTime: ctx.runtime.world.simTime, inputSequence: ctx.runtime.session.inputSequence,
    checkpoint: state, interference: ctx.interference,
    interferenceApplied: ctx.interferenceApplied,
    commitments: ctx.play.commitments.all(), tasks: ctx.play.board.toJSON(),
    exits: ctx.exits, decisions: ctx.decisions.length,
    decisionsSha256: shaFile(files.decisionsStart),
    fingerprintSha256: sha(canonical(fp)),
    nextClockTarget: nextClockTarget(ctx.runtime),
    countsAsModelResult: arm.family === 'live' });
  writeJson(files.phase('start'), phaseRecord('start', ctx, {
    exitCode: EXIT.ok, outcome, pending: state.pending,
    decisions: ctx.decisions.length, scorer: ctx.scorerStats }));
  console.log(`[${arm.id}/${seed}] D2 save at ${ctx.runtime.world.simTime} with ${state.pending} pending intent(s)`);
  return EXIT.ok;
}

function nextClockTarget(runtime) {
  const before = runtime.world.simTime;
  const snapshot = runtime.snapshot();
  const night = snapshot.minuteOfDay >= PROFILE.nightSkipFromMinute
    || snapshot.minuteOfDay < PROFILE.nightSkipToMinute;
  if (night) {
    const dayStart = Math.floor(before / PROFILE.minutesPerDay) * PROFILE.minutesPerDay;
    return Math.min(dayStart + PROFILE.minutesPerDay + PROFILE.nightSkipToMinute, before + 8 * 60);
  }
  return Math.floor(before / SCENARIO.clock.hourStepMinutes) * SCENARIO.clock.hourStepMinutes
    + SCENARIO.clock.hourStepMinutes;
}

async function phaseResume(arm, seed, dir, { replay = false } = {}) {
  const files = gameFiles(dir);
  if (!existsSync(files.save)) {
    writeJson(files.failure, { phase: replay ? 'replay' : 'resume',
      error: 'd2_save_missing', countsAsModelResult: false });
    return EXIT.noPendingWork;
  }
  const exitState = JSON.parse(readFileSync(files.exitState, 'utf8'));
  const runtime = R8Runtime.load(files.save, PROFILE);
  const play = gameplayOn(runtime, files.save);
  const unappliedBefore = [...runtime.intents.values()]
    .reduce((sum, intent) => sum + intent.projections.filter(claim => !claim.applied).length, 0);
  const bridge = createCommitmentBridge(runtime, play);
  const unappliedAfter = [...runtime.intents.values()]
    .reduce((sum, intent) => sum + intent.projections.filter(claim => !claim.applied).length, 0);
  const replayed = unappliedBefore - unappliedAfter;
  const loaded = [...runtime.intents.values()];
  const pending = loaded.filter(intent => intent.status === 'working');
  const loadReport = { schema: 'frostecho.r10.matrix-resume-load/1', pid: process.pid,
    phase: replay ? 'replay' : 'resume', simTime: runtime.world.simTime,
    savedSimTime: exitState.simTime, inputSequence: runtime.session.inputSequence,
    savedInputSequence: exitState.inputSequence, pendingIntents: pending.length,
    intents: loaded.map(intent => ({ intentId: intent.intentId, actorId: intent.actorId,
      status: intent.status, dueAt: intent.dueAt, commitmentId: intent.commitmentId })),
    projectionReplays: replayed,
    legacySpatial: runtime.legacyPosition('npc_01') !== null };
  const mismatch = [];
  if (runtime.world.simTime !== exitState.simTime) mismatch.push('clock');
  if (pending.length !== exitState.checkpoint.pending) mismatch.push('pending_count');
  for (const saved of exitState.checkpoint.intents) {
    const now = loaded.find(intent => intent.intentId === saved.intentId);
    if (!now) { mismatch.push(`missing:${saved.intentId}`); continue; }
    if (now.status !== 'working' || now.dueAt !== saved.dueAt) mismatch.push(`changed:${saved.intentId}`);
  }
  loadReport.mismatch = mismatch;
  if (!replay) writeJson(files.resumeLoad, loadReport);
  if (mismatch.length > 0) {
    writeJson(files.failure, { phase: loadReport.phase, error: 'resume_state_mismatch',
      mismatch, countsAsModelResult: false });
    return EXIT.settlement;
  }

  const resumeDecisions = replay && existsSync(files.decisionsResume)
    ? readFileSync(files.decisionsResume, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : null;
  const startDecisions = existsSync(files.decisionsStart)
    ? readFileSync(files.decisionsStart, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const priorPreflight = existsSync(files.preflight)
    ? JSON.parse(readFileSync(files.preflight, 'utf8')) : null;
  const scorer = replay ? new ReplayScorer(resumeDecisions) : arm.family === 'live'
    ? new LiveScorer(scorerCommand(arm, dir), { transcript: files.transcript('resume'),
      binding: priorPreflight ? { headSha256: priorPreflight.headSha256,
        featureIdentityHash: priorPreflight.manifestFeatureIdentityHash,
        rendererId: RENDERER_ID, labelSource: priorPreflight.labelSource } : null })
    : referenceAgencyScorer();
  const ctx = { arm, seed, phase: replay ? 'replay' : 'resume', runtime, play, bridge, scorer,
    decisions: [], councilDecisions: [], exits: [], timeline: [],
    interference: exitState.interference, interferenceApplied: exitState.interferenceApplied,
    checkpoint: exitState.checkpoint, rounds: 0, noProgressRounds: 0, furnaceLitHours: 0,
    scorerStats: null };
  let outcome;
  try {
    outcome = await playGame(ctx, { fromCheckpoint: true });
  } catch (error) {
    writeJson(files.failure, { phase: ctx.phase, error: error.message, pid: process.pid,
      countsAsModelResult: false, at: ctx.runtime.world.simTime });
    writeJson(files.phase(ctx.phase), phaseRecord(ctx.phase, ctx, {
      exitCode: replay ? EXIT.replay : EXIT.scorer, error: error.message }));
    ctx.scorer?.close?.();
    return replay ? EXIT.replay : EXIT.scorer;
  }
  ctx.scorerStats = ctx.scorer?.stats?.() ?? null;
  if (!replay) writeJsonl(files.decisionsResume, ctx.decisions);
  ctx.scorer?.close?.();
  if (outcome !== 'ended') {
    writeJson(files.failure, { phase: ctx.phase, error: outcome,
      simTime: ctx.runtime.world.simTime, countsAsModelResult: false });
    writeJson(files.phase(ctx.phase), phaseRecord(ctx.phase, ctx, {
      exitCode: EXIT.noPendingWork, outcome }));
    return EXIT.noPendingWork;
  }

  const fp = fingerprint(ctx.runtime, ctx.play);
  const final = { schema: 'frostecho.r10.matrix-final/1', pid: process.pid,
    arm: arm.id, seed, family: arm.family, memorySelection: arm.memory,
    scenarioSha: SCENARIO_SHA, source: SOURCE, simTime: ctx.runtime.world.simTime,
    ending: ctx.runtime.endingKind, fingerprintSha256: sha(canonical(fp)), fingerprint: fp,
    exits: ctx.exits, interference: ctx.interference };

  if (replay) {
    const prior = JSON.parse(readFileSync(files.final, 'utf8'));
    const replayReport = { schema: 'frostecho.r10.matrix-replay/1', pid: process.pid,
      arm: arm.id, seed, phase: 'replay', countsAsModelResult: false,
      recordedDecisions: resumeDecisions.length, used: ctx.scorer.stats().used,
      unused: ctx.scorer.stats().unused, mismatches: ctx.scorer.stats().mismatches,
      expectedFingerprintSha256: prior.fingerprintSha256,
      actualFingerprintSha256: sha(canonical(fp)),
      equivalent: prior.fingerprintSha256 === sha(canonical(fp)),
      decisionsDuringReplay: ctx.decisions.length };
    writeJson(files.replay, replayReport);
    writeJson(files.phase('replay'), phaseRecord('replay', ctx, {
      exitCode: replayReport.equivalent ? EXIT.ok : EXIT.replay,
      equivalent: replayReport.equivalent }));
    console.log(`[${arm.id}/${seed}] replay equivalent=${replayReport.equivalent}`);
    return replayReport.equivalent ? EXIT.ok : EXIT.replay;
  }

  const metrics = collectMetrics({ ...ctx, decisions: [...startDecisions, ...ctx.decisions] });
  const recon = reconciliation(metrics);
  const report = { ...metrics, ...recon, replay: 'separate control (replay.json)' };
  writeJson(files.metrics, report);
  writeJson(files.final, final);
  const exitCode = recon.reconciled ? EXIT.ok : EXIT.settlement;
  writeJson(files.phase('resume'), phaseRecord('resume', ctx, {
    exitCode, reconciled: recon.reconciled, checks: recon.checks,
    decisions: ctx.decisions.length, scorer: ctx.scorerStats,
    realForwards: ctx.scorerStats?.forwardCalls ?? 0 }));
  console.log(`[${arm.id}/${seed}] D4 ${ctx.runtime.endingKind} survivors=${metrics.survivors} `
    + `fulfilled=${metrics.realFulfilment.verified} reconciled=${recon.reconciled}`);
  return exitCode;
}

function scorerCommand(arm, dir) {
  const raw = arg('--scorer-command-json') ?? process.env.FROSTECHO_SCORER_COMMAND_JSON;
  if (raw) return JSON.parse(raw);
  return defaultScorerCommand(arm, dir);
}

function defaultScorerCommand(arm, dir) {
  const spec = headSpec(arm);
  const head = resolve(ROOT, spec.head);
  const manifestPath = resolve(ROOT, spec.manifest);
  // The encoder must reproduce the exact placement/GPU set the head was
  // trained on; the manifest records it. `--training-manifest` is deliberately
  // not passed: serve_joint.py would reject the R10 label source, so the
  // harness binds headSha256/featureIdentityHash/rendererId itself.
  let placement = 'auto';
  let gpus = '1';
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    placement = manifest.encodingExecution?.placement ?? 'auto';
    const recorded = manifest.featureIdentity?.physicalGpus;
    if (Array.isArray(recorded) && recorded.length > 0) gpus = recorded.join(',');
  }
  return [PYTHON, 'research/decision-choice/jev05/action/serve_joint.py',
    '--encoder', ENCODER,
    '--physical-gpus', process.env.FROSTECHO_PHYSICAL_GPUS ?? gpus,
    '--placement', process.env.FROSTECHO_PLACEMENT ?? placement,
    '--head', head, '--max-length', '2048',
    '--memory-policy', 'conditional-experience',
    '--output-dir', join(dir, 'scorer')];
}

/* ------------------------------ controls ------------------------------ */
function probe(seedCommitments, dir) {
  mkdirSync(dir, { recursive: true });
  const world = buildWorld('probe-commitment-input', { seedCommitments });
  const input = commitmentInputReport(world);
  writeJson(join(dir, 'commitment-input.json'), { schema: 'frostecho.r10.matrix-commitment-input/1',
    scenarioSha: SCENARIO_SHA, probe: seedCommitments ? 'positive' : 'negative',
    expectedExit: seedCommitments ? EXIT.ok : EXIT.commitmentInput, ...input });
  const code = input.passed ? EXIT.ok : EXIT.commitmentInput;
  writeJson(join(dir, 'phase-start.json'), { schema: 'frostecho.r10.matrix-phase/1',
    phase: 'probe', pid: process.pid, exitCode: code, refused: !input.passed,
    scenarioSha: SCENARIO_SHA, source: SOURCE, at: new Date().toISOString() });
  console.log(JSON.stringify({ probe: seedCommitments ? 'positive' : 'negative',
    passed: input.passed, exitCode: code, problems: input.problems }));
  return code;
}

/* ------------------------------ matrix ------------------------------ */
function runPhaseChild(phase, arm, seed, dir, overrides) {
  const args = [fileURLToPath(import.meta.url), '--phase', phase, '--arm', arm.id,
    '--seed', seed, '--out', dir, ...overrides];
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, FROSTECHO_REPO: ROOT } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.stdout.log`), result.stdout ?? '', 'utf8');
  writeFileSync(join(dir, `phase-${phase}.stderr.log`), result.stderr ?? '', 'utf8');
  return result.status ?? EXIT.internal;
}

function gameIdentity({ arm, seed, dir, exits, files }) {
  const read = name => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null;
  const preflight = read('preflight.json');
  const metrics = read('metrics.json');
  const final = read('final-state.json');
  const replay = read('replay.json');
  const load = read('commitment-input.json');
  const failure = read('failure.json');
  // A binding refusal happens after the encoder ran; the transcript is the
  // independent record of that forward.
  let transcriptForwards = 0;
  const transcriptPath = join(dir, 'scorer-start.jsonl');
  if (existsSync(transcriptPath)) {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.includes('"score_reply"')) continue;
      try {
        const row = JSON.parse(line);
        const count = row.reply?.identity?.encoderForwardCalls;
        if (typeof count === 'number') transcriptForwards = Math.max(transcriptForwards, count);
      } catch { /* partial line */ }
    }
  }
  const evidence = shaMap(dir);
  const identity = {
    schema: 'frostecho.r10.matrix-game/1', arm: arm.id, family: arm.family, seed,
    memorySelection: arm.memory, memoryTokenBudget: SCENARIO.memory.budgetTokens,
    scenarioSha: SCENARIO_SHA, source: SOURCE, exits,
    head: preflight ? { headPath: preflight.headPath ?? null,
      headSha256: preflight.headSha256 ?? null,
      manifestPath: preflight.manifestPath ?? null,
      manifestSha256: preflight.manifestSha256 ?? null,
      labelSource: preflight.labelSource ?? null,
      featureIdentityHash: preflight.manifestFeatureIdentityHash ?? null,
      manifestBinding: preflight.manifestBinding ?? null,
      rendererId: preflight.rendererId ?? null,
      rendererSourceSha256: preflight.rendererSourceSha256 ?? null,
      ok: preflight.ok, reason: preflight.reason ?? null } : null,
    commitmentInput: load ? { passed: load.passed, problems: load.problems,
      commitments: load.commitments } : null,
    replica: replay ? { equivalent: replay.equivalent, countsAsModelResult: false } : null,
    pids: {
      start: read('phase-start.json')?.pid ?? null,
      resume: read('phase-resume.json')?.pid ?? null,
      replay: read('phase-replay.json')?.pid ?? null,
    },
    final: final ? { simTime: final.simTime, ending: final.ending,
      fingerprintSha256: final.fingerprintSha256 } : null,
    metrics: metrics ? (() => {
      const phases = ['start', 'resume'].map(phase => read(`phase-${phase}.json`)).filter(Boolean);
      const forwards = phases.reduce((sum, phase) => sum + (phase.scorer?.forwardCalls ?? 0), 0);
      const scorerTimeouts = phases.reduce((sum, phase) => sum + (phase.scorer?.timeouts ?? 0), 0);
      const gpuWallSeconds = phases.reduce((sum, phase) =>
        sum + (phase.scorer?.serviceWallSeconds ?? 0), 0);
      const coverage = metrics.resourceCoverageHours
        ? Math.min(metrics.resourceCoverageHours.food, metrics.resourceCoverageHours.firewood,
          metrics.resourceCoverageHours.power) : null;
      const crises = Object.values(metrics.crises ?? {})
        .reduce((sum, value) => sum + value, 0);
      return { decisions: metrics.decisions,
        modelDecisions: metrics.modelDecisions, realForwards: forwards,
        scorerTimeouts,
        reconciled: metrics.reconciled, survivors: metrics.survivors,
        ending: metrics.ending,
        fulfilled: metrics.realFulfilment?.verified ?? 0,
        withdrawn: metrics.authorisedExit?.withdrawn ?? 0,
        deadlineTimeouts: metrics.deadlineTimeouts ?? 0,
        lateEffects: metrics.effectsAfterCancel?.lateAppliedIntents ?? 0,
        unauthorisedChanges: metrics.unauthorisedChanges?.length ?? 0,
        duplicateReceipts: metrics.duplicateReceipts?.duplicates ?? 0,
        noProgressRounds: metrics.noProgressRounds ?? 0,
        busySkips: metrics.busySkips ?? 0,
        settlementFailures: metrics.settlement?.failures ?? 0,
        workHours: metrics.workHours ?? 0,
        coverageHours: coverage,
        furnaceLitHours: metrics.furnaceLitHours ?? 0,
        crises,
        gpuWallSeconds };
    })() : null,
    failure: failure ? { error: failure.error,
      forwards: failure.forwards ?? 0,
      serviceWallSeconds: failure.serviceWallSeconds ?? 0,
      bindingDiffKeys: Object.keys(failure.bindingDiff ?? {}),
      manifestFeatureIdentityHash: failure.manifest?.featureIdentityHash ?? null,
      runtimeFeatureIdentityHash: failure.runtimeIdentity?.identity?.featureIdentityHash ?? null } : null,
  };
  identity.forwards = identity.metrics?.realForwards
    ?? Math.max(identity.failure?.forwards ?? 0, transcriptForwards);
  identity.gpuWallSeconds = identity.metrics?.gpuWallSeconds
    ?? identity.failure?.serviceWallSeconds ?? 0;
  identity.evidenceSha256 = sha(canonical(evidence));
  identity.gameSha256 = sha(canonical(identity));
  return { identity, evidence };
}

async function matrix() {
  const out = resolve(arg('--out') ?? 'artifacts/r10/matrix');
  mkdirSync(out, { recursive: true });
  const seeds = (arg('--seeds') ?? 'r10h-1,r10h-2').split(',').map(value => value.trim()).filter(Boolean);
  if (seeds.length !== 2) throw new Error('the matrix runs exactly two fresh seeds');
  writeJson(join(out, 'scenario.json'), { ...SCENARIO, scenarioSha: SCENARIO_SHA });
  writeJson(join(out, 'matrix-spec.json'), { schema: 'frostecho.r10.matrix-spec/1',
    generatedAt: new Date().toISOString(), source: SOURCE, scenarioSha: SCENARIO_SHA,
    seeds, arms: ARMS.map(arm => ({ ...arm, head: arm.head ? headSpec(arm) : null })),
    liveGames: LIVE_ARMS.length * seeds.length,
    referenceGames: REFERENCE_ARMS.length * seeds.length,
    memoryBudgetTokens: SCENARIO.memory.budgetTokens,
    note: 'live arms refuse to start when their head is missing/stale; they never fall back to rules' });

  const overrides = [];
  for (const key of ['--old-head', '--old-manifest', '--new-head', '--new-manifest',
    '--scorer-command-json']) {
    if (arg(key) !== undefined) overrides.push(key, arg(key));
  }
  const controlDir = join(out, 'controls');
  const positive = probe(true, join(controlDir, 'positive'));
  const negative = probe(false, join(controlDir, 'negative'));
  if (positive !== 0 || negative !== EXIT.commitmentInput)
    console.error(`commitment-input controls failed: positive=${positive} negative=${negative}`);

  // `--only` reruns a subset (e.g. the four new-head games after the head
  // arrives) and merges those rows into the existing table without touching
  // the evidence of the other games.
  const only = (arg('--only') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const liveArms = only.length ? LIVE_ARMS.filter(arm => only.includes(arm.id)) : LIVE_ARMS;
  const referenceArms = only.length ? REFERENCE_ARMS.filter(arm => only.includes(arm.id)) : REFERENCE_ARMS;
  if (only.length && liveArms.length === 0 && referenceArms.length === 0)
    throw new Error(`--only matched no arm: ${only.join(',')}`);
  const fresh = [];
  for (const arm of liveArms) {
    for (const seed of seeds) {
      const dir = join(out, 'arms', arm.id, seed);
      mkdirSync(dir, { recursive: true });
      console.log(`[${arm.id}/${seed}] start`);
      const start = runPhaseChild('start', arm, seed, dir, overrides);
      let resume = null, replay = null;
      if (start === 0) {
        console.log(`[${arm.id}/${seed}] resume`);
        resume = runPhaseChild('resume', arm, seed, dir, overrides);
        if (resume === 0) {
          console.log(`[${arm.id}/${seed}] replay`);
          replay = runPhaseChild('replay', arm, seed, dir, overrides);
        }
      }
      const exits = { start, resume, replay };
      const built = gameIdentity({ arm, seed, dir, exits });
      const early = JSON.parse(readFileSync(join(dir, 'preflight.json'), 'utf8'));
      const status = start !== 0 ? (early.ok ? `failed:start:${start}` : `refused:${early.reason}`)
        : resume !== 0 ? `failed:resume:${resume}`
          : replay !== 0 ? `failed:replay:${replay}` : 'completed';
      writeJson(join(dir, 'summary.json'), { ...built.identity, status, evidence: built.evidence });
      fresh.push({ ...built.identity, status, dir: rel(dir) });
    }
  }
  for (const arm of referenceArms) {
    for (const seed of seeds) {
      const dir = join(out, 'reference', arm.id, seed);
      mkdirSync(dir, { recursive: true });
      console.log(`[${arm.id}/${seed}] start`);
      const start = runPhaseChild('start', arm, seed, dir, overrides);
      let resume = null, replay = null;
      if (start === 0) {
        resume = runPhaseChild('resume', arm, seed, dir, overrides);
        if (resume === 0) replay = runPhaseChild('replay', arm, seed, dir, overrides);
      }
      const exits = { start, resume, replay };
      const built = gameIdentity({ arm, seed, dir, exits });
      const status = start !== 0 ? `refused:${start}` : resume !== 0 ? `failed:resume:${resume}`
        : replay !== 0 ? `failed:replay:${replay}` : 'completed';
      writeJson(join(dir, 'summary.json'), { ...built.identity, status, evidence: built.evidence });
      fresh.push({ ...built.identity, status, dir: rel(dir) });
    }
  }
  const priorPath = join(out, 'matrix-table.json');
  const prior = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')) : null;
  const replaced = new Set(fresh.map(row => `${row.arm}|${row.seed}`));
  const rows = [...(prior?.rows ?? []).filter(row => !replaced.has(`${row.arm}|${row.seed}`)), ...fresh];
  rows.sort((left, right) => (ARMS.findIndex(arm => arm.id === left.arm)
    - ARMS.findIndex(arm => arm.id === right.arm))
    || (seeds.indexOf(left.seed) - seeds.indexOf(right.seed)));

  const seedGroups = {};
  for (const row of rows.filter(entry => entry.family === 'reference')) {
    (seedGroups[row.seed] ??= new Set()).add(
      JSON.parse(readFileSync(join(ROOT, row.dir, 'd1-start.json'), 'utf8')).worldInitSha);
  }
  const checks = {
    scenarioIdentical: rows.every(row => row.scenarioSha === SCENARIO_SHA),
    worldInitIdenticalPerSeed: Object.entries(seedGroups)
      .every(([, hashes]) => hashes.size === 1),
    memoryBudgetIdentical: rows.every(row => row.memoryTokenBudget === SCENARIO.memory.budgetTokens),
    commitmentInputPositiveControl: positive === 0,
    commitmentInputNegativeControl: negative === EXIT.commitmentInput,
    liveArmsStarted: rows.filter(row => row.family === 'live' && row.exits.start === 0).length,
    liveArmsRefusedAtPreflight: rows.filter(row => row.family === 'live'
      && row.exits.start !== 0 && row.head?.ok === false).length,
    liveArmsFailedAfterStart: rows.filter(row => row.family === 'live'
      && row.exits.start !== 0 && row.head?.ok === true).length,
    referenceGamesCompleted: rows.filter(row => row.family === 'reference'
      && row.status === 'completed').length,
    resumeUsedNewProcess: rows.filter(row => row.exits.resume === 0)
      .every(row => row.pids.start !== null && row.pids.resume !== null
        && row.pids.start !== row.pids.resume),
    realForwards: rows.reduce((sum, row) => sum + (row.forwards ?? 0), 0),
    gpuWallSeconds: rows.reduce((sum, row) => sum + (row.gpuWallSeconds ?? 0), 0),
  };
  const table = { schema: 'frostecho.r10.matrix-table/1', generatedAt: new Date().toISOString(),
    source: SOURCE, scenarioSha: SCENARIO_SHA, seeds,
    memoryBudgetTokens: SCENARIO.memory.budgetTokens, checks, rows };
  writeJson(join(out, 'matrix-table.json'), table);
  writeFileSync(join(out, 'MATRIX.md'), matrixMarkdown(table), 'utf8');
  console.log(JSON.stringify({ out: rel(out), checks,
    refused: rows.filter(row => row.status.startsWith('refused')).length,
    completed: rows.filter(row => row.status === 'completed').length }, null, 2));
  const bad = rows.filter(row => row.status !== 'completed');
  return bad.length === 0
    && checks.scenarioIdentical && checks.worldInitIdenticalPerSeed
    && checks.memoryBudgetIdentical && checks.commitmentInputPositiveControl
    && checks.commitmentInputNegativeControl ? EXIT.ok : EXIT.matrixIncomplete;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(digits);
  return String(value);
}

function matrixMarkdown(table) {
  const lines = [];
  lines.push('# R10 matrix — 2 heads x 2 memory fills x 2 seeds (8 live) + CPU reference (4)');
  lines.push('');
  lines.push(`scenario \`${table.scenarioSha.slice(0, 16)}\` · source \`${table.source.head.slice(0, 7)}\``
    + ` · token budget ${table.memoryBudgetTokens} · seeds ${table.seeds.join(' / ')}`);
  lines.push('');
  lines.push('| game | arm | seed | start | resume | replay | status | fulfil | exit/deadline | post-cancel | unauth | dup | stuck | survivors | coverage h | lit h | work h | fwd | game SHA |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of table.rows) {
    const m = row.metrics ?? {};
    const exits = row.exits;
    const cells = [
      row.dir.replace(/^artifacts\/r10\/matrix\//, ''),
      row.arm, row.seed,
      fmt(exits.start), fmt(exits.resume), fmt(exits.replay), row.status,
      fmt(m.fulfilled), `${fmt(m.withdrawn)}/${fmt(m.deadlineTimeouts)}`,
      fmt(m.lateEffects), fmt(m.unauthorisedChanges),
      fmt(m.duplicateReceipts), fmt(m.noProgressRounds), fmt(m.survivors),
      m.coverageHours === null || m.coverageHours === undefined ? '—' : fmt(m.coverageHours, 1),
      m.furnaceLitHours === undefined ? '—' : fmt(m.furnaceLitHours, 1),
      m.workHours === undefined ? '—' : fmt(m.workHours, 1),
      row.family === 'live' ? fmt(row.forwards ?? 0) : '0 (rule)',
      row.gameSha256.slice(0, 12),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('`refused:<reason>` = the game never started (no rule/replay substitute). '
    + '`replay` is a separate same-action control and is not a model result.');
  lines.push('');
  lines.push('## Auxiliary metrics');
  lines.push('');
  lines.push('| game | model dec | busy skip | settle fail | crisis | coverage h | lit h | work h | fwd | timeout | gpu s | replay |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of table.rows) {
    const m = row.metrics ?? {};
    lines.push(`| ${row.dir.replace(/^artifacts\/r10\/matrix\//, '')} | ${fmt(m.modelDecisions)} | `
      + `${fmt(m.busySkips)} | ${fmt(m.settlementFailures)} | ${fmt(m.crises)} | `
      + `${m.coverageHours === null || m.coverageHours === undefined ? '—' : fmt(m.coverageHours, 1)} | `
      + `${m.furnaceLitHours === undefined ? '—' : fmt(m.furnaceLitHours, 1)} | `
      + `${m.workHours === undefined ? '—' : fmt(m.workHours, 1)} | `
      + `${row.family === 'live' ? fmt(row.forwards ?? 0) : '0 (rule)'} | `
      + `${fmt(m.scorerTimeouts)} | `
      + `${fmt(row.gpuWallSeconds ?? 0, 1)} | `
      + `${row.replica ? (row.replica.equivalent ? 'equivalent' : 'DIFFERS') : '—'} |`);
  }
  lines.push('');
  lines.push('Reference-arm note: the reference policy fulfils all four promises on D1 '
    + '(11:00-13:00), so at the D2 checkpoint it has no active commitment to cancel or '
    + 'renegotiate. `exit/post-cancel/unauth` are therefore 0-of-0 for that arm, not '
    + 'verified zeros.');
  const fixed = table.rows.filter(row => row.exitsBeforeFix);
  if (fixed.length > 0) {
    lines.push('');
    lines.push('Harness-fix note: '
      + fixed.map(row => `${row.dir} resume exited ${row.exitsBeforeFix.resume} on the first pass`
        + ' because settled intents were looked up in the pruned `runtime.intents`;'
        + ' the verdict was recomputed from `workLog` (`--reconcile`), so the original'
        + ' exit stays in `summary.json.exitsBeforeFix`').join('; ') + '.');
  }
  const startedLive = table.rows.filter(row => row.family === 'live' && row.exits.start !== 0
    && row.head?.ok === true);
  if (startedLive.length > 0) {
    const reasons = new Set();
    for (const row of startedLive) {
      const path = join(ROOT, row.dir, 'failure.json');
      if (existsSync(path)) reasons.add(JSON.parse(readFileSync(path, 'utf8')).error ?? 'unknown');
    }
    lines.push('');
    lines.push(`Live note: ${startedLive.length} game(s) loaded a real joint-c-action/2 head and then `
      + `failed the online binding at start (exit ${startedLive[0].exits.start}): `
      + `${[...reasons].join('; ') || 'see failure.json'}. Those failures are kept in the evidence `
      + 'and are not replaced by rules or replay.');
  }
  lines.push('');
  lines.push('checks: ' + Object.entries(table.checks)
    .map(([key, value]) => `${key}=${value}`).join(' · '));
  return `${lines.join('\n')}\n`;
}

/** Rewrite MATRIX.md from an existing table, without touching the evidence. */
function regenerateTable() {
  const out = resolve(arg('--out') ?? 'artifacts/r10/matrix');
  const table = JSON.parse(readFileSync(join(out, 'matrix-table.json'), 'utf8'));
  writeFileSync(join(out, 'MATRIX.md'), matrixMarkdown(table), 'utf8');
  console.log(`regenerated ${rel(join(out, 'MATRIX.md'))}`);
  return EXIT.ok;
}

/**
 * Recompute the settlement verdict from persisted evidence when a harness
 * check was wrong. Only the two derived fields move; the game's own metrics,
 * decisions and receipts are untouched, and the original process exit stays in
 * phase-resume.json as exitBeforeFix.
 */
function reconcileEvidence(dir) {
  const metricsPath = join(dir, 'metrics.json');
  const finalPath = join(dir, 'final-state.json');
  if (!existsSync(metricsPath) || !existsSync(finalPath)) {
    console.error(`reconcile needs metrics.json and final-state.json in ${rel(dir)}`);
    return EXIT.internal;
  }
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
  const final = JSON.parse(readFileSync(finalPath, 'utf8'));
  const readRows = name => existsSync(join(dir, name))
    ? readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const decisions = [...readRows('decisions-start.jsonl'), ...readRows('decisions-resume.jsonl')];
  const terminal = new Set([
    ...(final.fingerprint.intents ?? []).filter(intent => intent.status !== 'working')
      .map(intent => intent.intentId),
    ...(final.fingerprint.workLog ?? []).filter(item => item.status !== 'working')
      .map(item => item.intentId),
  ]);
  const unsettled = decisions.filter(record => record.executionStatus === 'working')
    .filter(record => !terminal.has(`${record.actorId}-r8-${record.worldVersion}`))
    .map(record => ({ actorId: record.actorId, selectedId: record.selectedId,
      requestId: record.requestId, intentId: `${record.actorId}-r8-${record.worldVersion}` }));
  const before = metrics.reconciled;
  metrics.settlement = { ...metrics.settlement, unsettled, unsettledDecisions: unsettled.length };
  metrics.checks = { ...metrics.checks, noUnsettledDecision: unsettled.length === 0 };
  metrics.reconciled = Object.values(metrics.checks).every(Boolean);
  metrics.reconciliationFix = { reason: 'runtime.intents is pruned; settled work was looked up in workLog',
    at: new Date().toISOString(), before, after: metrics.reconciled,
    startDecisions: readRows('decisions-start.jsonl').length,
    resumeDecisions: readRows('decisions-resume.jsonl').length };
  writeJson(metricsPath, metrics);
  const phasePath = join(dir, 'phase-resume.json');
  if (existsSync(phasePath)) {
    const phase = JSON.parse(readFileSync(phasePath, 'utf8'));
    phase.exitBeforeFix = phase.exitCode;
    phase.exitCode = metrics.reconciled ? EXIT.ok : EXIT.settlement;
    phase.reconciled = metrics.reconciled;
    phase.checks = metrics.checks;
    phase.reconciliationFix = metrics.reconciliationFix;
    writeJson(phasePath, phase);
  }
  console.log(`[${rel(dir)}] reconciled=${metrics.reconciled} unsettled=${unsettled.length}`);
  return metrics.reconciled ? EXIT.ok : EXIT.settlement;
}

/** Recompute per-game identities/summaries from the evidence already on disk. */
function regenerateSummaries() {
  const out = resolve(arg('--out') ?? 'artifacts/r10/matrix');
  const prior = JSON.parse(readFileSync(join(out, 'matrix-table.json'), 'utf8'));
  const rows = [];
  for (const row of prior.rows) {
    const arm = ARMS.find(entry => entry.id === row.arm);
    const dir = resolve(ROOT, row.dir);
    const phase = name => existsSync(join(dir, `phase-${name}.json`))
      ? JSON.parse(readFileSync(join(dir, `phase-${name}.json`), 'utf8')) : null;
    const exits = { start: phase('start')?.exitCode ?? null,
      resume: phase('resume')?.exitCode ?? null,
      replay: phase('replay')?.exitCode ?? null };
    const beforeFix = phase('resume')?.exitBeforeFix ?? null;
    const built = gameIdentity({ arm, seed: row.seed, dir, exits });
    const status = exits.start !== 0
      ? (built.identity.head?.ok ? `failed:start:${exits.start}`
        : `refused:${built.identity.head?.reason ?? exits.start}`)
      : exits.resume !== 0 ? `failed:resume:${exits.resume}`
        : exits.replay !== 0 ? `failed:replay:${exits.replay}` : 'completed';
    const identity = { ...built.identity, exits, status, dir: row.dir,
      ...(beforeFix !== null ? { exitsBeforeFix: { resume: beforeFix } } : {}) };
    const { gameSha256, ...withoutSha } = identity;
    identity.gameSha256 = sha(canonical(withoutSha));
    writeJson(join(dir, 'summary.json'), { ...identity, evidence: built.evidence });
    rows.push(identity);
  }
  const checks = { ...prior.checks,
    scenarioIdentical: rows.every(row => row.scenarioSha === SCENARIO_SHA),
    memoryBudgetIdentical: rows.every(row => row.memoryTokenBudget === SCENARIO.memory.budgetTokens),
    liveArmsStarted: rows.filter(row => row.family === 'live' && row.exits.start === 0).length,
    liveArmsRefusedAtPreflight: rows.filter(row => row.family === 'live'
      && row.exits.start !== 0 && row.head?.ok === false).length,
    liveArmsFailedAfterStart: rows.filter(row => row.family === 'live'
      && row.exits.start !== 0 && row.head?.ok === true).length,
    referenceGamesCompleted: rows.filter(row => row.family === 'reference'
      && row.status === 'completed').length,
    resumeUsedNewProcess: rows.filter(row => row.exits.resume === 0)
      .every(row => row.pids.start !== null && row.pids.resume !== null
        && row.pids.start !== row.pids.resume),
    realForwards: rows.reduce((sum, row) => sum + (row.forwards ?? 0), 0),
    gpuWallSeconds: Number(rows.reduce((sum, row) =>
      sum + (row.gpuWallSeconds ?? 0), 0).toFixed(1)) };
  const table = { ...prior, rows, checks };
  writeJson(join(out, 'matrix-table.json'), table);
  writeFileSync(join(out, 'MATRIX.md'), matrixMarkdown(table), 'utf8');
  console.log(`regenerated ${rows.length} summaries + ${rel(join(out, 'MATRIX.md'))}`);
  return EXIT.ok;
}

/* ------------------------------- main ------------------------------- */
async function main() {
  if (flag('--matrix')) return matrix();
  if (flag('--regenerate-table')) return regenerateTable();
  if (flag('--regenerate-summaries')) return regenerateSummaries();
  if (flag('--reconcile')) {
    if (!arg('--out')) { console.error('--reconcile needs --out <gameDir>'); return EXIT.internal; }
    return reconcileEvidence(resolve(arg('--out')));
  }
  if (flag('--preflight-only')) {
    const arm = ARMS.find(entry => entry.id === arg('--arm'));
    if (!arm) { console.error(`unknown arm ${arg('--arm')}`); return EXIT.internal; }
    const dir = resolve(arg('--out') ?? './preflight');
    mkdirSync(dir, { recursive: true });
    const preflight = { ...preflightHead(arm), arm: arm.id,
      seed: arg('--seed') ?? null, scenarioSha: SCENARIO_SHA };
    if (preflight.ok) preflight.command = scorerCommand(arm, dir);
    writeJson(join(dir, 'preflight.json'), preflight);
    console.log(JSON.stringify(preflight, null, 2));
    return preflight.code;
  }
  if (flag('--probe-commitment-input')) return probe(true, resolve(arg('--out') ?? './probe-positive'));
  if (flag('--probe-missing-commitments')) return probe(false, resolve(arg('--out') ?? './probe-negative'));
  const phase = arg('--phase');
  const armId = arg('--arm');
  const seed = arg('--seed');
  const out = arg('--out');
  if (!phase || !armId || !seed || !out) {
    console.error('need --phase start|resume|replay --arm <armId> --seed <seed> --out <dir>');
    return EXIT.internal;
  }
  const arm = ARMS.find(entry => entry.id === armId);
  if (!arm) { console.error(`unknown arm ${armId}`); return EXIT.internal; }
  if (phase === 'start') return phaseStart(arm, seed, resolve(out));
  if (phase === 'resume') return phaseResume(arm, seed, resolve(out), { replay: false });
  if (phase === 'replay') return phaseResume(arm, seed, resolve(out), { replay: true });
  console.error(`unknown phase ${phase}`);
  return EXIT.internal;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error);
  process.exitCode = EXIT.internal;
});
