#!/usr/bin/env node
/**
 * R10 C line: same-snapshot branch labelling.
 *
 *   node research/decision-choice/r10/label-branches.mjs \
 *     --cases <capture/cases.jsonl> --out <dir> [--horizon 120] [--slice 30]
 *
 * For every captured case:
 *   1. reload the exact pre-decision runtime (`R8Runtime.load`), once per candidate;
 *   2. force that candidate as the actor's next action through the same entry the
 *      live loop uses (`beginIntent` for time-consuming work, `executeCandidate`
 *      for the immediate ones) and settle it on the clock;
 *   3. advance the world with the SAME fixed controller (the reference rule
 *      policy, `reference-rule/1`) for `--horizon` minutes in `--slice` blocks;
 *   4. judge acceptability from the terminal state only.
 *
 * The label rule is a written predicate, not a preference:
 *
 *   acceptable := firstAction.status in {applied, applied-after-work}
 *              && focal actor alive at the horizon
 *              && aliveCount(horizon) >= aliveCount(branch point)
 *              && no accepted task of the actor was lost during the branch
 *
 * The per-branch terminal facts (resources, tasks, settled intents, rejections)
 * are stored verbatim, so a stricter rule can be recomputed without re-running.
 * There is no "everything that is not wait" rule anywhere in this file.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const load = path => require(resolve(root, 'dist', path));

const { R8Runtime } = load('src/r7/integration/runtime.js');
const { runStep, executeCandidate, notesFor, durationOf } =
  load('src/r7/integration/step.js');
const { referenceAgencyScorer } = load('src/r7/agency/reference.js');
const { taskBindingOfCandidate } = load('src/r7/agency/options.js');

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const casesPath = option('--cases');
const out = option('--out');
if (!casesPath || !out) throw new Error('Usage: --cases <cases.jsonl> --out <newDir>');
const horizon = Number(option('--horizon', '120'));
const slice = Number(option('--slice', '30'));
const snapshotsDir = option('--snapshots', join(dirname(resolve(casesPath)), 'snapshots'));
const requireDischarge = args.includes('--require-discharge');
/**
 * Credit assignment for ONE action: the focal actor does not get a second
 * decision inside the horizon, so the terminal state measures the action's own
 * consequence instead of the controller's repair. Every other actor is still
 * driven by the same fixed reference policy.
 */
const focalIdle = args.includes('--focal-idle');
const LABEL_RULE = requireDischarge
  ? 'first-action-applied && actor-alive && no-population-loss && no-accepted-task-lost && obligations-discharged'
  : 'first-action-applied && actor-alive && no-population-loss && no-accepted-task-lost';
const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });

const MOUNT = {
  memorySelection: 'obligation-first',
  memoryPolicy: 'conditional-experience',
  memoryTokenBudget: 640,
};
const reference = referenceAgencyScorer();
const controller = { identity: reference.identity, score: request => reference.score(request) };

const rows = readFileSync(casesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

function taskView(runtime, actorId) {
  return (runtime.states.tasks.tasks ?? [])
    .filter(task => task.assigneeId === actorId)
    .map(task => ({ taskId: task.taskId, type: task.type, status: task.status }));
}

function aliveCount(runtime) {
  return Object.values(runtime.world.npcs).filter(npc => npc.alive).length;
}

async function rollout(runtime, focalActorId) {
  let advanced = 0;
  let slices = 0;
  while (advanced < horizon && !runtime.ended) {
    for (const actorId of runtime.context().actorIds) {
      if (!runtime.world.npcs[actorId]?.alive) continue;
      if (runtime.busyUntil(actorId) !== null) continue;
      if (focalIdle && actorId === focalActorId) continue;
      await runStep(runtime, controller, {
        actorIds: [actorId], mode: 'reference', ...MOUNT,
        notes: id => notesFor(runtime, id, MOUNT.memoryPolicy),
      });
      if (runtime.ended) break;
    }
    const before = runtime.world.simTime;
    const to = before + slice;
    runtime.advanceWorld(to);
    slices += 1;
    advanced += runtime.world.simTime - before;
    if (runtime.world.simTime === before) break;
    void focalActorId;
  }
  return { slices, advanced };
}

async function branchOf(row, candidateIndex, branchDir) {
  const runtime = R8Runtime.load(join(branchDir, 'state'));
  const candidate = runtime === null ? null : row.request.candidates[candidateIndex];
  const actorId = row.actorId;
  const branchPoint = runtime.snapshot();
  const tasksAtBranch = taskView(runtime, actorId);
  const acceptedAtBranch = tasksAtBranch.filter(task => task.status === 'accepted');
  const aliveAtBranch = aliveCount(runtime);
  const workLogBefore = runtime.workLog.length;
  const rejectionsBefore = runtime.rejections.length;
  const minutes = durationOf(candidate);
  const intentId = `force-${row.caseId}-${candidateIndex}`;
  const commandId = `${actorId}-force-${candidateIndex}`;
  let first;
  if (minutes > 0) {
    const binding = taskBindingOfCandidate(candidate);
    const begun = runtime.beginIntent({
      intentId, commandId, actorId, candidate, minutes,
      inputSha256: row.inputSha256,
      taskId: binding?.taskId ?? null,
      taskType: binding?.type ?? null,
    });
    if ('rejected' in begun) {
      first = { status: 'refused-before-start', reason: begun.rejected, eventIds: [], minutes };
    } else {
      runtime.advanceWorld(begun.intent.dueAt);
      const settled = runtime.workLog.slice(workLogBefore)
        .filter(entry => entry.intentId === intentId).at(-1) ?? null;
      first = { status: settled?.status ?? 'unknown', reason: settled?.failureReason ?? '',
        eventIds: settled?.eventIds ?? [], minutes, intentId };
    }
  } else {
    const outcome = executeCandidate(runtime, actorId, candidate, commandId);
    first = { status: outcome.status, reason: outcome.reason, eventIds: outcome.eventIds, minutes };
  }
  const rolled = await rollout(runtime, actorId);
  const terminal = runtime.snapshot();
  const tasksAtHorizon = taskView(runtime, actorId);
  // A negative transition is what "lost" means: done is the goal, accepted is
  // still owed, cancelled/proposed/gone is an obligation the branch dropped.
  const NEGATIVE = new Set(['cancelled', 'proposed', 'rejected', 'failed', 'expired']);
  const acceptedLost = acceptedAtBranch.filter(before => {
    const after = tasksAtHorizon.find(task => task.taskId === before.taskId);
    return !after || NEGATIVE.has(after.status);
  }).map(task => ({ taskId: task.taskId, type: task.type,
    before: 'accepted', after: tasksAtHorizon.find(row2 => row2.taskId === task.taskId)?.status ?? 'gone' }));
  const stillOwed = acceptedAtBranch.filter(before => {
    const after = tasksAtHorizon.find(task => task.taskId === before.taskId);
    return after?.status === 'accepted';
  }).map(task => task.taskId);
  const alive = aliveCount(runtime);
  const actorAlive = Boolean(terminal.npcs[actorId]?.alive);
  const firstOk = first.status === 'applied';
  const base = firstOk && actorAlive && alive >= aliveAtBranch && acceptedLost.length === 0;
  const discharged = stillOwed.length === 0;
  const acceptable = base && (!requireDischarge || discharged);
  const reasons = [];
  if (!firstOk) reasons.push(`first_action:${first.status}`);
  if (!actorAlive) reasons.push('actor_dead');
  if (alive < aliveAtBranch) reasons.push('population_loss');
  if (acceptedLost.length > 0) reasons.push('accepted_task_lost');
  if (!discharged) reasons.push(`obligation_pending:${stillOwed.length}`);
  return {
    caseId: row.caseId,
    candidateIndex,
    candidateId: candidate.id,
    action: candidate.parameters.action,
    parameters: candidate.parameters,
    branchPoint: { day: branchPoint.day, minuteOfDay: branchPoint.minuteOfDay,
      simTime: branchPoint.simTime, worldVersion: branchPoint.version,
      alive: aliveAtBranch, acceptedTasks: acceptedAtBranch.map(task => task.taskId) },
    firstAction: first,
    rollout: rolled,
    terminal: {
      simTime: runtime.world.simTime,
      day: terminal.day,
      minuteOfDay: terminal.minuteOfDay,
      ended: runtime.ended,
      endingKind: runtime.endingKind,
      alive,
      actorAlive,
      resources: terminal.resources,
      furnace: terminal.furnace,
      actorFacts: { location: terminal.npcs[actorId]?.location,
        hunger: terminal.npcs[actorId]?.hunger, stamina: terminal.npcs[actorId]?.stamina,
        health: terminal.npcs[actorId]?.health, bodyTemp: terminal.npcs[actorId]?.bodyTemp },
      tasks: tasksAtHorizon,
      settledDuringBranch: runtime.workLog.slice(workLogBefore)
        .map(entry => ({ actorId: entry.actorId, kind: entry.kind, status: entry.status,
          failureReason: entry.failureReason })),
      rejectionsDuringBranch: runtime.rejections.slice(rejectionsBefore),
    },
    acceptedTaskLost: acceptedLost,
    obligationsStillOwed: stillOwed,
    acceptableBase: base,
    acceptable,
    acceptReasons: reasons,
  };
}

const started = Date.now();
const records = [];
const labels = [];
for (const row of rows) {
  const branchDir = join(outDir, 'branches', row.caseId);
  mkdirSync(branchDir, { recursive: true });
  // One copy of the captured snapshot per case: the branches must share it.
  // Resolve the snapshot portably: the captured absolute path may have moved,
  // `<cases dir>/snapshots/<caseId>` is the stable location.
  const portable = join(snapshotsDir, row.caseId);
  const snapshotBase = existsSync(`${row.snapshotBase}.r8.json`) ? row.snapshotBase : portable;
  const saved = readFileSync(snapshotBase);
  writeFileSync(join(branchDir, 'state'), saved);
  writeFileSync(join(branchDir, 'state.r8.json'), readFileSync(`${snapshotBase}.r8.json`));
  const branches = [];
  for (let index = 0; index < row.request.candidates.length; index += 1) {
    branches.push(await branchOf(row, index, branchDir));
  }
  const acceptableIds = branches.filter(branch => branch.acceptable).map(branch => branch.candidateId);
  const rule = reference.score(row.request);
  const rulePick = rule.selectedId;
  const label = {
    caseId: row.caseId,
    sourceEpisodeId: row.sourceEpisodeId,
    split: row.split,
    actorId: row.actorId,
    captureKind: row.captureKind,
    candidates: row.request.candidates.length,
    acceptableIds,
    allAcceptable: acceptableIds.length === row.request.candidates.length,
    noneAcceptable: acceptableIds.length === 0,
    rulePick,
    rulePickAcceptable: acceptableIds.includes(rulePick),
    randomExpectation: acceptableIds.length / row.request.candidates.length,
    labelRule: LABEL_RULE,
    horizonMinutes: horizon,
    sliceMinutes: slice,
    labelSource: 'same-snapshot-branch-rollout',
    branches,
  };
  labels.push(label);
  records.push(label);
  console.log(JSON.stringify({ caseId: row.caseId, k: label.candidates,
    acceptable: acceptableIds.length, ruleOk: label.rulePickAcceptable,
    firstRefused: branches.filter(branch => branch.firstAction.status !== 'applied').length }));
}
writeFileSync(join(outDir, 'labels.jsonl'), `${labels.map(label => JSON.stringify(label)).join('\n')}\n`);

// Seeded random baseline: 200 draws per case, deterministic.
let seed = 20261118;
const draw = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
let randomHits = 0;
let randomTotal = 0;
for (const label of labels) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pick = Math.min(label.candidates - 1, Math.floor(draw() * label.candidates));
    const ok = label.branches[pick].acceptable;
    randomHits += ok ? 1 : 0;
    randomTotal += 1;
  }
}
const ruleHits = labels.filter(label => label.rulePickAcceptable).length;
const summary = {
  schema: 'frostecho.r10c.labels/1',
  cases: labels.length,
  totalBranches: labels.reduce((sum, label) => sum + label.candidates, 0),
  allAcceptableCases: labels.filter(label => label.allAcceptable).length,
  noneAcceptableCases: labels.filter(label => label.noneAcceptable).length,
  meanAcceptablePerCase: Number((labels.reduce((sum, label) => sum + label.acceptableIds.length, 0)
    / labels.length).toFixed(4)),
  randomBaseline: { expectedTop1GivenUniformPick: Number((labels
    .reduce((sum, label) => sum + label.randomExpectation, 0) / labels.length).toFixed(4)),
    seededDrawTop1: Number((randomHits / randomTotal).toFixed(4)), draws: randomTotal },
  ruleBaseline: { top1InAcceptable: Number((ruleHits / labels.length).toFixed(4)), cases: labels.length },
  byCaptureKind: labels.reduce((acc, label) => {
    const entry = acc[label.captureKind] ?? { cases: 0, allAcceptable: 0, ruleOk: 0 };
    entry.cases += 1;
    entry.allAcceptable += label.allAcceptable ? 1 : 0;
    entry.ruleOk += label.rulePickAcceptable ? 1 : 0;
    acc[label.captureKind] = entry;
    return acc;
  }, {}),
  horizonMinutes: horizon,
  sliceMinutes: slice,
  requireDischarge,
  focalIdle,
  labelRule: LABEL_RULE,
  rendererIdentity: rows[0].rendered.rendererId,
  controller: reference.identity,
  wallSeconds: (Date.now() - started) / 1000,
  casesSha256: sha(readFileSync(casesPath, 'utf8')),
  labelsSha256: sha(labels.map(label => JSON.stringify(label)).join('\n')),
  note: 'Acceptable sets come only from terminal rollouts under one fixed controller; no non-wait rule is applied.',
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
