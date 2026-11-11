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
 *   assign <npcId> <kind>       assign gather-food|gather-wood|heating|leave-food
 *   cancel-task <taskId>        cancel a task (cancelled leave-food retracts)
 *   task-status                task board + day/ending (reference-rules/1)
 *   advance <minutes>           authoritative time advance
 *   knowledge                   each NPC's own promise knowledge
 *   save                        persist session + task board (barrier)
 *   quit                        exit after the queue drains (barrier)
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PlaySession, defaultStatePath } from '../src/application-v2/session';
import type { PlayerJob, PlayerJobKind } from '../src/application-v2/lifecycle';
import { GameplayLoop } from '../src/gameplay-v2/loop';
import { TaskBoard, type GameplayTaskKind } from '../src/gameplay-v2/tasks';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const statePath = argValue('--state') ?? defaultStatePath();
const npcCount = Number(argValue('--npc') ?? 8);
const days = Number(argValue('--days') ?? 4);
const food = argValue('--food') === undefined ? undefined : Number(argValue('--food'));

const session = existsSync(statePath) && !process.argv.includes('--fresh')
  ? PlaySession.load(statePath)
  : PlaySession.create(npcCount, { days, food, seed: argValue('--seed') ?? `play-${npcCount}` });

// Gameplay tasks live beside the session; both are written by `save`.
const tasksPath = `${statePath}.tasks.json`;
const board = existsSync(tasksPath) && !process.argv.includes('--fresh')
  ? TaskBoard.fromJSON(JSON.parse(readFileSync(tasksPath, 'utf8'))) : new TaskBoard();
const play = new GameplayLoop(session, board);

const emit = (value: Record<string, unknown>) => console.log(JSON.stringify(value));
emit({ schema: 'frostecho.play/2', event: 'ready', statePath,
  restored: existsSync(statePath) && !process.argv.includes('--fresh'),
  day: session.world.day, simTime: session.world.simTime, npcs: session.npcIds });

const jobs: PlayerJob[] = [];
let sequence = 0;
/** Control commands: immediate, submission order. */
let controlChain: Promise<void> = Promise.resolve();
/** Step jobs: serialized among themselves, never blocking later control input. */
let stepChain: Promise<void> = Promise.resolve();
const pendingSteps = new Set<Promise<void>>();
let closed = false;
let quitRequested = false;

function kindOf(command: string): PlayerJobKind {
  const known: PlayerJobKind[] = ['observe', 'promise', 'cancel', 'tell', 'advance',
    'step', 'knowledge', 'save', 'quit', 'assign', 'cancel-task', 'task-status',
    'game-step'];
  return (known as string[]).includes(command) ? command as PlayerJobKind : 'observe';
}

async function runJob(job: PlayerJob, line: string,
  expected: number | Record<string, number> = 0): Promise<void> {
  const [command, ...rest] = line.trim().split(/\s+/).filter(Boolean);
  job.status = 'running';
  try {
    switch (command) {
      case 'observe':
        emit({ command, jobId: job.jobId, ...session.observe() });
        break;
      case 'promise': {
        job.commandId = rest[1] ?? job.jobId;
        emit({ command, jobId: job.jobId, ...session.playerPromise(rest[0], job.commandId) });
        break;
      }
      case 'cancel': {
        job.commandId = job.jobId;
        emit({ command, jobId: job.jobId, ...session.playerCancel(rest[0], rest[1]) });
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
          const decision = await session.stepActor(rest[0], undefined, expected as number);
          emit({ command, jobId: job.jobId, decisions: [decision],
            outcomes: [{ taskId: job.jobId, actorId: rest[0],
              status: decision.status === 'cancelled' ? 'cancelled' : 'completed',
              ...(decision.status === 'cancelled' ? {} : { value: decision }) }] });
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
      case 'save':
        session.save(statePath);
        writeFileSync(`${statePath}.tasks.json`,
          `${JSON.stringify(play.board.toJSON(), null, 2)}\n`, 'utf8');
        emit({ command, jobId: job.jobId, saved: statePath, version: session.world.version,
          tasks: play.board.tasks.length,
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
    stepChain = stepChain.then(() => before).then(() => runJob(job, line, expected));
    const tracked = stepChain;
    pendingSteps.add(tracked);
    void tracked.finally(() => pendingSteps.delete(tracked));
    return;
  }

  if (command === 'save' || command === 'quit') {
    // Barrier: drain in-flight steps accepted before this line, then act.
    const snapshot = [...pendingSteps];
    controlChain = controlChain
      .then(() => Promise.allSettled(snapshot))
      .then(() => runJob(job, line));
    if (command === 'quit') {
      quitRequested = true;
      controlChain = controlChain.then(() => { closed = true; rl.close(); });
    }
    return;
  }

  controlChain = controlChain.then(() => runJob(job, line));
});

rl.on('close', () => {
  if (quitRequested) closed = true;
  const drain = Promise.allSettled([...pendingSteps]).then(() => stepChain).then(() => controlChain);
  void drain.then(() => {
    const open = jobs.filter(job => !job.terminal);
    if (open.length > 0) emit({ event: 'incomplete', open: open.map(job => job.jobId) });
    emit({ event: 'exit', jobs: jobs.length,
      completed: jobs.filter(job => job.status === 'completed').length,
      failed: jobs.filter(job => job.status === 'failed').length, closed });
    process.exit(open.length > 0 ? 1 : 0);
  });
});
