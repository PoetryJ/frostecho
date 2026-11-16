/**
 * P1 production domain: central heating, the three original machines and the
 * power/wood/food conversions.
 *
 * Original sources:
 *   - `src/systems/resource-system.js:35-40` heating wood 1.0/h, town power
 *     2.0/h, 1.8 food per meal, 2 meals a day;
 *   - `src/systems/machine-system.js:25-63` build costs/time/unlock powers;
 *   - `machine-system.js:304-314` `buildMaterialCost` is charged from `power`
 *     (there is no fourth material), and both costs must be affordable;
 *   - `src/systems/furnace-system.js:79-101` heating strength
 *     `woodRatio*0.65 + powerRatio*0.35`, thresholds 0.75/0.45/0.12.
 *
 * Machine yields are labelled PORT-CONSTANT: the original derives them inside
 * the real-time machine loop, this port states them explicitly per hour.
 */
import type { ActorDelta, DomainCommand, DomainModule, DomainResult,
  MachineId, MachineState } from '../../contracts';
import { emptyResult } from '../../contracts';

export interface ProductionState {
  machines: Record<MachineId, MachineState>;
  /** Minutes of build work left per machine. */
  buildRemaining: Partial<Record<MachineId, number>>;
  /** Consecutive minutes each machine ran, for receipts. */
  ranMinutes: Partial<Record<MachineId, number>>;
  lastMinute: number;
}

export interface MachineSpec {
  id: MachineId;
  name: string;
  buildPower: number;
  buildWood: number;
  buildMinutes: number;
  unlock: { resource: 'power' | 'firewood'; amount: number };
  consumes: { resource: 'firewood' | 'power'; perHour: number };
  produces: { resource: 'power' | 'firewood' | 'food'; perHour: number };
}

export const MACHINES: Record<MachineId, MachineSpec> = {
  generator: {
    id: 'generator', name: '自动发电机', buildPower: 10, buildWood: 12,
    buildMinutes: 240, unlock: { resource: 'power', amount: 10 },
    consumes: { resource: 'firewood', perHour: 3 }, produces: { resource: 'power', perHour: 8 },
  },
  lumberMill: {
    id: 'lumberMill', name: '自动伐木机', buildPower: 12, buildWood: 15,
    buildMinutes: 300, unlock: { resource: 'firewood', amount: 18 },
    consumes: { resource: 'power', perHour: 4 }, produces: { resource: 'firewood', perHour: 6 },
  },
  foodCollector: {
    id: 'foodCollector', name: '自动捕猎机', buildPower: 10, buildWood: 12,
    buildMinutes: 300, unlock: { resource: 'power', amount: 6 },
    consumes: { resource: 'power', perHour: 3 }, produces: { resource: 'food', perHour: 5 },
  },
};

export const HEATING_WOOD_PER_HOUR = 1.0;
export const HEATING_POWER_PER_HOUR = 2.0;
export const RESERVE_TARGET_HOURS = 24;
export const STRENGTH_THRESHOLDS = [
  { min: 0.75, label: 'hot' }, { min: 0.45, label: 'warm' },
  { min: 0.12, label: 'cold' }, { min: 0, label: 'none' },
] as const;

/** Original strength formula (`furnace-system.js:79-101`). */
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
      buildRemaining: {}, ranMinutes: {}, lastMinute: 0,
    };
  },

  reduce(state, command: DomainCommand, context): DomainResult<ProductionState> {
    const next: ProductionState = {
      machines: { ...state.machines },
      buildRemaining: { ...state.buildRemaining },
      ranMinutes: { ...state.ranMinutes },
      lastMinute: state.lastMinute,
    };
    const result = emptyResult(next);
    if (command.type !== 'build-machine') {
      if (command.type === 'stop-machine') {
        const machine = command.payload?.machine as MachineId;
        if (!MACHINES[machine]) {
          result.rejections.push({ intentId: `production:${command.type}:unknown`,
            code: 'unknown_machine', reason: `unknown machine ${String(machine)}` });
          return result;
        }
        result.intents.push({ id: `production:${machine}:stop`, kind: 'machine', machine,
          to: 'stopped', actorId: command.actorId, source: 'production.stop',
          preconditions: [{ kind: 'machine_state', machine, states: ['running'] }] });
        return result;
      }
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
    // Both costs must be affordable before anything is charged.
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
      delta: -spec.buildPower, actorId: command.actorId, source: 'production.build',
      preconditions: [{ kind: 'resource_at_least', resource: 'power', amount: spec.buildPower }],
    }, {
      id: `production:${machine}:build:wood`, kind: 'resource', resource: 'firewood',
      delta: -spec.buildWood, actorId: command.actorId, source: 'production.build',
      preconditions: [{ kind: 'resource_at_least', resource: 'firewood', amount: spec.buildWood }],
    }, {
      id: `production:${machine}:building`, kind: 'machine', machine, to: 'building',
      actorId: command.actorId, source: 'production.build',
      preconditions: [{ kind: 'machine_state', machine, states: ['absent'] }],
    });
    next.buildRemaining[machine] = spec.buildMinutes;
    next.machines[machine] = 'building';
    result.events.push({ proposalId: `production:${machine}:build-started`,
      type: 'machine_build_started', actorId: command.actorId, observedBy: 'all',
      payload: { machine, minutes: spec.buildMinutes } });
    return result;
  },

  onTimeSpan(state, fromMinute, toMinute, context): DomainResult<ProductionState> {
    const next: ProductionState = {
      machines: { ...state.machines },
      buildRemaining: { ...state.buildRemaining },
      ranMinutes: { ...state.ranMinutes },
      lastMinute: toMinute,
    };
    // Machines are shared world state: the committed snapshot is the truth,
    // the domain keeps only a mirror plus its own progress counters.
    next.machines = { ...context.snapshot.machines } as typeof next.machines;
    const result = emptyResult(next);
    const minutes = Math.max(0, toMinute - fromMinute);
    if (minutes === 0) return result;
    const hours = minutes / 60;
    const snapshot = context.snapshot;
    const resources = { ...snapshot.resources };

    // Building progress first: a machine starts running the minute it finishes.
    for (const [id, remaining] of Object.entries(next.buildRemaining)) {
      const machine = id as MachineId;
      if (next.machines[machine] !== 'building') continue;
      const left = (remaining ?? 0) - minutes;
      if (left > 0) {
        next.buildRemaining[machine] = left;
        continue;
      }
      delete next.buildRemaining[machine];
      next.machines[machine] = 'running';
      next.ranMinutes[machine] = 0;
      result.intents.push({ id: `production:${machine}:running`, kind: 'machine', machine,
        to: 'running', actorId: 'system', source: 'production.build-complete',
        preconditions: [{ kind: 'machine_state', machine, states: ['building'] }] });
      result.events.push({ proposalId: `production:${machine}:built`, type: 'machine_built',
        actorId: 'system', observedBy: 'all', payload: { machine } });
    }

    // Central heating: wood first, then power (original order).
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
    const band = heatingBand(strength);
    result.intents.push({ id: `production:heating:warmth:${toMinute}`, kind: 'intent-note',
      key: 'heatingStrength', value: strength, actorId: 'system', source: 'production.heating',
      preconditions: [] });
    result.events.push({ proposalId: `production:heating:${toMinute}`, type: 'heating_settled',
      actorId: 'system', observedBy: 'all',
      payload: { strength, band, wood: Number(wood.toFixed(3)), power: Number(power.toFixed(3)) } });

    // Machines: each converts its input into its output while it can run.
    for (const machine of Object.keys(MACHINES) as MachineId[]) {
      const stateOf = next.machines[machine];
      if (stateOf !== 'running') continue;
      const spec = MACHINES[machine];
      const need = spec.consumes.perHour * hours;
      const available = resources[spec.consumes.resource];
      if (available < need) {
        next.machines[machine] = 'stopped';
        result.intents.push({ id: `production:${machine}:stopped:${toMinute}`,
          kind: 'machine', machine, to: 'stopped', actorId: 'system',
          source: 'production.input-exhausted',
          preconditions: [{ kind: 'machine_state', machine, states: ['running'] }] });
        result.events.push({ proposalId: `production:${machine}:stop:${toMinute}`,
          type: 'machine_stopped', actorId: 'system', observedBy: 'all',
          payload: { machine, reason: `missing ${spec.consumes.resource}`, need } });
        continue;
      }
      const output = spec.produces.perHour * hours;
      resources[spec.consumes.resource] = Number((available - need).toFixed(6));
      resources[spec.produces.resource] = Number(
        (resources[spec.produces.resource] + output).toFixed(6));
      next.ranMinutes[machine] = (next.ranMinutes[machine] ?? 0) + minutes;
      result.intents.push({ id: `production:${machine}:consume:${toMinute}`, kind: 'resource',
        resource: spec.consumes.resource, delta: -need, actorId: 'system',
        source: `production.${machine}`,
        preconditions: [{ kind: 'resource_at_least', resource: spec.consumes.resource,
          amount: need }] });
      result.intents.push({ id: `production:${machine}:produce:${toMinute}`, kind: 'resource',
        resource: spec.produces.resource, delta: output, actorId: 'system',
        source: `production.${machine}`, preconditions: [] });
    }
    return result;
  },
};

export type { ActorDelta };
