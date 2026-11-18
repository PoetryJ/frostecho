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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { createCommitmentBridge } from '../../src/r7/integration/commitment-bridge';
import { auditSettlement, loadFourDaySidecars, saveFourDaySidecars,
  type SettlementAudit } from '../../src/r7/integration/sidecar';
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
  /** R10: which bounded-memory arm fills the model input (same token budget). */
  memorySelection: 'raw-last12' | 'obligation-first';
  scorerCommand: string[] | null;
  fullMap: boolean;
  /** Skip the four seeded promises (reference arms only). */
  noCommitments: boolean;
  /** CLI-identical save bundle: session + boards + R8 sidecar. */
  state: string;
  /** Continue a four-day run from a saved state instead of creating one. */
  restore: string | null;
  /** Stop (and save with pending work) on this day, for the D2 restore story. */
  stopAfterDays: number | null;
  /** Ask for the four pledges on this day instead of at the start. */
  pledgeAfterDay: number | null;
  /** Control arm: keep the reference survival exit out of the picture. */
  noSurvivalExit: boolean;
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
  const memorySelection = (get('--memory-selection') ?? 'obligation-first') as
    'raw-last12' | 'obligation-first';
  if (!['raw-last12', 'obligation-first'].includes(memorySelection)) {
    throw new Error(`unknown memory selection ${memorySelection}`);
  }
  const scorer = get('--scorer-command-json') ?? process.env.FROSTECHO_SCORER_COMMAND_JSON;
  if (mode === 'jev-admitted') throw new Error('admitted mode requires a verified certificate; use jev-experimental');
  if (mode !== 'reference' && !scorer) throw new Error('jev-experimental requires --scorer-command-json');
  const restore = get('--restore');
  const stopAfterDays = get('--stop-after-days') === undefined
    ? null : Number(get('--stop-after-days'));
  if (stopAfterDays !== null && (!Number.isInteger(stopAfterDays) || stopAfterDays < 1)) {
    throw new Error(`invalid --stop-after-days ${String(stopAfterDays)}`);
  }
  if (restore && stopAfterDays !== null) {
    throw new Error('--restore and --stop-after-days are mutually exclusive');
  }
  const pledgeAfterDay = get('--pledge-after-day') === undefined
    ? null : Number(get('--pledge-after-day'));
  if (pledgeAfterDay !== null && (!Number.isInteger(pledgeAfterDay) || pledgeAfterDay < 1)) {
    throw new Error(`invalid --pledge-after-day ${String(pledgeAfterDay)}`);
  }
  if (restore && pledgeAfterDay !== null) {
    throw new Error('--restore adopts the pledges recorded in the save');
  }
  return {
    profile, seed: get('--seed') ?? 'r8-1', mode, out: resolve(out), lives,
    npcCount: Number(get('--npc') ?? 8), food: Number(get('--food') ?? 130),
    memoryPolicy, memorySelection,
    noCommitments: argv.includes('--no-commitments'),
    fullMap: argv.includes('--full-map'),
    scorerCommand: scorer ? parseScorerCommand(scorer) : null,
    // A resumed process writes its own state; the D2 save it read stays byte
    // for byte as evidence, so no restore can quietly rewrite its own input.
    state: resolve(get('--state') ?? join(resolve(out), 'state.json')),
    restore: restore ? resolve(restore) : null,
    stopAfterDays,
    pledgeAfterDay,
    noSurvivalExit: argv.includes('--no-survival-exit'),
  };
}

/** Runner bookkeeping that must survive the process exit, never a world fact. */
interface RunnerState {
  schema: 'frostecho.r10.playthrough-state/1';
  seed: string;
  mode: Mode;
  lives: number;
  profile: string;
  /** The D2 interference is applied once per run, not once per process. */
  interfered: boolean;
  /** The four pledges exist once per run; a restored process never re-pledges. */
  pledged: boolean;
  pledgeAfterDay: number | null;
  noSurvivalExit: boolean;
  requestedCommitmentIds: string[];
  stopAfterDays: number | null;
  savedAt: string | null;
  restoredFrom: string | null;
}

function runnerStatePath(base: string): string { return `${base}.runner.json`; }

function readRunnerState(base: string): RunnerState {
  const path = runnerStatePath(base);
  if (!existsSync(path)) throw new Error(`missing_four_day_runner_state:${path}`);
  const document = JSON.parse(readFileSync(path, 'utf8')) as RunnerState;
  if (document.schema !== 'frostecho.r10.playthrough-state/1') {
    throw new Error(`unsupported runner state ${document.schema}`);
  }
  return document;
}

function writeRunnerState(base: string, document: RunnerState): void {
  mkdirSync(dirname(runnerStatePath(base)), { recursive: true });
  writeFileSync(runnerStatePath(base), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
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
  settlement?: {
    intents: number; pending: number;
    terminal: { applied: number; rejected: number; cancelled: number; unresolved: number };
    decisionStates: Record<string, number>; receipts: number;
    rejectedAtSettlement: { actorId: string; intentId: string; action: string;
      reason: string | null }[];
    unsettledWork: { actorId: string; selectedId: string | null; requestId: string }[];
    scope: 'fresh-run' | 'restored-process';
    reconciled: boolean;
  };
  timeline: { at: number; elapsed: number; day: number; type: string;
    actorId: string; payload: Record<string, unknown> }[];
  environment: Record<string, unknown>;
  files: Record<string, string>;
  /** Set when the run stopped on purpose to leave pending work on disk. */
  stopped?: { requestedDay: number; day: number; simTime: number; pending: number;
    state: string; sidecars: Record<string, string> };
  /** Set when this process continued another process's save. */
  restore?: { from: string; savedAt: string | null; clock: number;
    commitments: number; pendingIntents: number };
  settlementAudit?: SettlementAudit;
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
  actorId: string, args: Args, decisions: DecisionRecord[],
  bridge: ReturnType<typeof createCommitmentBridge>): Promise<void> {
  const snapshot = runtime.snapshot();
  const result = await runStep(runtime, scorer, { actorIds: [actorId], mode: args.mode,
    memorySelection: args.memorySelection,
    memoryPolicy: args.memoryPolicy, goalBridge: bridge,
    notes: id => notesFor(runtime, id, args.memoryPolicy) });
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
  let runtime: R8Runtime;
  let play: GameplayLoop;
  let runner: RunnerState;
  let restoreInfo: RunReport['restore'] | undefined;
  let restoredCommitments: Record<string, unknown>[] | undefined;
  if (args.restore) {
    // The D2 exit is a real second process: no session is rebuilt here, the
    // saved one is the authority and the boards come from the same base path.
    const saved = readRunnerState(args.restore);
    if (saved.seed !== args.seed) throw new Error(`restore seed ${saved.seed} != ${args.seed}`);
    if (saved.mode !== args.mode) throw new Error(`restore mode ${saved.mode} != ${args.mode}`);
    if (saved.lives !== args.lives) throw new Error(`restore lives ${saved.lives} != ${args.lives}`);
    if (saved.noSurvivalExit !== args.noSurvivalExit)
      throw new Error('restore survival-exit flag does not match the save');
    const restored = loadFourDaySidecars(args.restore);
    runtime = restored.runtime;
    play = restored.play;
    runner = { ...saved, restoredFrom: args.restore, stopAfterDays: null };
    const spatial = runtime.legacyPosition(runtime.session.npcIds[0]) !== null;
    if (spatial !== args.fullMap) throw new Error('restore full-map flag does not match the save');
    restoreInfo = { from: args.restore, savedAt: saved.savedAt,
      clock: runtime.world.simTime,
      commitments: play.commitments.all().length,
      pendingIntents: [...runtime.intents.values()]
        .filter(intent => intent.status === 'working').length };
    restoredCommitments = play.commitments.all().map(row => ({
      commitmentId: row.commitmentId, goal: row.goal, status: row.status,
      revision: row.revision, promisorId: row.promisorId }));
  } else {
    runtime = R8Runtime.create(scenario);
    if (args.fullMap) runtime.enableLegacySpatial();
    play = new GameplayLoop(runtime.session);
    runner = { schema: 'frostecho.r10.playthrough-state/1', seed: args.seed,
      mode: args.mode, lives: args.lives, profile: args.profile.id, interfered: false,
      pledged: false, pledgeAfterDay: args.pledgeAfterDay,
      noSurvivalExit: args.noSurvivalExit,
      requestedCommitmentIds: [], stopAfterDays: args.stopAfterDays, savedAt: null,
      restoredFrom: null };
  }

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
  if (restoreInfo) report.restore = restoreInfo;
  if (restoredCommitments) report.environment.restoredCommitments = restoredCommitments;

  try {
  for (let life = 1; life <= args.lives; life += 1) {
    // R10 (B): the four-day runner uses the SAME commitment bridge, task board
    // and memory projection as the CLI/web entry - not a second policy.
    if (life > 1) play = new GameplayLoop(runtime.session);
    const bridge = createCommitmentBridge(runtime, play);
    // Four long-horizon stories with interference; each actor keeps its own
    // record of what it was told, so an unheard change cannot leak.
    // A restored process must NOT re-create promises: they came from disk.
    const pledge = (): void => {
      if (args.restore || args.noCommitments || runner.pledged) return;
      const promises = ['npc_01', 'npc_02', 'npc_03', 'npc_04'].map((actorId, index) => {
        const goal = index < 2 ? 'deliver-meal' : 'supply-warehouse';
        return play.requestCommitment(actorId, goal, { verdict: 'accept' });
      });
      runner.pledged = true;
      runner.requestedCommitmentIds = promises.map(entry => entry.commitment.commitmentId);
      report.environment.commitments = promises.map(entry => ({
        commitmentId: entry.commitment.commitmentId,
        goal: entry.commitment.goal, promisorId: entry.commitment.promisorId,
        taskId: entry.task?.taskId ?? null }));
    };
    // Default arms pledge at the start; the D2-restore arm pledges on the day
    // it exits, so the promises are live across the process boundary.
    if (runner.pledgeAfterDay === null) pledge();
    let interfered = runner.interfered;
    let guard = 0;
    while (!runtime.ended && guard < 1200) {
      guard += 1;
      runCouncilIfDue(runtime, decisions, args.seed);
      // "Day N" means N 08:00, the original start hour, not N 00:00: a midnight
      // snapshot has every body cold and the reference arm would exit the
      // promise it just made, which is not a promise carried across a restart.
      const reached = (day: number): boolean => {
        const snapshot = runtime.snapshot();
        return snapshot.day > day
          || (snapshot.day === day && snapshot.minuteOfDay >= args.profile.startMinuteOfDay);
      };
      if (runner.pledgeAfterDay !== null && !runner.pledged
        && reached(runner.pledgeAfterDay)) pledge();
      // This iteration ends the run on purpose: the decisions below queue REAL
      // work and then the state is saved. The interference is deferred so the
      // RESUMED process applies the private cancel, not the exiting one.
      const willStop = args.stopAfterDays !== null && reached(args.stopAfterDays);
      // The D2 interference: one promise is cancelled by the player and only
      // npc_02 hears it; another gets a source-change proposal. This is the
      // story the model must carry across the restart.
      if (!interfered && !willStop && runner.pledged && runtime.snapshot().day >= 2) {
        interfered = true;
        const rows = play.commitments.all().filter(row => row.status === 'active');
        if (rows[0]) {
          const cancelled = play.cancelCommitment(rows[0].commitmentId,
            { heardBy: ['npc_02'], reason: '玩家改主意' });
          report.environment.interference = {
            kind: 'private-cancel', commitmentId: rows[0].commitmentId,
            heardBy: ['npc_02'], status: cancelled.commitment.status,
            at: runtime.world.simTime };
        }
        if (rows[1]) {
          const proposed = play.commitments.proposeChange(rows[1].commitmentId, {
            kind: 'alt-source', reason: 'warehouse-empty',
            terms: { source: 'gather', reason: '先采集再交付' },
            at: runtime.world.simTime, evidenceEventIds: [] });
          runtime.session.ingestCommitmentEvent(proposed.event);
          report.environment.interference2 = {
            kind: 'change-proposed', commitmentId: rows[1].commitmentId,
            status: proposed.commitment.status, at: runtime.world.simTime };
        }
        runner.interfered = true;
      }
      for (const actorId of runtime.context().actorIds) {
        // A reference arm that never lets a body quit would die holding a
        // promise; the honest baseline is an explicit, recorded exit. The
        // `--no-survival-exit` control keeps the promise alive across the D2
        // boundary so the cross-process settlement itself can be observed.
        if (args.mode === 'reference' && !args.noSurvivalExit) {
          const npc = runtime.world.npcs[actorId];
          const danger = npc?.alive && (npc.hunger < 45 || npc.stamina < 35
            || (npc.bodyTemp ?? 36.5) < 35.9);
          if (danger) {
            for (const row of play.commitments.all()) {
              if (row.promisorId !== actorId || row.status !== 'active') continue;
              const exited = play.withdrawCommitment(row.commitmentId,
                { reason: 'survival-exit', inputId: `exit-${row.commitmentId}-${runtime.world.simTime}` });
              const exits = (report.environment.exits ??= []) as Record<string, unknown>[];
              exits.push({ commitmentId: row.commitmentId,
                actorId, at: runtime.world.simTime, status: exited.commitment.status,
                hunger: Math.round(npc.hunger), stamina: Math.round(npc.stamina) });
            }
          }
        }
        await decide(runtime, scorer, actorId, args, decisions, bridge);
        if (runtime.ended) break;
      }
      // The D2 exit: stop with REAL queued work, so the file on disk carries a
      // working intent and open promises instead of a tidy between-actions gap.
      if (willStop) {
        const pending = [...runtime.intents.values()]
          .filter(intent => intent.status === 'working');
        if (pending.length > 0) {
          const paths = saveFourDaySidecars(runtime, play, args.state);
          runner.savedAt = new Date().toISOString();
          writeRunnerState(args.state, runner);
          report.stopped = { requestedDay: args.stopAfterDays!,
            day: runtime.snapshot().day, simTime: runtime.world.simTime,
            pending: pending.length, state: args.state, sidecars: { ...paths } };
          break;
        }
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
    // A crash must not drop the promises either: same bundle as the CLI.
    saveFourDaySidecars(runtime, play, join(args.out, `partial-${runId}.json`));
    throw error;
  } finally { service?.close(); }

  writeFileSync(trajectoryPath, `${decisions.map(record => JSON.stringify(record)).join('\n')}\n`,
    'utf8');
  report.decisions = decisions.length;
  report.executed = decisions.filter(record => record.executed).length;
  // R10: a working decision is not a success, and a settlement refusal is not a
  // decision refusal. Both are counted, and every queued action must reconcile
  // to one terminal state.
  const decisionStates: Record<string, number> = {};
  for (const record of decisions) {
    const key = String(record.executionStatus ?? 'none');
    decisionStates[key] = (decisionStates[key] ?? 0) + 1;
  }
  const intents = [...runtime.intents.values()];
  const terminal = { applied: 0, rejected: 0, cancelled: 0, unresolved: 0 };
  for (const intent of intents) {
    if (intent.status === 'working') continue;
    terminal[intent.status as keyof typeof terminal] += 1;
  }
  const unsettled = decisions.filter(record => record.executionStatus === 'working')
    .filter(record => !intents.some(intent => intent.actorId === record.actorId
      && intent.candidateId === record.selectedId && intent.status !== 'working'))
    .map(record => ({ actorId: record.actorId, selectedId: record.selectedId,
      requestId: record.requestId }));
  const settlementRejections = intents.filter(intent => intent.status === 'rejected');
  // Re-derived from the persisted queue + ledgers, never from a process flag.
  const audit = auditSettlement(runtime, play);
  report.settlement = {
    intents: intents.length,
    pending: intents.filter(intent => intent.status === 'working').length,
    terminal,
    decisionStates,
    receipts: runtime.committedEvents().length,
    rejectedAtSettlement: settlementRejections.map(intent => ({
      actorId: intent.actorId, intentId: intent.intentId,
      action: String(intent.candidate.parameters.action),
      reason: intent.failureReason })),
    unsettledWork: unsettled,
    // On a restore the queue legitimately contains intents queued by the other
    // process, so the decision-count identity is not applicable; the restored
    // run reconciles against the persisted audit instead of pretending.
    scope: args.restore ? 'restored-process' : 'fresh-run',
    reconciled: unsettled.length === 0 && (args.restore ? audit.ok
      : decisions.length === intents.length + decisions.filter(record =>
        ['applied', 'abstained', 'rejected', 'busy', 'stale'].includes(String(record.executionStatus))
        && !intents.some(intent => intent.actorId === record.actorId
          && intent.candidateId === record.selectedId)).length),
  };
  report.rejected = decisions.filter(record => record.executionStatus === 'rejected').length
    + settlementRejections.length;
  report.environment.scorerIdentity = { ...scorer.identity };
  report.environment.referenceCouncilDecisions = decisions.filter(record => record.scorerId === 'council-reference/1').length;
  report.environment.actionDecisions = decisions.filter(record => record.scorerId !== 'council-reference/1').length;
  report.environment.duplicateDemands = runtime.duplicateDemands.length;
  report.environment.survivalExit = !args.noSurvivalExit;
  report.rejections = runtime.rejections.map(entry => ({ code: entry.code,
    reason: entry.reason }));
  report.files.trajectory = trajectoryPath;
  const summaryPath = join(args.out, `summary-${runId}.json`);
  report.files.summary = summaryPath;
  report.files.runtimeDocument = join(args.out, `runtime-${runId}.json`);
  // ONE bundle, the same file set the CLI writes: without the gameplay boards
  // a restored four-day run loses every promise while keeping the world.
  const paths = saveFourDaySidecars(runtime, play, args.state);
  runner.savedAt = new Date().toISOString();
  writeRunnerState(args.state, runner);
  report.files = { ...report.files, session: paths.session, tasks: paths.tasks,
    experience: paths.experience, commitments: paths.commitments,
    council: paths.council, longTermMemory: paths.longTermMemory,
    r8Runtime: paths.runtime, runnerState: runnerStatePath(args.state) };
  report.settlementAudit = audit;
  writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(report.files.runtimeDocument,
    `${JSON.stringify(runtime.toDocument(), null, 2)}\n`, 'utf8');
  writeFileSync(join(args.out, `settlement-audit-${runId}.json`),
    `${JSON.stringify(report.settlementAudit, null, 2)}\n`, 'utf8');
  const last = endings.at(-1);
  console.log(JSON.stringify({ ok: Boolean(last) || Boolean(report.stopped),
    profile: args.profile.id,
    seed: args.seed, mode: args.mode, lives: args.lives, ending: last?.ending ?? null,
    survivors: last?.survivors ?? null, elapsed: last?.elapsed ?? null,
    decisions: report.decisions, executed: report.executed,
    rejected: report.rejected, out: args.out, summary: summaryPath,
    state: args.state, restoredFrom: report.restore?.from ?? null,
    stopped: report.stopped ?? null,
    settlementAuditOk: report.settlementAudit.ok }, null, 2));
  if (!last && !report.stopped) process.exitCode = 1;
  if (report.settlementAudit && !report.settlementAudit.ok) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exit(1);
});

