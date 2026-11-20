#!/usr/bin/env node
/**
 * R11 C line: same-snapshot branch rollouts on ONE absolute deadline.
 *
 *   node research/decision-choice/r11/label-deadline-branches.mjs \
 *     --cases <capture/cases.jsonl> --out <newDir> --horizon 240 --slice 30
 *
 * For every captured case the deadline is pre-registered BEFORE any rollout:
 *   t* = the focal believed commitment's deadline, when it is in the future
 *        (basis ``commitment-due``); otherwise t0 + the frozen horizon
 *        (basis ``frozen-default``).
 *
 * Each candidate starts from a byte-identical copy of the same snapshot, is
 * forced through the same entry the live loop uses, then the SAME fixed
 * reference controller runs every living actor until the SAME absolute t*.
 * A slow action whose due time is after t* stays pending: the clock is never
 * extended to make a label nicer.
 *
 * Recorded per branch: first-action admission/status, obligation status at the
 * deadline, authorisation withdrawals and rejections, resource net change,
 * person-minutes, receipts, exogenous crisis events, terminal tasks/work log.
 *
 * Two labels are computed from those facts, never from a preference:
 *   base         first action applied && actor alive && no population loss
 *                && no accepted task lost                      (R10 base)
 *   fulfillment  the believed obligation is fulfilled with a receipt by its
 *                deadline, or the actor heard an authorised exit; actor alive;
 *                no unauthorised side effect; nothing open past the deadline.
 *                Undefined (excluded) when the state carries no obligation.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const load = path => require(resolve(root, 'dist', path));

const { R8Runtime } = load('src/r7/integration/runtime.js');
const { runStep, executeCandidate, notesFor, durationOf } = load('src/r7/integration/step.js');
const { referenceAgencyScorer } = load('src/r7/agency/reference.js');
const { taskBindingOfCandidate } = load('src/r7/agency/options.js');
const { GameplayLoop } = load('src/gameplay-v2/loop.js');
const { createCommitmentBridge } = load('src/r7/integration/commitment-bridge.js');

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
const horizon = Number(option('--horizon', '240'));
const allowClockDefect = args.includes('--allow-known-clock-defect');
const slice = Number(option('--slice', '30'));
if (!Number.isInteger(horizon) || horizon < 1) throw new Error('--horizon must be a positive integer');
if (!Number.isInteger(slice) || slice < 1) throw new Error('--slice must be a positive integer');
const outDir = resolve(out);
if (existsSync(outDir)) throw new Error(`${outDir} exists; labels are a new directory`);
mkdirSync(join(outDir, 'branches'), { recursive: true });

const MOUNT = { memorySelection: 'obligation-first',
  memoryPolicy: 'conditional-experience', memoryTokenBudget: 640 };
const reference = referenceAgencyScorer();
const controller = { identity: reference.identity, score: request => reference.score(request) };
const rows = readFileSync(casesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

/* ------------------------- pre-register the deadline ------------------------ */
const deadlines = [];
for (const row of rows) {
  const t0 = row.simTime;
  const goals = (row.request.goals ?? []).filter(goal => goal?.source === 'legacy-commitment');
  const owes = goals.filter(goal => !['cancelled', 'withdrawn', 'fulfilled', 'declined', 'expired']
    .includes(goal.status));
  const ranked = [...owes].sort((left, right) => {
    const a = Number.isFinite(left.deadline) ? left.deadline : Number.POSITIVE_INFINITY;
    const b = Number.isFinite(right.deadline) ? right.deadline : Number.POSITIVE_INFINITY;
    return a - b || String(left.commitmentId).localeCompare(String(right.commitmentId));
  });
  const focal = ranked[0] ?? null;
  const useCommitmentDeadline = focal && Number.isFinite(focal.deadline) && focal.deadline > t0;
  const tStar = useCommitmentDeadline ? focal.deadline : t0 + horizon;
  deadlines.push({
    caseId: row.caseId, sourceEpisodeId: row.sourceEpisodeId, actorId: row.actorId,
    t0, tStar, basis: useCommitmentDeadline ? 'commitment-due' : 'frozen-default',
    horizonMinutes: horizon, sliceMinutes: slice,
    obligation: focal ? { present: true, commitmentId: focal.commitmentId,
      taskId: focal.legacyTaskId ?? focal.taskId ?? null, revision: focal.revision,
      deadline: focal.deadline ?? null, believedStatus: focal.status ?? 'active',
      believedReady: focal.ready ?? null } : { present: false },
    allGoals: goals.map(goal => ({ commitmentId: goal.commitmentId, taskId: goal.legacyTaskId,
      status: goal.status, deadline: goal.deadline ?? null })),
    frozenHorizon: Number(row.deadlineHorizonMinutes ?? horizon),
    freezeSha256: row.freezeSha256 ?? null,
  });
}
const deadlinesSha = sha(deadlines.map(row => canonical(row)).join('\n'));
writeFileSync(join(outDir, 'deadlines.jsonl'), `${deadlines.map(row => canonical(row)).join('\n')}\n`);

/* --------------------------------- helpers -------------------------------- */
function taskView(runtime, actorId) {
  return (runtime.states.tasks.tasks ?? [])
    .filter(task => task.assigneeId === actorId || task.actorId === actorId)
    .map(task => ({ taskId: task.taskId, type: task.type, status: task.status }));
}
function aliveCount(runtime) {
  return Object.values(runtime.world.npcs).filter(npc => npc.alive).length;
}
function eventsBetween(runtime, from, to) {
  return runtime.committedEvents().filter(event => event.simTime > from && event.simTime <= to);
}
function resourceDelta(before, after) {
  const delta = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const left = Number(before?.[key] ?? 0);
    const right = Number(after?.[key] ?? 0);
    if (left !== right) delta[key] = right - left;
  }
  return delta;
}
function personMinutes(workLog, t0, tStar) {
  // Planned work intervals, counted once per intent. The current legacy-map
  // runner can re-settle one intent many times; counting settledAt would
  // invent hundreds of person-minutes. Duplicates are reported separately and
  // the whole label file is refused unless the defect is explicitly allowed.
  const seen = new Map();
  for (const entry of workLog) if (!seen.has(entry.intentId)) seen.set(entry.intentId, entry);
  let total = 0;
  for (const entry of seen.values()) {
    const begin = Math.max(entry.startedAt, t0);
    const end = Math.min(entry.endsAt, tStar);
    if (end > begin) total += end - begin;
  }
  return total;
}

/** Restore the runtime state AND the gameplay ledgers on ONE session. */
function restoreBranch(base) {
  const sidecars = ['tasks.json', 'commitments.json', 'council.json',
    'experience.json', 'long-term-memory.json'];
  const runtime = R8Runtime.load(base);
  const loaded = GameplayLoop.load(base);
  const play = new GameplayLoop(runtime.session, loaded.board, {
    memoryArm: loaded.memoryArm, experience: loaded.experience,
    commitments: loaded.commitments, council: loaded.council,
    longTermMemory: loaded.longTermMemory,
    decisionMemoryMode: loaded.decisionMemoryMode,
    decisionMemoryTokenBudget: loaded.decisionMemoryTokenBudget,
  });
  return { runtime, play, sidecars };
}

async function rollout(runtime) {
  let slices = 0;
  while (runtime.world.simTime < tStar && !runtime.ended) {
    for (const actorId of runtime.context().actorIds) {
      if (!runtime.world.npcs[actorId]?.alive) continue;
      if (runtime.busyUntil(actorId) !== null) continue;
      await runStep(runtime, controller, {
        actorIds: [actorId], mode: 'reference', ...MOUNT,
        notes: id => notesFor(runtime, id, MOUNT.memoryPolicy),
      });
      if (runtime.ended) break;
    }
    const before = runtime.world.simTime;
    const to = Math.min(before + slice, tStar);
    runtime.advanceWorld(to);
    if (runtime.world.simTime === before) break;
    slices += 1;
  }
  return slices;
}

const started = Date.now();
let tStar = 0;
const labels = [];
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];
  const registration = deadlines[index];
  tStar = registration.tStar;
  if (registration.frozenHorizon !== horizon) {
    throw new Error(`${row.caseId} was captured with horizon ${registration.frozenHorizon}, `
      + `but labels are produced with ${horizon}`);
  }
  const branchDir = join(outDir, 'branches', row.caseId);
  mkdirSync(branchDir, { recursive: true });
  const snapshotBase = join(dirname(resolve(casesPath)), 'snapshots', row.caseId);
  const source = existsSync(`${row.snapshotBase}.r8.json`) ? row.snapshotBase : snapshotBase;
  if (!existsSync(`${source}.r8.json`)) throw new Error(`snapshot missing for ${row.caseId}`);
  copyFileSync(source, join(branchDir, 'state'));
  copyFileSync(`${source}.r8.json`, join(branchDir, 'state.r8.json'));
  for (const sidecar of ['tasks.json', 'commitments.json', 'council.json',
    'experience.json', 'long-term-memory.json']) {
    if (existsSync(`${source}.${sidecar}`)) {
      copyFileSync(`${source}.${sidecar}`, join(branchDir, `state.${sidecar}`));
    } else if (row.activeCommitments?.length) {
      throw new Error(`${row.caseId} has active commitments but no ${sidecar}; `
        + 'the snapshot would silently lose its ledger');
    }
  }

  const branches = [];
  const clockIssues = [];
  for (let candidateIndex = 0; candidateIndex < row.request.candidates.length; candidateIndex += 1) {
    const candidate = row.request.candidates[candidateIndex];
    const restored = restoreBranch(join(branchDir, 'state'));
    const { runtime, play } = restored;
    createCommitmentBridge(runtime, play);
    const t0 = runtime.world.simTime;
    const branchPoint = runtime.snapshot();
    const tasksAtBranch = taskView(runtime, row.actorId);
    const acceptedAtBranch = tasksAtBranch.filter(task => task.status === 'accepted');
    const aliveAtBranch = aliveCount(runtime);
    const resourcesBefore = { ...runtime.world.resources };
    const workLogBefore = runtime.workLog.length;
    const rejectionsBefore = runtime.rejections.length;
    const crisisBefore = (runtime.states.crises?.history ?? []).length;
    const minutes = durationOf(candidate);
    const intentId = `force-${row.caseId}-${candidateIndex}`;
    const commandId = `${row.actorId}-force-${candidateIndex}`;
    let first;
    let settledEntry = null;
    if (minutes > 0) {
      const binding = taskBindingOfCandidate(candidate);
      const begun = runtime.beginIntent({
        intentId, commandId, actorId: row.actorId, candidate, minutes,
        inputSha256: row.inputSha256,
        taskId: binding?.taskId ?? candidate.parameters.legacyTaskId ?? null,
        taskType: binding?.type ?? null,
        commitmentId: candidate.parameters.commitmentId ?? null,
        commitmentRevision: candidate.parameters.commitmentRevision ?? null,
      });
      if ('rejected' in begun) {
        first = { admitted: false, status: 'refused-before-start', refusal: begun.rejected,
          minutes, startedAt: null, dueAt: null };
      } else {
        const dueAt = begun.intent.dueAt;
        runtime.advanceWorld(Math.min(dueAt, tStar));
        settledEntry = runtime.workLog.slice(workLogBefore)
          .filter(entry => entry.intentId === intentId)[0] ?? null;
        const stillActive = runtime.activeIntent(row.actorId)?.intentId === intentId;
        first = { admitted: true, status: stillActive ? 'pending' : (settledEntry?.status ?? 'unknown'),
          refusal: settledEntry?.failureReason ?? null, minutes,
          startedAt: begun.intent.startedAt, dueAt, intentId,
          eventIds: settledEntry?.eventIds ?? [] };
      }
    } else {
      const outcome = executeCandidate(runtime, row.actorId, candidate, commandId);
      first = { admitted: outcome.status !== 'rejected',
        status: outcome.status, refusal: outcome.status === 'rejected' ? outcome.reason : null,
        minutes, startedAt: t0, dueAt: t0, eventIds: outcome.eventIds };
    }
    const slicesRun = await rollout(runtime);
    const branchWorkLog = runtime.workLog.slice(workLogBefore);
    const intentIds = branchWorkLog.map(entry => entry.intentId);
    const clockIntegrity = {
      duplicateSettlements: intentIds.length - new Set(intentIds).size,
      clockOverrunMinutes: runtime.world.simTime - tStar,
      clockAtDeadline: runtime.world.simTime,
    };

    const terminal = runtime.snapshot();
    const tasksAtHorizon = taskView(runtime, row.actorId);
    const NEGATIVE = new Set(['cancelled', 'proposed', 'rejected', 'failed', 'expired']);
    const acceptedLost = acceptedAtBranch.filter(before => {
      const after = tasksAtHorizon.find(task => task.taskId === before.taskId);
      return !after || NEGATIVE.has(after.status);
    });
    const alive = aliveCount(runtime);
    const actorAlive = Boolean(terminal.npcs[row.actorId]?.alive);
    const resourcesAfter = { ...runtime.world.resources };
    const events = eventsBetween(runtime, t0, tStar);
    const firstEventIds = new Set(first.eventIds ?? []);
    const receiptCounts = {};
    for (const event of events) {
      const key = `${event.type}${firstEventIds.has(event.eventId) ? '@first-action' : ''}`;
      receiptCounts[key] = (receiptCounts[key] ?? 0) + 1;
    }
    const rejections = runtime.rejections.slice(rejectionsBefore);
    const authorizationRejections = rejections.filter(entry =>
      /commitment|authoriz|cancel|not_open|task_not_open/i.test(String(entry.reason ?? '')));

    // Obligation facts come from the real ledger, not from the label rule.
    const obligationRegistration = registration.obligation;
    let obligation = { present: Boolean(obligationRegistration.present), kind: null,
      statusAtDeadline: null, completedAt: null, receiptTypes: [],
      cancelledAt: null, worldStatus: null };
    let authorisedExit = false;
    if (obligationRegistration.present) {
      const commitment = play.commitments.find(obligationRegistration.commitmentId);
      const task = obligationRegistration.taskId ? play.board.find(obligationRegistration.taskId) : null;
      obligation = {
        present: true,
        kind: task?.kind ?? commitment?.goal ?? null,
        worldStatus: commitment?.status ?? null,
        statusAtDeadline: commitment?.status ?? null,
        completedAt: commitment?.status === 'fulfilled'
          ? commitment?.updatedAt ?? null : null,
        completionBasis: 'commitment.updatedAt at the fulfilled transition',
        receiptTypes: (commitment?.evidenceEventIds ?? []).map(id =>
          runtime.committedEvent(id)?.type ?? 'unknown'),
        lastTransitionAt: commitment?.updatedAt ?? null,
        evidenceEventIds: commitment?.evidenceEventIds ?? [],
        deadline: obligationRegistration.deadline,
        believedStatus: obligationRegistration.believedStatus,
        taskStatus: task?.status ?? null,
      };
      if (['cancelled', 'withdrawn'].includes(commitment?.status)
          && !['cancelled', 'withdrawn'].includes(obligationRegistration.believedStatus)) {
        // The world ended the promise while the actor's own record still owes it.
        obligation.unheardExit = true;
      }
      authorisedExit = ['cancelled', 'withdrawn'].includes(commitment?.status)
        && ['cancelled', 'withdrawn'].includes(obligationRegistration.believedStatus);
    }
    const deadlinePassed = runtime.world.simTime >= tStar;
    const pastDeadline = obligation.present && ['active', 'suspended', 'pending-change']
      .includes(obligation.statusAtDeadline) && deadlinePassed;
    const fulfilledInTime = obligation.present && obligation.statusAtDeadline === 'fulfilled'
      && (obligation.completedAt === null || Number(obligation.completedAt) <= registration.tStar);
    const baseAcceptable = first.status === 'applied' && actorAlive && alive >= aliveAtBranch
      && acceptedLost.length === 0;
    const fulfillmentAcceptable = obligation.present
      && (fulfilledInTime || authorisedExit)
      && actorAlive && authorizationRejections.length === 0 && !pastDeadline;
    const pending = first.status === 'pending';
    const receipts = Object.entries(receiptCounts).map(([type, count]) => ({ type, count }));
    const crisisAfter = (runtime.states.crises?.history ?? []).slice(crisisBefore)
      .map(entry => ({ kind: entry.kind, startedAtMinute: entry.startedAtMinute,
        resolvedAtMinute: entry.resolvedAtMinute, subjectIds: entry.subjectIds }));
    if (clockIntegrity.duplicateSettlements > 0 || clockIntegrity.clockOverrunMinutes > 0
        || clockIntegrity.clockAtDeadline > tStar) {
      clockIssues.push({ candidateIndex, candidateId: candidate.id, ...clockIntegrity });
    }
    branches.push({
      candidateIndex, candidateId: candidate.id,
      action: candidate.parameters.action, parameters: candidate.parameters,
      firstAction: first, rollout: { slices: slicesRun, advanced: runtime.world.simTime - t0 },
      clockIntegrity,
      obligation, authorisedExit, pending, deadlinePassed, pastDeadline,
      authorization: { withdrawn: authorizationRejections.length > 0,
        unauthorizedSideEffects: authorizationRejections.length,
        rejections: rejections.map(entry => ({ reason: entry.reason, at: entry.at })) },
      resources: { before: resourcesBefore, after: resourcesAfter,
        delta: resourceDelta(resourcesBefore, resourcesAfter) },
      personMinutes: personMinutes(runtime.workLog, t0, tStar)
        + (pending ? Math.max(0, tStar - (first.startedAt ?? tStar)) : 0),
      receipts, crisis: crisisAfter,
      terminal: { simTime: runtime.world.simTime, day: terminal.day,
        minuteOfDay: terminal.minuteOfDay, ended: runtime.ended,
        endingKind: runtime.endingKind, alive, actorAlive,
        tasks: tasksAtHorizon, resources: terminal.resources,
        actorFacts: { location: terminal.npcs[row.actorId]?.location,
          hunger: terminal.npcs[row.actorId]?.hunger,
          stamina: terminal.npcs[row.actorId]?.stamina,
          health: terminal.npcs[row.actorId]?.health,
          bodyTemp: terminal.npcs[row.actorId]?.bodyTemp } },
      acceptedTaskLost: acceptedLost,
      baseAcceptable,
      fulfillmentAcceptable,
      fulfillmentDefined: obligation.present,
    });
  }
  const acceptableBase = branches.filter(branch => branch.baseAcceptable).map(branch => branch.candidateId);
  const acceptableFulfillment = branches.filter(branch => branch.fulfillmentAcceptable)
    .map(branch => branch.candidateId);
  const defined = branches.filter(branch => branch.fulfillmentDefined);
  labels.push({
    caseId: row.caseId, sourceEpisodeId: row.sourceEpisodeId, story: row.story,
    actorId: row.actorId, candidates: row.request.candidates.length,
    t0: registration.t0, tStar: registration.tStar, deadlineBasis: registration.basis,
    horizonMinutes: horizon, sliceMinutes: slice,
    continuationPolicy: reference.identity.scorerId,
    obligation: registration.obligation,
    acceptableIds: acceptableBase,
    acceptableFulfillmentIds: acceptableFulfillment,
    fulfillmentDefined: defined.length > 0,
    allBase: acceptableBase.length === row.request.candidates.length,
    noneBase: acceptableBase.length === 0,
    allFulfillment: defined.length > 0 && acceptableFulfillment.length === defined.length,
    noneFulfillment: defined.length > 0 && acceptableFulfillment.length === 0,
    labelRuleBase: 'first-action-applied && actor-alive && no-population-loss && no-accepted-task-lost',
    labelRuleFulfillment: 'believed-obligation-fulfilled-by-deadline-or-authorised-exit && actor-alive '
      + '&& no-unauthorized-side-effect && no-obligation-open-past-deadline',
    labelSource: 'same-snapshot-branch-rollout',
    rulePick: reference.score(row.request).selectedId,
    clockIntegrity: { ok: clockIssues.length === 0, issues: clockIssues },
    branches,
  });
  console.log(canonical({ caseId: row.caseId, deadline: registration.tStar,
    basis: registration.basis, base: acceptableBase.length,
    fulfillment: acceptableFulfillment.length, defined: defined.length }));
}
const integrityIssues = labels.filter(label => !label.clockIntegrity.ok);
const integrityReport = {
  schema: 'frostecho.r11c.clock-integrity/1',
  ok: integrityIssues.length === 0,
  cases: labels.length,
  failingCases: integrityIssues.length,
  duplicateSettlementCases: integrityIssues.filter(label =>
    label.clockIntegrity.issues.some(issue => issue.duplicateSettlements > 0)).length,
  clockOverrunCases: integrityIssues.filter(label =>
    label.clockIntegrity.issues.some(issue => issue.clockOverrunMinutes > 0)).length,
  allowedByOperator: allowClockDefect,
  detail: 'A branch that settles one intent more than once, or moves the clock past the '
    + 'absolute deadline, is not a same-deadline counterfactual. Labels stay unwritten '
    + 'until the shared runner has one clock and one settlement.',
  examples: integrityIssues.slice(0, 5).map(label => ({ caseId: label.caseId,
    issues: label.clockIntegrity.issues.slice(0, 3) })),
};
writeFileSync(join(outDir, 'clock-integrity.json'), `${JSON.stringify(integrityReport, null, 2)}\n`);
if (!integrityReport.ok && !allowClockDefect) {
  console.log(JSON.stringify({ ok: false, refused: true, code: 'clock-reentry',
    ...integrityReport }, null, 2));
  process.exit(2);
}
writeFileSync(join(outDir, 'labels.jsonl'), `${labels.map(label => canonical(label)).join('\n')}\n`);
const discriminativeBase = labels.filter(label => !label.allBase && !label.noneBase).length;
const definedLabels = labels.filter(label => label.fulfillmentDefined);
const discriminativeFulfillment = definedLabels
  .filter(label => !label.allFulfillment && !label.noneFulfillment).length;
const summary = {
  schema: 'frostecho.r11c.deadline-labels/1',
  cases: labels.length,
  totalBranches: labels.reduce((sum, label) => sum + label.candidates, 0),
  horizonMinutes: horizon, sliceMinutes: slice,
  deadlineBasis: labels.reduce((acc, label) => ({
    ...acc, [label.deadlineBasis]: (acc[label.deadlineBasis] ?? 0) + 1 }), {}),
  base: {
    allAcceptableCases: labels.filter(label => label.allBase).length,
    noneAcceptableCases: labels.filter(label => label.noneBase).length,
    discriminativeCases: discriminativeBase,
    meanAcceptablePerCase: Number((labels.reduce((sum, label) =>
      sum + label.acceptableIds.length, 0) / labels.length).toFixed(4)),
    rulePickAcceptable: labels.filter(label =>
      label.acceptableIds.includes(label.rulePick)).length,
  },
  fulfillment: {
    definedCases: definedLabels.length,
    allAcceptableCases: definedLabels.filter(label => label.allFulfillment).length,
    noneAcceptableCases: definedLabels.filter(label => label.noneFulfillment).length,
    discriminativeCases: discriminativeFulfillment,
    meanAcceptablePerCase: definedLabels.length ? Number((definedLabels.reduce((sum, label) =>
      sum + label.acceptableFulfillmentIds.length, 0) / definedLabels.length).toFixed(4)) : null,
    emptySetCases: definedLabels.filter(label => label.acceptableFulfillmentIds.length === 0).length,
    rulePickAcceptable: definedLabels.filter(label =>
      label.acceptableFulfillmentIds.includes(label.rulePick)).length,
  },
  byStory: labels.reduce((acc, label) => {
    const entry = acc[label.story] ?? { cases: 0, baseDiscriminative: 0,
      fulfillmentDefined: 0, fulfillmentDiscriminative: 0, noneFulfillment: 0 };
    entry.cases += 1;
    entry.baseDiscriminative += (!label.allBase && !label.noneBase) ? 1 : 0;
    entry.fulfillmentDefined += label.fulfillmentDefined ? 1 : 0;
    entry.fulfillmentDiscriminative += (label.fulfillmentDefined
      && !label.allFulfillment && !label.noneFulfillment) ? 1 : 0;
    entry.noneFulfillment += (label.fulfillmentDefined && label.noneFulfillment) ? 1 : 0;
    acc[label.story] = entry;
    return acc;
  }, {}),
  casesSha256: sha(readFileSync(casesPath, 'utf8')),
  labelsSha256: sha(labels.map(label => canonical(label)).join('\n')),
  deadlinesSha256: deadlinesSha,
  rendererSourceSha256: rows[0]?.rendererSourceSha256 ?? null,
  freezeSha256: rows[0]?.freezeSha256 ?? null,
  clockIntegrity: { ok: integrityReport.ok, failingCases: integrityIssues.length,
    allowedByOperator: allowClockDefect },
  labelsTrustworthy: integrityReport.ok,
  controller: reference.identity,
  note: 'All branches share one snapshot, one fixed controller and one absolute deadline; '
    + 'pending slow actions are recorded as pending, never extended.',
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
