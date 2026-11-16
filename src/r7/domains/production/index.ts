/**
 * P1 production domain: central heating, the three original machines, and the
 * power/wood/food conversions.
 *
 * Values are read back out of `src/systems/machine-system.js:30-78` (v4.37):
 *   generator     : wood 3.0/h  -> power 20/h, stops below 5 wood
 *   lumberMill    : power 4.0/h -> wood 24/h,  stops below 5 power
 *   foodCollector : power 3.0/h -> food 12/h,  stops below 5 power
 *   build         : power 10/12/10 + wood 12/15/15, 4h/5h/5h, one worker
 * Production is proportional to the input actually consumed
 * (`machine-system.js:509-521`), so a half-empty tank cannot yield a full hour.
 *
 * Correction against the first R8 draft: the draft used 8/6/5 per hour and let a
 * starved machine keep producing. Both are counterexamples in the completion
 * pack and are fixed here.
 */
import type { ActorDelta, DomainCommand, DomainModule, DomainResult,
  MachineId, MachineState } from '../../contracts';
import { emptyResult } from '../../contracts';

export interface ProductionState {
  machines: Record<MachineId, MachineState>;
  buildRemaining: Partial<Record<MachineId, number>>;
  /** The worker that must be present for the build to advance. */
  buildWorker: Partial<Record<MachineId, string>>;
  ranMinutes: Partial<Record<MachineId, number>>;
  lastMinute: number;
}

export interface MachineSpec {
  id: MachineId;
  name: string;
  buildPower: number;
  buildWood: number;
  buildMinutes: number;
  unlockDay: number;
  consumes: { resource: 'firewood' | 'power'; perHour: number; minRun: number };
  produces: { resource: 'power' | 'firewood' | 'food'; perHour: number };
}

/** `machine-system.js:20-78`, verbatim numbers. */
export const MACHINES: Record<MachineId, MachineSpec> = {
  generator: {
    id: 'generator', name: '自动发电机', buildPower: 10, buildWood: 12,
    buildMinutes: 240, unlockDay: 1,
    consumes: { resource: 'firewood', perHour: 3.0, minRun: 5 },
    produces: { resource: 'power', perHour: 20 },
  },
  lumberMill: {
    id: 'lumberMill', name: '自动伐木机', buildPower: 12, buildWood: 15,
    buildMinutes: 300, unlockDay: 1,
    consumes: { resource: 'power', perHour: 4.0, minRun: 5 },
    produces: { resource: 'firewood', perHour: 24 },
  },
  foodCollector: {
    id: 'foodCollector', name: '自动捕猎机', buildPower: 10, buildWood: 12,
    buildMinutes: 300, unlockDay: 1,
    consumes: { resource: 'power', perHour: 3.0, minRun: 5 },
    produces: { resource: 'food', perHour: 12 },
  },
};

export const HEATING_WOOD_PER_HOUR = 1.0;
export const HEATING_POWER_PER_HOUR = 2.0;
export const RESERVE_TARGET_HOURS = 24;
export const STRENGTH_THRESHOLDS = [
  { min: 0.75, label: 'hot' }, { min: 0.45, label: 'warm' },
  { min: 0.12, label: 'cold' }, { min: 0, label: 'none' },
] as const;
/** Building is real work: this many stamina points per build minute. */
export const BUILD_STAMINA_PER_MINUTE = 0.08;

export function heatingStrength(firewood: number, power: number): number {
  const woodRatio = Math.min(1, firewood / (HEATING_WOOD_PER_HOUR * RESERVE_TARGET_HOURS));
  const powerRatio = Math.min(1, power / (HEATING_POWER_PER_HOUR * RESERVE_TARGET_HOURS));
  return Number((woodRatio * 0.65 + powerRatio * 0.35).toFixed(6));
}

export function heatingBand(strength: number): string {
  return STRENGTH_THRESHOLDS.find(entry => strength >= entry.min)?.label ?? 'none';
}

export const productionDomain: DomainModule<ProductionState> = {
  id: 'production',
  initial(): ProductionState {
    return {
      machines: { generator: 'absent', lumberMill: 'absent', foodCollector: 'absent' },
      buildRemaining: {}, buildWorker: {}, ranMinutes: {}, lastMinute: 0,
    };
  },

  reduce(state, command: DomainCommand, context): DomainResult<ProductionState> {
    const next: ProductionState = {
      machines: { ...state.machines },
      buildRemaining: { ...state.buildRemaining },
      buildWorker: { ...state.buildWorker },
      ranMinutes: { ...state.ranMinutes },
      lastMinute: state.lastMinute,
    };
    const result = emptyResult(next);

    if (command.type === 'start-machine') {
      const machine = command.payload?.machine as MachineId;
      const spec = MACHINES[machine];
      if (!spec) {
        result.rejections.push({ intentId: 'production:start:unknown', code: 'unknown_machine',
          reason: `unknown machine ${String(machine)}` });
        return result;
      }
      if (next.machines[machine] !== 'stopped') {
        result.rejections.push({ intentId: `production:${machine}:start`,
          code: 'not_stopped', reason: `${machine} is ${next.machines[machine]}` });
        return result;
      }
      const held = context.snapshot.resources[spec.consumes.resource];
      if (held < spec.consumes.minRun) {
        result.rejections.push({ intentId: `production:${machine}:start`,
          code: 'input_below_minimum',
          reason: `${spec.consumes.resource} ${held} < minRun ${spec.consumes.minRun}` });
        return result;
      }
      result.intents.push({ id: `production:${machine}:restart:${context.snapshot.elapsed}`,
        kind: 'machine', machine, to: 'running', actorId: command.actorId,
        source: 'production.restart',
        preconditions: [{ kind: 'machine_state', machine, states: ['stopped'] }] });
      result.events.push({ proposalId: `production:${machine}:restarted`,
        type: 'machine_restarted', actorId: command.actorId, observedBy: 'all',
        payload: { machine } });
      return result;
    }

    if (command.type === 'stop-machine') {
      const machine = command.payload?.machine as MachineId;
      if (!MACHINES[machine]) {
        result.rejections.push({ intentId: 'production:stop:unknown', code: 'unknown_machine',
          reason: `unknown machine ${String(machine)}` });
        return result;
      }
      result.intents.push({ id: `production:${machine}:stop`, kind: 'machine', machine,
        to: 'stopped', actorId: command.actorId, source: 'production.stop',
        preconditions: [{ kind: 'machine_state', machine, states: ['running'] }] });
      return result;
    }

    if (command.type !== 'build-machine') {
      result.rejections.push({ intentId: `production:${command.type}`, code: 'unknown_command',
        reason: `production does not handle ${command.type}` });
      return result;
    }

    const machine = command.payload?.machine as MachineId;
    const spec = MACHINES[machine];
    if (!spec) {
      result.rejections.push({ intentId: 'production:build:unknown', code: 'unknown_machine',
        reason: `unknown machine ${String(machine)}` });
      return result;
    }
    const snapshot = context.snapshot;
    if (snapshot.machines[machine] !== 'absent') {
      result.rejections.push({ intentId: `production:${machine}:build`, code: 'already_built',
        reason: `${machine} is ${snapshot.machines[machine]}` });
      return result;
    }
    if (snapshot.day < spec.unlockDay) {
      result.rejections.push({ intentId: `production:${machine}:build`, code: 'locked',
        reason: `${machine} unlocks on day ${spec.unlockDay}` });
      return result;
    }
    const workerId = String(command.payload?.workerId ?? command.actorId);
    const worker = snapshot.npcs[workerId];
    if (!worker?.alive) {
      result.rejections.push({ intentId: `production:${machine}:build`, code: 'no_worker',
        reason: `worker ${workerId} is not alive` });
      return result;
    }
    const power = snapshot.resources.power;
    const wood = snapshot.resources.firewood;
    if (power < spec.buildPower || wood < spec.buildWood) {
      result.rejections.push({ intentId: `production:${machine}:build`,
        code: 'insufficient_build_cost',
        reason: `need power>=${spec.buildPower} and firewood>=${spec.buildWood}, ` +
          `have ${power}/${wood}` });
      return result;
    }
    result.intents.push({
      id: `production:${machine}:build:power`, kind: 'resource', resource: 'power',
      delta: -spec.buildPower, actorId: workerId, source: 'production.build',
      preconditions: [{ kind: 'resource_at_least', resource: 'power', amount: spec.buildPower }],
    }, {
      id: `production:${machine}:build:wood`, kind: 'resource', resource: 'firewood',
      delta: -spec.buildWood, actorId: workerId, source: 'production.build',
      preconditions: [{ kind: 'resource_at_least', resource: 'firewood', amount: spec.buildWood }],
    }, {
      id: `production:${machine}:building`, kind: 'machine', machine, to: 'building',
      actorId: workerId, source: 'production.build',
      preconditions: [{ kind: 'machine_state', machine, states: ['absent'] }],
    });
    next.buildRemaining[machine] = spec.buildMinutes;
    next.buildWorker[machine] = workerId;
    next.machines[machine] = 'building';
    result.events.push({ proposalId: `production:${machine}:build-started`,
      type: 'machine_build_started', actorId: workerId, observedBy: 'all',
      payload: { machine, minutes: spec.buildMinutes, workerId } });
    return result;
  },

  onTimeSpan(state, fromMinute, toMinute, context): DomainResult<ProductionState> {
    const next: ProductionState = {
      machines: { ...state.machines },
      buildRemaining: { ...state.buildRemaining },
      buildWorker: { ...state.buildWorker },
      ranMinutes: { ...state.ranMinutes },
      lastMinute: toMinute,
    };
    // Machines are shared world state: the committed snapshot is the truth.
    next.machines = { ...context.snapshot.machines } as typeof next.machines;
    const result = emptyResult(next);
    const minutes = Math.max(0, toMinute - fromMinute);
    if (minutes === 0) return result;
    const hours = minutes / 60;
    const snapshot = context.snapshot;
    const resources = { ...snapshot.resources };

    // --- building: only while the assigned worker is alive, present, awake ---
    for (const [id, remaining] of Object.entries(next.buildRemaining)) {
      const machine = id as MachineId;
      if (next.machines[machine] !== 'building') continue;
      const workerId = next.buildWorker[machine];
      const worker = workerId ? snapshot.npcs[workerId] : undefined;
      // Real work: an alive, non-exhausted worker must be on the job. Where it
      // stands is P2's spatial concern, not a second gate here.
      const canWork = Boolean(worker?.alive) && worker!.stamina > 5;
      if (!canWork) {
        result.events.push({ proposalId: `production:${machine}:stalled:${toMinute}`,
          type: 'machine_build_stalled', actorId: workerId ?? 'system', observedBy: 'all',
          payload: { machine,
            reason: worker ? `worker stamina ${worker.stamina.toFixed(1)}` : 'no worker' } });
        continue;
      }
      const left = (remaining ?? 0) - minutes;
      if (left > 0) {
        next.buildRemaining[machine] = left;
        result.intents.push({ id: `production:${machine}:build-labour:${toMinute}`,
          kind: 'actor', actorId: workerId!, delta: {
            stamina: -BUILD_STAMINA_PER_MINUTE * minutes } as ActorDelta,
          source: 'production.build', preconditions: [{ kind: 'actor_alive', actorId: workerId! }] });
        continue;
      }
      delete next.buildRemaining[machine];
      next.machines[machine] = 'running';
      next.ranMinutes[machine] = 0;
      result.intents.push({ id: `production:${machine}:running`, kind: 'machine', machine,
        to: 'running', actorId: workerId!, source: 'production.build-complete',
        preconditions: [{ kind: 'machine_state', machine, states: ['building'] }] });
      result.events.push({ proposalId: `production:${machine}:built`, type: 'machine_built',
        actorId: workerId!, observedBy: 'all', payload: { machine } });
    }

    // --- central heating: wood first, then power (original order) ---
    const wood = Math.min(resources.firewood, HEATING_WOOD_PER_HOUR * hours);
    const power = Math.min(resources.power, HEATING_POWER_PER_HOUR * hours);
    if (wood > 0) {
      resources.firewood = Number((resources.firewood - wood).toFixed(6));
      result.intents.push({ id: `production:heating:wood:${toMinute}`, kind: 'resource',
        resource: 'firewood', delta: -wood, actorId: 'system', source: 'production.heating',
        preconditions: [{ kind: 'resource_at_least', resource: 'firewood', amount: wood }] });
    }
    if (power > 0) {
      resources.power = Number((resources.power - power).toFixed(6));
      result.intents.push({ id: `production:heating:power:${toMinute}`, kind: 'resource',
        resource: 'power', delta: -power, actorId: 'system', source: 'production.heating',
        preconditions: [{ kind: 'resource_at_least', resource: 'power', amount: power }] });
    }
    const strength = heatingStrength(resources.firewood, resources.power);
    result.intents.push({ id: `production:heating:warmth:${toMinute}`, kind: 'intent-note',
      key: 'heatingStrength', value: strength, actorId: 'system', source: 'production.heating',
      preconditions: [] });
    result.events.push({ proposalId: `production:heating:${toMinute}`, type: 'heating_settled',
      actorId: 'system', observedBy: 'all',
      payload: { strength, band: heatingBand(strength),
        wood: Number(wood.toFixed(3)), power: Number(power.toFixed(3)) } });

    // --- machines: proportional output, stop below minRun ---
    for (const machine of Object.keys(MACHINES) as MachineId[]) {
      if (next.machines[machine] !== 'running') continue;
      const spec = MACHINES[machine];
      const available = resources[spec.consumes.resource];
      if (available < spec.consumes.minRun) {
        next.machines[machine] = 'stopped';
        result.intents.push({ id: `production:${machine}:stopped:${toMinute}`,
          kind: 'machine', machine, to: 'stopped', actorId: 'system',
          source: 'production.input-exhausted',
          preconditions: [{ kind: 'machine_state', machine, states: ['running'] }] });
        result.events.push({ proposalId: `production:${machine}:stop:${toMinute}`,
          type: 'machine_stopped', actorId: 'system', observedBy: 'all',
          payload: { machine, reason: `below minRun ${spec.consumes.minRun}`,
            held: available } });
        continue;
      }
      const need = spec.consumes.perHour * hours;
      const consumed = Math.min(available, need);
      const ratio = need > 0 ? consumed / need : 0;
      const output = Number((spec.produces.perHour * hours * ratio).toFixed(6));
      if (consumed > 0) {
        resources[spec.consumes.resource] = Number((available - consumed).toFixed(6));
        result.intents.push({ id: `production:${machine}:consume:${toMinute}`,
          kind: 'resource', resource: spec.consumes.resource, delta: -consumed,
          actorId: 'system', source: `production.${machine}`,
          preconditions: [{ kind: 'resource_at_least',
            resource: spec.consumes.resource, amount: consumed }] });
      }
      if (output > 0) {
        resources[spec.produces.resource] = Number(
          (resources[spec.produces.resource] + output).toFixed(6));
        result.intents.push({ id: `production:${machine}:produce:${toMinute}`,
          kind: 'resource', resource: spec.produces.resource, delta: output,
          actorId: 'system', source: `production.${machine}`, preconditions: [] });
      }
      next.ranMinutes[machine] = (next.ranMinutes[machine] ?? 0) + minutes;
    }
    return result;
  },
};

export type { ActorDelta };
