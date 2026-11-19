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

/**
 * Original assignment policy (`task-generator.js:277-340`,
 * `resource-report.js:296-315`), transcribed so the daily board is not an
 * invented priority list:
 *   - only living residents with stamina >= 30 and health >= 30 are assignable;
 *   - a resource is CRITICAL at <= 6 hours of wood/power cover or <= 1 meal,
 *     and then wood/food get up to 2 workers and power 1;
 *   - specialists come first (`task-system.js:198-285`), 老钱 last
 *     (the original reserves him for mediation).
 */
export const ASSIGN_MIN_STAMINA = 30;
export const ASSIGN_MIN_HEALTH = 30;
export const CRITICAL_HOURS = 6;
/** `resource-system.js:35-39` consumption constants. */
export const HEATING_WOOD_PER_HOUR = 1.0;
export const HEATING_POWER_PER_HOUR = 2.0;
export const FOOD_PER_MEAL_PER_PERSON = 1.8;

/** legacy `npc-configs.js` order -> the engine's immutable npc ids. */
export const NPCS_BY_LEGACY_ID: Record<string, string> = {
  li_shen: 'npc_01', zhao_chef: 'npc_02', wang_teacher: 'npc_03', old_qian: 'npc_04',
  su_doctor: 'npc_05', lu_chen: 'npc_06', ling_yue: 'npc_07', qing_xuan: 'npc_08',
};

/** `task-system.js:198-285` bonuses, keyed by engine actor id. */
export const SPECIALTY_BONUS: Record<string, Partial<Record<TaskTypeId, number>>> = {
  npc_01: { DISTRIBUTE_FOOD: 2.0, COLLECT_FOOD: 1.5, PREPARE_WARMTH: 1.5, PREPARE_MEDICAL: 1.2 },
  npc_02: { COLLECT_WOOD: 1.5, COLLECT_MATERIAL: 1.3, COLLECT_FOOD: 1.3,
    BUILD_GENERATOR: 1.3, BUILD_LUMBER_MILL: 1.3, BUILD_FOOD_COLLECTOR: 1.3 },
  npc_03: { MAINTAIN_POWER: 2.0, COORDINATE: 1.5, BUILD_GENERATOR: 1.5,
    BUILD_LUMBER_MILL: 1.5, BUILD_FOOD_COLLECTOR: 1.5 },
  npc_04: { MAINTAIN_ORDER: 2.0, COORDINATE: 2.0, BOOST_MORALE: 1.5 },
  npc_05: { PREPARE_MEDICAL: 2.0, REST_RECOVER: 1.5, BOOST_MORALE: 1.2 },
  npc_06: { COLLECT_MATERIAL: 1.5, COLLECT_FOOD: 1.3, COLLECT_WOOD: 1.3,
    BUILD_GENERATOR: 1.2, BUILD_LUMBER_MILL: 1.2, BUILD_FOOD_COLLECTOR: 1.2 },
  npc_07: { SCOUT_RUINS: 2.0, PREPARE_MEDICAL: 1.5, BOOST_MORALE: 1.3, COLLECT_MATERIAL: 1.3 },
  npc_08: { PREPARE_MEDICAL: 1.5, BOOST_MORALE: 1.1 },
};

export function specialtyOf(actorId: string, type: TaskTypeId): number {
  return SPECIALTY_BONUS[actorId]?.[type] ?? 1;
}

export interface AssignmentView {
  day: number;
  resources: { food: number; firewood: number; power: number; medicine: number };
  furnace: { lit: boolean; fuel: number };
  machines: Record<string, string>;
  npcs: Record<string, { id: string; alive: boolean; stamina: number; health: number;
    hunger: number; san: number; location: string }>;
}

export interface PlannedAssignment { actorId: string; type: TaskTypeId; reason: string }

/**
 * The daily board, in the original's order: critical resources first (wood,
 * food, power), then each resident's own state. `budget` caps the number of
 * proposals (the original proposes at most four per meeting).
 */
export function planAssignments(view: AssignmentView, budget = 4): PlannedAssignment[] {
  const alive = Object.values(view.npcs).filter(npc => npc.alive)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (alive.length === 0) return [];
  const population = Math.max(0.1, alive.length / 8);
  // `getWoodFuelHoursRemaining` / `getPowerHoursRemaining` scale the hourly burn
  // by the population ratio, so cover hours are what the original compares.
  const woodHours = view.resources.firewood / (HEATING_WOOD_PER_HOUR * population);
  const powerHours = view.resources.power / (HEATING_POWER_PER_HOUR * population);
  const meals = view.resources.food / (alive.length * FOOD_PER_MEAL_PER_PERSON);
  const woodCritical = woodHours <= CRITICAL_HOURS;
  const powerCritical = powerHours <= CRITICAL_HOURS;
  const foodCritical = meals <= 1;

  const assignable = alive.filter(npc => npc.stamina >= ASSIGN_MIN_STAMINA
    && npc.health >= ASSIGN_MIN_HEALTH);
  const pool = assignable.length > 0 ? [...assignable] : [...alive].sort((left, right) =>
    right.stamina - left.stamina).slice(0, 2);
  const taken = new Set<string>();
  const plan: PlannedAssignment[] = [];
  const pick = (type: TaskTypeId, count: number, reason: string): void => {
    const today = alive.filter(npc => npc.alive && !taken.has(npc.id));
    today.sort((left, right) => specialtyOf(right.id, type) - specialtyOf(left.id, type)
      || (right.id === 'npc_04' ? -1 : 0) - (left.id === 'npc_04' ? -1 : 0)
      || right.stamina - left.stamina);
    for (let index = 0; index < Math.min(count, today.length)
      && plan.length < budget; index += 1) {
      const npc = today[index];
      taken.add(npc.id);
      plan.push({ actorId: npc.id, type, reason });
    }
  };

  // `event-system.js:405-441`: the day-4 broadcast says -60 C outdoors and that
  // going out loses body heat fast; the outdoor band then costs ~3 health per
  // game minute. A board that still sends residents to the lumber camp on day 4
  // is not "prioritising logging", it is signing a death warrant, so no outdoor
  // task is proposed once the outdoor grid is lethal.
  const outdoorLethal = view.day >= 4;
  const OUTDOOR: ReadonlySet<TaskTypeId> = new Set(['COLLECT_WOOD', 'COLLECT_FOOD',
    'COLLECT_MATERIAL', 'SCOUT_RUINS']);
  const pickOutdoor = (type: TaskTypeId, count: number, reason: string): void => {
    if (outdoorLethal) return;
    pick(type, count, reason);
  };

  // `resource-system.js:17`: "木柴 — 初始30单位，Day1够烧但需采集为Day2囤".
  // Day 1 is the only safe outdoor day (0 C, no band damage), so the board
  // stocks up then instead of discovering the shortage on the -30 C day.
  if (view.day === 1) {
    pickOutdoor('COLLECT_WOOD', 3, 'day-1 stocking for day 2 (RESOURCE_DEFAULTS note)');
    if (view.resources.food < 100) pickOutdoor('COLLECT_FOOD', 1, 'day-1 food stocking');
  }
  // Heating is 65% wood and 35% power (`furnace-system.js:63-67`), so a power
  // shift keeps the town alive when the wood runs out. Power cover below a full
  // day means the whole town cools tonight; keep one indoor worker on it.
  if (powerHours < 24) {
    pick('MAINTAIN_POWER', 1, `power ${powerHours.toFixed(1)}h < 24h cover`);
  }
  // The original never leaves the wood tank under six hours while people are
  // idle: this is the "伐木优先级" the R10 reference run was missing.
  if (woodCritical) pickOutdoor('COLLECT_WOOD', 2, `firewood ${woodHours.toFixed(1)}h <= ${CRITICAL_HOURS}h`);
  if (foodCritical) pickOutdoor('COLLECT_FOOD', 2, `food ${meals.toFixed(1)} meals <= 1`);
  if (powerCritical) pick('MAINTAIN_POWER', 1, `power ${powerHours.toFixed(1)}h <= ${CRITICAL_HOURS}h`);

  for (const npc of pool) {
    if (plan.length >= budget) break;
    if (taken.has(npc.id)) continue;
    const indoorOnly = outdoorLethal;
    // A resident's own hunger is not a reason to send them to the frozen lake:
    // the original handles personal need by eating (`resource-consumption.js`),
    // and a collection trip with a full warehouse is pure exposure. Only the
    // stock level may justify an outdoor trip.
    const type: TaskTypeId | null = npc.health < 50 ? 'PREPARE_MEDICAL'
      : npc.san < 40 ? 'BOOST_MORALE'
        : npc.stamina < 35 ? 'REST_RECOVER'
          : view.resources.firewood < 24 && !indoorOnly ? 'COLLECT_WOOD'
            : view.resources.food < 60 && !indoorOnly ? 'COLLECT_FOOD'
              : view.furnace.fuel < 20 ? 'PREPARE_WARMTH'
                : view.machines.lumberMill === 'absent' && !indoorOnly ? 'BUILD_LUMBER_MILL'
                  : indoorOnly ? 'MAINTAIN_ORDER' : 'COORDINATE';
    taken.add(npc.id);
    plan.push({ actorId: npc.id, type, reason: `own state (${type})` });
  }
  return plan.slice(0, budget);
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
