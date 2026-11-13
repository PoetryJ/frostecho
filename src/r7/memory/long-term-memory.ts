import { createHash } from 'node:crypto';
import { ExperienceStore, type FoldableEvent } from '../../memory/experience';
import type { MemoryRecord } from '../../memory/store';

/** Memory for DecisionInput, not an execution queue or a second world. */
export type MemorySource = 'observation' | 'report' | 'inference';
export interface ObservedEvent {
  eventId: string;
  lifeId: string;
  simTime: number;
  kind: string;
  payload: Record<string, unknown>;
  actorId?: string;
  /** Explicit recipients supplied by the authoritative observation path. */
  observedBy: string[];
  source: MemorySource;
  /** Preserved when ingesting a per-observer MemoryStore record. */
  originEventId?: string;
  sourceRecordId?: string;
  occurredAt?: number;
}

export type FactValue = string | number | boolean;
export interface Condition {
  key: string;
  op: 'eq' | 'gte' | 'lte';
  value: FactValue;
}
export interface ValidWhen {
  lifeId?: string;
  conditions: Condition[];
  expiresAt?: number;
}
export interface MemoryNote {
  id: string;
  actorId: string;
  lifeId: string;
  kind: 'fact' | 'relationship' | 'commitment' | 'report';
  key: string;
  claim: string;
  value: FactValue;
  evidenceIds: string[];
  validWhen: ValidWhen;
  confidenceKind: MemorySource;
  supersedes?: string;
  invalidatedBy: string[];
  valid: boolean;
  simTime: number;
}
export interface ConditionalExperience {
  id: string;
  actorId: string;
  lifeId: string;
  goal: string;
  attempt: string;
  outcome: 'success' | 'failure';
  lesson: string;
  evidenceIds: string[];
  validWhen: ValidWhen;
  simTime: number;
  /** A sequence is observational evidence, not a claimed causal experiment. */
  basis: 'receipt' | 'observed-sequence';
}
export interface LifeTransition {
  lifeId: string;
  nextLifeId: string;
  ending: string;
  rulesProfile: string;
  seed: string;
}
export interface SerializedLongTermMemory {
  schema: 'frostecho.jev-memory/1';
  initialLifeId: string;
  currentLifeId: string;
  events: ObservedEvent[];
  transitions: LifeTransition[];
}
export interface MemoryQuery {
  actorId: string;
  now: number;
  goal?: string;
  place?: string;
  tokenBudget: number;
  mode?: 'raw' | 'layered';
}
export interface ContextItem {
  id: string;
  kind: 'event' | 'note' | 'experience';
  text: string;
  evidenceIds: string[];
  applicability?: 'applicable' | 'unknown' | 'contradicted';
}
export interface MemoryContext {
  schema: 'frostecho.jev-memory-context/1';
  actorId: string;
  lifeId: string;
  mode: 'raw' | 'layered';
  contextText: string;
  items: ContextItem[];
  evidenceIds: string[];
  observationHash: string;
  memoryHash: string;
  tokenBudget: number;
  /** Conservative bound, not a claim to use the model's tokenizer. */
  estimatedTokens: number;
  tokenEstimator: 'utf8-byte-upper-bound';
  omitted: number;
  applicableExperienceIds: string[];
}

interface Projection {
  notes: MemoryNote[];
  experiences: ConditionalExperience[];
  facts: Map<string, FactValue>;
}
interface DeliverySequence {
  empty?: ObservedEvent;
  gather?: ObservedEvent;
  deposit?: ObservedEvent;
  withdraw?: ObservedEvent;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
function copy<T>(value: T): T { return structuredClone(value); }
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`memory: ${name} required`);
}
function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`memory: ${name} must be a nonnegative finite number`);
  }
}
function assertJson(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(assertJson); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(assertJson); return;
  }
  throw new Error('memory: payload must contain finite JSON values');
}
function field(event: ObservedEvent, name: string, fallback = ''): string {
  const value = event.payload[name];
  return typeof value === 'string' ? value : fallback;
}
function amount(event: ObservedEvent, name: string): number | undefined {
  const value = event.payload[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function eventRef(event: ObservedEvent): string { return `${event.lifeId}/${event.eventId}`; }
function sourceRefs(events: ObservedEvent[]): string[] { return [...new Set(events.map(eventRef))]; }
function matches(condition: Condition, actual: FactValue | undefined): boolean {
  if (condition.op === 'eq') return actual === condition.value;
  if (typeof actual !== 'number' || typeof condition.value !== 'number') return false;
  return condition.op === 'gte' ? actual >= condition.value : actual <= condition.value;
}

/**
 * Canonical source events are the persistence format. All notes and experiences
 * are rebuilt from the recipient's own ledger, including after a restore.
 */
export class LongTermMemory {
  private readonly events: ObservedEvent[] = [];
  private readonly transitions: LifeTransition[] = [];
  private readonly byId = new Map<string, ObservedEvent>();
  private readonly byObserver = new Map<string, ObservedEvent[]>();
  private readonly initialLifeId: string;
  private lifeId: string;

  constructor(lifeId = 'life-1') {
    nonempty(lifeId, 'lifeId');
    this.initialLifeId = lifeId;
    this.lifeId = lifeId;
  }

  get currentLifeId(): string { return this.lifeId; }

  ingest(input: ObservedEvent): { duplicate: boolean; event: ObservedEvent } {
    nonempty(input.eventId, 'eventId'); nonempty(input.lifeId, 'lifeId');
    nonempty(input.kind, 'kind'); finite(input.simTime, 'simTime');
    if (input.lifeId !== this.lifeId) throw new Error('memory: event belongs to a different life');
    if (!['observation', 'report', 'inference'].includes(input.source)) throw new Error('memory: invalid source');
    if (!Array.isArray(input.observedBy)) throw new Error('memory: explicit observedBy required');
    input.observedBy.forEach(id => nonempty(id, 'observerId'));
    if (input.actorId !== undefined) nonempty(input.actorId, 'actorId');
    if (!input.payload || Array.isArray(input.payload)) throw new Error('memory: payload object required');
    assertJson(input.payload);
    const event = copy({ ...input, observedBy: [...new Set(input.observedBy)].sort() });
    const key = eventRef(event);
    const previous = this.byId.get(key);
    if (previous) {
      if (canonical(previous) !== canonical(event)) throw new Error(`memory: event_id_conflict ${key}`);
      return { duplicate: true, event: copy(previous) };
    }
    this.events.push(event); this.byId.set(key, event);
    for (const observer of event.observedBy) {
      const seen = this.byObserver.get(observer) ?? [];
      seen.push(event); this.byObserver.set(observer, seen);
    }
    return { duplicate: false, event: copy(event) };
  }

  /** WorldEvent/old FoldableEvent adapter: visibility is never inferred here. */
  ingestWorldEvent(event: FoldableEvent & { actorId?: string }, options: {
    observedBy: string[]; lifeId?: string; source?: MemorySource;
  }): { duplicate: boolean; event: ObservedEvent } {
    return this.ingest({ eventId: event.eventId ?? '', lifeId: options.lifeId ?? this.lifeId,
      simTime: event.simTime ?? 0, kind: event.type ?? event.kind ?? '',
      payload: event.payload ?? {}, ...(event.actorId ? { actorId: event.actorId } : {}),
      observedBy: options.observedBy, source: options.source ?? 'observation' });
  }

  /** Personal records are separate immutable observations of a world event. */
  ingestMemoryRecord(record: MemoryRecord, lifeId = this.lifeId): { duplicate: boolean; event: ObservedEvent } {
    const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? record.payload as Record<string, unknown> : { value: record.payload ?? null };
    const source: MemorySource = record.source === 'inference' || record.authority === 'inference'
      ? 'inference' : record.source === 'engine' && record.authority === 'engine' ? 'observation' : 'report';
    const actorId = typeof payload.actorId === 'string' ? payload.actorId
      : typeof payload.fromId === 'string' ? payload.fromId : record.subjectIds[0];
    return this.ingest({ eventId: `record:${record.recordId}`, lifeId, simTime: record.observedAt,
      occurredAt: record.occurredAt, kind: record.kind, payload,
      ...(actorId ? { actorId } : {}), observedBy: [record.observerId], source,
      originEventId: record.eventId, sourceRecordId: record.recordId });
  }

  /** Existing GameplayLoop may use this without changing its experience rules. */
  toLegacyExperience(actorId: string, now = Number.MAX_SAFE_INTEGER): ExperienceStore {
    const events = this.visibleEvents(actorId, now).filter(event =>
      event.lifeId === this.lifeId && event.source === 'observation');
    return ExperienceStore.fromEvents(actorId, events.map(event => ({
      eventId: eventRef(event), kind: event.kind, simTime: event.simTime, payload: copy(event.payload),
    })));
  }

  /** Resolve life-qualified evidence ids back to actual WorldEvent ids. */
  evidence(actorId: string, evidenceIds: string[], now: number): ObservedEvent[] {
    const visible = new Map(this.visibleEvents(actorId, now).map(event => [eventRef(event), event]));
    return [...new Set(evidenceIds)].map(id => {
      const event = visible.get(id);
      if (!event) throw new Error(`memory: evidence is not visible to ${actorId}: ${id}`);
      return copy(event);
    });
  }

  private visibleEvents(actorId: string, now: number): ObservedEvent[] {
    nonempty(actorId, 'actorId'); finite(now, 'now');
    const lifeOrder = [this.initialLifeId, ...this.transitions.map(item => item.nextLifeId)];
    const lifeRank = new Map(lifeOrder.map((life, index) => [life, index]));
    // Keep the original game's twenty completed-life retrieval horizon. The raw
    // ledger remains intact for provenance; it is never fed wholesale to an NPC.
    const allowedLives = new Set(lifeOrder.slice(-21));
    // Sort only this observer's records. Stable sorting preserves receipt order
    // at equal simulation times without repeatedly scanning the world ledger.
    return (this.byObserver.get(actorId) ?? []).filter(event => allowedLives.has(event.lifeId)
      && (event.lifeId !== this.lifeId || event.simTime <= now))
      .sort((a, b) => lifeRank.get(a.lifeId)! - lifeRank.get(b.lifeId)!
        || a.simTime - b.simTime);
  }

  private project(actorId: string, events: ObservedEvent[]): Projection {
    const notes: MemoryNote[] = [];
    const experiences: ConditionalExperience[] = [];
    const facts = new Map<string, FactValue>();
    const latest = new Map<string, MemoryNote>();
    let activeLife = '';
    let delivery: DeliverySequence = {};
    const note = (event: ObservedEvent, key: string, value: FactValue,
      claim: string, kind: MemoryNote['kind'] = 'fact'): void => {
      const predecessor = latest.get(key);
      const id = `note-${hash([actorId, eventRef(event), key]).slice(0, 20)}`;
      if (predecessor) { predecessor.valid = false; predecessor.invalidatedBy.push(eventRef(event)); }
      const item: MemoryNote = { id, actorId, lifeId: event.lifeId, kind, key, claim, value,
        evidenceIds: [eventRef(event)], validWhen: { lifeId: event.lifeId, conditions: [] },
        confidenceKind: event.source, ...(predecessor ? { supersedes: predecessor.id } : {}),
        invalidatedBy: [], valid: true, simTime: event.simTime };
      notes.push(item); latest.set(key, item); facts.set(key, value);
    };
    const experience = (event: ObservedEvent, goal: string, attempt: string,
      outcome: ConditionalExperience['outcome'], lesson: string, evidence: ObservedEvent[],
      conditions: Condition[], basis: ConditionalExperience['basis'] = 'receipt'): void => {
      experiences.push({ id: `experience-${hash([actorId, eventRef(event), attempt]).slice(0, 20)}`,
        actorId, lifeId: event.lifeId, goal, attempt, outcome, lesson,
        evidenceIds: sourceRefs(evidence), validWhen: { conditions }, simTime: event.simTime, basis });
    };
    for (const event of events) {
      if (event.lifeId !== activeLife) {
        activeLife = event.lifeId; facts.clear(); latest.clear(); delivery = {};
      }
      // Hearing a claim records the claim, not its truth. It cannot supersede
      // observations or teach a verified successful action.
      if (event.source !== 'observation' || /rumor|rumour/.test(event.kind)) {
        notes.push({ id: `report-${hash([actorId, eventRef(event)]).slice(0, 20)}`,
          actorId, lifeId: event.lifeId, kind: 'report', key: `report:${eventRef(event)}`,
          claim: `${event.kind}: ${canonical(event.payload)}`, value: event.kind,
          evidenceIds: [eventRef(event)], validWhen: { lifeId: event.lifeId, conditions: [] },
          confidenceKind: event.source === 'observation' ? 'report' : event.source,
          invalidatedBy: [], valid: true, simTime: event.simTime });
        continue;
      }
      const place = field(event, 'place', 'warehouse');
      const stockKey = `stock:${place}`;
      const self = event.actorId === actorId || field(event, 'actorId') === actorId;
      if (event.kind === 'out_of_stock') {
        const stock = (amount(event, 'available') ?? 0) > 0 ? 'limited' : 'empty';
        note(event, stockKey, stock, `${place} 最后亲见${stock === 'empty' ? '为空' : '库存不足以满足本次请求'}。`);
        if (self) {
          delivery = { empty: event };
          experience(event, 'deliver-meal', 'warehouse-withdraw', 'failure',
            '已亲见此来源缺货；再次取用前需有新库存证据，可核实替代来源或请求帮助。',
            [event], [{ key: stockKey, op: 'eq', value: stock }]);
        }
      }
      if (['stock_restocked', 'stock_deposited', 'stock_withdrawn'].includes(event.kind)) {
        const remaining = amount(event, 'total') ?? amount(event, 'remaining');
        const positive = remaining !== undefined ? remaining > 0
          : event.kind !== 'stock_withdrawn' && (amount(event, 'amount') ?? 0) > 0;
        if (remaining !== undefined || positive) {
          note(event, stockKey, positive ? 'stocked' : 'empty',
            `${place} 最新亲见库存${positive ? '可用' : '为空'}，旧库存判断已更新。`);
        }
        if (self && delivery.empty && event.kind === 'stock_deposited' && delivery.gather
          && (amount(event, 'amount') ?? 0) > 0) delivery.deposit = event;
        if (self && delivery.deposit && event.kind === 'stock_withdrawn'
          && (amount(event, 'amount') ?? 0) > 0) delivery.withdraw = event;
      }
      if (self && event.kind === 'gathered' && field(event, 'resource') === 'food'
        && (amount(event, 'amount') ?? 0) > 0 && delivery.empty) delivery.gather = event;
      if (event.kind === 'road_closed' || event.kind === 'road_reopened') {
        const road = field(event, 'roadId', field(event, 'detail', 'village'));
        note(event, `road:${road}`, event.kind === 'road_closed' ? 'closed' : 'open',
          `${road} 道路${event.kind === 'road_closed' ? '已关闭' : '已重开'}。`);
      }
      if (event.kind.startsWith('commitment_') && field(event, 'commitmentId')) {
        const status = event.kind.slice('commitment_'.length);
        if (['proposed', 'accepted', 'declined', 'cancelled', 'withdrawn', 'fulfilled', 'resumed', 'suspended'].includes(status)) {
          note(event, `commitment:${field(event, 'commitmentId')}`, status,
            `承诺 ${field(event, 'commitmentId')} 状态：${status}。`, 'commitment');
        }
      }
      if (['relation_changed', 'relationship_changed'].includes(event.kind)) {
        const partner = field(event, 'targetId', field(event, 'partnerId'));
        const trust = amount(event, 'trust');
        if (partner && trust !== undefined) {
          note(event, `relation:${partner}:trust`, trust, `对 ${partner} 的已知信任为 ${trust}。`, 'relationship');
          note(event, `relation:${partner}:cooperative`, trust >= 0.5,
            `${partner} 的合作判断随最新关系证据更新。`, 'relationship');
        }
      }
      if (['promise_kept', 'promise_broken', 'give', 'rescue', 'snatch'].includes(event.kind)
        && field(event, 'fromId') === actorId && field(event, 'toId')) {
        const confirmation = event.payload.confirmation as Record<string, unknown> | undefined;
        const confirmed = event.kind !== 'promise_kept' || Boolean(confirmation
          && confirmation.status === 'applied'
          && confirmation.promiseId === event.payload.promiseId
          && confirmation.beneficiaryId === event.payload.toId
          && Array.isArray(confirmation.eventIds)
          && confirmation.eventIds.includes(event.originEventId ?? event.eventId));
        if (confirmed) {
          const partner = field(event, 'toId');
          const delta: Record<string, number> = { promise_kept: 0.1, promise_broken: -0.2,
            give: 0.05, rescue: 0.3, snatch: -0.3 };
          const before = facts.get(`relation:${partner}:trust`);
          const trust = (typeof before === 'number' ? before : 0) + delta[event.kind];
          note(event, `relation:${partner}:trust`, trust,
            `对 ${partner} 的信任随已确认行为 ${event.kind} 更新为 ${trust}。`, 'relationship');
          note(event, `relation:${partner}:cooperative`, trust >= 0.5,
            `${partner} 的合作判断随实际行为更新。`, 'relationship');
        }
      }
      if (self && event.kind === 'cooperation_received' && field(event, 'partnerId')) {
        const partner = field(event, 'partnerId');
        const goal = field(event, 'goal', 'deliver-meal');
        note(event, `relation:${partner}:cooperative`, true, `${partner} 实际提供过协助。`, 'relationship');
        experience(event, goal, `ask-help:${partner}`, 'success',
          `${partner} 曾实际协助完成 ${goal}；再次合作需核对当前关系与可用性。`, [event],
          [{ key: `relation:${partner}:cooperative`, op: 'eq', value: true }]);
      }
      if (self && event.kind === 'meal_delivered' && (amount(event, 'amount') ?? 0) > 0) {
        note(event, `delivery:${event.eventId}`, 'delivered', '实际送饭回执已确认。');
        experience(event, 'deliver-meal', 'deliver-carried-food', 'success',
          '携带的食物已实际送达；发言或任务状态不能代替送达回执。', [event], []);
        if (delivery.empty && delivery.gather && delivery.deposit && delivery.withdraw) {
          experience(event, 'deliver-meal', 'gather-deposit-withdraw-deliver', 'success',
            '本次缺货后，采集→交存→取用→送达序列完成；缺货条件改变时重新比较仓库来源。',
            [delivery.empty, delivery.gather, delivery.deposit, delivery.withdraw, event],
            [{ key: `stock:${field(delivery.empty, 'place', 'warehouse')}`, op: 'eq',
              value: (amount(delivery.empty, 'available') ?? 0) > 0 ? 'limited' : 'empty' }],
            'observed-sequence');
        }
        delivery = {};
      }
    }
    // Prior lives contribute conditional experience, never current world facts.
    if (activeLife !== this.lifeId) facts.clear();
    return { notes, experiences, facts };
  }

  private applicability(experience: ConditionalExperience, facts: Map<string, FactValue>):
    'applicable' | 'unknown' | 'contradicted' {
    let unknown = false;
    for (const condition of experience.validWhen.conditions) {
      const value = facts.get(condition.key);
      if (value === undefined) unknown = true;
      else if (!matches(condition, value)) return 'contradicted';
    }
    return unknown ? 'unknown' : 'applicable';
  }

  query(options: MemoryQuery): MemoryContext {
    finite(options.tokenBudget, 'tokenBudget');
    if (!Number.isInteger(options.tokenBudget)) throw new Error('memory: tokenBudget must be an integer');
    const events = this.visibleEvents(options.actorId, options.now);
    const mode = options.mode ?? 'layered';
    if (!['raw', 'layered'].includes(mode)) throw new Error('memory: invalid retrieval mode');
    const projection = this.project(options.actorId, events);
    const candidates: Array<ContextItem & { score: number; order: number }> = [];
    const relevance = (text: string): number => (options.goal && text.includes(options.goal) ? 20 : 0)
      + (options.place && text.includes(options.place) ? 10 : 0);
    if (mode === 'raw') {
      events.forEach((event, order) => {
        const text = `[${eventRef(event)} ${event.source}] ${event.kind} ${canonical(event.payload)}`;
        candidates.push({ id: eventRef(event), kind: 'event', text,
          evidenceIds: [eventRef(event)], score: 0, order });
      });
    } else {
      projection.notes.filter(note => note.valid && note.lifeId === this.lifeId).forEach((note, order) => {
        const text = `[${note.confidenceKind};证据=${note.evidenceIds.join(',')}] ${note.claim}`;
        candidates.push({ id: note.id, kind: 'note', text, evidenceIds: note.evidenceIds,
          score: (note.kind === 'commitment' ? 90 : note.kind === 'report' ? 15 : 60) + relevance(note.key), order });
      });
      projection.experiences.filter(experience => !options.goal || experience.goal === options.goal)
        .forEach((experience, order) => {
          const applicability = this.applicability(experience, projection.facts);
          const status = applicability === 'applicable' ? '条件符合'
            : applicability === 'unknown' ? '需先核实条件' : '条件已变，不沿用此办法';
          const text = `[${experience.outcome};${status};条件=${canonical(experience.validWhen.conditions)};证据=${experience.evidenceIds.join(',')}] ${experience.lesson}`;
          candidates.push({ id: experience.id, kind: 'experience', text,
            evidenceIds: experience.evidenceIds, applicability,
            score: (applicability === 'applicable' ? 80 : applicability === 'unknown' ? 40 : 25)
              + relevance(`${experience.goal} ${canonical(experience.validWhen)}`), order });
        });
      // Non-specialized observed events remain available; consolidation must
      // not silently erase a new event type that the current folder ignores.
      const summarized = new Set([...projection.notes, ...projection.experiences]
        .flatMap(item => item.evidenceIds));
      events.filter(event => event.lifeId === this.lifeId && !summarized.has(eventRef(event)))
        .forEach((event, order) => candidates.push({ id: eventRef(event), kind: 'event',
          text: `[${eventRef(event)} ${event.source}] ${event.kind} ${canonical(event.payload)}`,
          evidenceIds: [eventRef(event)], score: 20 + relevance(event.kind), order }));
    }
    candidates.sort((a, b) => b.score - a.score || b.order - a.order || a.id.localeCompare(b.id));
    const selected: ContextItem[] = [];
    let contextText = '';
    for (const candidate of candidates) {
      const text = contextText ? `${contextText}\n${candidate.text}` : candidate.text;
      // UTF-8 bytes conservatively bound byte-tokenizer tokens, including CJK.
      // Never cut a sentence/evidence reference midway to claim it fitted.
      if (Buffer.byteLength(text, 'utf8') > options.tokenBudget) continue;
      const { score: _score, order: _order, ...item } = candidate;
      selected.push(copy(item)); contextText = text;
    }
    const evidenceIds = [...new Set(selected.flatMap(item => item.evidenceIds))];
    const observationHash = hash(events);
    return { schema: 'frostecho.jev-memory-context/1', actorId: options.actorId,
      lifeId: this.lifeId, mode, contextText, items: selected, evidenceIds, observationHash,
      memoryHash: hash({ actorId: options.actorId, lifeId: this.lifeId, mode, contextText, evidenceIds }),
      tokenBudget: options.tokenBudget, estimatedTokens: Buffer.byteLength(contextText, 'utf8'),
      tokenEstimator: 'utf8-byte-upper-bound', omitted: candidates.length - selected.length,
      applicableExperienceIds: selected.filter(item => item.kind === 'experience'
        && item.applicability === 'applicable').map(item => item.id) };
  }

  /** Night/rest consolidation rechecks sources; it never overwrites the log. */
  consolidate(options: { actorId: string; now: number }): {
    actorId: string; lifeId: string; notes: MemoryNote[]; experiences: ConditionalExperience[];
    checkedEvidenceIds: string[]; sourceVerified: true; sourceHash: string;
  } {
    const events = this.visibleEvents(options.actorId, options.now);
    const projection = this.project(options.actorId, events);
    const visible = new Set(events.map(eventRef));
    const references = [...new Set([...projection.notes, ...projection.experiences]
      .flatMap(item => item.evidenceIds))];
    if (references.some(id => !visible.has(id))) throw new Error('memory: consolidation source unavailable');
    return copy({ actorId: options.actorId, lifeId: this.lifeId,
      notes: projection.notes, experiences: projection.experiences,
      checkedEvidenceIds: references, sourceVerified: true as const, sourceHash: hash(events) });
  }

  nextLife(options: Omit<LifeTransition, 'lifeId'>): LifeTransition {
    nonempty(options.nextLifeId, 'nextLifeId'); nonempty(options.ending, 'ending');
    nonempty(options.rulesProfile, 'rulesProfile'); nonempty(options.seed, 'seed');
    if ([this.initialLifeId, ...this.transitions.map(item => item.nextLifeId)].includes(options.nextLifeId)) {
      throw new Error('memory: nextLifeId must be new');
    }
    const transition = { lifeId: this.lifeId, ...copy(options) };
    this.transitions.push(transition); this.lifeId = options.nextLifeId;
    return copy(transition);
  }

  serialize(): SerializedLongTermMemory {
    return copy({ schema: 'frostecho.jev-memory/1', initialLifeId: this.initialLifeId,
      currentLifeId: this.lifeId, events: this.events, transitions: this.transitions });
  }

  static restore(snapshot: SerializedLongTermMemory): LongTermMemory {
    if (snapshot.schema !== 'frostecho.jev-memory/1'
      || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.transitions)) {
      throw new Error('memory: unsupported snapshot');
    }
    const store = new LongTermMemory(snapshot.initialLifeId);
    const remaining = [...snapshot.events];
    for (const transition of [...snapshot.transitions, null]) {
      const events = remaining.filter(event => event.lifeId === store.lifeId);
      for (const event of events) store.ingest(event);
      for (const event of events) remaining.splice(remaining.indexOf(event), 1);
      if (transition) {
        if (transition.lifeId !== store.lifeId) throw new Error('memory: invalid life transition');
        store.nextLife(transition);
      }
    }
    if (remaining.length || store.lifeId !== snapshot.currentLifeId) throw new Error('memory: invalid snapshot lineage');
    return store;
  }
}

/** Both arms use exactly the same observed ledger; only retrieval differs. */
export function compareMemoryContexts(memory: LongTermMemory, query: Omit<MemoryQuery, 'mode'>): {
  raw: MemoryContext; layered: MemoryContext;
} {
  return { raw: memory.query({ ...query, mode: 'raw' }),
    layered: memory.query({ ...query, mode: 'layered' }) };
}
