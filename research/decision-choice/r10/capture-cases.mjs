#!/usr/bin/env node
/**
 * R10 C line: capture real on-policy decision states from the live four-day
 * runtime, together with the exact model request and a restorable snapshot.
 *
 *   node research/decision-choice/r10/capture-cases.mjs --out <dir> --episodes 12
 *
 * What is captured (and what is NOT hand-made):
 *   - the world is driven by the shared reference policy through the SAME
 *     `runStep` the web/CLI/four-day entries use, with the R10 defaults
 *     (`obligation-first` memory arm, 640-token budget, conditional notes);
 *   - a "case" is the `ChoiceRequest` built by `runStep` at a real decision
 *     point, saved verbatim (request JSON + rendered text + sha256);
 *   - the pre-decision runtime is saved next to it (`runtime.save`), which is
 *     what the branch labeller reloads to try every candidate on the same
 *     snapshot.
 *
 * Fixes against the R9 corpus exporter:
 *   1. actors rotate: every living actor of every slice is a capture candidate,
 *      not `actorIds[0]`;
 *   2. `medical` really appears in captured candidate sets (`--injured`
 *      episodes start NPCs below the 70-health threshold with medicine in
 *      stock), so `medical` is a real branch, not an assumption;
 *   3. `cancel-after-work` cancels a task whose work **already started**,
 *      after the clock advanced into its duration, and records the settlement
 *      status of the cancelled intent;
 *   4. no "all non-wait is acceptable" rule exists anywhere: acceptable sets
 *      are produced by `label-branches.mjs` from branch rollouts only.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const load = path => require(resolve(root, 'dist', path));

const { R8Runtime } = load('src/r7/integration/runtime.js');
const { runStep, notesFor } = load('src/r7/integration/step.js');
const { referenceAgencyScorer } = load('src/r7/agency/reference.js');
const { renderRequest } = load('src/r7/jev/render.js');
const { runCouncilIfDue } = load('scripts/r8/playthrough.js');

const sha = value => createHash('sha256').update(value).digest('hex');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const out = option('--out');
if (!out) throw new Error('Usage: --out <newDir> [--episodes N] [--slices N] [--injured]');
const episodes = Number(option('--episodes', '12'));
const slices = Number(option('--slices', '6'));
const injured = args.includes('--injured');
const prefix = option('--seed-prefix', 'r10c');
const capPerEpisode = Number(option('--cap', '26'));
// Spread the per-episode budget over the whole episode instead of filling it in
// the first slices: late-game states (empty warehouse, dead furnace) are the
// interesting ones, and first-come capture never reaches them.
const perSliceCap = Math.max(1, Math.ceil(capPerEpisode / Math.max(1, slices)));

const outDir = resolve(out);
const snapDir = join(outDir, 'snapshots');
mkdirSync(snapDir, { recursive: true });
const casesPath = join(outDir, 'cases.jsonl');
const ledgerPath = join(outDir, 'episodes.jsonl');
writeFileSync(casesPath, '');
writeFileSync(ledgerPath, '');

const RENDER_SRC = sha(readFileSync(join(root, 'src/r7/jev/render.ts')));
const RENDER_BUILD = sha(readFileSync(join(root, 'dist/src/r7/jev/render.js')));
const MOUNT = {
  memorySelection: 'obligation-first',
  memoryPolicy: 'conditional-experience',
  memoryTokenBudget: 640,
};

const reference = referenceAgencyScorer();
const totals = { requests: 0, kept: 0, withMedical: 0, cancelAfterWork: 0, refused: 0 };

function envelopeOf(request, meta) {
  const rendered = renderRequest(request);
  const requestJson = JSON.stringify(request);
  return {
    schema: 'frostecho.joint-encoding-request/1',
    sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
    seed: meta.episodeSeed, npcCount: 8, request, requestJson,
    inputSha256: sha(requestJson),
    // The encoder contract is `utf16-code-unit` (joint_encoder.prepare); the
    // R9 exporter used the same token.
    rendered: { ...rendered, spanUnit: 'utf16-code-unit' },
    rendererSourceSha256: RENDER_SRC,
    rendererBuildSha256: RENDER_BUILD,
    renderedTextSha256: sha(rendered.text),
    modelCalls: 0, worldCommits: 0, realModel: false,
    policyRun: { scorerId: reference.identity.scorerId, mode: 'reference',
      rendererId: rendered.rendererId, memoryArm: MOUNT.memorySelection,
      memoryTokenBudget: MOUNT.memoryTokenBudget },
  };
}

/** Is this a state worth branching on? Never "everything": filter is explicit. */
function wanted(request) {
  if (request.candidates.length < 2) return false;
  const actions = request.candidates.map(candidate => String(candidate.parameters.action ?? ''));
  const kind = {
    medical: actions.includes('medical'),
    goal: request.goals.length > 0,
    wide: request.candidates.length >= 5,
    destructive: actions.includes('withdraw') || actions.includes('build-machine'),
  };
  return { keep: kind.medical || kind.goal || kind.wide || kind.destructive, kind };
}

let caseSeq = 0;

async function captureDecision(runtime, actorId, meta, captureKind, extra = {}) {
  const made = [];
  const scorer = {
    identity: reference.identity,
    async score(request) {
      totals.requests += 1;
      const want = wanted(request);
      if (!want.keep || meta.kept >= capPerEpisode || meta.sliceKept >= perSliceCap) {
        return reference.score(request);
      }
      const caseId = `${prefix}-${String(meta.episodeIndex).padStart(2, '0')}-s${meta.sliceIndex}`
        + `-${actorId}-${String(caseSeq++).padStart(4, '0')}`;
      const snapshotBase = join(snapDir, caseId);
      // The world has not been committed yet: this is exactly the state the
      // request was built from.
      runtime.save(snapshotBase);
      const snapshot = runtime.snapshot();
      const frozen = JSON.parse(JSON.stringify(request));
      const envelope = envelopeOf(frozen, meta);
      const row = {
        ...envelope,
        caseId,
        sourceEpisodeId: meta.episodeSeed,
        episodeIndex: meta.episodeIndex,
        scenarioProfile: meta.profile,
        sliceIndex: meta.sliceIndex,
        captureKind,
        policyMode: 'reference-rule/1',
        policyRunStep: true,
        day: snapshot.day,
        minuteOfDay: snapshot.minuteOfDay,
        simTime: runtime.world.simTime,
        worldVersion: runtime.world.version,
        actorId,
        actorFacts: {
          location: snapshot.npcs[actorId]?.location ?? null,
          hunger: snapshot.npcs[actorId]?.hunger ?? null,
          stamina: snapshot.npcs[actorId]?.stamina ?? null,
          health: snapshot.npcs[actorId]?.health ?? null,
          medicine: snapshot.resources.medicine,
          alive: snapshot.npcs[actorId]?.alive ?? false,
        },
        candidateActions: request.candidates.map(candidate => ({
          id: candidate.id,
          kind: candidate.kind,
          action: candidate.parameters.action,
          description: candidate.description,
        })),
        acceptedGoals: request.goals,
        wants: want.kind,
        snapshotBase,
        ...extra,
        acceptedIds: null, // filled by label-branches.mjs from rolled-out branches
        labelSource: 'same-snapshot-branch-rollout',
        labelStatus: 'unlabelled',
      };
      appendFileSync(casesPath, `${JSON.stringify(row)}\n`);
      meta.kept += 1;
      meta.sliceKept += 1;
      totals.kept += 1;
      if (want.kind.medical) totals.withMedical += 1;
      made.push(caseId);
      return reference.score(request);
    },
  };
  const result = await runStep(runtime, scorer, {
    actorIds: [actorId], mode: 'reference', ...MOUNT,
    notes: id => notesFor(runtime, id, MOUNT.memoryPolicy),
  });
  for (const record of result.records) {
    if (record.executionStatus === 'rejected') totals.refused += 1;
  }
  return { made, result };
}

async function runEpisode(index) {
  const seed = `${prefix}-ep${String(index).padStart(2, '0')}`;
  // Scenario profiles cycle so train/dev/test all hold the same three regimes:
  // stocked, injured, and scarce (the last one is where single actions really
  // compete for the last unit of food/wood/medicine).
  const profile = ['normal', 'injured', 'scarce'][index % 3];
  const runtime = R8Runtime.create({ seed });
  let scenarioSetup = null;
  // Per-episode scenario variant. Two episodes that start byte-identical would
  // produce byte-identical inputs, and identical text across splits is leakage;
  // the variant also makes the captured states genuinely different.
  const variant = (index * 5) % 12;
  runtime.world.simTime = 480 + 30 * (variant % 4);
  runtime.world.resources.food += 4 * (variant % 5);
  runtime.world.resources.firewood += 3 * (variant % 4);
  runtime.world.resources.power += 5 * (variant % 3);
  for (const [position, id] of runtime.context().actorIds.entries()) {
    const npc = runtime.world.npcs[id];
    npc.hunger = Math.max(30, npc.hunger - 5 * ((variant + position) % 5));
    npc.stamina = Math.max(35, npc.stamina - 6 * ((variant + position) % 4));
  }
  scenarioSetup = { profile, variant, startSimTime: runtime.world.simTime,
    resources: { ...runtime.world.resources } };
  if (profile === 'scarce') {
    runtime.world.resources.food = 6 + (variant % 2);
    runtime.world.resources.firewood = 4 + (variant % 3);
    runtime.world.resources.power = 6;
    runtime.world.resources.medicine = 1;
    runtime.world.furnace.fuel = 18;
    scenarioSetup = { profile, variant, startSimTime: runtime.world.simTime,
      resources: { ...runtime.world.resources }, furnaceFuel: runtime.world.furnace.fuel };
  }
  if (injured || profile === 'injured') {
    // Scenario configuration only (same class as `--food`): two NPCs start hurt
    // in the medical room with medicine in stock. Every decision after this
    // point is produced by the policy through runStep; no observation is written
    // by hand. `medical` is place-gated by the R10 candidate layer, so the site
    // has to be real for the branch to exist at all.
    runtime.world.resources.medicine = 4;
    const hurt = ['npc_03', 'npc_06'];
    for (const id of hurt) {
      runtime.world.npcs[id].health = 52;
      runtime.world.npcs[id].hunger = 58;
      runtime.world.npcs[id].location = 'medical';
    }
    scenarioSetup = { ...scenarioSetup, profile, injuredActors: hurt, health: 52,
      medicine: 4, location: 'medical' };
  }
  if (!scenarioSetup) scenarioSetup = { profile };
  const meta = { episodeSeed: seed, episodeIndex: index, sliceIndex: 0, kept: 0,
    sliceKept: 0, profile };
  let cancelled = null;
  let pendingCancelCapture = null;
  let ended = null;

  for (let slice = 0; slice < slices; slice += 1) {
    meta.sliceIndex = slice;
    meta.sliceKept = 0;
    runCouncilIfDue(runtime, [], seed);
    // Rotate the actor order across slices and episodes, and put the injured
    // actors first in their own episodes so a real `medical` decision is not
    // starved by the per-slice capture budget.
    const order = [...runtime.context().actorIds];
    const offset = (index * 5 + slice * 3) % order.length;
    const rotated = [...order.slice(offset), ...order.slice(0, offset)];
    const hurtFirst = (scenarioSetup?.injuredActors ?? [])
      .filter(id => rotated.includes(id) && !(meta.hurtCaptured ?? []).includes(id));
    const pending = pendingCancelCapture ? [pendingCancelCapture.actorId] : [];
    const actorOrder = [...pending,
      ...hurtFirst.filter(id => !pending.includes(id)),
      ...rotated.filter(id => !pending.includes(id) && !hurtFirst.includes(id))];
    for (const actorId of actorOrder) {
      if (!runtime.world.npcs[actorId]?.alive) continue;
      if (runtime.busyUntil(actorId) !== null) continue;
      const captureKind = pendingCancelCapture?.actorId === actorId ? 'cancel-after-work' : 'natural';
      const extra = captureKind === 'cancel-after-work' ? { cancelAfterWork: pendingCancelCapture } : {};
      if (captureKind === 'cancel-after-work') pendingCancelCapture = null;
      const { made } = await captureDecision(runtime, actorId, meta, captureKind, extra);
      if (made.length > 0 && (scenarioSetup?.injuredActors ?? []).includes(actorId)) {
        meta.hurtCaptured = [...(meta.hurtCaptured ?? []), actorId];
      }
      if (captureKind === 'cancel-after-work' && made.length > 0) totals.cancelAfterWork += 1;

      // A real "work started, then the player cancels it" intervention, once.
      if (!cancelled) {
        const intent = runtime.activeIntent(actorId);
        const taskId = intent?.taskId ?? null;
        if (intent && taskId) {
          const startedAt = intent.startedAt;
          const dueAt = intent.dueAt;
          const middle = startedAt + Math.max(1, Math.floor((dueAt - startedAt) / 3));
          runtime.advanceWorld(middle);
          const cancelAt = runtime.world.simTime;
          const cancelledDispatch = runtime.dispatch('tasks', 'cancel', 'old_qian', { taskId });
          runtime.advanceWorld(dueAt);
          const settled = (runtime.workLog ?? []).filter(row => row.actorId === actorId).at(-1) ?? null;
          cancelled = {
            actorId, taskId, startedAt, cancelledAt: cancelAt, dueAt,
            cancelEvents: cancelledDispatch.events.map(event => event.eventId),
            settlementStatus: settled?.status ?? null,
            settlementReason: settled?.failureReason ?? null,
            workKind: settled?.kind ?? null,
          };
          pendingCancelCapture = { ...cancelled, captureAfterSettlement: true };
        }
      }
      if (runtime.ended) break;
    }
    if (runtime.ended) { ended = runtime.endingKind; break; }
    const before = runtime.world.simTime;
    // Same night skip as the four-day runner: 20:00 -> next day 06:00. Without
    // it a "long" capture never leaves day 1 and the late-game states are lost.
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
  // Final on-policy state of the episode is evidence, not a label source.
  const final = runtime.snapshot();
  appendFileSync(ledgerPath, `${JSON.stringify({
    episodeSeed: seed, episodeIndex: index, slices, injured, scenarioSetup,
    kept: meta.kept, cancelled, ended,
    final: { day: final.day, minuteOfDay: final.minuteOfDay, simTime: runtime.world.simTime,
      alive: Object.values(final.npcs).filter(npc => npc.alive).length,
      resources: final.resources, furnace: final.furnace },
  })}\n`);
  return meta;
}

const started = Date.now();
for (let index = 0; index < episodes; index += 1) {
  const meta = await runEpisode(index);
  console.log(JSON.stringify({ episode: index, kept: meta.kept, elapsedMs: Date.now() - started }));
}

const rows = readFileSync(casesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const summary = {
  schema: 'frostecho.r10c.capture/1',
  cases: rows.length,
  episodes,
  slices,
  injured,
  rendererSourceSha256: RENDER_SRC,
  rendererBuildSha256: RENDER_BUILD,
  rendererId: renderRequest(rows[0].request).rendererId,
  policy: { scorerId: reference.identity.scorerId, mode: 'reference', mount: MOUNT },
  totals,
  byKind: rows.reduce((acc, row) => ({ ...acc, [row.captureKind]: (acc[row.captureKind] ?? 0) + 1 }), {}),
  byEpisode: rows.reduce((acc, row) => ({ ...acc, [row.sourceEpisodeId]: (acc[row.sourceEpisodeId] ?? 0) + 1 }), {}),
  withMedicalCandidate: rows.filter(row => row.candidateActions.some(entry => entry.action === 'medical')).length,
  withAcceptedGoals: rows.filter(row => row.acceptedGoals.length > 0).length,
  wallSeconds: (Date.now() - started) / 1000,
  sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
  casesSha256: sha(rows.map(row => JSON.stringify(row)).join('\n')),
  note: 'States are produced by the reference policy through runStep; nothing here is a hand-written observation.',
};
writeFileSync(join(outDir, 'capture.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
