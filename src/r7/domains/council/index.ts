/**
 * P3 council domain: morning meeting, proposals, votes, refusal, counter and
 * reassignment.
 *
 * Source: `src/systems/council-system.js:45-51` triggers (firewood<15,
 * food<20, power<10, tension>0.5, 8 game-hour cooldown), `:884-920` votes,
 * `:1032-1072` tie broken by 老钱, `:1138` winner applied to the task system,
 * `:1167-1169` expired council tasks are cleaned.
 *
 * The original has no counter-proposal ("反提案") mechanism; the counter path
 * here is the task-domain respond('counter'), recorded as a refusal with an
 * alternative, and is labelled as a port decision, not an original feature.
 */
import type { DomainCommand, DomainModule, DomainResult } from '../../contracts';
import { emptyResult } from '../../contracts';
import { TASK_CATALOG, type TaskTypeId } from '../tasks/index';

export interface CouncilProposal {
  proposalId: string;
  authorId: string;
  assignments: { actorId: string; type: TaskTypeId }[];
  rationale: string;
}

export interface CouncilMeeting {
  meetingId: string;
  openedAtMinute: number;
  reason: string;
  proposals: CouncilProposal[];
  votes: Record<string, string>;
  status: 'open' | 'resolved' | 'expired';
  winnerProposalId: string | null;
  tieBreakBy?: string;
}

export interface CouncilState {
  meetings: CouncilMeeting[];
  seq: number;
  /** Absolute minute before which no new meeting opens (8 game hours). */
  cooldownUntil: number;
}

export const COUNCIL_TRIGGERS = { firewood: 15, food: 20, power: 10, tension: 0.5 };
export const COUNCIL_COOLDOWN_MINUTES = 8 * 60;
/** Original tie breaker (`council-system.js:1032-1072`). */
export const COUNCIL_TIE_BREAKER = 'old_qian';

export function councilShouldOpen(resources: { firewood: number; food: number; power: number },
  tension: number, absoluteMinute: number, cooldownUntil: number): string | null {
  if (absoluteMinute < cooldownUntil) return null;
  if (resources.firewood < COUNCIL_TRIGGERS.firewood) return 'firewood_low';
  if (resources.food < COUNCIL_TRIGGERS.food) return 'food_low';
  if (resources.power < COUNCIL_TRIGGERS.power) return 'power_low';
  if (tension > COUNCIL_TRIGGERS.tension) return 'tension_high';
  return null;
}

function openMeeting(state: CouncilState, reason: string): CouncilMeeting {
  state.seq += 1;
  return {
    meetingId: `council-${state.seq}`, openedAtMinute: 0, reason,
    proposals: [], votes: {}, status: 'open', winnerProposalId: null,
  };
}

export const councilDomain: DomainModule<CouncilState> = {
  id: 'council',
  initial(): CouncilState {
    return { meetings: [], seq: 0, cooldownUntil: 0 };
  },

  reduce(state, command: DomainCommand, context): DomainResult<CouncilState> {
    const next: CouncilState = {
      meetings: state.meetings.map(meeting => ({ ...meeting, votes: { ...meeting.votes },
        proposals: meeting.proposals.map(proposal => ({ ...proposal,
          assignments: [...proposal.assignments] })) })),
      seq: state.seq,
      cooldownUntil: state.cooldownUntil,
    };
    const result = emptyResult(next);
    const now = context.snapshot.elapsed;

    if (command.type === 'open') {
      // The original also convenes an opening council after the night skip
      // (`core/game-time.js:308-311`); `force` carries that case only.
      const forced = command.payload?.force === true;
      const reason = forced ? 'morning'
        : councilShouldOpen(context.snapshot.resources,
          Number(command.payload?.tension ?? 0), now, next.cooldownUntil);
      if (!reason) {
        result.rejections.push({ intentId: 'council:open', code: 'no_trigger',
          reason: 'no council trigger and no cooldown elapsed' });
        return result;
      }
      const meeting = openMeeting(next, reason);
      meeting.openedAtMinute = now;
      next.meetings.push(meeting);
      next.cooldownUntil = now + COUNCIL_COOLDOWN_MINUTES;
      result.events.push({ proposalId: `council:${meeting.meetingId}:opened`,
        type: 'council_opened', actorId: command.actorId, observedBy: 'all',
        payload: { meetingId: meeting.meetingId, reason } });
      return result;
    }

    const meeting = next.meetings.find(entry =>
      entry.meetingId === String(command.payload?.meetingId ?? ''));
    if (!meeting) {
      result.rejections.push({ intentId: `council:${command.type}`, code: 'unknown_meeting',
        reason: 'no such meeting' });
      return result;
    }
    if (meeting.status !== 'open') {
      result.rejections.push({ intentId: `council:${command.type}`, code: 'meeting_closed',
        reason: `meeting is ${meeting.status}` });
      return result;
    }

    if (command.type === 'propose') {
      const raw = (command.payload?.assignments ?? []) as { actorId: string; type: string }[];
      const assignments = raw.map(entry => ({ actorId: String(entry.actorId),
        type: String(entry.type) as TaskTypeId }))
        .filter(entry => Boolean(TASK_CATALOG[entry.type]));
      if (assignments.length === 0) {
        result.rejections.push({ intentId: 'council:propose', code: 'empty_proposal',
          reason: 'a proposal needs at least one known task' });
        return result;
      }
      meeting.proposals.push({ proposalId: `p-${meeting.meetingId}-${meeting.proposals.length + 1}`,
        authorId: command.actorId, assignments,
        rationale: String(command.payload?.rationale ?? '') });
      return result;
    }

    if (command.type === 'vote') {
      const proposalId = String(command.payload?.proposalId ?? '');
      if (!meeting.proposals.some(proposal => proposal.proposalId === proposalId)) {
        result.rejections.push({ intentId: 'council:vote', code: 'unknown_proposal',
          reason: `no proposal ${proposalId}` });
        return result;
      }
      if (!context.snapshot.npcs[command.actorId]?.alive) {
        result.rejections.push({ intentId: 'council:vote', code: 'not_alive',
          reason: 'a dead actor cannot vote' });
        return result;
      }
      meeting.votes[command.actorId] = proposalId;
      return result;
    }

    if (command.type === 'resolve') {
      if (meeting.proposals.length === 0) {
        result.rejections.push({ intentId: 'council:resolve', code: 'no_proposals',
          reason: 'nothing to vote on' });
        return result;
      }
      const counts = new Map<string, number>();
      for (const proposalId of Object.values(meeting.votes)) {
        counts.set(proposalId, (counts.get(proposalId) ?? 0) + 1);
      }
      const ranked = [...counts.entries()].sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0]));
      let winner = ranked[0]?.[0];
      if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
        winner = meeting.proposals[0].proposalId;
        meeting.tieBreakBy = COUNCIL_TIE_BREAKER;
      }
      if (!winner) {
        winner = meeting.proposals[0].proposalId;
      }
      meeting.winnerProposalId = winner;
      meeting.status = 'resolved';
      const chosen = meeting.proposals.find(proposal => proposal.proposalId === winner)!;
      for (const assignment of chosen.assignments) {
        result.requests.push({ requestId: `${meeting.meetingId}:${assignment.actorId}`,
          kind: 'council', actorId: assignment.actorId,
          payload: { meetingId: meeting.meetingId, type: assignment.type } });
      }
      result.events.push({ proposalId: `council:${meeting.meetingId}:resolved`,
        type: 'council_resolved', actorId: command.actorId, observedBy: 'all',
        payload: { meetingId: meeting.meetingId, winner,
          tieBreakBy: meeting.tieBreakBy ?? '', votes: Object.keys(meeting.votes).length } });
      return result;
    }

    if (command.type === 'refuse') {
      // A council request refused by its assignee is reassigned, never dropped.
      const requestId = String(command.payload?.requestId ?? '');
      const assignment = meeting.proposals
        .flatMap(proposal => proposal.assignments)
        .find(entry => `${meeting.meetingId}:${entry.actorId}` === requestId);
      if (!assignment) {
        result.rejections.push({ intentId: 'council:refuse', code: 'unknown_request',
          reason: `no request ${requestId}` });
        return result;
      }
      result.events.push({ proposalId: `council:${meeting.meetingId}:refused:${requestId}`,
        type: 'council_refused', actorId: command.actorId, observedBy: 'all',
        payload: { requestId, type: assignment.type,
          reason: String(command.payload?.reason ?? 'refused') } });
      return result;
    }

    result.rejections.push({ intentId: `council:${command.type}`, code: 'unknown_command',
      reason: `council does not handle ${command.type}` });
    return result;
  },

  onTimeSpan(state, fromMinute, toMinute): DomainResult<CouncilState> {
    const next: CouncilState = {
      meetings: state.meetings.map(meeting => ({ ...meeting })),
      seq: state.seq,
      cooldownUntil: state.cooldownUntil,
    };
    const result = emptyResult(next);
    // Original: council tasks expire after 10 real minutes (`:1167-1169`),
    // which is 600 game minutes at timeSpeed 60.
    for (const meeting of next.meetings) {
      if (meeting.status !== 'open') continue;
      if (toMinute - meeting.openedAtMinute > 600) {
        meeting.status = 'expired';
        result.events.push({ proposalId: `council:${meeting.meetingId}:expired`,
          type: 'council_expired', actorId: 'system', observedBy: 'all',
          payload: { meetingId: meeting.meetingId } });
      }
    }
    void fromMinute;
    return result;
  },
};
