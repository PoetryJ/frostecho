/**
 * G08 closeout worker A — world causal chain.
 *
 * The verifier must prove that ONE decision produced ONE command and its
 * events. This module re-executes the recorded command ledger on a fresh
 * Engine (reusing the G07 `reexecuteCommands`) and additionally re-derives the
 * model action from the RAW response and requires the executed command to be
 * exactly that action. A ledger that is internally consistent but no longer
 * matches the model output is rejected, and so is a ledger whose commands the
 * Engine cannot reproduce.
 *
 * It never builds a provider, never issues a request and never writes.
 */
import { PLAYER_ACTOR_ID } from '../src/reactive/contracts';
import { canonical } from '../src/util';
import { G07_INITIAL_STATE, G07_TARGET, reexecuteCommands } from './g07-eval-lib';
import { strictG08Action } from './g08-evidence-contracts';
import type {
  DerivedBehavior, G08ParseOutcome, WorldAudit, WorldAuditEntry, WorldAuditRecord,
} from './g08-evidence-contracts';

/** The model's raw content inside a captured chat response, or null. */
function responseContent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

function statusOfCommand(entry: { result?: { status?: unknown } }): string | null {
  const status = entry.result?.status;
  return typeof status === 'string' ? status : null;
}

function reasonOfCommand(entry: { result?: { reason?: unknown } }): string | null {
  const reason = entry.result?.reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * Audit one episode: is the recorded world exactly the world that one model
 * decision must produce?
 */
export function auditWorldEpisode(entry: WorldAuditEntry, record: WorldAuditRecord): WorldAudit {
  const id = entry.episodeId;
  const issues: string[] = [];
  const snapshot = record?.snapshot;
  if (
    snapshot === undefined || snapshot === null
    || snapshot.initialState === undefined || snapshot.finalState === undefined
    || !Array.isArray(snapshot.commands) || !Array.isArray(snapshot.events)
  ) {
    return { issues: [`${id}: the record has no replayable command/event ledger`], derivedBehavior: null };
  }

  /* --- 1. the world started from the frozen experiment state --------- */
  const frozen = canonical(G07_INITIAL_STATE);
  if (canonical(record.initialState) !== frozen) {
    issues.push(`${id}: the episode's frozen initial state is not the experiment initial state`);
  }
  if (canonical(snapshot.initialState) !== frozen) {
    issues.push(`${id}: the game did not start from the experiment initial state`);
  }

  /* --- 2. the raw response must name the decision -------------------- */
  const rawContent = responseContent(record.http[0]?.response?.raw);
  let rawAction: G08ParseOutcome = null;
  if (rawContent === null) {
    issues.push(`${id}: the captured response carries no parseable raw content`);
  } else {
    rawAction = strictG08Action(rawContent);
    if (rawAction === 'invalid_output') {
      issues.push(`${id}: the raw response is not a legal action for any axis`);
    }
  }

  /* --- 3. re-execute the ledger on a fresh Engine -------------------- */
  issues.push(...reexecuteCommands({ plan: { episodeId: id }, snapshot }));

  /* --- 4. the executed command must BE the model action -------------- */
  const commands = snapshot.commands as {
    seq: number;
    command: { commandId: string; actorId: string; type: string; payload?: unknown };
    result?: { status?: string; reason?: string };
  }[];
  const npcCommands = commands.filter(c => c.command?.actorId === G07_TARGET);
  const playerCommands = commands.filter(c => c.command?.actorId === PLAYER_ACTOR_ID);
  const worldActorCommands = commands.filter(
    c => c.command?.actorId !== G07_TARGET && c.command?.actorId !== PLAYER_ACTOR_ID,
  );
  if (worldActorCommands.length > 0) {
    issues.push(`${id}: the episode ledger carries ${worldActorCommands.length} non-NPC/player command(s) that the protocol never produces`);
  }

  const action = rawAction === 'invalid_output' ? null : rawAction;
  if (action !== null) {
    if (action.type === 'eat' || action.type === 'move') {
      if (npcCommands.length !== 1) {
        issues.push(`${id}: the raw response says ${action.type} but the ledger holds ${npcCommands.length} ${G07_TARGET} command(s)`);
      } else {
        const command = npcCommands[0]!.command;
        if (command.type !== action.type) {
          issues.push(`${id}: the raw response says ${action.type} but the executed ${G07_TARGET} command is ${command.type}`);
        }
        if (action.type === 'move') {
          const to = (command.payload as { to?: unknown } | undefined)?.to;
          if (to !== action.to) {
            issues.push(`${id}: the raw response says move to ${String(action.to)} but the executed command moves to ${String(to)}`);
          }
        } else if (command.payload !== undefined && canonical(command.payload) !== canonical({})) {
          issues.push(`${id}: an eat command carries a payload`);
        }
        // The engine's own id scheme proves the command came from this run.
        if (!command.commandId.startsWith(`${id}:npc:${G07_TARGET}:`)) {
          issues.push(`${id}: the ${G07_TARGET} command id ${JSON.stringify(command.commandId)} does not follow the run's id scheme`);
        }
      }
    } else {
      // stop / wait never touch the world.
      if (npcCommands.length !== 0) {
        issues.push(`${id}: the raw response says ${action.type} but the ledger holds ${npcCommands.length} ${G07_TARGET} command(s)`);
      }
    }
  }

  /* --- 5. the player's single attempt follows the decision ----------- */
  const derived: DerivedBehavior = {
    actionSet: entry.actionSet,
    npcAction: action === null ? null : action.type,
    npcAte: false,
    playerEatStatus: null,
    waitAccepted: false,
    waitDeadline: null,
    npcState: null,
    providerCalls: 0,
  };
  if (npcCommands.length === 1 && npcCommands[0]!.command.type === 'eat' && statusOfCommand(npcCommands[0]!) === 'accepted') {
    derived.npcAte = true;
  }
  if (playerCommands.length > 1) {
    issues.push(`${id}: the protocol produces at most one player command, found ${playerCommands.length}`);
  }
  if (playerCommands.length === 1) {
    const player = playerCommands[0]!;
    if (player.command.type !== 'eat') {
      issues.push(`${id}: the player attempt is a ${player.command.type}, the protocol only replays eat`);
    }
    if (npcCommands.length === 1 && player.seq <= npcCommands[0]!.seq) {
      issues.push(`${id}: the player attempt runs before the NPC decision (seq ${player.seq})`);
    }
    derived.playerEatStatus = statusOfCommand(player);
  }
  if (record.outcome === 'completed' && playerCommands.length !== 1) {
    issues.push(`${id}: a completed episode must record exactly one player attempt, found ${playerCommands.length}`);
  }
  if (record.outcome === 'invalid_output' && commands.length > 0) {
    issues.push(`${id}: an invalid-output episode must not execute any world command, found ${commands.length}`);
  }

  /* --- 6. derive the wait state from the game, not from flags ------- */
  const actors = (snapshot.actors ?? {}) as Record<string, { state?: unknown; providerCalls?: unknown }>;
  const npcActor = actors[G07_TARGET];
  derived.npcState = typeof npcActor?.state === 'string' ? npcActor.state : null;
  derived.providerCalls = typeof npcActor?.providerCalls === 'number' ? npcActor.providerCalls : 0;
  const deadlines = (snapshot.wakeAtSimTime ?? {}) as Record<string, number | null | undefined>;
  derived.waitDeadline = deadlines[G07_TARGET] ?? null;
  derived.waitAccepted = derived.npcState === 'timed_wait';

  const simTime = (snapshot.initialState as { simTime?: unknown }).simTime;
  if (derived.waitAccepted) {
    if (entry.actionSet !== 'timed_wait') {
      issues.push(`${id}: a paused ${G07_TARGET} on the legacy axis is impossible`);
    }
    if (action === null || action.type !== 'wait') {
      issues.push(`${id}: ${G07_TARGET} is paused but the raw response did not decide wait`);
    }
    const expected = typeof simTime === 'number' ? simTime + 1 : null;
    if (derived.waitDeadline === null) {
      issues.push(`${id}: the paused ${G07_TARGET} has no deadline`);
    } else if (expected !== null && derived.waitDeadline !== expected) {
      issues.push(`${id}: the wait deadline ${derived.waitDeadline} is not simTime ${simTime} + 1`);
    }
  } else if (action !== null && action.type === 'wait') {
    issues.push(`${id}: the raw response decided wait but ${G07_TARGET} is not paused`);
  }

  /* --- 7. the recorded behavior must agree with the derivation ------ */
  const behavior = record.behavior as {
    actionSet?: unknown;
    npcAction?: unknown;
    npcAte?: unknown;
    npcEat?: { status?: unknown; reason?: unknown } | null;
    playerEatCommand?: { status?: unknown } | null;
    wait?: { accepted?: unknown; wakeAtSimTime?: unknown };
  } | null;
  if (behavior === null || behavior === undefined) {
    if (record.outcome === 'completed') {
      issues.push(`${id}: a completed episode carries no behavior record`);
    }
    return { issues, derivedBehavior: derived };
  }
  if (behavior.actionSet !== entry.actionSet) {
    issues.push(`${id}: behavior actionSet ${JSON.stringify(behavior.actionSet)} does not match the plan axis ${entry.actionSet}`);
  }
  if (action !== null && canonical(behavior.npcAction ?? null) !== canonical(action)) {
    issues.push(`${id}: behavior.npcAction ${JSON.stringify(behavior.npcAction ?? null)} does not match the raw decision ${JSON.stringify(action)}`);
  }
  if (behavior.npcAte !== derived.npcAte) {
    issues.push(`${id}: behavior.npcAte ${String(behavior.npcAte)} contradicts the re-executed ledger (${String(derived.npcAte)})`);
  }
  if (npcCommands.length === 1 && npcCommands[0]!.command.type === 'eat') {
    if (behavior.npcEat?.status !== statusOfCommand(npcCommands[0]!)) {
      issues.push(`${id}: behavior.npcEat.status ${String(behavior.npcEat?.status)} contradicts the executed eat command (${String(statusOfCommand(npcCommands[0]!))})`);
    }
  }
  const recordedPlayerStatus = behavior.playerEatCommand?.status ?? null;
  if (recordedPlayerStatus !== derived.playerEatStatus) {
    issues.push(`${id}: behavior.playerEatCommand.status ${JSON.stringify(recordedPlayerStatus)} contradicts the executed player command (${JSON.stringify(derived.playerEatStatus)})`);
  }
  const recordedWait = behavior.wait?.accepted === true;
  if (recordedWait !== derived.waitAccepted) {
    issues.push(`${id}: behavior.wait.accepted ${String(recordedWait)} contradicts the derived game state (${String(derived.waitAccepted)})`);
  }
  if ((behavior.wait?.wakeAtSimTime ?? null) !== derived.waitDeadline) {
    issues.push(`${id}: behavior.wait.wakeAtSimTime ${JSON.stringify(behavior.wait?.wakeAtSimTime ?? null)} contradicts the derived deadline ${JSON.stringify(derived.waitDeadline)}`);
  }
  if (derived.providerCalls !== 1) {
    issues.push(`${id}: the re-executed ${G07_TARGET} session records ${derived.providerCalls} provider call(s), expected 1`);
  }
  if (reasonOfCommand(playerCommands[0] ?? {}) !== ((behavior.playerEatCommand as { reason?: unknown } | null | undefined)?.reason ?? null)) {
    issues.push(`${id}: behavior.playerEatCommand.reason contradicts the executed player command`);
  }

  return { issues, derivedBehavior: derived };
}
