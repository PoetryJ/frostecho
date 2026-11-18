/**
 * D (R10) four-day CPU reference run on the SAME authority, candidate layer,
 * reference scorer and clock as `scripts/r8/playthrough.ts`.
 *
 * Why a second driver exists (and what it does NOT change):
 *   - it does not re-implement any rule: the world is `R8Runtime`, time is
 *     `advanceWorld`, decisions are `runStep` + `referenceAgencyScorer`, memory
 *     notes are `notesFor` from the R8 runner, and the task board is
 *     `planAssignments` (original `task-generator.js` policy);
 *   - it fixes two DRIVER defects the canonical runner has, both of which are
 *     about walking, not about rules:
 *       1. the night walk home only resolved `from` for an actor with a building
 *          door; an actor standing in the open village was silently left outside
 *          all night (this is what killed the four promisors at D2 01:00);
 *       2. a hypothermic crisis was answered by the legacy teleport rescue; here
 *          the rescuer really walks (a queued 15-minute `move`), the reach stage
 *          requires the same room, and both bodies then walk to `medical`
 *          (real `travel` legs) before the escort closes.
 *
 * Evidence written to --out: trajectory.jsonl (every scored decision), summary.json
 * (endings, settlement reconciliation, the resource/heating clock), intents.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { createCommitmentBridge } from '../../src/r7/integration/commitment-bridge';
import { GOSPEL_PROFILE, type TimeProfile } from '../../src/r7/contracts';
import type { Candidate, ChoiceRequest, ChoiceResult } from '../../src/decision/contracts';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import type { MemoryPolicyId } from '../../src/r7/agency/options';
import { runStep } from '../../src/r7/integration/step';
import { councilShouldOpen, planAssignments, type AssignmentView } from '../../src/r7/domains/council/index';
import { TASK_CATALOG, type TaskTypeId } from '../../src/r7/domains/tasks/index';
import { heatingStrength } from '../../src/r7/domains/production/index';
import { heatingOf } from '../../src/r7/domains/survival/index';
import { BUILDINGS, MAPS, findPath, type Cell } from '../../src/spatial-v2/map';
import { notesFor } from '../r8/playthrough';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Args { seed: string; out: string; npc: number; food: number;
  memoryPolicy: MemoryPolicyId; memorySelection: 'raw-last12' | 'obligation-first';
  commitments: boolean; profile: TimeProfile }

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const out = get('--out');
  if (!out) throw new Error('--out <dir> is required');
  return {
    seed: get('--seed') ?? 'r10-d', out: resolve(out), npc: Number(get('--npc') ?? 8),
    food: Number(get('--food') ?? 130),
    memoryPolicy: (get('--memory-policy') ?? 'conditional-experience') as MemoryPolicyId,
    memorySelection: (get('--memory-selection') ?? 'obligation-first') as
      'raw-last12' | 'obligation-first',
    commitments: !argv.includes('--no-commitments'),
    profile: GOSPEL_PROFILE,
  };
}

interface DecisionRow {
  at: number; day: number; minuteOfDay: number; actorId: string; requestId: string;
  candidateSetHash: string; inputSha256: string | null; rules: string[];
  selectedId: string | null; selectedKind: string | null;
  selectedParameters: Record<string, unknown> | null;
  observations: number; executionStatus: string; reason: string; actorLocation: string;
  worldVersion: number;
}

interface ClockRow {
  at: number; day: number; minuteOfDay: number; firewood: number; power: number;
  food: number; furnaceFuel: number; furnaceLit: boolean; heatingStrength: number;
  heatingBand: string; alive: number; dead: string[];
  locations: Record<string, string>;
}

const OUT_OF_PLACE = ['village', 'warehouse', 'kitchen', 'workshop', 'medical', 'dorm-a', 'dorm-b',
  'command'];

/** `world-v2 positionOf` fallback: an actor in the open stands at the village centre. */
function positionOf(runtime: R8Runtime, actorId: string): Cell {
  const position = runtime.world.spatial?.positions[actorId];
  if (position) return { x: position.x, y: position.y };
  const location = runtime.world.npcs[actorId]?.location;
  const building = BUILDINGS.find(entry => entry.id === location);
  return building ? { ...building.door } : { x: 25, y: 8 };
}

/**
 * Walk an actor to a building along the real map. Returns the minutes spent or
 * null when no route exists (the actor stays put; the cold is charged honestly).
 */
function walkToBuilding(runtime: R8Runtime, actorId: string, buildingId: string,
  tag: string): { minutes: number; tiles: number } | null {
  const building = BUILDINGS.find(entry => entry.id === buildingId);
  if (!building) return null;
  const from = positionOf(runtime, actorId);
  const closed = new Set(runtime.world.spatial?.closedCells ?? []);
  const route = findPath(MAPS.village, from, building.door, closed).path;
  if (!route || route.length === 0) return null;
  const commandId = `d-walk-${tag}-${actorId}-${runtime.world.simTime}`;
  const submitted = runtime.session.submitWorldCommand({ commandId, type: 'travel',
    actorId, route, minutesPerTile: 2 });
  if (submitted.status !== 'applied') return null;
  runtime.recordCommitted(submitted.events);
  const event = submitted.events.find(entry => entry.type === 'traveled');
  const payload = (event?.payload ?? {}) as { minutes?: number; tiles?: number };
  return { minutes: Number(payload.minutes ?? 0), tiles: Number(payload.tiles ?? 0) };
}

/** A queued 15-minute walk between rooms (the candidate layer's own travel cost). */
function queuedMove(runtime: R8Runtime, actorId: string, to: string): string | null {
  const candidate: Candidate = {
    id: `d-move-${to}-${sha256(actorId).slice(0, 6)}`, kind: 'move',
    description: `前往${to}`, parameters: { action: 'move', to, purpose: 'driver-walk' },
    preconditions: ['alive'], expectedEffects: { travelMinutes: 15 }, utilityComponents: {},
  };
  const begun = runtime.beginIntent({ intentId: `d-move-${actorId}-${runtime.world.simTime}`,
    commandId: `d-move-${actorId}-${runtime.world.simTime}`, actorId, candidate, minutes: 15 });
  if ('rejected' in begun) return begun.rejected;
  runtime.advanceWorld(begun.intent.dueAt);
  return null;
}

function runCouncil(runtime: R8Runtime, decisions: DecisionRow[], seed: string): void {
  const snapshot = runtime.snapshot();
  const seeMorning = runtime.states.council.meetings.some(meeting => meeting.reason === 'morning'
    && Math.floor((meeting.openedAtMinute + runtime.profile.startMinuteOfDay)
      / runtime.profile.minutesPerDay) + runtime.profile.startDay === snapshot.day);
  const isMorning = snapshot.minuteOfDay >= 8 * 60 && snapshot.minuteOfDay < 10 * 60
    && !seeMorning;
  const reason = isMorning ? 'morning'
    : councilShouldOpen(snapshot.resources, Number(snapshot.facts.tension ?? 0),
      snapshot.elapsed, (runtime.states.council as { cooldownUntil: number }).cooldownUntil);
  if (!reason) return;
  const opened = runtime.dispatch('council', 'open', 'old_qian',
    { tension: 0, force: isMorning });
  const meetingId = (runtime.states.council as { meetings: { meetingId: string }[] })
    .meetings.at(-1)?.meetingId;
  if (!meetingId || opened.rejected.length > 0) return;

  const view: AssignmentView = {
    day: snapshot.day,
    resources: snapshot.resources,
    furnace: snapshot.furnace,
    machines: snapshot.machines as Record<string, string>,
    npcs: Object.fromEntries(Object.entries(snapshot.npcs).map(([id, npc]) => [id, {
      id, alive: npc.alive, stamina: npc.stamina, health: npc.health,
      hunger: npc.hunger, san: npc.san, location: npc.location,
    }])),
  };
  const plan = planAssignments(view, 4);
  if (plan.length === 0) return;
  runtime.dispatch('council', 'propose', 'old_qian', { meetingId,
    assignments: plan.map(entry => ({ actorId: entry.actorId, type: entry.type })),
    rationale: plan.map(entry => `${entry.actorId}:${entry.type} (${entry.reason})`).join('; ') });
  const proposalId = (runtime.states.council as
    { meetings: { proposals: { proposalId: string }[] }[] }).meetings.at(-1)!.proposals[0].proposalId;
  for (const actorId of runtime.context().actorIds) {
    runtime.dispatch('council', 'vote', actorId, { meetingId, proposalId });
  }
  runtime.dispatch('council', 'resolve', 'old_qian', { meetingId });
  for (const assignment of plan) {
    const proposed = runtime.dispatch('tasks', 'propose', 'old_qian',
      { type: assignment.type, assigneeId: assignment.actorId });
    const taskId = (runtime.states.tasks as { tasks: { taskId: string }[] }).tasks.at(-1)?.taskId;
    if (!taskId || proposed.rejected.length > 0) continue;
    const npc = runtime.snapshot().npcs[assignment.actorId];
    const verdict = !npc?.alive ? 'decline'
      : npc.stamina < 20 && assignment.type !== 'REST_RECOVER' ? 'counter'
        : npc.health < 40 && assignment.type !== 'PREPARE_MEDICAL' ? 'decline' : 'accept';
    runtime.dispatch('tasks', 'respond', assignment.actorId, { taskId, verdict,
      reason: verdict === 'accept' ? '可以接下' : `自身状态不适合 ${assignment.type}`,
      counterType: 'REST_RECOVER' });
    if (verdict !== 'accept') {
      const spare = runtime.context().actorIds.find(id => id !== assignment.actorId
        && runtime.snapshot().npcs[id]?.alive
        && runtime.snapshot().npcs[id].stamina >= 30);
      if (spare) runtime.dispatch('tasks', 'reassign', 'old_qian', { taskId, assigneeId: spare });
    }
    decisions.push(councilRow(runtime, seed, assignment.actorId, assignment.type, verdict));
  }
}

function councilRow(runtime: R8Runtime, seed: string, actorId: string, type: TaskTypeId,
  verdict: string): DecisionRow {
  const snapshot = runtime.snapshot();
  return {
    at: runtime.world.simTime, day: snapshot.day, minuteOfDay: snapshot.minuteOfDay,
    actorId, requestId: `${seed}:council:${type}:${actorId}`,
    candidateSetHash: sha256(`${type}|${actorId}|${verdict}`),
    inputSha256: sha256(JSON.stringify({ type, actorId, verdict })),
    rules: [`council.assignment:${type}`, `council.${verdict}`],
    selectedId: `task:${type}`, selectedKind: 'task',
    selectedParameters: { action: 'task', type },
    observations: 1, executionStatus: 'applied', reason: `council ${verdict}`,
    actorLocation: snapshot.npcs[actorId]?.location ?? 'unknown',
    worldVersion: runtime.world.version,
  };
}

/** The routed rescue: reach (same room) -> walk both to medical -> escort. */
function driveRescue(runtime: R8Runtime, rescuerId: string, victimId: string): string[] {
  const notes: string[] = [];
  const reach = runtime.dispatch('crises', 'rescue', rescuerId, { victimId, stage: 'reach' });
  if (reach.rejected.length > 0) {
    notes.push(`reach refused: ${reach.rejected[0].code} ${reach.rejected[0].reason}`);
    return notes;
  }
  notes.push('reach applied');
  const victim = runtime.world.npcs[victimId];
  const rescuer = runtime.world.npcs[rescuerId];
  if (victim.location !== 'medical') {
    if (victim.location === 'village') {
      walkToBuilding(runtime, victimId, 'medical', 'escort-victim');
    } else {
      queuedMove(runtime, victimId, 'medical');
    }
  }
  if (rescuer.location !== 'medical') {
    if (rescuer.location === 'village') {
      walkToBuilding(runtime, rescuerId, 'medical', 'escort-rescuer');
    } else {
      queuedMove(runtime, rescuerId, 'medical');
    }
  }
  const escort = runtime.dispatch('crises', 'rescue', rescuerId, { victimId, stage: 'escort' });
  notes.push(escort.rejected.length > 0
    ? `escort refused: ${escort.rejected[0].code} ${escort.rejected[0].reason}`
    : 'escort applied');
  return notes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  let runtime = R8Runtime.create({ seed: args.seed, npcCount: args.npc,
    resources: { food: args.food } });
  const play = new GameplayLoop(runtime.session);
  const bridge = createCommitmentBridge(runtime, play);
  const decisions: DecisionRow[] = [];
  const clock: ClockRow[] = [];
  const rescues: { at: number; victimId: string; rescuerId: string; notes: string[] }[] = [];
  const walks: { at: number; actorId: string; building: string; minutes: number; tiles: number }[] = [];
  const stranded: { at: number; actorId: string; location: string }[] = [];
  /**
   * The CPU reference arm plus ONE explicit survival veto: on a lethal outdoor
   * day (`outdoorTemperature(4, ...)` = -60, band damage ~3 health/minute) the
   * arm never walks out or gathers. `reference-rule/1` itself is untouched (it
   * is H's frozen comparison baseline); this wrapper only refuses a choice that
   * the weather makes suicidal, and records every refusal in the summary.
   */
  const base = referenceAgencyScorer();
  const vetoes: { at: number; actorId: string; candidate: string; reason: string }[] = [];
  const scorer = {
    identity: { ...base.identity, scorerId: `${base.identity.scorerId}+d-weather-veto/1` },
    score(request: ChoiceRequest): ChoiceResult {
      const result = base.score(request) as ChoiceResult;
      const day = Number((request.observation as { day?: number })?.day ?? 1);
      if (day < 4) return result;
      const chosen = request.candidates.find(entry => entry.id === result.selectedId);
      const action = String(chosen?.parameters.action ?? '');
      const to = String(chosen?.parameters.to ?? '');
      const outdoor = action === 'gather' || (action === 'move' && to === 'village');
      if (!outdoor) return result;
      const dayMinute = Number((request.observation as { minuteOfDay?: number })?.minuteOfDay ?? 0);
      vetoes.push({ at: dayMinute, actorId: request.actorId, candidate: String(result.selectedId),
        reason: `day-${day} outdoor is lethal (-60 C); choice refused` });
      const safe = request.candidates.filter(entry => {
        const act = String(entry.parameters.action ?? '');
        const dest = String(entry.parameters.to ?? '');
        return act !== 'gather' && !(act === 'move' && dest === 'village');
      });
      const fallback = safe.find(entry => entry.parameters.action !== 'wait') ?? safe[0];
      if (!fallback) return result;
      return { ...result, selectedId: fallback.id,
        reason: `${result.reason}; d-weather-veto -> ${String(fallback.parameters.action)}` };
    },
  };
  const summary: Record<string, unknown> = {
    schema: 'frostecho.r10.d-fourday/1', seed: args.seed, profile: args.profile.id,
    sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
    node: process.version, startedAt: new Date().toISOString(),
    mode: 'reference', memoryPolicy: args.memoryPolicy, memorySelection: args.memorySelection,
  };

  if (args.commitments) {
    const promises = ['npc_01', 'npc_02', 'npc_03', 'npc_04'].map((actorId, index) =>
      play.requestCommitment(actorId, index < 2 ? 'deliver-meal' : 'supply-warehouse',
        { verdict: 'accept' }));
    summary.commitments = promises.map(entry => ({ commitmentId: entry.commitment.commitmentId,
      goal: entry.commitment.goal, promisorId: entry.commitment.promisorId,
      taskId: entry.task?.taskId ?? null }));
  }

  const recordClock = (): void => {
    const snapshot = runtime.snapshot();
    const heating = heatingOf(snapshot);
    clock.push({ at: runtime.world.simTime, day: snapshot.day,
      minuteOfDay: snapshot.minuteOfDay, firewood: snapshot.resources.firewood,
      power: snapshot.resources.power, food: snapshot.resources.food,
      furnaceFuel: snapshot.furnace.fuel, furnaceLit: snapshot.furnace.lit,
      heatingStrength: heating.strength,
      heatingBand: heating.strength >= 0.75 ? 'hot' : heating.strength >= 0.45 ? 'warm'
        : heating.strength >= 0.12 ? 'cold' : 'none',
      alive: Object.values(snapshot.npcs).filter(npc => npc.alive).length,
      dead: [...runtime.world.dead].sort(),
      locations: Object.fromEntries(Object.entries(snapshot.npcs)
        .map(([id, npc]) => [id, npc.location])) });
  };
  recordClock();

  let interfered = false;
  let guard = 0;
  while (!runtime.ended && guard < 1400) {
    guard += 1;
    // `event-system.js:405-441`: the day-4 broadcast says the outdoors is lethal.
    // A task handed out on day 3 would still walk its assignee to the lumber
    // camp at -60 C, so the board withdraws outdoor tasks when the lethal day
    // starts (one recorded cancellation per task, no silent drop).
    if (runtime.snapshot().day >= 4) {
      const outdoor = new Set(['COLLECT_WOOD', 'COLLECT_FOOD', 'COLLECT_MATERIAL', 'SCOUT_RUINS']);
      for (const task of (runtime.states.tasks as
        { tasks: { taskId: string; type: string; status: string }[] }).tasks) {
        if (!outdoor.has(task.type)) continue;
        if (task.status !== 'accepted' && task.status !== 'proposed') continue;
        runtime.dispatch('tasks', 'cancel', 'old_qian', { taskId: task.taskId });
      }
    }
    runCouncil(runtime, decisions, args.seed);
    if (!interfered && runtime.snapshot().day >= 2) {
      interfered = true;
      const rows = play.commitments.all().filter(row => row.status === 'active');
      if (rows[0]) {
        const cancelled = play.cancelCommitment(rows[0].commitmentId,
          { heardBy: ['npc_02'], reason: '玩家改主意' });
        summary.interference = { kind: 'private-cancel', commitmentId: rows[0].commitmentId,
          heardBy: ['npc_02'], status: cancelled.commitment.status, at: runtime.world.simTime };
      }
      if (rows[1]) {
        const proposed = play.commitments.proposeChange(rows[1].commitmentId, {
          kind: 'alt-source', reason: 'warehouse-empty',
          terms: { source: 'gather', reason: '先采集再交付' },
          at: runtime.world.simTime, evidenceEventIds: [] });
        runtime.session.ingestCommitmentEvent(proposed.event);
        summary.interference2 = { kind: 'change-proposed',
          commitmentId: rows[1].commitmentId, status: proposed.commitment.status,
          at: runtime.world.simTime };
      }
    }
    for (const actorId of runtime.context().actorIds) {
      const npc = runtime.world.npcs[actorId];
      if (!npc?.alive) continue;
      const danger = npc.hunger < 45 || npc.stamina < 35 || (npc.bodyTemp ?? 36.5) < 35.9;
      if (danger) {
        for (const row of play.commitments.all()) {
          if (row.promisorId !== actorId || row.status !== 'active') continue;
          const exited = play.withdrawCommitment(row.commitmentId,
            { reason: 'survival-exit', inputId: `exit-${row.commitmentId}-${runtime.world.simTime}` });
          const exits = (summary.exits ??= []) as Record<string, unknown>[];
          exits.push({ commitmentId: row.commitmentId, actorId, at: runtime.world.simTime,
            status: exited.commitment.status, hunger: Math.round(npc.hunger),
            stamina: Math.round(npc.stamina) });
        }
      }
      const result = await runStep(runtime, scorer, { actorIds: [actorId], mode: 'reference',
        memorySelection: args.memorySelection, memoryPolicy: args.memoryPolicy,
        goalBridge: bridge, notes: id => notesFor(runtime, id, args.memoryPolicy) });
      for (const row of result.records) {
        const selected = row.candidates.find(entry => entry.id === row.selectedId);
        decisions.push({ at: runtime.world.simTime, day: runtime.snapshot().day,
          minuteOfDay: runtime.snapshot().minuteOfDay, actorId: row.actorId,
          requestId: row.requestId, candidateSetHash: row.candidateSetHash,
          inputSha256: row.inputSha256 ?? null, rules: row.rules,
          selectedId: row.selectedId, selectedKind: selected?.kind ?? null,
          selectedParameters: selected?.parameters ?? null,
          observations: row.candidates.length, executionStatus: row.executionStatus,
          reason: row.reason, actorLocation: runtime.world.npcs[actorId]?.location ?? 'unknown',
          worldVersion: row.worldVersion });
      }
      if (runtime.ended) break;
    }
    // --- crisis: one real routed rescue per open rescue crisis -----------------
    for (const event of runtime.journal.slice(-40)) {
      if (event.type !== 'rescue_needed') continue;
      const victimId = String(event.payload.actorId ?? '');
      const open = (runtime.states.crises as { active: { kind: string; subjectIds: string[] }[] })
        .active.some(entry => entry.kind === 'rescue' && entry.subjectIds.includes(victimId));
      if (!open) continue;
      const victim = runtime.world.npcs[victimId];
      if (!victim?.alive) continue;
      const candidates = runtime.context().actorIds.filter(id => id !== victimId
        && runtime.world.npcs[id]?.alive
        && runtime.world.npcs[id].stamina > 30
        && runtime.world.npcs[id].location === victim.location);
      let rescuerId = candidates[0] ?? null;
      if (!rescuerId) {
        // Nobody is in the room: the healthiest resident really walks there.
        const walker = runtime.context().actorIds.filter(id => id !== victimId
          && runtime.world.npcs[id]?.alive)
          .sort((left, right) => runtime.world.npcs[right].health
            - runtime.world.npcs[left].health)[0];
        if (walker) {
          const moved = queuedMove(runtime, walker, victim.location);
          if (!moved && runtime.world.npcs[walker].location === victim.location
            && runtime.world.npcs[walker].stamina > 30) rescuerId = walker;
          else if (moved) rescues.push({ at: runtime.world.simTime, victimId,
            rescuerId: walker, notes: [`walk refused: ${moved}`] });
        }
      }
      if (!rescuerId) continue;
      const notes = driveRescue(runtime, rescuerId, victimId);
      rescues.push({ at: runtime.world.simTime, victimId, rescuerId, notes });
    }

    // --- the clock: one game hour, or the original night window ----------------
    const before = runtime.world.simTime;
    const snapshot = runtime.snapshot();
    const night = snapshot.minuteOfDay >= args.profile.nightSkipFromMinute
      || snapshot.minuteOfDay < args.profile.nightSkipToMinute;
    if (night) {
      for (const actorId of runtime.context().actorIds) {
        const npc = runtime.world.npcs[actorId];
        if (!npc?.alive) continue;
        const home = actorId.endsWith('2') || actorId.endsWith('4') ? 'dorm-b' : 'dorm-a';
        if (npc.location === home) continue;
        if (OUT_OF_PLACE.includes(npc.location) && npc.location !== 'village') {
          // Inside another room: a queued 15-minute walk to the dorm.
          const refused = queuedMove(runtime, actorId, home);
          if (refused) stranded.push({ at: runtime.world.simTime, actorId, location: npc.location });
          continue;
        }
        // In the open: a real route (the R8 runner skipped these actors).
        const walked = walkToBuilding(runtime, actorId, home, 'night');
        if (walked) walks.push({ at: runtime.world.simTime, actorId, building: home,
          minutes: walked.minutes, tiles: walked.tiles });
        else stranded.push({ at: runtime.world.simTime, actorId, location: npc.location });
      }
      const dayStart = Math.floor(before / args.profile.minutesPerDay) * args.profile.minutesPerDay;
      const wake = dayStart + args.profile.minutesPerDay + args.profile.nightSkipToMinute;
      runtime.advanceWorld(Math.min(wake, before + 8 * 60));
    } else {
      runtime.advanceWorld(Math.floor(before / 60) * 60 + 60);
    }
    recordClock();
    if (runtime.ended) break;
    if (runtime.world.simTime === before) break;
  }

  const lifeState = runtime.states.life as { ending: { kind: string; survivors: number;
    settledAtElapsed: number } | null };
  const intents = [...runtime.intents.values()];
  const terminal = { applied: 0, rejected: 0, cancelled: 0, unresolved: 0 };
  for (const intent of intents) {
    if (intent.status === 'working') continue;
    terminal[intent.status as keyof typeof terminal] += 1;
  }
  const decisionStates: Record<string, number> = {};
  for (const row of decisions) {
    decisionStates[row.executionStatus] = (decisionStates[row.executionStatus] ?? 0) + 1;
  }
  const summaryFinal = {
    ...summary,
    endedAt: runtime.world.simTime, elapsed: runtime.elapsed(),
    ending: lifeState.ending, dead: [...runtime.world.dead].sort(),
    survivors: Object.values(runtime.world.npcs).filter(npc => npc.alive).length,
    resources: runtime.world.resources, furnace: runtime.world.furnace,
    heating: heatingOf(runtime.snapshot()),
    decisions: decisions.length, decisionStates,
    intents: intents.length, terminal,
    rejectedAtSettlement: intents.filter(intent => intent.status === 'rejected')
      .map(intent => ({ actorId: intent.actorId, intentId: intent.intentId,
        action: String(intent.candidate.parameters.action), reason: intent.failureReason })),
    rescues, nightWalks: walks, strandedAtNight: stranded,
    weatherVetoes: vetoes,
    clock, clockSha256: sha256(JSON.stringify(clock)),
    trajectorySha256: sha256(decisions.map(row => JSON.stringify(row)).join('\n')),
  };
  writeFileSync(join(args.out, 'trajectory.jsonl'),
    `${decisions.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  writeFileSync(join(args.out, 'summary.json'), `${JSON.stringify(summaryFinal, null, 2)}\n`, 'utf8');
  writeFileSync(join(args.out, 'intents.json'), `${JSON.stringify(intents, null, 2)}\n`, 'utf8');
  runtime.save(join(args.out, 'session.json'));
  console.log(JSON.stringify({ seed: args.seed, ending: lifeState.ending,
    survivors: summaryFinal.survivors, decisions: decisions.length,
    terminal, out: args.out }, null, 2));
  if (!lifeState.ending) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exit(1);
});
