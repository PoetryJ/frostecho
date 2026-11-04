/**
 * G10 worker A — the application controller.
 *
 * A thin forwarder over the existing createNeedsGame controller. No domain
 * truth is kept here: hunger, food, request status, bindings and the provider
 * budget all come from game/request/session on every read. One decision lane:
 * a step is at most one provider call, run N is at most N advances, and no
 * command ever advances world time implicitly or retries.
 */
import type { GoalRequestSnapshot } from '../negotiation/contracts';
import { G09_ALLOWED_GOALS, G09_REQUEST_TEXT } from '../negotiation/contracts';
import { createGoalRequest } from '../negotiation/requests';
import { EPISODE_CALL_LIMIT, SESSION_CALL_LIMIT } from '../reactive/contracts';
import type {
  ApplicationController, ApplicationPorts, AppCommand, AppNpcView, AppRequestView, AppView,
  ControllerCloseResult, ControllerDeps, ExecuteResult, FinalizationResult, GoalBinding,
  GoalRequestStore, NeedsGame, SaveCode,
} from './contracts';

const TERMINAL = new Set(['goal_reached', 'stopped', 'failed', 'invalid_run', 'budget_exhausted', 'timeout', 'provider_error', 'request_expired', 'insufficient_budget']);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ApplicationControllerImpl implements ApplicationController {
  private closed = false;
  private busy = false;
  private failed = false;
  private savedPath: string | null = null;
  private requestSeq = 0;
  private finalized: Promise<FinalizationResult> | null = null;
  private failureDetail: string | null = null;

  constructor(private readonly deps: ControllerDeps) {
    // A restored slot already holds host requests; never reuse their ordinal.
    this.requestSeq = Object.keys(this.deps.game.goalRequests().requests).length;
  }

  private get game(): NeedsGame { return this.deps.game; }

  isClosed(): boolean { return this.closed || this.game.isClosed(); }

  isBusy(): boolean { return this.busy; }

  hasFailed(): boolean { return this.failed; }

  lastSavedPath(): string | null { return this.savedPath; }

  async execute(command: AppCommand): Promise<ExecuteResult> {
    if (command.kind === 'help' || command.kind === 'status') return { ok: true, code: 'OK' };
    if (command.kind === 'quit') {
      // The ONE finalize (close + record + exit code) is driven by finalize();
      // quit itself must not snapshot a half-closed state.
      return { ok: true, code: 'OK', detail: this.failed ? '本次运行已记录失败；退出码非零，原因见 stderr' : undefined };
    }
    if (this.isClosed()) return { ok: false, code: 'CLOSED', detail: '本次运行已关闭' };
    switch (command.kind) {
      case 'request':
        if (command.goal !== 'yield_once') return { ok: false, code: 'REQUEST_REJECTED', detail: 'S1 只表达 yield_once' };
        return this.request(command.actorId, command.goal);
      case 'step': return this.decideOnce();
      case 'run': return this.run(command.steps);
      case 'player_move': return this.playerLine(`player move ${command.to}`);
      case 'player_eat': return this.playerLine('player eat');
      case 'world_time': return this.worldTime(command.steps);
      case 'world_restock': return this.worldRestock(command.location, command.amount);
      case 'save': return this.save(command.slot);
    }
  }

  private request(actorId: string, goal: 'yield_once'): ExecuteResult {
    if (this.deps.meta.goalMode !== 'negotiated') {
      return { ok: false, code: 'REQUEST_REJECTED', detail: '默认 legacy 模式不消费请求；请用 --goals negotiated 启动' };
    }
    this.requestSeq += 1;
    const requestId = `${this.deps.slot}-req-${this.requestSeq}`;
    const simTime = Number(this.game.world.getState().simTime ?? 0);
    const built = createGoalRequest({
      requestId,
      episodeId: this.deps.meta.episodeId,
      to: actorId,
      text: G09_REQUEST_TEXT,
      options: G09_ALLOWED_GOALS[this.deps.meta.candidateSet],
      createdAtSimTime: simTime,
      arm: this.deps.meta.candidateSet,
    });
    if (!built.ok) return { ok: false, code: 'REQUEST_REJECTED', detail: built.issues.join('; ') };
    const enqueued = this.game.submitGoalRequest(built.value);
    if (!enqueued.ok) return { ok: false, code: 'REQUEST_REJECTED', detail: (enqueued.issues ?? []).join('; ') };
    return { ok: true, code: 'OK' };
  }

  private async decideOnce(): Promise<ExecuteResult> {
    if (this.busy) return { ok: false, code: 'BUSY', advanced: 0 };
    this.busy = true;
    try {
      const outcome = await this.game.advance();
      switch (outcome.kind) {
        case 'stepped': {
          const status = outcome.result.status;
          if (status === 'timeout' || status === 'provider_error') {
            // The game latched a provider failure. It is a FAILURE (nonzero
            // exit + evidence), never a normal game result.
            this.failed = true;
            this.deps.ports.failure(new Error(`${outcome.actorId}: ${status}`));
            return { ok: false, code: 'PROVIDER_ERROR', advanced: 1, detail: status };
          }
          return { ok: true, code: 'OK', advanced: 1, detail: `${outcome.actorId} cycle=${outcome.cycle} ${status}` };
        }
        case 'idle':
          return { ok: false, code: 'IDLE', advanced: 0, detail: '没有可推进的决策' };
        case 'busy':
          return { ok: false, code: 'BUSY', advanced: 0 };
        case 'closed':
          return { ok: false, code: 'CLOSED', advanced: 0 };
        case 'interrupted':
          return { ok: false, code: 'IDLE', advanced: 0, detail: 'interrupted' };
      }
    } catch (error) {
      this.failed = true;
      this.deps.ports.failure(error);
      return { ok: false, code: 'PROVIDER_ERROR', advanced: 0, detail: messageOf(error) };
    } finally {
      this.busy = false;
    }
  }

  private async run(steps: number): Promise<ExecuteResult> {
    if (this.busy) return { ok: false, code: 'BUSY', advanced: 0 };
    let advanced = 0;
    let last: ExecuteResult = { ok: false, code: 'IDLE', advanced: 0 };
    while (advanced < steps) {
      const result = await this.decideOnce();
      if (!result.ok) { last = result; break; }
      advanced += 1;
      last = { ok: true, code: 'OK', advanced };
    }
    if (advanced === 0) return last;
    return { ok: true, code: 'OK', advanced };
  }

  private playerLine(line: string): ExecuteResult {
    const result = this.game.playerLine(line);
    return result.ok
      ? { ok: true, code: 'OK', detail: result.detail }
      : { ok: false, code: 'WORLD_REJECTED', detail: result.detail };
  }

  private worldTime(steps: number): ExecuteResult {
    const result = this.game.worldAdvanceTime(steps);
    return result.ok
      ? { ok: true, code: 'OK', detail: `${result.before} -> ${result.after}` }
      : { ok: false, code: 'WORLD_REJECTED', detail: result.error };
  }

  private worldRestock(location: 'kitchen' | 'dorm', amount: number): ExecuteResult {
    const result = this.game.worldRestock(location, amount);
    return result.ok
      ? { ok: true, code: 'OK', detail: `${location}+${amount}` }
      : { ok: false, code: 'WORLD_REJECTED', detail: result.error };
  }

  private save(slot: string): ExecuteResult {
    if (this.busy) return { ok: false, code: 'SAVE_BUSY', detail: '决策在途，本次不落半档', saveCode: 'SAVE_BUSY' };
    try {
      const saved = this.deps.ports.save(slot);
      if (saved.ok) {
        this.savedPath = saved.path;
        return { ok: true, code: 'OK', detail: saved.path ?? undefined, saveCode: 'OK' };
      }
      if (saved.fatal) {
        // A real write failure is durable: latch it so quit/EOF cannot turn
        // this run into a success. Keep the original code and cause.
        this.failed = true;
        this.failureDetail = saved.cause ?? saved.issues.join('; ');
        this.deps.ports.failure(new Error(`save ${saved.code}: ${this.failureDetail}`));
        return { ok: false, code: 'PERSISTENCE_FAILED', detail: `${saved.code}: ${this.failureDetail}`, saveCode: saved.code };
      }
      // EXISTS / INVALID_SLOT / SAVE_BUSY are named, actionable refusals.
      return {
        ok: false,
        code: saved.code === 'SAVE_BUSY' ? 'SAVE_BUSY' : 'SAVE_FAILED',
        detail: `${saved.code}: ${saved.issues.join('; ')}`,
        saveCode: saved.code,
      };
    } catch (error) {
      this.failed = true;
      this.failureDetail = messageOf(error);
      this.deps.ports.failure(error);
      return { ok: false, code: 'PERSISTENCE_FAILED', detail: messageOf(error) };
    }
  }

  finalize(): Promise<FinalizationResult> {
    if (this.finalized !== null) return this.finalized;
    this.finalized = this.doFinalize();
    return this.finalized;
  }

  private async doFinalize(): Promise<FinalizationResult> {
    const beforeCloseView = this.view();
    const errors: FinalizationResult['errors'] = [];
    try {
      await this.close();
    } catch (error) {
      this.failed = true;
      errors.push({ code: 'CLOSE_FAILED', message: messageOf(error) });
    }
    let recordPath: string | null = null;
    try {
      const record = this.deps.ports.writeRunRecord(beforeCloseView);
      if (record.ok) recordPath = record.path;
      else {
        this.failed = true;
        errors.push({
          code: 'PERSISTENCE_FAILED',
          message: `${record.code}: ${record.cause ?? (record.issues.join('; ') || 'run record was not written')}`,
        });
      }
    } catch (error) {
      this.failed = true;
      errors.push({ code: 'PERSISTENCE_FAILED', message: messageOf(error) });
    }
    const exitCode = this.failed ? 1 : 0;
    return { ok: exitCode === 0, exitCode, recordPath, errors, beforeCloseView };
  }

  view(): AppView {
    const state = this.game.world.getState();
    const snapshot = this.game.snapshot();
    const store: GoalRequestStore = this.game.goalRequests();
    const sessions = this.game.sessionsOf();
    const npcs: AppNpcView[] = sessions.map(entry => {
      const session = entry.session;
      const binding: GoalBinding | null = session.goalBinding;
      const own = Object.values(store.requests).filter(candidate => candidate.to === entry.actorId);
      const request = binding !== null ? (store.requests[binding.requestId] ?? null) : (own.at(-1) ?? null);
      const result = session.result();
      return {
        actorId: entry.actorId,
        cycle: entry.cycle,
        phase: session.phase,
        status: session.status,
        providerCalls: session.providerCalls,
        selectedGoal: binding?.goal ?? request?.decision?.goal ?? null,
        selectedGoalAchieved: binding?.goal === 'feed_self' || (binding === null && request?.decision?.goal === 'feed_self')
          ? result.hungerNeedSatisfied
          : result.selectedGoalReached,
        selectedGoalReached: result.selectedGoalReached,
        hungerNeedSatisfied: result.hungerNeedSatisfied,
        sessionOutcome: TERMINAL.has(session.status) ? result.outcome : null,
        wakeAtSimTime: session.wakeAtSimTime,
        request: request === null ? null : requestView(request),
      };
    });
    const npcA = npcs.find(entry => entry.actorId === 'npc_a');
    const player = state.npcs['npc_b'];
    const campaign = this.deps.ports.budget();
    return {
      episodeId: this.deps.meta.episodeId,
      mode: this.deps.config.mode,
      providerKind: this.deps.meta.providerKind,
      fixtureId: this.deps.meta.fixtureId,
      goalMode: this.deps.meta.goalMode,
      candidateSet: this.deps.meta.candidateSet,
      scripted: this.deps.meta.scripted,
      simTime: Number(state.simTime ?? 0),
      tick: Number(state.tick ?? 0),
      player: {
        actorId: 'npc_b',
        location: player?.location ?? 'unknown',
        hunger: player?.hunger ?? 0,
      },
      food: { kitchen: state.food?.kitchen ?? 0, dorm: state.food?.dorm ?? 0 },
      npcs,
      budget: {
        sessionCalls: npcA?.providerCalls ?? 0,
        sessionLimit: SESSION_CALL_LIMIT,
        episodeCalls: snapshot.actors['npc_a']?.providerCalls ?? npcA?.providerCalls ?? 0,
        episodeLimit: EPISODE_CALL_LIMIT,
      },
      campaign,
      savedPath: this.savedPath,
      closed: this.isClosed(),
      busy: this.busy,
    };
  }

  async close(): Promise<ControllerCloseResult> {
    if (this.closed) return { ok: !this.failed, failed: this.failed };
    this.closed = true;
    try {
      await this.game.close();
    } catch (error) {
      this.failed = true;
      this.deps.ports.failure(error);
    }
    return { ok: !this.failed, failed: this.failed };
  }
}

function requestView(request: GoalRequestSnapshot): AppRequestView {
  return {
    requestId: request.requestId,
    text: request.text,
    status: request.status,
    outcome: request.outcome,
    outcomeReason: request.outcomeReason,
    expiresAtSimTime: request.expiresAtSimTime,
    acceptedAfterSeq: request.acceptedAfterSeq ?? null,
    lastProcessedSeq: request.lastProcessedSeq ?? null,
    decidedGoal: request.decision?.goal ?? null,
  };
}

export function createApplicationController(deps: ControllerDeps): ApplicationController {
  return new ApplicationControllerImpl(deps);
}

/** Test-only convenience: an empty port set for controllers built by hand. */
export function emptyPorts(): ApplicationPorts {
  return {
    save: () => ({ ok: false, path: null, code: 'INVALID_SNAPSHOT', fatal: false, issues: ['no save adapter'], cause: null }),
    failure: () => null,
    budget: () => null,
    writeRunRecord: () => ({ ok: false, path: null, code: 'INTERNAL', cause: 'no run-record adapter', issues: [] }),
    now: () => Date.now(),
  };
}
