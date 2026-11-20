#!/usr/bin/env node
/**
 * R11 C line: capture real on-policy decision states for the two label
 * families, after O publishes FREEZE.json.
 *
 *   node research/decision-choice/r11/collect-cases.mjs \
 *     --freeze <FREEZE.json> --freeze-sha256 <sha256> --out <newDir> \
 *     --episodes 12 --slices 8 [--policy reference|jev] [--scorer-cmd '<json array>']
 *
 * Two access strata, both recorded verbatim:
 *   reference  the frozen rule policy drives every decision (CPU only);
 *   jev        a real serve_joint process answers every request; the reply's
 *              manifestSha256 must equal the local manifest and an abstention is
 *              recorded (with a reference fallback that keeps the world moving),
 *              never hidden.
 *
 * A case is one real ChoiceRequest built by `runStep` plus the restorable
 * pre-decision snapshot.  No observation is written by hand.  The four story
 * setups manipulate the WORLD (cancel told/not told, unaccepted source change,
 * last-unit contention), then the policy produces the decisions.
 *
 * The freeze is mandatory: without O's published contract there is no sampling.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const load = path => require(resolve(root, 'dist', path));

const { R8Runtime } = load('src/r7/integration/runtime.js');
const { runStep, notesFor } = load('src/r7/integration/step.js');
const { referenceAgencyScorer } = load('src/r7/agency/reference.js');
const { renderRequest } = load('src/r7/jev/render.js');
const { GameplayLoop } = load('src/gameplay-v2/loop.js');
const { createCommitmentBridge } = load('src/r7/integration/commitment-bridge.js');

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const flag = name => args.includes(name);

const freezePath = option('--freeze');
const expectedFreezeSha = option('--freeze-sha256');
const out = option('--out');
if (!freezePath || !out) {
  throw new Error('Usage: --freeze <FREEZE.json> --out <newDir> [--episodes N] [--slices N]');
}
if (!existsSync(freezePath)) throw new Error(`FREEZE.json not found at ${freezePath}`);
const freeze = JSON.parse(readFileSync(freezePath, 'utf8'));
const freezeSha = sha(readFileSync(freezePath));
if (expectedFreezeSha && expectedFreezeSha !== freezeSha) {
  throw new Error(`FREEZE.json sha ${freezeSha} differs from the pinned ${expectedFreezeSha}`);
}
const pick = (...values) => values.find(value => value !== undefined && value !== null);
const freezeSource = pick(freeze.sourceCommit, freeze.commit, freeze.source?.commit);
const renderer = freeze.renderer ?? {};
const rendererSha = pick(renderer.sourceSha256, freeze.rendererSourceSha256);
const horizon = pick(freeze.deadline?.horizonMinutes, freeze.deadlineHorizonMinutes,
  freeze.horizonMinutes);
const memory = freeze.memory ?? {};
const memoryPolicy = pick(memory.policy, freeze.memoryPolicy, 'conditional-experience');
const memorySelection = pick(memory.selection, freeze.memorySelection, 'obligation-first');
const memoryTokenBudget = pick(memory.tokenBudget, freeze.memoryTokenBudget, 640);
const splitSeed = pick(freeze.splits?.seed, freeze.splitSeed);
const freezeStatus = pick(freeze.status, 'frozen');
if (freezeStatus !== 'frozen') throw new Error(`FREEZE.json status is ${freezeStatus}, not frozen`);
if (!freezeSource) throw new Error('FREEZE.json must bind sourceCommit');
if (!Number.isInteger(horizon) || horizon < 1) {
  throw new Error('FREEZE.json must freeze a positive deadline.horizonMinutes');
}
if (!rendererSha) throw new Error('FREEZE.json must bind renderer.sourceSha256');
const liveRenderer = sha(readFileSync(join(root, 'src/r7/jev/render.ts')));
if (rendererSha !== liveRenderer) {
  throw new Error(`FREEZE renderer ${rendererSha} differs from live ${liveRenderer}`);
}
if (!splitSeed) throw new Error('FREEZE.json must freeze the split seed');
if (!Number.isInteger(memoryTokenBudget) || memoryTokenBudget < 1) {
  throw new Error('FREEZE.json must freeze a positive memory.tokenBudget');
}

const episodes = Number(option('--episodes', String(pick(freeze.scenario?.episodes, 12))));
const slices = Number(option('--slices', String(pick(freeze.scenario?.slices, 8))));
const capPerEpisode = Number(option('--cap', String(pick(freeze.scenario?.capPerEpisode, 8))));
const policy = option('--policy', 'reference');
if (!['reference', 'jev'].includes(policy)) throw new Error('--policy must be reference or jev');
const prefix = option('--seed-prefix', 'r11c');
const scorerCommand = option('--scorer-cmd') ? JSON.parse(option('--scorer-cmd')) : null;
const manifestPath = option('--manifest');
if (policy === 'jev' && (!scorerCommand || !manifestPath)) {
  throw new Error('--policy jev requires --scorer-cmd and --manifest');
}
const manifestSha = manifestPath ? sha(readFileSync(manifestPath)) : null;
const manifestDocument = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
if (policy === 'jev') {
  if (!['frostecho.action-training-manifest/2',
    'frostecho.training-manifest/r11'].includes(manifestDocument.schema)
      || manifestDocument.experimental !== true
      || manifestDocument.countsAsAdmitted !== false
      || !manifestDocument.labelSource) {
    throw new Error('the scorer manifest must be an unadmitted /2 contract document');
  }
}
const expectedHeadSha = manifestDocument?.selectedCheckpointSha256 ?? null;
const STORIES = ['cancel-heard', 'cancel-unheard', 'change-unaccepted', 'last-unit-contention'];

const outDir = resolve(out);
if (existsSync(outDir)) throw new Error(`${outDir} exists; every collection is a new directory`);
mkdirSync(join(outDir, 'snapshots'), { recursive: true });
const casesPath = join(outDir, 'cases.jsonl');
const ledgerPath = join(outDir, 'episodes.jsonl');
writeFileSync(casesPath, '');
writeFileSync(ledgerPath, '');

const RENDER_SRC = sha(readFileSync(join(root, 'src/r7/jev/render.ts')));
const RENDER_BUILD = sha(readFileSync(join(root, 'dist/src/r7/jev/render.js')));
const MOUNT = { memorySelection, memoryPolicy, memoryTokenBudget };
const reference = referenceAgencyScorer();

/* ----------------------------- JEV stdio client ----------------------------- */
class JointService {
  constructor(command, expectedManifestSha, expectedHead) {
    this.child = spawn(command[0], command.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = [];
    this.stderr = '';
    this.expectedManifestSha = expectedManifestSha;
    this.expectedHeadSha = expectedHead;
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      const waiter = this.pending.shift();
      if (!waiter) return;
      try { waiter.resolve(JSON.parse(line)); } catch (error) { waiter.reject(error); }
    });
    this.child.on('exit', code => {
      while (this.pending.length) {
        this.pending.shift().reject(new Error(`serve_joint exited ${code}: ${this.stderr.slice(-800)}`));
      }
    });
  }
  request(envelope) {
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.push({ resolve: resolvePromise, reject: rejectPromise });
      this.child.stdin.write(`${canonical(envelope)}\n`);
    });
  }
  async score(envelope) {
    const reply = await this.request(envelope);
    if (reply.disposition === 'error') throw new Error(`serve_joint request failed: ${reply.error}`);
    if (reply.manifestSha256 !== this.expectedManifestSha) {
      throw new Error(`reply manifest ${reply.manifestSha256} differs from ${this.expectedManifestSha}`);
    }
    if (reply.requestId !== envelope.request.requestId) throw new Error('reply requestId mismatch');
    if (this.expectedHeadSha && reply.identity?.headSha256 !== this.expectedHeadSha) {
      throw new Error(`reply head ${reply.identity?.headSha256} differs from manifest `
        + `${this.expectedHeadSha}`);
    }
    return reply;
  }
  close() { try { this.child.stdin.end(); } catch { /* already closed */ } }
}

/* ------------------------------- capture loop ------------------------------- */
function envelopeOf(request, meta) {
  const rendered = renderRequest(request);
  const requestJson = JSON.stringify(request);
  return {
    schema: 'frostecho.joint-encoding-request/1',
    sourceHEAD: freezeSource, seed: meta.episodeSeed, npcCount: freeze.scenario?.npcCount ?? 8,
    request, requestJson,
    inputSha256: sha(requestJson),
    rendered: { ...rendered, spanUnit: 'utf16-code-unit' },
    rendererSourceSha256: RENDER_SRC, rendererBuildSha256: RENDER_BUILD,
    renderedTextSha256: sha(rendered.text),
    modelCalls: 0, worldCommits: 0, realModel: policy === 'jev',
  };
}

function wanted(request, actorId, runtime, play) {
  if (request.candidates.length < 2) return { keep: false };
  const active = play.commitments.all().filter(row =>
    row.promisorId === actorId && ['active', 'suspended'].includes(row.status));
  const actions = request.candidates.map(candidate => String(candidate.parameters.action ?? ''));
  const kind = {
    obligation: active.length > 0 || request.goals.length > 0,
    medical: actions.includes('medical'),
    wide: request.candidates.length >= 5,
    destructive: actions.includes('withdraw') || actions.includes('build-machine'),
  };
  return { keep: kind.obligation || kind.medical || kind.wide || kind.destructive, kind,
    activeCommitmentIds: active.map(row => row.commitmentId) };
}

async function collectEpisode(index, service) {
  const seed = `${prefix}-ep${String(index).padStart(2, '0')}`;
  const story = STORIES[index % STORIES.length];
  const runtime = R8Runtime.create({
    seed, npcCount: freeze.scenario?.npcCount ?? 8,
    resources: freeze.scenario?.resources,
  });
  runtime.enableLegacySpatial();
  const play = new GameplayLoop(runtime.session);
  const bridge = createCommitmentBridge(runtime, play);
  const start = runtime.world.simTime;
  const seeded = [];
  const goals = ['deliver-meal', 'deliver-meal', 'supply-warehouse', 'supply-warehouse'];
  for (const [position, actorId] of runtime.context().actorIds.slice(0, 4).entries()) {
    const requested = play.requestCommitment(actorId, goals[position], {
      verdict: 'accept', deadline: start + horizon,
      conditions: goals[position] === 'deliver-meal' ? ['warehouse-supply'] : ['warehouse-supply'],
      inputId: `${seed}-commit-${position}`,
    });
    seeded.push({ actorId, goal: goals[position], commitmentId: requested.commitment.commitmentId,
      taskId: requested.task?.taskId ?? null, status: requested.commitment.status,
      deadline: requested.commitment.deadline });
  }
  const setup = { story, seeded };
  if (story === 'last-unit-contention') {
    runtime.world.resources.food = 3;
    runtime.world.resources.firewood = 4;
    runtime.world.resources.power = 8;
    setup.resources = { ...runtime.world.resources };
  }
  if (story === 'change-unaccepted') {
    for (const row of seeded.slice(0, 2)) {
      const changed = play.commitments.proposeChange(row.commitmentId, {
        kind: 'alt-source', reason: 'warehouse-empty',
        terms: { source: 'gather', reason: '先采集再交付' },
        at: runtime.world.simTime, evidenceEventIds: [],
      });
      runtime.session.ingestCommitmentEvent(changed.event);
      setup.change = { ...setup.change, [row.commitmentId]: changed.event.eventId };
    }
  }
  const meta = { episodeSeed: seed, episodeIndex: index, sliceIndex: 0, kept: 0,
    sliceKept: 0, story, profile: story };
  let interference = null;
  let ended = null;
  const perSliceCap = Math.max(1, Math.ceil(capPerEpisode / Math.max(1, slices)));

  const scorer = {
    identity: policy === 'jev'
      ? { scorerId: 'jev-experimental-live', mode: 'jev-experimental', manifestSha256: manifestSha }
      : reference.identity,
    async score(request) {
      const want = wanted(request, meta.currentActor, runtime, play);
      if (!want.keep || meta.kept >= capPerEpisode || meta.sliceKept >= perSliceCap) {
        return reference.score(request);
      }
      const caseId = `${prefix}-${String(index).padStart(2, '0')}-s${meta.sliceIndex}`
        + `-${meta.currentActor}-${String(meta.kept).padStart(3, '0')}`;
      const snapshotBase = join(outDir, 'snapshots', caseId);
      runtime.save(snapshotBase);
      // The gameplay boards live beside the runtime state; without these the
      // commitment ledger would silently vanish on restore.
      play.save(snapshotBase);
      const snapshot = runtime.snapshot();
      const frozen = JSON.parse(JSON.stringify(request));
      const envelope = envelopeOf(frozen, meta);
      const commitments = play.commitments.all()
        .filter(row => row.promisorId === meta.currentActor)
        .map(row => ({ commitmentId: row.commitmentId, goal: row.goal, status: row.status,
          revision: row.revision, deadline: row.deadline ?? null, taskId: row.taskId ?? null }));
      let jev = null;
      let decision = null;
      if (policy === 'jev') {
        jev = await service.score(envelope);
        if (jev.disposition === 'accept' && jev.selectedId) {
          decision = { scorerId: 'jev-experimental-live', mode: 'jev-experimental',
            selectedId: jev.selectedId, disposition: 'accept', reason: 'live jev scorer' };
        } else if (jev.disposition === 'abstain') {
          const fallback = reference.score(request);
          decision = { ...fallback,
            reason: 'reference fallback after a recorded live abstention',
            fallback: 'reference-after-abstain' };
        } else {
          throw new Error(`unexpected live disposition ${jev.disposition}`);
        }
      }
      const row = {
        ...envelope,
        caseId, sourceEpisodeId: seed, episodeIndex: index, story,
        scenarioProfile: story, sliceIndex: meta.sliceIndex,
        captureKind: 'natural', policyMode: scorer.identity.scorerId,
        policyRun: policy === 'jev'
          ? { scorerId: 'jev-experimental-live', mode: 'jev-experimental',
            headSha256: jev?.identity?.headSha256 ?? null,
            manifestSha256: jev?.manifestSha256 ?? null,
            featureIdentityHash: jev?.identity?.featureIdentityHash ?? null,
            disposition: jev?.disposition ?? null,
            selectedId: jev?.selectedId ?? null,
            fallback: decision?.fallback ?? null,
            fallbackSelectedId: decision?.fallback ? decision.selectedId : null,
            replySha256: jev ? sha(canonical(jev)) : null }
          : { scorerId: reference.identity.scorerId, mode: 'reference' },
        accessState: policy === 'jev' ? 'real-jev' : 'reference',
        legacySpatial: true,
        freezeSha256: freezeSha, freezeSourceCommit: freezeSource,
        splitSeed,
        day: snapshot.day, minuteOfDay: snapshot.minuteOfDay,
        simTime: runtime.world.simTime, worldVersion: runtime.world.version,
        actorId: meta.currentActor,
        activeCommitments: commitments,
        actorFacts: { location: snapshot.npcs[meta.currentActor]?.location ?? null,
          hunger: snapshot.npcs[meta.currentActor]?.hunger ?? null,
          stamina: snapshot.npcs[meta.currentActor]?.stamina ?? null,
          health: snapshot.npcs[meta.currentActor]?.health ?? null,
          alive: snapshot.npcs[meta.currentActor]?.alive ?? false },
        resources: { ...snapshot.resources },
        candidateActions: request.candidates.map(candidate => ({
          id: candidate.id, kind: candidate.kind,
          action: candidate.parameters.action, description: candidate.description })),
        acceptedGoals: request.goals, wants: want.kind, snapshotBase,
        labelSource: 'same-snapshot-branch-rollout', labelStatus: 'unlabelled',
      };
      appendFileSync(casesPath, `${canonical(row)}\n`);
      meta.kept += 1;
      meta.sliceKept += 1;
      return decision ?? reference.score(request);
    },
  };

  for (let slice = 0; slice < slices; slice += 1) {
    meta.sliceIndex = slice;
    meta.sliceKept = 0;
    if (slice === 2 && !interference) {
      const target = seeded[index % seeded.length];
      if (story === 'cancel-heard' || story === 'cancel-unheard') {
        const heardBy = story === 'cancel-heard'
          ? [target.actorId]
          : [runtime.context().actorIds.find(id => id !== target.actorId)];
        const cancelled = play.cancelCommitment(target.commitmentId, {
          heardBy, reason: '玩家改主意', inputId: `${seed}-cancel`,
        });
        interference = { kind: story, target: target.actorId, heardBy,
          eventIds: [cancelled.event.eventId] };
      } else if (story === 'change-unaccepted') {
        interference = { kind: story, target: target.actorId,
          change: setup.change?.[target.commitmentId] ?? null };
      } else {
        runtime.world.resources.food = 2;
        runtime.world.resources.firewood = 3;
        interference = { kind: story, target: target.actorId,
          resources: { ...runtime.world.resources } };
      }
    }
    const order = [...runtime.context().actorIds];
    const offset = (index * 5 + slice * 3) % order.length;
    const rotated = [...order.slice(offset), ...order.slice(0, offset)];
    for (const actorId of rotated) {
      if (!runtime.world.npcs[actorId]?.alive) continue;
      if (runtime.busyUntil(actorId) !== null) continue;
      meta.currentActor = actorId;
      await runStep(runtime, scorer, {
        actorIds: [actorId], mode: policy === 'jev' ? 'jev-experimental' : 'reference',
        ...MOUNT, goalBridge: bridge,
        notes: id => notesFor(runtime, id, MOUNT.memoryPolicy),
      });
      if (runtime.ended) break;
    }
    if (runtime.ended) { ended = runtime.endingKind; break; }
    const before = runtime.world.simTime;
    const snapshot = runtime.snapshot();
    const dayStart = Math.floor(before / runtime.profile.minutesPerDay)
      * runtime.profile.minutesPerDay;
    const to = (snapshot.minuteOfDay >= runtime.profile.nightSkipFromMinute
      || snapshot.minuteOfDay < runtime.profile.nightSkipToMinute)
      ? dayStart + runtime.profile.minutesPerDay + runtime.profile.nightSkipToMinute
      : Math.floor(before / 60) * 60 + 60;
    runtime.advanceWorld(to);
    if (runtime.ended) { ended = runtime.endingKind; break; }
  }
  const final = runtime.snapshot();
  appendFileSync(ledgerPath, `${canonical({
    episodeSeed: seed, episodeIndex: index, story, slices, setup, interference, ended,
    kept: meta.kept,
    final: { day: final.day, minuteOfDay: final.minuteOfDay, simTime: runtime.world.simTime,
      alive: Object.values(final.npcs).filter(npc => npc.alive).length,
      resources: final.resources, furnace: final.furnace },
  })}\n`);
  return meta;
}

const started = Date.now();
const service = policy === 'jev'
  ? new JointService(scorerCommand, manifestSha, expectedHeadSha) : null;
try {
  for (let index = 0; index < episodes; index += 1) {
    const meta = await collectEpisode(index, service);
    console.log(canonical({ episode: index, story: meta.story, kept: meta.kept,
      elapsedMs: Date.now() - started }));
  }
} finally {
  service?.close();
}
const rows = readFileSync(casesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const summary = {
  schema: 'frostecho.r11c.capture/1',
  cases: rows.length, episodes, slices, policy,
  freezeSha256: freezeSha, freezeSourceCommit: freezeSource, splitSeed,
  rendererSourceSha256: RENDER_SRC, rendererBuildSha256: RENDER_BUILD,
  rendererId: rows.length ? renderRequest(rows[0].request).rendererId : null,
  memory: MOUNT, deadlineHorizonMinutes: horizon, legacySpatial: true,
  manifestSha256: manifestSha,
  byStory: rows.reduce((acc, row) => ({ ...acc, [row.story]: (acc[row.story] ?? 0) + 1 }), {}),
  byEpisode: rows.reduce((acc, row) => ({ ...acc, [row.sourceEpisodeId]: (acc[row.sourceEpisodeId] ?? 0) + 1 }), {}),
  byAccessState: rows.reduce((acc, row) => ({ ...acc, [row.accessState]: (acc[row.accessState] ?? 0) + 1 }), {}),
  withActiveCommitment: rows.filter(row => row.activeCommitments.length > 0).length,
  wallSeconds: (Date.now() - started) / 1000,
  casesSha256: sha(rows.map(row => canonical(row)).join('\n')),
  realModel: policy === 'jev',
  note: 'States come from runStep under the frozen policy; story setups touch the world, never the observation.',
};
writeFileSync(join(outDir, 'capture.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(canonical({ ok: true, ...summary }));
