/**
 * Four-day playable loop (P, R2). Composes the frozen PlaySession authority
 * path (candidate -> authoritative command -> events -> memory) with a
 * deterministic reference task policy. Mode is always reported as
 * `reference-rules/1`; this is not model understanding.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PlaySession } from '../application-v2/session';
import { TaskBoard, type GameplayTask, type GameplayTaskKind } from './tasks';
import { buildGameplayCandidates, chooseReference,
  type GameplayStepRecord } from './decisions';

export interface GameplayStepResult {
  records: GameplayStepRecord[];
  executed: number;
  mode: 'reference-rules/1';
}

const KIND_TO_TASK: Record<string, GameplayTaskKind> = {
  'gather-food': 'gather-food', 'gather-wood': 'gather-wood',
  heating: 'heating', 'leave-food': 'leave-food',
};

export class GameplayLoop {
  constructor(readonly session: PlaySession,
    readonly board: TaskBoard = new TaskBoard()) {}

  static create(npcCount = 8, options: { days?: number; seed?: string; food?: number } = {}):
    GameplayLoop {
    return new GameplayLoop(PlaySession.create(npcCount, options));
  }

  /** Assign one task; `leave-food` also creates a promise instance for that NPC. */
  assign(actorId: string, kind: GameplayTaskKind): GameplayTask {
    if (!KIND_TO_TASK[kind]) throw new Error(`unknown task kind ${kind}`);
    const existing = this.board.activeFor(actorId).find(task => task.kind === kind);
    if (existing) return existing;
    let promiseId: string | undefined;
    if (kind === 'leave-food') {
      promiseId = this.session.playerPromise(actorId).promiseId;
    }
    return this.board.assign(actorId, kind,
      { promiseId, now: this.session.world.simTime });
  }

  /** Cancel a task. A cancelled leave-food task also retracts its promise. */
  cancelTask(taskId: string): boolean {
    const task = this.board.find(taskId);
    if (!task) return false;
    if (!this.board.cancel(taskId)) return false;
    if (task.kind === 'leave-food') this.session.playerCancel(task.actorId);
    return true;
  }

  /** One decision per alive NPC, executed through the authoritative session path. */
  step(): GameplayStepResult {
    const records: GameplayStepRecord[] = [];
    const knowledge = this.session.knowledge();
    for (const actorId of this.session.npcIds) {
      const npc = this.session.world.npcs[actorId];
      if (!npc?.alive) continue;
      const relation = knowledge[actorId]?.relation as { trust?: number } | null;
      const trust = typeof relation?.trust === 'number' ? relation.trust : 0;
      const { candidates, conflict } = buildGameplayCandidates({
        actorId, npc: { id: npc.id, hunger: npc.hunger, stamina: npc.stamina,
          health: npc.health, san: npc.san, alive: npc.alive },
        resources: this.session.world.resources, furnace: this.session.world.furnace,
        tasks: this.board.activeFor(actorId), relationTrust: trust,
      });
      const chosen = chooseReference(candidates);
      const commandId = `${actorId}-game-${this.session.world.version}-${chosen.candidate.id}`;
      const outcome = this.session.executeCandidate(actorId, chosen.candidate, commandId);
      if (outcome.status === 'applied') {
        const taskKind = chosen.candidate.id === 'g-gather-food' ? 'gather-food'
          : chosen.candidate.id === 'g-gather-wood' ? 'gather-wood'
            : chosen.candidate.id === 'g-heat' ? 'heating'
              : chosen.candidate.id.startsWith('c-help-') ? 'leave-food' : null;
        if (taskKind) {
          const task = this.board.activeFor(actorId).find(entry => entry.kind === taskKind);
          if (task) this.board.complete(task.taskId);
        }
      }
      records.push({ actorId, selectedId: chosen.candidate.id,
        executed: outcome.status === 'applied', reason: chosen.rule,
        conflict, candidates: candidates.map(entry => ({ id: entry.candidate.id,
          utility: entry.utility, rule: entry.rule })), mode: 'reference-rules/1' });
    }
    return { records, executed: records.filter(record => record.executed).length,
      mode: 'reference-rules/1' };
  }

  advance(minutes: number): { status: string; simTime: number; eventIds: string[] } {
    return this.session.advance(minutes);
  }

  status(): Record<string, unknown> {
    return { day: this.session.world.day, simTime: this.session.world.simTime,
      hoursElapsed: this.session.world.simTime / 60, ending: this.session.world.ending,
      mode: 'reference-rules/1', tasks: this.board.toJSON(),
      resources: this.session.world.resources };
  }

  /** Session + task-board sidecar; the sidecar keeps save/restore honest. */
  save(path: string): void {
    this.session.save(path);
    writeFileSync(`${path}.tasks.json`, `${JSON.stringify(this.board.toJSON(), null, 2)}\n`,
      'utf8');
  }

  static load(path: string): GameplayLoop {
    const session = PlaySession.load(path);
    const sidecar = `${path}.tasks.json`;
    const board = existsSync(sidecar)
      ? TaskBoard.fromJSON(JSON.parse(readFileSync(sidecar, 'utf8'))) : new TaskBoard();
    return new GameplayLoop(session, board);
  }
}

/** Structured player commands this module exposes (owner wires them into the CLI). */
export const GAMEPLAY_COMMANDS = [
  { name: 'assign', usage: 'assign <npcId> <gather-food|gather-wood|heating|leave-food>' },
  { name: 'cancel-task', usage: 'cancel-task <taskId>' },
  { name: 'task-status', usage: 'task-status' },
] as const;
