/**
 * R8 playable entry: one real run from D1 08:00 to the D4 18:00 ending, then
 * (optionally) the reincarnation cycle.
 *
 *   node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --seed r8-1 \
 *     --mode reference --out artifacts/sprint-r8/O/<runId>
 *
 * Nothing here is a fixture world: the authority is the same PlaySession the
 * web UI drives, the clock is `R8Runtime.advanceWorld`, and every decision is
 * recorded with the exact request that was scored.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { GOSPEL_PROFILE, REFERENCE_PROFILE, type TimeProfile } from '../../src/r7/contracts';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import { applicableNotes, type MemoryPolicyId,
  type ExperienceNote } from '../../src/r7/agency/options';
import { JointScorerClient, parseScorerCommand } from '../../src/r7/ui/joint-scorer';
import { runStep } from '../../src/r7/integration/step';
import type { ScorePort } from '../../src/r7/contracts';
import { councilShouldOpen } from '../../src/r7/domains/council/index';
import { TASK_CATALOG, type TaskTypeId } from '../../src/r7/domains/tasks/index';
import { BUILDINGS, findPath, MAPS } from '../../src/spatial-v2/map';

type Mode = 'reference' | 'jev-experimental' | 'jev-admitted';

interface Args {
  profile: TimeProfile;
  seed: string;
  mode: Mode;
  out: string;
  lives: number;
  npcCount: number;
  food: number;
  memoryPolicy: MemoryPolicyId;
  scorerCommand: string[] | null;
  fullMap: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const profileId = get('--profile') ?? 'gospel-5.8.19';
  const profile = profileId === REFERENCE_PROFILE.id ? REFERENCE_PROFILE : GOSPEL_PROFILE;
  if (profileId !== GOSPEL_PROFILE.id && profileId !== REFERENCE_PROFILE.id) {
    throw new Error(`unknown profile ${profileId}`);
  }
  const mode = (get('--mode') ?? 'reference') as Mode;
  if (!['reference', 'jev-experimental', 'jev-admitted'].includes(mode)) {
    throw new Error(`unknown mode ${mode}`);
  }
  const out = get('--out');
  if (!out) throw new Error('--out <newDir> is required');
  const lives = Number(get('--lives') ?? 1);
  const memoryPolicy = (get('--memory-policy') ?? 'conditional-experience') as MemoryPolicyId;
  const scorer = get('--scorer-command-json') ?? process.env.FROSTECHO_SCORER_COMMAND_JSON;
  if (mode === 'jev-admitted') throw new Error('admitted mode requires a verified certificate; use jev-experimental');
  if (mode !== 'reference' && !scorer) throw new Error('jev-experimental requires --scorer-command-json');
  return {
    profile, seed: get('--seed') ?? 'r8-1', mode, out: resolve(out), lives,
    npcCount: Number(get('--npc') ?? 8), food: Number(get('--food') ?? 130),
    memoryPolicy,
    fullMap: argv.includes('--full-map'),
    scorerCommand: scorer ? parseScorerCommand(scorer) : null,
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface DecisionRecord {
  seed: string;
  episode: string;
  lifeNumber: number;
  at: number;
  elapsed: number;
  day: number;
  minuteOfDay: number;
  actorId: string;
  mode: Mode;
  requestId: string;
  candidateSetHash: string;
  inputSha256: string | null;
  candidates: { id: string; kind: string; description: string;
    parameters: Record<string, unknown>; preconditions: string[];
    text: string }[];
  observationText: string;
  renderSha256: string;
  jointText: string;
  rules: string[];
  notesUsed: string[];
  selectedId: string | null;
  disposition: string;
  scorerId: string;
  latencyMs: number;
  executed: boolean;
  executionStatus: string | null;
  reason: string;
  worldVersion: number;
}

interface RunReport {
  schema: 'frostecho.r8.playthrough/1';
  profile: string;
  seed: string;
  mode: Mode;
  memoryPolicy: MemoryPolicyId;
  sourceHEAD: string | null;
  startedAt: string;
  lives: number;
  endings: { lifeNumber: number; ending: string; survivors: number;
    elapsed: number; at: number }[];
  decisions: number;
  executed: number;
  rejected: number;
  rejections: { code: string; reason: string }[];
  timeline: { at: number; elapsed: number; day: number; type: string;
    actorId: string; payload: Record<string, unknown> }[];
  environment: Record<string, unknown>;
  files: Record<string, string>;
}

/** Notes this actor holds. Built from its own records, never from world truth. */
export function notesFor(runtime: R8Runtime, actorId: string, policy: MemoryPolicyId):
  ExperienceNote[] {
  const store = runtime.session.memories.get(actorId);
  if (!store) return [];
  const records = store.toJSON().records.filter(record => record.observerId === actorId);
  const notes: ExperienceNote[] = [];
  const shortage = records.find(record => record.kind === 'out_of_stock');
  if (shortage) {
    notes.push({ noteId: `note-shortage-${actorId}`, sourceEventIds: [...shortage.sourceEventIds],
      conditions: { place: 'warehouse' }, lesson: 'delay-should-be-reported', version: 1 });
  }
  const refusal = records.find(record => record.kind === 'task_declined');
  if (refusal) {
    notes.push({ noteId: `note-refusal-${actorId}`, sourceEventIds: [...refusal.sourceEventIds],
      conditions: { taskState: 'declined' }, lesson: 'conflict', version: 1 });
  }
  return applicableNotes(notes, policy, { place: 'warehouse', taskState: 'declined' });
}

function actorVerdict(runtime: R8Runtime, actorId: string, type: TaskTypeId):
  { verdict: 'accept' | 'decline' | 'counter'; reason: string; counterType?: TaskTypeId } {
  const npc = runtime.snapshot().npcs[actorId];
  if (!npc?.alive) return { verdict: 'decline', reason: 'not alive' };
  if (npc.hunger < 35 && type !== 'COLLECT_FOOD' && type !== 'DISTRIBUTE_FOOD') {
    return { verdict: 'decline', reason: `饥饿 ${npc.hunger.toFixed(0)} < 35，先找吃的` };
  }
  if (npc.stamina < 20 && type !== 'REST_RECOVER') {
    return { verdict: 'counter', reason: `体力 ${npc.stamina.toFixed(0)} < 20，申请先休息`,
      counterType: 'REST_RECOVER' };
  }
  if (npc.health < 40 && type !== 'PREPARE_MEDICAL') {
    return { verdict: 'decline', reason: `健康 ${npc.health.toFixed(0)} < 40，先治疗` };
  }
  return { verdict: 'accept', reason: '可以接下' };
}

export function runCouncilIfDue(runtime: R8Runtime, decisions: DecisionRecord[] = [], seed = runtime.session.seed): void {
  const snapshot = runtime.snapshot();
  const seenMorning = runtime.states.council.meetings.some(meeting => meeting.reason === 'morning'
    && Math.floor((meeting.openedAtMinute + runtime.profile.startMinuteOfDay) / runtime.profile.minutesPerDay) + runtime.profile.startDay === snapshot.day);
  const isMorning = snapshot.minuteOfDay >= 8 * 60 && snapshot.minuteOfDay < 10 * 60 && !seenMorning;
  const reason = isMorning ? 'morning'
    : councilShouldOpen(snapshot.resources, Number(snapshot.facts.tension ?? 0),
      snapshot.elapsed, (runtime.states.council as { cooldownUntil: number }).cooldownUntil);
  if (!reason) return;
  const opened = runtime.dispatch('council', 'open', 'old_qian',
    { tension: 0, force: isMorning });
  const meetingId = (runtime.states.council as { meetings: { meetingId: string }[] })
    .meetings.at(-1)?.meetingId;
  if (!meetingId || opened.rejected.length > 0) return;
  // Deterministic reference proposals: cover the scarcest resource first, and
  // put an affordable machine on the board once the basics are covered.
  // Cover in hours, not raw units: food 7.2/h (8 NPC x 0.9), wood 1/h,
  // power 2/h. The scarcest cover decides the task.
  const cover = {
    food: snapshot.resources.food / 7.2,
    firewood: snapshot.resources.firewood / 1,
    power: snapshot.resources.power / 2,
    medicine: snapshot.resources.medicine / 0.2,
  };
  const scarcest = Object.entries(cover)
    .sort((left, right) => left[1] - right[1])[0][0];
  const machines = snapshot.machines as Record<string, string>;
  const buildable = snapshot.resources.power >= 12 && snapshot.resources.firewood >= 15
    && machines.lumberMill === 'absent' && cover.food > 6 ? 'BUILD_LUMBER_MILL'
    : snapshot.resources.power >= 10 && snapshot.resources.firewood >= 12
      && machines.generator === 'absent' && cover.power < 8 ? 'BUILD_GENERATOR'
      : snapshot.resources.power >= 10 && snapshot.resources.firewood >= 12
        && machines.foodCollector === 'absent' && cover.food < 8 ? 'BUILD_FOOD_COLLECTOR'
        : null;
  const type: TaskTypeId = buildable ?? (scarcest === 'food' ? 'COLLECT_FOOD'
    : scarcest === 'firewood' ? 'COLLECT_WOOD'
      : scarcest === 'power' ? 'MAINTAIN_POWER' : 'PREPARE_MEDICAL');
  const alreadyOpen = (runtime.states.tasks as { tasks: { type: string; status: string }[] })
    .tasks.some(task => task.type === type
      && (task.status === 'accepted' || task.status === 'proposed'));
  if (alreadyOpen) return;
  const actors = runtime.context().actorIds.filter(id => snapshot.npcs[id]?.alive);
  // Each actor is proposed the assignment that fits its own state; the same
  // morning can carry several task types, which is what the original does.
  const needOf = (id: string): TaskTypeId | null => {
    const npc = snapshot.npcs[id];
    if (!npc?.alive) return null;
    if (npc.health < 50) return 'PREPARE_MEDICAL';
    if (npc.hunger < 45) return 'COLLECT_FOOD';
    if (npc.san < 40) return 'BOOST_MORALE';
    if (npc.stamina < 35) return 'REST_RECOVER';
    if (snapshot.furnace.fuel < 20) return 'PREPARE_WARMTH';
    if (cover.power < 6) return 'MAINTAIN_POWER';
    if (cover.firewood < 8) return 'COLLECT_WOOD';
    if (buildable) return buildable;
    if (cover.food < 6) return 'COLLECT_FOOD';
    return 'SCOUT_RUINS';
  };
  const assignments = actors.map(actorId => {
    const own = needOf(actorId);
    return own ? { actorId, type: own } : null;
  }).filter((entry): entry is { actorId: string; type: TaskTypeId } => entry !== null)
    .slice(0, Math.max(1, Math.min(4, actors.length)));
  runtime.dispatch('council', 'propose', 'old_qian',
    { meetingId, assignments, rationale: `${scarcest} is the scarcest resource` });
  const proposalId = (runtime.states.council as { meetings: { proposals: { proposalId: string }[] }[] })
    .meetings.at(-1)!.proposals[0].proposalId;
  for (const actorId of actors) {
    runtime.dispatch('council', 'vote', actorId, { meetingId, proposalId });
  }
  runtime.dispatch('council', 'resolve', 'old_qian', { meetingId });
  for (const assignment of assignments) {
    const proposed = runtime.dispatch('tasks', 'propose', 'old_qian',
      { type: assignment.type, assigneeId: assignment.actorId });
    const taskId = (runtime.states.tasks as { tasks: { taskId: string }[] })
      .tasks.at(-1)?.taskId;
    if (!taskId || proposed.rejected.length > 0) continue;
    const verdict = actorVerdict(runtime, assignment.actorId, assignment.type);
    runtime.dispatch('tasks', 'respond', assignment.actorId,
      { taskId, verdict: verdict.verdict, reason: verdict.reason,
        counterType: verdict.counterType ?? assignment.type });
    if (verdict.verdict !== 'accept') {
      // A refusal goes back to the board and is reassigned, never silently kept.
      const spare = actors.find(id => id !== assignment.actorId
        && actorVerdict(runtime, id, assignment.type).verdict === 'accept');
      if (spare) {
        runtime.dispatch('tasks', 'reassign', 'old_qian',
          { taskId, assigneeId: spare });
      }
      decisions.push({
        seed,
        episode: `${seed}-life${(runtime.states.life as { lifeNumber: number }).lifeNumber}`,
        lifeNumber: (runtime.states.life as { lifeNumber: number }).lifeNumber,
        at: runtime.world.simTime, elapsed: runtime.elapsed(), day: snapshot.day,
        minuteOfDay: snapshot.minuteOfDay, actorId: assignment.actorId, mode: 'reference',
        requestId: `${meetingId}:${assignment.actorId}:verdict`,
        candidateSetHash: sha256(`${taskId}|${verdict.verdict}`),
        inputSha256: sha256(JSON.stringify(verdict)),
        candidates: [{ id: 'council-verdict', kind: 'commitment',
          description: `${verdict.verdict}:${verdict.reason}`,
          parameters: { action: 'task' }, preconditions: [], text: verdict.reason }],
        observationText: `晨会分工:${assignment.type}`,
        renderSha256: sha256(`${taskId}|${verdict.reason}`),
        jointText: verdict.reason,
        rules: [`council.${verdict.verdict}`], notesUsed: [],
        selectedId: 'council-verdict', disposition: 'accept',
        scorerId: 'council-reference/1', latencyMs: 0, executed: true,
        executionStatus: 'applied', reason: verdict.reason,
        worldVersion: runtime.world.version,
      });
      continue;
    }
    decisions.push({
      seed,
      episode: `${seed}-life${(runtime.states.life as { lifeNumber: number }).lifeNumber}`,
      lifeNumber: (runtime.states.life as { lifeNumber: number }).lifeNumber,
      at: runtime.world.simTime, elapsed: runtime.elapsed(), day: snapshot.day,
      minuteOfDay: snapshot.minuteOfDay, actorId: assignment.actorId, mode: 'reference',
      requestId: `${meetingId}:${assignment.actorId}`,
      candidateSetHash: sha256(`${meetingId}|${assignment.actorId}|${assignment.type}`),
      inputSha256: sha256(JSON.stringify({ meetingId, assignment })),
      candidates: [{ id: `task:${assignment.type}`,
        kind: 'task', description: TASK_CATALOG[assignment.type].name,
        parameters: { action: 'task', type: assignment.type }, preconditions: [],
        text: TASK_CATALOG[assignment.type].name }],
      observationText: `晨会分工:${assignment.type}`,
      renderSha256: sha256(`${meetingId}|${assignment.actorId}|${assignment.type}`),
      jointText: TASK_CATALOG[assignment.type].name,
      rules: ['council.assignment'], notesUsed: [], selectedId: `task:${assignment.type}`,
      disposition: 'accept', scorerId: 'council-reference/1', latencyMs: 0,
      executed: true, executionStatus: 'applied', reason: 'council winner applied',
      worldVersion: runtime.world.version,
    });
  }
}

async function decide(runtime: R8Runtime, scorer: ScorePort,
  actorId: string, args: Args, decisions: DecisionRecord[]): Promise<void> {
  const snapshot = runtime.snapshot();
  const result = await runStep(runtime, scorer, { actorIds: [actorId], mode: args.mode,
    memoryPolicy: args.memoryPolicy, notes: id => notesFor(runtime, id, args.memoryPolicy) });
  for (const row of result.records) decisions.push({ ...row, seed: args.seed,
    inputSha256: row.inputSha256 ?? null,
    episode: `${args.seed}-life${runtime.states.life.lifeNumber}`,
    lifeNumber: runtime.states.life.lifeNumber, at: runtime.world.simTime,
    elapsed: runtime.elapsed(), day: snapshot.day, minuteOfDay: snapshot.minuteOfDay,
    mode: args.mode, notesUsed: notesFor(runtime, actorId, args.memoryPolicy).map(note => note.noteId),
    executed: row.executionStatus === 'applied' });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const runId = `${args.mode}-${args.seed}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const trajectoryPath = join(args.out, `trajectory-${runId}.jsonl`);
  const decisions: DecisionRecord[] = [];
  const endings: RunReport['endings'] = [];
  const timeline: RunReport['timeline'] = [];
  const scenario = { seed: args.seed, profile: args.profile,
    npcCount: args.npcCount, resources: { food: args.food } };
  let runtime = R8Runtime.create(scenario);
  if (args.fullMap) runtime.enableLegacySpatial();

  const service = args.mode === 'reference' ? null
    : new JointScorerClient(process.cwd(), args.scorerCommand!,
      Number(process.env.FROSTECHO_SCORER_TIMEOUT_MS ?? 300000),
      join(args.out, `scorer-${runId}.jsonl`));
  const scorer = service ?? referenceAgencyScorer();
  const report: RunReport = {
    schema: 'frostecho.r8.playthrough/1', profile: args.profile.id, seed: args.seed,
    mode: args.mode, memoryPolicy: args.memoryPolicy,
    sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
    startedAt: new Date().toISOString(), lives: args.lives, endings,
    decisions: 0, executed: 0, rejected: 0, rejections: [], timeline,
    environment: { node: process.version, platform: process.platform, fullMap: args.fullMap },
    files: {},
  };

  try {
  for (let life = 1; life <= args.lives; life += 1) {
    let guard = 0;
    while (!runtime.ended && guard < 1200) {
      guard += 1;
      runCouncilIfDue(runtime, decisions, args.seed);
      for (const actorId of runtime.context().actorIds) {
        await decide(runtime, scorer, actorId, args, decisions);
        if (runtime.ended) break;
      }
      // One game hour, or the night skip when the original window is open.
      const before = runtime.world.simTime;
      const snapshot = runtime.snapshot();
      const night = snapshot.minuteOfDay >= args.profile.nightSkipFromMinute
        || snapshot.minuteOfDay < args.profile.nightSkipToMinute;
      if (night) {
        // Original night skip (`core/game-time.js:159-203`): jump to 06:00 with
        // indoor recovery, never to the next game day.
        const dayStart = Math.floor(before / args.profile.minutesPerDay)
          * args.profile.minutesPerDay;
        const wake = dayStart + args.profile.minutesPerDay + args.profile.nightSkipToMinute;
        const to = Math.min(wake, before + 8 * 60);
        // Going home to sleep is a real spatial command, not a hidden teleport.
        for (const actorId of runtime.context().actorIds) {
          const npc = runtime.world.npcs[actorId];
          if (!npc?.alive) continue;
          const home = actorId.endsWith('2') || actorId.endsWith('4') ? 'dorm-b' : 'dorm-a';
          if (npc.location === home) continue;
          if (runtime.legacyPosition(actorId)) {
            runtime.travelLegacyTo(actorId, home, `sleep-${before}-${actorId}`);
            continue;
          }
          // Walk home along the real map; no teleport. If no path exists the
          // actor stays where it is and the night is simply cold.
          const door = BUILDINGS.find(building => building.id === home)?.door;
          const from = runtime.world.spatial?.positions[actorId]
            ?? BUILDINGS.find(building => building.id === npc.location)?.door;
          if (!door || !from) continue;
          const closed = new Set(runtime.world.spatial?.closedCells ?? []);
          const route = findPath(MAPS.village, from, door, closed).path;
          if (!route || route.length === 0) continue;
          const command = { commandId: `sleep-${before}-${actorId}`, type: 'travel' as const,
            actorId, route, minutesPerTile: 2 };
          const result = runtime.session.submitWorldCommand(command);
          if (result.status === 'applied') runtime.recordCommitted(result.events);
        }
        const reportSegment = runtime.advanceWorld(to);
        timeline.push(...reportSegment.domainEvents.map(event => ({
          at: runtime.world.simTime, elapsed: runtime.elapsed(),
          day: runtime.snapshot().day, ...event })));
      } else {
        const to = Math.floor(before / 60) * 60 + 60;
        const reportSegment = runtime.advanceWorld(to);
        timeline.push(...reportSegment.domainEvents.map(event => ({
          at: runtime.world.simTime, elapsed: runtime.elapsed(),
          day: runtime.snapshot().day, ...event })));
        for (const event of runtime.journal.slice(-reportSegment.domainEvents.length)) {
          if (event.type === 'rescue_needed') {
            const rescuer = runtime.context().actorIds
              .filter(id => runtime.snapshot().npcs[id]?.alive)
              .sort((left, right) => runtime.snapshot().npcs[right].health
                - runtime.snapshot().npcs[left].health)[0];
            if (rescuer) {
              runtime.dispatch('crises', 'rescue', rescuer,
                { victimId: event.payload.actorId });
            }
          }
        }
      }
      if (runtime.ended) break;
      if (runtime.world.simTime === before) break; // no progress: stop, never spin
    }
    const lifeState = runtime.states.life as { ending: { kind: string; survivors: number;
      settledAtElapsed: number } | null };
    if (lifeState.ending) {
      endings.push({ lifeNumber: life, ending: lifeState.ending.kind,
        survivors: lifeState.ending.survivors,
        elapsed: lifeState.ending.settledAtElapsed, at: runtime.world.simTime });
    }
    if (life < args.lives) {
      const next = runtime.reincarnate(scenario);
      const runtimeEnding = runtime;
      void runtimeEnding;
      runtime = next;
      runtime.journal.push({ at: runtime.world.simTime, type: 'reincarnated',
        actorId: 'system', payload: { lifeNumber: life + 1 } });
    }
  }
  } catch (error) {
    writeFileSync(join(args.out, `failure-${runId}.json`), JSON.stringify({
      error: (error as Error).message, decisions: decisions.length,
      simTime: runtime.world.simTime, mode: args.mode, countsAsAdmitted: false }, null, 2) + '\n');
    writeFileSync(trajectoryPath, decisions.map(row => JSON.stringify(row)).join('\n') + '\n');
    runtime.save(join(args.out, `partial-${runId}.json`));
    throw error;
  } finally { service?.close(); }

  writeFileSync(trajectoryPath, `${decisions.map(record => JSON.stringify(record)).join('\n')}\n`,
    'utf8');
  report.decisions = decisions.length;
  report.executed = decisions.filter(record => record.executed).length;
  report.rejected = decisions.filter(record => record.executionStatus === 'rejected').length;
  report.environment.scorerIdentity = { ...scorer.identity };
  report.environment.referenceCouncilDecisions = decisions.filter(record => record.scorerId === 'council-reference/1').length;
  report.environment.actionDecisions = decisions.filter(record => record.scorerId !== 'council-reference/1').length;
  report.rejections = runtime.rejections.map(entry => ({ code: entry.code,
    reason: entry.reason }));
  report.files.trajectory = trajectoryPath;
  const summaryPath = join(args.out, `summary-${runId}.json`);
  report.files.summary = summaryPath;
  report.files.runtimeDocument = join(args.out, `runtime-${runId}.json`);
  report.files.session = join(args.out, `session-${runId}.json`);
  runtime.save(report.files.session);
  writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(report.files.runtimeDocument,
    `${JSON.stringify(runtime.toDocument(), null, 2)}\n`, 'utf8');
  const last = endings.at(-1);
  console.log(JSON.stringify({ ok: Boolean(last), profile: args.profile.id,
    seed: args.seed, mode: args.mode, lives: args.lives, ending: last?.ending ?? null,
    survivors: last?.survivors ?? null, elapsed: last?.elapsed ?? null,
    decisions: report.decisions, executed: report.executed,
    rejected: report.rejected, out: args.out, summary: summaryPath }, null, 2));
  if (!last) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exit(1);
});

