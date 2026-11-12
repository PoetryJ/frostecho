/**
 * Real player entry (G). Reads commands from stdin, not a scripted fixture.
 *
 *   node dist/scripts/play-sprint.js --state artifacts/sprint-r1/play/session.json
 *
 * R2 lifecycle:
 *  - every input becomes a tracked job (jobId, terminal state);
 *  - control inputs (promise/cancel/tell/advance/observe/knowledge) execute
 *    immediately in submission order, so a cancel is not stuck behind a long
 *    scoring call — it revokes that actor's commit generation;
 *  - step jobs run asynchronously, one after another, and their commit section
 *    re-checks generation/version/memory synchronously;
 *  - save/quit are barriers that first drain in-flight steps (or record them
 *    explicitly), then persist; EOF drains before exiting. No accepted job is
 *    dropped silently, and the exit code reflects unsettled work.
 *
 * Commands:
 *   observe                     show day/time/resources/NPCs
 *   promise <npcId> [commandId] ask that NPC to leave food (others present hear)
 *   cancel <npcId> [instanceId] cancel face to face with that NPC only
 *   tell <npcId> <promisorId>   tell another NPC the player already cancelled
 *   step [npcId]               run decisions (all alive NPCs, or one)
 *   game-step                  run the four-day reference task loop (P)
 *   assign <npcId> <kind>       assign gather-food|gather-wood|heating|leave-food|deliver-meal
 *   cancel-task <taskId>        cancel a task (cancelled leave-food retracts)
 *   task-status                task board + day/ending (reference-rules/1)
 *   advance <minutes>           authoritative time advance
 *   knowledge                   each NPC's own promise knowledge
 *   map [village|warehouse|kitchen]  grid, buildings, doors, closed cells (R3)
 *   where <npcId>               current location + grid cell (R3)
 *   travel <npcId> <building>   walk a real A* route to a building door (R3)
 *   withdraw <npcId> [amount]   take meals from the warehouse stock (R3)
 *   deliver <npcId> [amount]    hand carried meals to the kitchen (R3)
 *   restock <amount> [source]   refill the warehouse stock (player action, R3)
 *   close-road <x,y> [...]      seal village cells (R3)
 *   open-road <x,y> [...]       reopen sealed cells (R3)
 *   tell-restock <npcId>        rumor: player says the warehouse is refilled (R3)
 *   save                        persist session + task board (barrier)
 *   quit                        exit after the queue drains (barrier)
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PlaySession, defaultStatePath } from '../src/application-v2/session';
import type { PlayerJob, PlayerJobKind } from '../src/application-v2/lifecycle';
import { GameplayLoop, actorCell, MINUTES_PER_TILE } from '../src/gameplay-v2/loop';
import { TaskBoard, type GameplayTaskKind } from '../src/gameplay-v2/tasks';
import { BUILDINGS, MAPS, findPath } from '../src/spatial-v2/map';
import type { ScorerPort } from '../src/planning/candidates';

declare const require: (modulePath: string) => {
  createScorer: () => ScorerPort;
};

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * R3 (M): --scorer <module.cjs> loads an external scorer factory
 * (module.exports = { createScorer(): ScorerPort }) so acceptance runs can
 * drive the real CLI with a slow, controllable async model scorer. The
 * default stays the synchronous reference scorer.
 */
function scorerProvider(): (() => ScorerPort) | undefined {
  const modulePath = argValue('--scorer');
  if (!modulePath) return undefined;
  const loaded = require(modulePath);
  if (typeof loaded.createScorer !== 'function') {
    throw new Error(`--scorer module must export createScorer(): ${modulePath}`);
  }
  return () => loaded.createScorer();
}

const statePath = argValue('--state') ?? defaultStatePath();
const npcCount = Number(argValue('--npc') ?? 8);
const days = Number(argValue('--days') ?? 4);
const food = argValue('--food') === undefined ? undefined : Number(argValue('--food'));
const customScorer = scorerProvider();

// The session ALWAYS comes from the gameplay loop (which owns the restore
// path), so `session` and `play.session` can never diverge.
const restoredSession = existsSync(statePath) && !process.argv.includes('--fresh')
  ? PlaySession.load(statePath, customScorer)
  : PlaySession.create(npcCount, { days, food, seed: argValue('--seed') ?? `play-${npcCount}`,
    scorerProvider: customScorer });

// R4: session + task board + experience + commitments all live beside the
// session file and are written together by `save` / read together by `load`.
const play = existsSync(statePath) && !process.argv.includes('--fresh')
  ? GameplayLoop.load(statePath, {}, customScorer)
  : new GameplayLoop(restoredSession);
const session = play.session;

const emit = (value: Record<string, unknown>) => console.log(JSON.stringify(value));
emit({ schema: 'frostecho.play/2', event: 'ready', statePath,
  restored: existsSync(statePath) && !process.argv.includes('--fresh'),
  day: session.world.day, simTime: session.world.simTime, npcs: session.npcIds });

const jobs: PlayerJob[] = [];
let sequence = 0;
/** Control commands: immediate, submission order. */
let controlChain: Promise<void> = Promise.resolve();
/** R4 (G2): save/quit barriers; bounded and independent of control input. */
let barrierChain: Promise<void> = Promise.resolve();
/** Step jobs: serialized among themselves, never blocking later control input. */
let stepChain: Promise<void> = Promise.resolve();
let closed = false;
let quitRequested = false;

function kindOf(command: string): PlayerJobKind {
  const known: PlayerJobKind[] = ['observe', 'promise', 'cancel', 'tell', 'advance',
    'step', 'knowledge', 'save', 'quit', 'assign', 'cancel-task', 'task-status',
    'game-step', 'map', 'where', 'travel', 'withdraw', 'deliver', 'restock',
    'close-road', 'open-road', 'tell-restock', 'request', 'respond-change',
    'commitment-status', 'resume-commitment', 'relinquish', 'cancel-commitment',
    'deposit'];
  return (known as string[]).includes(command) ? command as PlayerJobKind : 'observe';
}

/**
 * R4 (G1): every player operation carries a persistent input id. A trailing
 * `id=<value>` explicitly retries that operation (replay when the content
 * matches, conflict otherwise); without it a fresh persistent id is issued.
 */
function inputIdFor(kind: string, parts: string[]): { id: string; parts: string[]; retry: boolean } {
  const index = parts.findIndex(part => part.startsWith('id='));
  if (index >= 0) {
    return { id: parts[index].slice(3), retry: true,
      parts: parts.filter((_, position) => position !== index) };
  }
  return { id: session.nextInputId(kind), parts, retry: false };
}

function parseCells(parts: string[]): Array<{ x: number; y: number }> {
  return parts.map(part => {
    const [x, y] = part.split(',').map(piece => Number.parseInt(piece, 10));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad cell ${part} (use x,y)`);
    return { x, y };
  });
}

/**
 * R4 (G2): the settle bound for save/quit/EOF barriers. It comes from the
 * frozen lifecycle policy (10s) and is overridable for acceptance runs.
 */
const SETTLE_MS = Number(process.env.R4_BARRIER_MS ?? 10_000);
/** R4 (G2): one CLI step's lease timeout (also the scorer bound). */
const STEP_TIMEOUT_MS = Number(process.env.R4_STEP_TIMEOUT_MS ?? 10_000);

/**
 * R5 (G2): one accepted step job plus the exact actors/generations it captured
 * when the line arrived. A barrier revokes THIS set only — never a later job.
 */
interface StepJobRecord {
  job: PlayerJob;
  actorIds: string[];
  expected: number | Record<string, number>;
  done: Promise<void>;
  captured: boolean;
}
const stepJobs = new Set<StepJobRecord>();
/** Actors with a step job currently in flight (diagnostic only). */
const inFlightActors = new Set<string>();
const revokedByBarrier: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cancelJob(job: PlayerJob, reason: string): void {
  if (job.terminal) return;
  job.status = 'cancelled';
  job.terminal = true;
  job.detail = { ...(job.detail as Record<string, unknown> | undefined), reason };
  emit({ event: 'job_terminal', jobId: job.jobId, kind: job.kind,
    status: 'cancelled', reason });
}

/**
 * Wait for the captured records to settle or for the settle bound to elapse.
 * On timeout only the captured actors lose their submission right and only the
 * captured non-terminal jobs become `cancelled`; later jobs re-stamp against
 * the new generation and keep running.
 */
async function settleWithin(records: StepJobRecord[], boundMs: number,
  extra?: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(true), boundMs);
  });
  const pending: Promise<unknown>[] = records.map(record => record.done);
  if (extra) pending.push(extra);
  const settled = Promise.allSettled(pending).then(() => false);
  const didTimeOut = await Promise.race([settled, timedOut]);
  if (timer) clearTimeout(timer);
  if (didTimeOut) {
    const open = records.filter(record => !record.job.terminal);
    const actors = new Set(open.flatMap(record => record.actorIds));
    for (const actorId of actors) {
      session.bumpGeneration(actorId, 'barrier_timeout');
      revokedByBarrier.push(actorId);
    }
    // A timeout is an explicit terminal state, never a silent drop and never
    // a completed action.
    for (const record of open) cancelJob(record.job, 'barrier_timeout');
    // Jobs accepted AFTER this barrier captured its set are outside its
    // authority: re-stamp their expected generation so they still run.
    for (const record of stepJobs) {
      if (record.captured || record.job.terminal) continue;
      if (typeof record.expected === 'number') {
        record.expected = session.generationFor(record.actorIds[0]);
      } else {
        for (const actorId of record.actorIds) {
          record.expected[actorId] = session.generationFor(actorId);
        }
      }
    }
  }
  return !didTimeOut;
}

async function runJob(job: PlayerJob, line: string,
  expected: number | Record<string, number> = 0): Promise<void> {
  const [command, ...rest] = line.trim().split(/\s+/).filter(Boolean);
  if (job.terminal) {
    // A queued job revoked by an earlier barrier must never start its effects.
    emit({ command, jobId: job.jobId, cancelled: true,
      reason: String((job.detail as Record<string, unknown> | undefined)?.reason
        ?? 'cancelled_before_start'), decisions: [], outcomes: [] });
    return;
  }
  job.status = 'running';
  try {
    switch (command) {
      case 'observe':
        emit({ command, jobId: job.jobId, ...session.observe() });
        break;
      case 'promise': {
        // R4 (G1): a fresh persistent id for a new request; the second argument
        // is an EXPLICIT retry id (replay on identical content, conflict else).
        job.commandId = rest[1] ?? session.nextInputId('promise', rest[0]);
        emit({ command, jobId: job.jobId,
          ...session.playerPromise(rest[0], rest[1] ? job.commandId : undefined) });
        break;
      }
      case 'cancel': {
        job.commandId = rest[2] ?? session.nextInputId('cancel', rest[0]);
        emit({ command, jobId: job.jobId,
          ...session.playerCancel(rest[0], rest[1], rest[2]) });
        break;
      }
      case 'tell':
        job.commandId = job.jobId;
        emit({ command, jobId: job.jobId, ...session.playerTell(rest[0], rest[1]) });
        break;
      case 'advance':
        emit({ command, jobId: job.jobId, ...session.advance(Number(rest[0] ?? 60)) });
        break;
      case 'step': {
        if (rest.length > 0) {
          // R4 (G2): the single-actor path gets the same revocable lease and a
          // bounded timeout as the scheduler path; a missing scorer result can
          // no longer wedge save/quit/EOF.
          const bounded = await session.stepActorBounded(rest[0], expected as number,
            STEP_TIMEOUT_MS);
          const decision = bounded.decision;
          emit({ command, jobId: job.jobId, decisions: [decision],
            outcomes: [{ taskId: job.jobId, actorId: rest[0],
              status: bounded.outcome.status, ...(bounded.outcome.status === 'completed'
                ? { value: decision } : {}) }] });
        } else {
          const result = await session.stepAll({
            expectedGenerations: expected as Record<string, number> });
          emit({ command, jobId: job.jobId, decisions: result.decisions,
            outcomes: result.outcomes });
        }
        break;
      }
      case 'knowledge':
        emit({ command, jobId: job.jobId, knowledge: session.knowledge(),
          plans: session.plans, instances: session.instances });
        break;
      case 'assign': {
        const task = play.assign(rest[0], rest[1] as GameplayTaskKind);
        emit({ command, jobId: job.jobId, task, mode: 'reference-rules/1' });
        break;
      }
      case 'cancel-task':
        emit({ command, jobId: job.jobId, cancelled: play.cancelTask(rest[0]) });
        break;
      case 'task-status':
        emit({ command, jobId: job.jobId, status: play.status() });
        break;
      case 'game-step': {
        const result = play.step();
        emit({ command, jobId: job.jobId, ...result });
        break;
      }
      case 'map': {
        const mapId = (rest[0] ?? 'village') as keyof typeof MAPS;
        const map = MAPS[mapId];
        if (!map) throw new Error(`unknown map ${String(rest[0])} (village|warehouse|kitchen)`);
        emit({ command, jobId: job.jobId, map: { id: map.id, w: map.w, h: map.h,
          buildings: BUILDINGS.map(entry => ({ id: entry.id, door: entry.door })),
          interests: map.interests,
          closedCells: session.world.spatial?.closedCells ?? [] } });
        break;
      }
      case 'where': {
        const npc = session.world.npcs[rest[0]];
        if (!npc) throw new Error(`unknown npc ${String(rest[0])}`);
        emit({ command, jobId: job.jobId, npcId: rest[0], location: npc.location,
          cell: actorCell(session.world, rest[0]), alive: npc.alive });
        break;
      }
      case 'travel': {
        const input = inputIdFor('travel', rest);
        const actorId = input.parts[0];
        const npc = session.world.npcs[actorId];
        if (!npc) throw new Error(`unknown npc ${String(actorId)}`);
        const target = BUILDINGS.find(entry => entry.id === input.parts[1]);
        if (!target) throw new Error(`unknown building ${String(input.parts[1])} `
          + `(${BUILDINGS.map(entry => entry.id).join('|')})`);
        // R5: replay/conflict is decided on the canonical intent BEFORE a route
        // is planned. The route is derived only when the input is new.
        const result = session.submitSpatialIntent({ kind: 'travel', inputId: input.id,
          digest: JSON.stringify({ actorId, building: target.id }),
          build: () => {
            const from = actorCell(session.world, actorId);
            const route = findPath(MAPS.village, from, target.door,
              new Set(session.world.spatial?.closedCells ?? []));
            if (!route.path) throw new Error(`route blocked: ${route.blockedBy}`);
            return { commandId: input.id, type: 'travel', actorId, route: route.path,
              minutesPerTile: MINUTES_PER_TILE };
          } });
        const traveledEvent = result.events.find(entry => entry.type === 'traveled');
        const traveled = traveledEvent
          ? traveledEvent.payload as { tiles?: number; minutes?: number } : undefined;
        emit({ command, jobId: job.jobId, ...result,
          tiles: traveled?.tiles ?? 0, minutes: traveled?.minutes ?? 0,
          location: session.world.npcs[actorId].location });
        break;
      }
      case 'withdraw': {
        const input = inputIdFor('withdraw', rest);
        const actorId = input.parts[0];
        const result = play.submitSpatial({ commandId: input.id,
          type: 'withdraw', actorId, place: 'warehouse', resource: 'food',
          amount: Number(input.parts[1] ?? 1) });
        emit({ command, jobId: job.jobId, ...result,
          warehouseFood: session.world.spatial?.stocks.warehouse.food,
          carry: session.world.spatial?.carry[actorId]?.meals ?? 0 });
        break;
      }
      case 'deliver': {
        const input = inputIdFor('deliver', rest);
        const actorId = input.parts[0];
        const result = play.submitSpatial({ commandId: input.id,
          type: 'deliver', actorId, to: 'kitchen', amount: Number(input.parts[1] ?? 1) });
        emit({ command, jobId: job.jobId, ...result,
          deliveredMeals: session.world.spatial?.deliveredMeals ?? 0,
          carry: session.world.spatial?.carry[actorId]?.meals ?? 0 });
        break;
      }
      case 'restock': {
        const input = inputIdFor('restock', rest);
        const result = play.submitSpatial({ commandId: input.id,
          type: 'restock', place: 'warehouse', resource: 'food',
          amount: Number(input.parts[0]), source: input.parts[1] ?? 'player' });
        emit({ command, jobId: job.jobId, ...result,
          warehouseFood: session.world.spatial?.stocks.warehouse.food });
        break;
      }
      case 'close-road': {
        const input = inputIdFor('close-road', rest);
        const cells = parseCells(input.parts);
        const result = play.submitSpatial({ commandId: input.id,
          type: 'close-road', cells });
        emit({ command, jobId: job.jobId, ...result,
          closedCells: session.world.spatial?.closedCells ?? [] });
        break;
      }
      case 'open-road': {
        const input = inputIdFor('open-road', rest);
        const cells = parseCells(input.parts);
        const result = play.submitSpatial({ commandId: input.id,
          type: 'open-road', cells });
        emit({ command, jobId: job.jobId, ...result,
          closedCells: session.world.spatial?.closedCells ?? [] });
        break;
      }
      case 'deposit': {
        const input = inputIdFor('deposit', rest);
        const actorId = input.parts[0];
        const result = play.submitSpatial({ commandId: input.id,
          type: 'deposit', actorId, place: 'warehouse', resource: 'food',
          amount: Number(input.parts[1] ?? 1) });
        emit({ command, jobId: job.jobId, ...result,
          publicFood: session.world.resources.food,
          warehouseFood: session.world.spatial?.stocks.warehouse.food });
        break;
      }
      case 'request': {
        const input = inputIdFor('request', rest);
        const result = play.requestCommitment(input.parts[0],
          input.parts[1] ?? 'deliver-meal', { inputId: input.id });
        emit({ command, jobId: job.jobId, ...result, mode: 'reference-rules/1' });
        break;
      }
      case 'respond-change': {
        const input = inputIdFor('respond-change', rest);
        const verdict = input.parts[1] === 'accept' ? 'accept' as const : 'reject' as const;
        const result = play.respondChange(input.parts[0], verdict, { inputId: input.id });
        emit({ command, jobId: job.jobId, ...result, mode: 'reference-rules/1' });
        break;
      }
      case 'commitment-status':
        emit({ command, jobId: job.jobId, ...play.commitmentStatus(),
          mode: 'reference-rules/1' });
        break;
      case 'resume-commitment': {
        const input = inputIdFor('resume-commitment', rest);
        emit({ command, jobId: job.jobId,
          ...play.resumeCommitment(input.parts[0], { inputId: input.id,
            reason: input.parts[1] ?? 'player-ordered' }) });
        break;
      }
      case 'relinquish': {
        const input = inputIdFor('relinquish', rest);
        emit({ command, jobId: job.jobId,
          ...play.withdrawCommitment(input.parts[0], { inputId: input.id,
            reason: input.parts[1] ?? 'explicit-exit' }) });
        break;
      }
      case 'cancel-commitment': {
        const input = inputIdFor('cancel-commitment', rest);
        emit({ command, jobId: job.jobId,
          ...play.cancelCommitment(input.parts[0], { inputId: input.id }) });
        break;
      }
      case 'tell-restock': {
        emit({ command, jobId: job.jobId, ...session.tellRestock(rest[0]) });
        break;
      }
      case 'save':
        play.save(statePath);
        emit({ command, jobId: job.jobId, saved: statePath, version: session.world.version,
          tasks: play.board.tasks.length,
          commitments: play.commitments.all().map(row => ({ commitmentId: row.commitmentId,
            status: row.status, revision: row.revision })),
          pending: jobs.filter(entry => entry.kind === 'step' && !entry.terminal).length });
        break;
      case 'quit':
        emit({ command, jobId: job.jobId, bye: true, version: session.world.version });
        break;
      case '':
        break;
      default:
        throw new Error(`unknown command ${command}`);
    }
    if (job.terminal) {
      // A late scorer result must not overwrite the barrier's terminal record.
      // (Only the barrier sets terminal while this handler is still running.)
      emit({ event: 'job_late_result_ignored', jobId: job.jobId, kind: job.kind,
        status: 'cancelled',
        reason: String((job.detail as Record<string, unknown> | undefined)?.reason
          ?? 'cancelled') });
      return;
    }
    job.status = 'completed';
    job.terminal = true;
  } catch (error) {
    job.status = 'failed';
    job.terminal = true;
    job.detail = (error as Error).message;
    emit({ command, jobId: job.jobId, error: (error as Error).message });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', line => {
  const [command] = line.trim().split(/\s+/).filter(Boolean);
  const job: PlayerJob = { jobId: `job-${String(++sequence).padStart(4, '0')}`,
    kind: kindOf(command), status: 'pending', terminal: false, commandId: null };
  jobs.push(job);

  if (command === 'step') {
    // Start after everything already submitted (control commands queued before
    // this step, and the previous step), but do NOT block later control input.
    // The commit generation is captured HERE: a cancel accepted after this
    // line revokes it, so a queued step cannot execute an old choice.
    const rest = line.trim().split(/\s+/).filter(Boolean).slice(1);
    const expected: number | Record<string, number> = rest.length > 0
      ? session.generationFor(rest[0])
      : Object.fromEntries(session.npcIds.map(id => [id, session.generationFor(id)]));
    const before = controlChain;
    const actorIds = rest.length > 0 ? [rest[0]] : session.npcIds
      .filter(id => session.world.npcs[id]?.alive);
    const record = { job, actorIds, expected, captured: false } as StepJobRecord;
    const tracked = stepChain.then(() => before).then(() => {
      if (job.terminal) return runJob(job, line, expected);
      for (const id of actorIds) inFlightActors.add(id);
      return runJob(job, line, expected);
    }).finally(() => {
      for (const id of actorIds) inFlightActors.delete(id);
    });
    stepChain = tracked;
    record.done = tracked;
    stepJobs.add(record);
    void tracked.finally(() => { stepJobs.delete(record); });
    return;
  }

  if (command === 'save' || command === 'quit') {
    // R4 (G2): the barrier waits for the steps accepted BEFORE this line, but
    // only up to the settle bound. Control input (cancel/tell/cancel-task)
    // stays on its own chain, so a waiting save can never block a cancel:
    // the cancel revokes the generation and the pending step settles by
    // refusing its stale submission.
    // R5: the barrier captures exactly this set now. Later steps are outside it.
    const snapshot = [...stepJobs].filter(record => !record.job.terminal);
    for (const record of snapshot) record.captured = true;
    barrierChain = barrierChain.then(async () => {
      await controlChain;
      revokedByBarrier.length = 0;
      const settled = await settleWithin(snapshot, SETTLE_MS);
      job.detail = { settled, revokedByBarrier: [...revokedByBarrier] };
      await runJob(job, line);
      if (!settled) {
        emit({ command, event: 'barrier_timeout', revoked: [...revokedByBarrier],
          boundMs: SETTLE_MS });
      }
    });
    if (command === 'quit') {
      quitRequested = true;
      barrierChain = barrierChain.then(() => { closed = true; rl.close(); });
    }
    return;
  }

  controlChain = controlChain.then(() => runJob(job, line));
});

rl.on('close', () => {
  if (quitRequested) closed = true;
  // R4 (G2): EOF is a barrier too, and an unreturned scorer must not hold the
  // process open forever: bound the drain and revoke anything still running.
  const snapshot = [...stepJobs].filter(record => !record.job.terminal);
  for (const record of snapshot) record.captured = true;
  const drain = Promise.allSettled(snapshot.map(record => record.done))
    .then(() => stepChain).then(() => controlChain).then(() => barrierChain);
  void settleWithin(snapshot, SETTLE_MS, drain).then(settled => {
    if (!settled) {
      emit({ event: 'barrier_timeout', revoked: [...revokedByBarrier], boundMs: SETTLE_MS,
        at: 'eof' });
    }
    const open = jobs.filter(job => !job.terminal);
    if (open.length > 0) emit({ event: 'incomplete', open: open.map(job => job.jobId) });
    emit({ event: 'exit', jobs: jobs.length,
      completed: jobs.filter(job => job.status === 'completed').length,
      failed: jobs.filter(job => job.status === 'failed').length, closed,
      settled });
    // An explicitly revoked (timed-out) job is a recorded terminal state, not
    // a silent drop: exit nonzero only for jobs that never reached a terminal.
    process.exit(open.length > 0 ? 1 : 0);
  });
});
