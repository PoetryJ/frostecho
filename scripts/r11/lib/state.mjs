/**
 * R11 (H) full authority capture + comparison.
 *
 * The capture is a plain JSON document of everything that can change a later
 * decision or receipt: world (all fields), map cells/closed roads/stocks/carry,
 * tasks and commitments with every cross-reference, memories with provenance
 * and relations, domain states, intents/work progress/generations, committed
 * receipts, journal, and the hash-derived RNG position.
 *
 * Deliberately excluded (declared telemetry): pids, wall-clock timestamps,
 * model latencies, service residency. They are recorded next to the capture,
 * never inside the equality check.
 */
import { createHash } from 'node:crypto';
import { hashUnit } from '../../../dist/src/survival/world-v2.js';
import { absoluteMinute } from '../../../dist/src/r7/contracts.js';

export const STATE_SCHEMA = 'frostecho.r11.full-state/1';

const sortDeep = value => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
};
export const canonical = value => JSON.stringify(sortDeep(value));
export const sha = value => createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');

const plain = value => value === undefined ? null : JSON.parse(JSON.stringify(value));

function mapValues(map) {
  if (!map) return [];
  if (Array.isArray(map)) return plain(map);
  const rows = map instanceof Map ? [...map.values()] : Object.values(map);
  return plain(rows);
}

/**
 * The RNG is a pure function of (seed, world version, channel). Capturing the
 * next few draws proves the resumed process continues the same stream.
 */
function rngPosition(world, draws = 8) {
  const next = [];
  for (let index = 0; index < draws; index += 1) {
    next.push(Number(hashUnit(world.rngSeed, world.version, `r11-probe:${index}`).toFixed(12)));
  }
  return { seed: world.rngSeed, version: world.version, nextDraws: next };
}

/** Work progress, including the serialisable travel leg if A's runtime has one. */
function workProgress(runtime) {
  const now = runtime.world.simTime;
  return [...runtime.intents.values()].map(intent => {
    const parameters = intent.candidate?.parameters ?? {};
    const route = parameters.route ?? parameters.path ?? intent.path ?? null;
    const leg = parameters.leg ?? intent.leg ?? null;
    const progress = parameters.progress ?? intent.progress ?? null;
    const cancelAt = parameters.cancelAt ?? intent.cancelAt ?? null;
    return {
      intentId: intent.intentId, actorId: intent.actorId,
      action: String(parameters.action ?? ''),
      status: intent.status, startedAt: intent.startedAt, dueAt: intent.dueAt,
      settledAt: intent.settledAt ?? null,
      elapsed: intent.status === 'working' ? now - intent.startedAt : null,
      remaining: intent.status === 'working' ? intent.dueAt - now : null,
      generation: intent.generation, taskId: intent.taskId,
      taskType: intent.taskType ?? null,
      commitmentId: intent.commitmentId ?? null,
      commitmentRevision: intent.commitmentRevision ?? null,
      requiredPlace: intent.requiredPlace ?? null,
      startPlace: intent.startPlace ?? null,
      route: route === undefined ? null : plain(route),
      leg: leg === undefined ? null : plain(leg),
      progress: progress === undefined ? null : plain(progress),
      cancelAt: cancelAt === undefined ? null : plain(cancelAt),
      receiptIds: [...(intent.receiptIds ?? [])],
      failureReason: intent.failureReason ?? null,
      projections: plain(intent.projections ?? []),
    };
  }).sort((a, b) => a.intentId.localeCompare(b.intentId));
}

export function captureState(runtime, play, extra = {}) {
  // The long-term decision memory is a derived cache of the same session
  // memories; sync it so a capture taken without a save equals a reloaded save.
  play.syncLongTermMemory();
  const world = plain(runtime.world);
  const session = runtime.session;
  const memories = {};
  for (const actorId of [...session.memories.keys()].sort()) {
    memories[actorId] = session.memories.get(actorId).toJSON();
  }
  const doc = runtime.toDocument();
  const commitmentPayload = play.commitments.toJSON();
  const tasks = play.board.toJSON();
  const intents = plain(doc.intents ?? []);
  const map = {
    positions: world.spatial?.positions ?? {},
    closedCells: [...(world.spatial?.closedCells ?? [])].sort(),
    stocks: world.spatial?.stocks ?? null,
    carry: world.spatial?.carry ?? {},
    deliveredMeals: world.spatial?.deliveredMeals ?? 0,
    locations: Object.fromEntries(Object.values(world.npcs)
      .map(npc => [npc.id, npc.location]).sort(([a], [b]) => a.localeCompare(b))),
    buildings: extra.buildings ?? null,
  };
  return {
    schema: STATE_SCHEMA,
    clock: {
      simTime: world.simTime, day: world.day, version: world.version,
      elapsed: runtime.elapsed(), ended: runtime.ended, endingKind: runtime.endingKind,
      profileEnd: absoluteMinute(runtime.profile, runtime.profile.endDay,
        runtime.profile.endMinuteOfDay),
    },
    rng: rngPosition(world),
    world,
    map,
    tasks,
    commitments: commitmentPayload,
    council: play.council.toJSON(),
    experience: play.experience.toJSON(),
    longTermMemory: play.longTermMemory.serialize(),
    memories,
    relationships: memoryRelationships(memories),
    session: {
      seed: session.seed, sequence: session.sequence, inputSequence: session.inputSequence,
      generations: Object.fromEntries([...session.generations.entries()].sort(([a], [b]) => a.localeCompare(b))),
      outcomes: plain(session.outcomes), plans: plain(session.plans),
      instances: plain(session.instances), inputReceipts: plain(session.inputReceipts),
    },
    domains: plain(doc.states),
    intents,
    work: workProgress(runtime),
    workLog: plain(doc.workLog ?? []),
    duplicateDemands: plain(doc.duplicateDemands ?? []),
    rejections: plain(doc.rejections ?? []),
    journal: plain(doc.journal ?? []),
    receipts: plain(doc.committed ?? []),
    deterministicIds: extra.deterministicIds ?? true,
  };
}

/**
 * Relations are a projection of the memory stores; capture them explicitly so
 * a changed trust/grievance is visible even when the record list is truncated.
 */
function memoryRelationships(memories) {
  const out = {};
  for (const [actorId, payload] of Object.entries(memories)) {
    const records = payload?.records ?? [];
    const relations = {};
    for (const record of records) {
      if (record.kind !== 'promise_kept' && record.kind !== 'promise_broken') continue;
      const other = String((record.payload ?? {}).promiseId ?? 'unknown');
      const row = relations[other] ?? { kept: 0, broken: 0 };
      if (record.kind === 'promise_kept') row.kept += 1; else row.broken += 1;
      relations[other] = row;
    }
    out[actorId] = relations;
  }
  return out;
}

/* ------------------------------- diff ------------------------------- */
const CATEGORY = path => {
  if (path.startsWith('map')) return 'map';
  if (path.startsWith('world.spatial')) return 'map';
  if (path.startsWith('world')) return 'world';
  if (path.startsWith('tasks')) return 'task';
  if (path.startsWith('commitments')) return 'commitment';
  if (path.startsWith('memories') || path.startsWith('relationships')) return 'memory';
  if (path.startsWith('work') || path.startsWith('intents')) return 'work';
  if (path.startsWith('receipts')) return 'receipt';
  if (path.startsWith('session.generations')) return 'generation';
  if (path.startsWith('rng')) return 'rng';
  if (path.startsWith('domains')) return 'domain';
  if (path.startsWith('journal')) return 'journal';
  return 'other';
};

/**
 * Structural comparison. Arrays are compared element-wise (order is part of
 * the state); objects by key. Returns every difference up to `limit`.
 */
export function diffStates(left, right, { limit = 60, path = '$', out = [] } = {}) {
  if (out.length >= limit) return out;
  if (left === right) return out;
  const leftType = Array.isArray(left) ? 'array' : left === null ? 'null' : typeof left;
  const rightType = Array.isArray(right) ? 'array' : right === null ? 'null' : typeof right;
  if (leftType !== rightType) {
    out.push({ path, category: CATEGORY(path.slice(2)), left: left ?? null, right: right ?? null,
      reason: `type ${leftType}->${rightType}` });
    return out;
  }
  if (leftType === 'array') {
    if (left.length !== right.length) {
      out.push({ path: `${path}.length`, category: CATEGORY(path.slice(2)), left: left.length,
        right: right.length, reason: 'array length' });
    }
    const n = Math.min(left.length, right.length);
    for (let index = 0; index < n && out.length < limit; index += 1) {
      diffStates(left[index], right[index], { limit, path: `${path}[${index}]`, out });
    }
    return out;
  }
  if (leftType === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (out.length >= limit) break;
      if (!(key in left)) {
        out.push({ path: `${path}.${key}`, category: CATEGORY(path.slice(2)), left: null,
          right: right[key], reason: 'missing on left' });
        continue;
      }
      if (!(key in right)) {
        out.push({ path: `${path}.${key}`, category: CATEGORY(path.slice(2)), left: left[key],
          right: null, reason: 'missing on right' });
        continue;
      }
      diffStates(left[key], right[key], { limit, path: `${path}.${key}`, out });
    }
    return out;
  }
  out.push({ path, category: CATEGORY(path.slice(2)), left, right, reason: 'value' });
  return out;
}

export function compareStates(left, right, options = {}) {
  const diffs = diffStates(left, right, options);
  const categories = {};
  for (const diff of diffs) categories[diff.category] = (categories[diff.category] ?? 0) + 1;
  return {
    schema: 'frostecho.r11.state-compare/1',
    equal: diffs.length === 0,
    diffs: diffs.length,
    categories,
    samples: diffs,
    leftSha256: sha(left), rightSha256: sha(right),
  };
}

/* ------------------------------ tamper ------------------------------ */
/** Each mutation targets one evidence class required by the R11 contract. */
export const TAMPERS = {
  'commitment-reference': state => {
    const task = (state.tasks?.tasks ?? []).find(row => row.commitmentId);
    const commitment = (state.commitments?.commitments ?? [])[0];
    if (task) {
      const original = task.commitmentId;
      task.commitmentId = commitment && commitment.commitmentId !== original
        ? commitment.commitmentId : 'cm-tampered-reference';
      return { path: `tasks.tasks[${task.taskId}].commitmentId`, before: original,
        after: task.commitmentId };
    }
    if (commitment) {
      const original = commitment.taskId;
      commitment.taskId = 'task-tampered-reference';
      return { path: `commitments[${commitment.commitmentId}].taskId`, before: original,
        after: commitment.taskId };
    }
    throw new Error('no commitment reference to tamper');
  },
  'map-position': state => {
    const id = Object.keys(state.map?.positions ?? {})[0] ?? 'npc_01';
    const cell = state.map.positions[id] ?? { x: 0, y: 0 };
    const before = { ...cell };
    cell.x += 1;
    state.map.positions[id] = cell;
    if (state.world?.spatial?.positions?.[id]) {
      state.world.spatial.positions[id] = { ...cell };
    }
    return { path: `map.positions[${id}]`, before, after: { ...cell } };
  },
  'memory-source': state => {
    for (const [actorId, payload] of Object.entries(state.memories ?? {})) {
      const record = (payload.records ?? []).find(row => row.source === 'engine')
        ?? payload.records?.[0];
      if (!record) continue;
      const before = { source: record.source, speakerId: record.speakerId ?? null,
        authority: record.authority };
      record.source = 'player_statement';
      record.speakerId = 'npc_07';
      record.authority = 'player';
      return { path: `memories[${actorId}].records[${record.recordId}].source`, before,
        after: { source: record.source, speakerId: record.speakerId, authority: record.authority } };
    }
    throw new Error('no memory record to tamper');
  },
  'travel-leg': state => {
    const row = (state.work ?? []).find(entry => entry.status === 'working'
      && (entry.route || entry.leg || entry.progress !== null));
    if (row) {
      const before = { route: row.route, leg: row.leg, progress: row.progress };
      if (Array.isArray(row.route) && row.route.length > 0) {
        row.route = row.route.slice(0, -1).concat([{ x: 1, y: 1 }]);
      } else if (row.leg !== null) {
        row.leg = Number(row.leg) + 1;
      } else {
        row.progress = Number(row.progress ?? 0) + 1;
      }
      return { path: `work[${row.intentId}].leg`, before,
        after: { route: row.route, leg: row.leg, progress: row.progress } };
    }
    // No serialised travel in flight: inject one as the saved state claims.
    state.work = [...(state.work ?? []), {
      intentId: 'tampered-inflight-travel', actorId: 'npc_01', action: 'move',
      status: 'working', startedAt: state.clock?.simTime ?? 0, dueAt: (state.clock?.simTime ?? 0) + 30,
      elapsed: 0, remaining: 30, generation: 0, taskId: null, taskType: null,
      commitmentId: null, commitmentRevision: null, requiredPlace: null, startPlace: 'dorm-a',
      route: [{ x: 16, y: 23 }, { x: 16, y: 15 }], leg: 0, progress: 0, cancelAt: null,
      receiptIds: [], failureReason: null, projections: [],
    }];
    return { path: 'work[injected-travel]', before: null, after: 'injected in-flight travel leg' };
  },
  receipt: state => {
    const receipt = (state.receipts ?? [])[0];
    if (!receipt) throw new Error('no receipt to tamper');
    const before = { eventId: receipt.eventId, amount: receipt.payload?.amount ?? null };
    receipt.payload = { ...(receipt.payload ?? {}), amount: Number(receipt.payload?.amount ?? 0) + 99 };
    return { path: `receipts[${receipt.eventId}].payload.amount`, before,
      after: { eventId: receipt.eventId, amount: receipt.payload.amount } };
  },
};

export function applyTamper(name, state) {
  const mutation = TAMPERS[name];
  if (!mutation) throw new Error(`unknown tamper ${name}`);
  const clone = JSON.parse(JSON.stringify(state));
  const detail = mutation(clone);
  return { name, detail, mutated: clone };
}
