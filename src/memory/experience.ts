/**
 * R3 (E): minimal conditional experience notes. A note is a practical lesson
 * ("the warehouse was empty when I stood there") tied to the events that prove
 * it, NOT a permanent world fact. Notes are invalidated by contradicting
 * events the actor personally witnessed (a restock refills the warehouse, a
 * reopening clears the blocked road), so experience can never permanently
 * disable an option.
 *
 * The whole store is recomputable from the actor's own raw event log —
 * `ExperienceStore.fromEvents(actorId, events)` replays the same folds.
 */
import { randomUUID } from 'node:crypto';

/**
 * Lessons an actor can hold. Kept deliberately tiny (R3 scope) and BOTH-SIDED:
 * failures (empty shelves, a closed road) and successes (stock actually taken,
 * a delivery confirmed) are recorded — never only the negative side.
 */
export type ExperienceLesson = 'warehouse-empty' | 'road-blocked'
  | 'warehouse-stocked' | 'delivery-confirmed';

/** Events that CREATE a note (own observation only; rumors never qualify). */
const NOTE_MAKERS: Record<string, ExperienceLesson> = {
  out_of_stock: 'warehouse-empty',
  road_closed: 'road-blocked',
  stock_withdrawn: 'warehouse-stocked',
  stock_restocked: 'warehouse-stocked',
  meal_delivered: 'delivery-confirmed',
};

/** Events that INVALIDATE a lesson when personally witnessed. */
const NOTE_INVALIDATORS: Partial<Record<ExperienceLesson, string>> = {
  'warehouse-empty': 'stock_restocked',
  'road-blocked': 'road_reopened',
  'warehouse-stocked': 'out_of_stock',
};

export interface ExperienceNote {
  noteId: string;
  ownerActorId: string;
  lesson: ExperienceLesson;
  /** Conditions under which it was learned (place, learnedAt simTime). */
  conditions: { place: string; learnedAt: number };
  source: 'own-observation';
  evidenceEventIds: string[];
  /** Events that ended this note's validity. */
  invalidatedByEventIds: string[];
  valid: boolean;
}

/** Minimal event shape needed for folding (world events and memory records). */
export type FoldableEvent = {
  eventId?: string;
  type?: string;
  kind?: string;
  simTime?: number;
  payload?: Record<string, unknown>;
};

function eventType(event: FoldableEvent): string {
  return event.type ?? event.kind ?? '';
}

export class ExperienceStore {
  private constructor(private readonly notes: Record<string, ExperienceNote>) {}

  static empty(): ExperienceStore {
    return new ExperienceStore({});
  }

  /** Replay an actor's own event log into notes (recomputable at any time). */
  static fromEvents(ownerActorId: string, events: readonly FoldableEvent[]): ExperienceStore {
    const store = ExperienceStore.empty();
    for (const event of events) store.observe(ownerActorId, event);
    return store;
  }

  static fromJSON(notes: Record<string, ExperienceNote>): ExperienceStore {
    return new ExperienceStore(structuredClone(notes));
  }

  /** Fold one personally-witnessed event into the store. */
  observe(ownerActorId: string, event: FoldableEvent): void {
    const type = eventType(event);
    const evidence = event.eventId ?? `synthetic:${type}:${String(event.simTime ?? 0)}`;
    this.invalidate(ownerActorId, type, evidence);
    const lesson = NOTE_MAKERS[type];
    if (!lesson) return;
    this.note(ownerActorId, lesson, {
      place: String(event.payload?.place ?? event.payload?.to ?? 'village'),
      learnedAt: Number(event.simTime ?? 0),
    }, [evidence]);
  }

  /** Record (or refresh) one evidence-backed note for an actor. */
  note(ownerActorId: string, lesson: ExperienceLesson,
    conditions: ExperienceNote['conditions'], evidenceEventIds: string[]):
    ExperienceNote {
    const existing = Object.values(this.notes).find(note =>
      note.ownerActorId === ownerActorId && note.lesson === lesson && note.valid);
    if (existing) {
      for (const evidence of evidenceEventIds) {
        if (!existing.evidenceEventIds.includes(evidence)) {
          existing.evidenceEventIds.push(evidence);
        }
      }
      return existing;
    }
    const noteId = `exp-${randomUUID()}`;
    const note: ExperienceNote = {
      noteId, ownerActorId, lesson, source: 'own-observation',
      conditions: { ...conditions },
      evidenceEventIds: [...evidenceEventIds], invalidatedByEventIds: [], valid: true,
    };
    this.notes[noteId] = note;
    return note;
  }

  /** Invalidate every valid note contradicted by one witnessed event type. */
  invalidate(ownerActorId: string, contradictionType: string, evidenceEventId: string): number {
    let ended = 0;
    for (const note of Object.values(this.notes)) {
      if (!note.valid || note.ownerActorId !== ownerActorId) continue;
      if (NOTE_INVALIDATORS[note.lesson] !== contradictionType) continue;
      note.valid = false;
      note.invalidatedByEventIds.push(evidenceEventId);
      ended += 1;
    }
    return ended;
  }

  /** Rebuild this owner's notes from the raw event log (recomputation path). */
  refetch(ownerActorId: string, events: readonly FoldableEvent[]): void {
    for (const [noteId, note] of Object.entries(this.notes)) {
      if (note.ownerActorId === ownerActorId) delete this.notes[noteId];
    }
    const rebuilt = ExperienceStore.fromEvents(ownerActorId, events);
    Object.assign(this.notes, rebuilt.toJSON());
  }

  validNotes(ownerActorId: string, lesson?: ExperienceLesson): ExperienceNote[] {
    return Object.values(this.notes).filter(note =>
      note.ownerActorId === ownerActorId && note.valid
      && (lesson === undefined || note.lesson === lesson));
  }

  /** True only while a fresh (uncontradicted) empty-warehouse note exists. */
  believesWarehouseEmpty(ownerActorId: string): boolean {
    return this.validNotes(ownerActorId, 'warehouse-empty').length > 0;
  }

  /** True while the last witnessed stock evidence was positive (success side). */
  believesWarehouseStocked(ownerActorId: string): boolean {
    return this.validNotes(ownerActorId, 'warehouse-stocked').length > 0;
  }

  /** True when a confirmed delivery is on record (success side). */
  believesDeliveryConfirmed(ownerActorId: string): boolean {
    return this.validNotes(ownerActorId, 'delivery-confirmed').length > 0;
  }

  believesRoadBlocked(ownerActorId: string): boolean {
    return this.validNotes(ownerActorId, 'road-blocked').length > 0;
  }

  toJSON(): Record<string, ExperienceNote> {
    return structuredClone(this.notes);
  }
}
