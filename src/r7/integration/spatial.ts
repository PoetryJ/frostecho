/** Original-map movement on the existing runtime commit, world and clock. */
import { createHash } from 'node:crypto';
import { DEFAULT_WAREHOUSE_FOOD, TRAVEL_STAMINA_PER_TILE, type WorldEvent } from '../../survival/world-v2';
import { absoluteMinute, type WorldIntent, type LocationId } from '../contracts';
import { cellKey, type Cell } from '../../spatial-v2/map';
import { LEGACY_MAP_IDS, createLegacyMapRegistry, findLegacyRoute, makeLegacyPosition,
  moveLegacyPosition, transitionLegacyDoor, parseLegacyPosition, type LegacyMapId,
  type LegacyPosition } from '../../spatial-v2/legacy-profile';
import { nextLegAt, type ActionIntent, type IntentLeg } from './action-intent';
import type { R8Runtime } from './runtime';

export const LEGACY_TILE_MINUTES = 1;
export const LEGACY_SPATIAL_ENABLED_KEY = 'legacySpatial.enabled';
const key = (actor: string, field: string): string => `legacySpatial.${actor}.${field}`;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export const mapLocation = (map: LegacyMapId): LocationId =>
  (map === 'dorm_a' ? 'dorm-a' : map === 'dorm_b' ? 'dorm-b' : map);
const locationMap = (location: string): LegacyMapId =>
  (location === 'dorm-a' ? 'dorm_a' : location === 'dorm-b' ? 'dorm_b' : location) as LegacyMapId;
export interface LegacyMovementResult {
  status: 'applied' | 'rejected' | 'duplicate'; reason: string; eventIds: string[];
  position: LegacyPosition | null; postStateVersion: number; elapsedMinutes: number;
}
/** A travel plan is pure data: no clock, no world mutation, fully serialisable. */
export interface TravelPlan {
  status: 'planned';
  target: LegacyMapId;
  path: IntentLeg[];
  minutes: number;
}
export interface TravelPlanRejected { status: 'rejected'; reason: string }
/** Outcome of landing ONE planned leg (a leg is one minute of real walking). */
export interface LegLanding {
  status: 'landed' | 'applied' | 'rejected';
  reason: string;
  eventId: string | null;
  observedEventIds: string[];
  position: LegacyPosition | null;
}
type Commit = (intents: readonly WorldIntent[], events: { type: string; actorId: string;
  payload: Record<string, unknown> }[]) => { applied: string[]; rejected: { code: string; reason: string }[];
  events: WorldEvent[] };

export class LegacySpatialController {
  constructor(private readonly runtime: R8Runtime, private readonly commit: Commit) {
    // Guard both public legacy submission paths, including runStep's scorer
    // selection. Existing runtimes that do not opt in retain original behavior.
    const session = runtime.session;
    const submit = session.submitWorldCommand.bind(session);
    const execute = session.executeCandidate.bind(session);
    session.submitWorldCommand = command => {
      if (!this.enabled()) return submit(command);
      if (command.type === 'travel') return { status: 'rejected',
        reason: 'original_map_requires_walkLegacy_not_three_map_travel', eventIds: [], events: [], observedBy: [] };
      if (command.type !== 'move') return submit(command);
      const result = this.travelTo(command.actorId, command.to, command.commandId);
      return { status: result.status === 'duplicate' ? 'applied' : result.status,
        reason: result.reason, eventIds: result.eventIds,
        events: this.events(result.eventIds), observedBy: result.eventIds.length ? [command.actorId] : [] };
    };
    session.executeCandidate = (actorId, candidate, commandId, grant) => {
      if (!this.enabled() || candidate.parameters.action !== 'move') {
        return execute(actorId, candidate, commandId, grant);
      }
      const result = candidate.parameters.purpose === 'verify-stock'
        && this.position(actorId)?.mapId === 'warehouse'
        ? this.observeStock(actorId, commandId)
        : this.travelTo(actorId, String(candidate.parameters.to ?? ''), commandId);
      return { status: result.status === 'duplicate' ? 'applied' : result.status,
        reason: result.reason, eventIds: result.eventIds,
        postStateVersion: result.postStateVersion, events: this.events(result.eventIds) };
    };
  }
  enabled(): boolean { return this.runtime.world.r8?.facts[LEGACY_SPATIAL_ENABLED_KEY] === 1; }
  private registry() { return createLegacyMapRegistry({
    gatesClosed: this.runtime.world.r8?.facts['legacySpatial.gatesClosed'] === 1 }); }
  position(actorId: string): LegacyPosition | null {
    if (!this.enabled()) return null;
    const facts = this.runtime.world.r8!.facts;
    const mapId = LEGACY_MAP_IDS[facts[key(actorId, 'map')]];
    const position = makeLegacyPosition(mapId, { x: facts[key(actorId, 'x')], y: facts[key(actorId, 'y')] }, this.registry());
    if (this.runtime.world.npcs[actorId]?.location !== mapLocation(mapId))
      throw new Error(`legacy_spatial_location_drift:${actorId}`);
    return position;
  }
  private note(id: string, actorId: string, fact: string, value: number): WorldIntent {
    return { id, actorId, kind: 'intent-note', key: fact, value, source: 'legacy.spatial', preconditions: [] };
  }
  private positionIntents(actorId: string, position: LegacyPosition, commandId: string): WorldIntent[] {
    return [this.note(`${commandId}:map`, actorId, key(actorId, 'map'), LEGACY_MAP_IDS.indexOf(position.mapId)),
      this.note(`${commandId}:x`, actorId, key(actorId, 'x'), position.cell.x),
      this.note(`${commandId}:y`, actorId, key(actorId, 'y'), position.cell.y),
      { id: `${commandId}:location`, kind: 'spatial', actorId, to: mapLocation(position.mapId),
        source: 'legacy.spatial', preconditions: [{ kind: 'actor_alive', actorId }] }];
  }
  enable(): { status: 'applied' | 'duplicate'; eventIds: string[]; positions: Record<string, LegacyPosition> } {
    if (this.runtime.profile.id !== 'gospel-5.8.19') throw new Error('legacy_spatial_requires_gospel_profile');
    const positions: Record<string, LegacyPosition> = {};
    if (this.enabled()) {
      for (const actorId of this.runtime.session.npcIds) positions[actorId] = this.position(actorId)!;
      return { status: 'duplicate', eventIds: [], positions };
    }
    const registry = this.registry();
    const intents: WorldIntent[] = [this.note('legacy-spatial-enable', 'system', LEGACY_SPATIAL_ENABLED_KEY, 1)];
    for (const actorId of this.runtime.session.npcIds) {
      const mapId = locationMap(this.runtime.world.npcs[actorId].location);
      const map = registry.maps[mapId];
      if (!map) throw new Error(`cannot_migrate_location:${mapId}`);
      const at = mapId === 'village' ? this.runtime.world.spatial?.positions[actorId]
        ?? registry.maps.village.interests.furnace_plaza : map.entrySpawn!;
      positions[actorId] = makeLegacyPosition(mapId, at, registry);
      // Migration records coordinates only; existing locations are unchanged,
      // including dead actors whose save still needs a map coordinate.
      intents.push(...this.positionIntents(actorId, positions[actorId], `legacy-enable:${actorId}`).slice(0, 3));
    }
    const committed = this.commit(intents, [{ type: 'legacy_spatial_enabled', actorId: 'system',
      payload: { profileId: registry.profileId, actors: Object.keys(positions).length,
        migration: 'existing location to original map entry', tileMinutes: LEGACY_TILE_MINUTES } }]);
    if (committed.rejected.length) throw new Error('legacy_spatial_enable_commit_failed');
    return { status: 'applied', eventIds: committed.events.map(event => event.eventId), positions };
  }
  private events(ids: string[]): WorldEvent[] {
    return ids.map(id => this.runtime.committedEvent(id)).filter(event => event !== null) as WorldEvent[];
  }
  private reject(actorId: string, reason: string): LegacyMovementResult {
    return { status: 'rejected', reason, eventIds: [], position: this.enabled()
      && this.runtime.world.npcs[actorId] ? this.position(actorId) : null,
      postStateVersion: this.runtime.world.version, elapsedMinutes: 0 };
  }
  private check(actorId: string): string | null {
    if (!this.enabled()) return 'original_map_not_enabled';
    if (!this.runtime.world.npcs[actorId]?.alive) return 'actor_not_alive';
    if (this.runtime.ended) return 'world_already_ended';
    const end = absoluteMinute(this.runtime.profile, this.runtime.profile.endDay, this.runtime.profile.endMinuteOfDay);
    if (this.runtime.world.simTime + LEGACY_TILE_MINUTES > end) return 'insufficient_time_before_ending';
    if (this.runtime.world.npcs[actorId].stamina < TRAVEL_STAMINA_PER_TILE) return 'insufficient_stamina';
    return null;
  }
  private replay(actorId: string, commandId: string, digest: string): LegacyMovementResult | null {
    const previous = this.runtime.committedEvent(`legacy-command:${sha(commandId)}`);
    if (!previous) return null;
    if (previous.payload.digest !== digest) return this.reject(actorId, 'command_id_conflict');
    const result = JSON.parse(String(previous.payload.resultJson)) as LegacyMovementResult;
    return { ...result, status: result.status === 'applied' ? 'duplicate' : result.status, reason: 'duplicate_replay' };
  }
  private remember(actorId: string, commandId: string, digest: string,
    result: LegacyMovementResult): LegacyMovementResult {
    if (!result.eventIds.length) return result;
    const eventId = `legacy-command:${sha(commandId)}`;
    const full = { ...result, eventIds: [...result.eventIds, eventId] };
    this.runtime.recordCommitted([{ eventId, type: 'legacy_spatial_command', actorId,
      simTime: this.runtime.world.simTime, payload: { commandId, digest, resultJson: JSON.stringify(full) } }]);
    return full;
  }
  /**
   * Commit ONE physical step: coordinates, location and the real effort, then
   * the step receipt. This never moves the clock; the caller owns time.
   */
  private commitStep(actorId: string, to: LegacyPosition, commandId: string, kind: string):
    LegacyMovementResult {
    const before = this.runtime.world.simTime;
    const from = this.position(actorId)!;
    const intents = this.positionIntents(actorId, to, commandId);
    intents.push({ id: `${commandId}:effort`, kind: 'actor', actorId,
      delta: { stamina: -TRAVEL_STAMINA_PER_TILE }, source: 'legacy.spatial',
      preconditions: [{ kind: 'actor_alive', actorId }] });
    const committed = this.commit(intents, []);
    if (committed.rejected.length) throw new Error('legacy_spatial_commit_failed');
    const movement: WorldEvent = { eventId: `legacy-step:${sha(commandId)}`, type: kind, actorId,
      simTime: before, payload: { fromMap: from.mapId, toMap: to.mapId, fromX: from.cell.x,
        fromY: from.cell.y, x: to.cell.x, y: to.cell.y, commandId,
        extraStamina: TRAVEL_STAMINA_PER_TILE, minutes: LEGACY_TILE_MINUTES } };
    this.runtime.recordCommitted([movement]);
    this.runtime.session.ingestTeamEvent(kind, movement.payload, before);
    const observed = kind === 'legacy_door_crossed' && to.mapId === 'warehouse'
      && this.runtime.world.npcs[actorId].alive ? this.observeStock(actorId, `${commandId}:inspect`) : null;
    return { status: 'applied', reason: kind, eventIds: [movement.eventId, ...(observed?.eventIds ?? [])],
      position: this.position(actorId), postStateVersion: this.runtime.world.version,
      elapsedMinutes: this.runtime.world.simTime - before };
  }

  /**
   * Legacy synchronous step: the step itself never advances the clock, then
   * the single clock owner pays its minute. This is the only clock request the
   * legacy command path makes, and it is never issued from inside settlement.
   */
  private land(actorId: string, to: LegacyPosition, commandId: string, kind: string): LegacyMovementResult {
    const before = this.runtime.world.simTime;
    const stepped = this.commitStep(actorId, to, commandId, kind);
    // The step receipt is stamped at the time it is paid for.
    this.runtime.advanceWorld(before + LEGACY_TILE_MINUTES);
    return { ...stepped, position: this.position(actorId),
      postStateVersion: this.runtime.world.version,
      elapsedMinutes: this.runtime.world.simTime - before };
  }

  /**
   * Plan a macro `move` as a serialisable travel phase. Pure: it reads the
   * world, never mutates it and never moves the clock, so the queue can price
   * the walk correctly at enqueue time ("path and work minutes are planned").
   */
  planTravel(actorId: string, targetLocation: string): TravelPlan | TravelPlanRejected {
    const refused = this.check(actorId);
    if (refused) return { status: 'rejected', reason: refused };
    const registry = this.registry();
    const target = locationMap(targetLocation);
    if (!registry.maps[target]) return { status: 'rejected', reason: 'unknown_original_destination' };
    const from = this.position(actorId)!;
    if (from.mapId === target) return { status: 'rejected', reason: 'already_in_destination_map' };
    const path: IntentLeg[] = [];
    let mapId = from.mapId;
    let cell: Cell = { ...from.cell };
    const walk = (goal: Cell): string | null => {
      const route = findLegacyRoute(mapId, cell, goal, this.closedCells(mapId), registry);
      if (!route.path) return 'original_route_blocked';
      // Standing ON the door tile is not a failure: the leg list simply starts
      // at the door itself, exactly like the synchronous walk accepted it.
      if (route.path.length < 2) return null;
      for (const step of route.path.slice(1)) {
        path.push({ index: path.length, kind: 'cell', mapId,
          cell: { x: step.x, y: step.y }, targetMapId: null, minutes: LEGACY_TILE_MINUTES });
      }
      cell = { ...route.path[route.path.length - 1] };
      return null;
    };
    const door = (): string | null => {
      let transition: ReturnType<typeof transitionLegacyDoor>;
      try { transition = transitionLegacyDoor(makeLegacyPosition(mapId, cell, registry), registry); }
      catch (error) { return (error as Error).message; }
      if (!transition) return 'actor_not_at_original_door';
      if (this.closedCells(transition.from.mapId).has(cellKey(transition.from.cell))
        || this.closedCells(transition.to.mapId).has(cellKey(transition.to.cell)))
        return 'original_door_closed';
      path.push({ index: path.length, kind: 'door', mapId, cell: { ...cell },
        targetMapId: transition.to.mapId, minutes: LEGACY_TILE_MINUTES });
      mapId = transition.to.mapId;
      cell = { ...transition.to.cell };
      return null;
    };
    if (mapId !== 'village') {
      const exit = registry.maps[mapId].triggers[0];
      const failed = walk({ x: exit.x, y: exit.y }) ?? door();
      if (failed) return { status: 'rejected', reason: failed };
    }
    if (target !== 'village') {
      const entry = registry.maps.village.triggers.find(trigger => trigger.target === target)!;
      const failed = walk({ x: entry.x, y: entry.y }) ?? door();
      if (failed) return { status: 'rejected', reason: failed };
    }
    if (mapId !== target) return { status: 'rejected', reason: 'route_receipt_position_changed' };
    if (path.length === 0) return { status: 'rejected', reason: 'already_at_destination' };
    return { status: 'planned', target, path,
      minutes: path.reduce((sum, leg) => sum + leg.minutes, 0) };
  }

  /**
   * Land exactly the next leg of a queued travel intent. The clock has already
   * been advanced by `advanceWorld` to this leg's due minute, so this only
   * commits the physical effect of time that was paid. Landing the same leg
   * twice is impossible: `progress.leg` is the cursor and the caller claims the
   * intent first.
   */
  landLeg(intent: ActionIntent): LegLanding {
    const move = intent.move;
    const actorId = intent.actorId;
    const failed = (reason: string): LegLanding => ({ status: 'rejected', reason, eventId: null,
      observedEventIds: [], position: null });
    if (!move) return failed('no_travel_plan');
    if (!this.enabled()) return failed('original_map_not_enabled');
    if (!this.runtime.world.npcs[actorId]?.alive) return failed('actor_not_alive');
    if (this.runtime.ended) return failed('world_already_ended');
    // The way was already shut when the trip was queued: the actor still spends
    // the minute, and the refusal is a real record rather than a silent drop.
    if (move.refusedReason) return failed(move.refusedReason);
    if (move.leg >= move.path.length)
      return { status: 'applied', reason: 'original_maps_traversed', eventId: null,
        observedEventIds: [], position: this.position(actorId) };
    const leg = move.path[move.leg];
    const due = nextLegAt(intent);
    if (due !== null && this.runtime.world.simTime < due) return failed(`leg_not_paid_yet:${due}`);
    const end = absoluteMinute(this.runtime.profile, this.runtime.profile.endDay,
      this.runtime.profile.endMinuteOfDay);
    if (this.runtime.world.simTime + leg.minutes > end)
      return failed('insufficient_time_before_ending');
    if (this.runtime.world.npcs[actorId].stamina < TRAVEL_STAMINA_PER_TILE)
      return failed('insufficient_stamina');
    const here = this.position(actorId)!;
    const commandId = `${intent.intentId}:step:${leg.index}`;
    let next: LegacyPosition;
    if (leg.kind === 'cell') {
      if (here.mapId !== leg.mapId) return failed('travel_plan_position_drift');
      try { next = moveLegacyPosition(here, leg.cell, this.closedCells(leg.mapId), this.registry()); }
      catch (error) { return failed((error as Error).message); }
    } else {
      if (here.mapId !== leg.mapId || cellKey(here.cell) !== cellKey(leg.cell))
        return failed('travel_plan_position_drift');
      let transition: ReturnType<typeof transitionLegacyDoor>;
      try { transition = transitionLegacyDoor(here, this.registry()); }
      catch (error) { return failed((error as Error).message); }
      if (!transition) return failed('actor_not_at_original_door');
      if (this.closedCells(transition.from.mapId).has(cellKey(transition.from.cell))
        || this.closedCells(transition.to.mapId).has(cellKey(transition.to.cell)))
        return failed('original_door_closed');
      next = transition.to;
    }
    let stepped: LegacyMovementResult;
    try { stepped = this.commitStep(actorId, next, commandId,
      leg.kind === 'door' ? 'legacy_door_crossed' : 'legacy_cell_moved'); }
    catch (error) { return failed(`leg_commit_failed:${(error as Error).message}`); }
    move.leg += 1;
    move.progress += leg.minutes;
    move.committedAt = this.runtime.world.simTime;
    move.legReceiptIds.push(stepped.eventIds[0]);
    move.landedAt.push(this.runtime.world.simTime);
    const observedEventIds = stepped.eventIds.slice(1);
    if (move.leg >= move.path.length) {
      return { status: 'applied', reason: 'original_maps_traversed',
        eventId: stepped.eventIds[0], observedEventIds, position: this.position(actorId) };
    }
    return { status: 'landed', reason: stepped.reason, eventId: stepped.eventIds[0],
      observedEventIds, position: this.position(actorId) };
  }
  /** A direct engine observation is private to the actor inside the warehouse. */
  observeStock(actorId: string, suppliedId?: string): LegacyMovementResult {
    const commandId = suppliedId ?? `legacy-observe:${actorId}:${this.runtime.world.version}`;
    const digest = sha(JSON.stringify({ kind: 'observe-warehouse-stock', actorId }));
    const replay = this.replay(actorId, commandId, digest); if (replay) return replay;
    if (!this.enabled()) return this.reject(actorId, 'original_map_not_enabled');
    if (!this.runtime.world.npcs[actorId]?.alive) return this.reject(actorId, 'actor_not_alive');
    const position = this.position(actorId)!;
    if (position.mapId !== 'warehouse') return this.reject(actorId, 'warehouse_stock_not_visible');
    const remaining = this.runtime.world.spatial?.stocks.warehouse.food ?? DEFAULT_WAREHOUSE_FOOD;
    const at = this.runtime.world.simTime;
    this.commit([this.note(`${commandId}:observed-at`, actorId, key(actorId, 'stockObservedAt'), at)], []);
    const event: WorldEvent = { eventId: `legacy-observation:${sha(commandId)}`,
      type: 'warehouse_stock_observed', actorId, simTime: at,
      payload: { place: 'warehouse', resource: 'food', remaining, simTime: at, commandId } };
    this.runtime.recordCommitted([event]);
    this.runtime.session.memories.get(actorId)!.append({ eventId: event.eventId, observerId: actorId,
      occurredAt: at, observedAt: at, kind: event.type, subjectIds: [actorId, 'warehouse'],
      payload: event.payload, source: 'engine', authority: 'engine', speakerId: 'engine' });
    return this.remember(actorId, commandId, digest, { status: 'applied', reason: 'warehouse_stock_observed',
      eventIds: [event.eventId], position, postStateVersion: this.runtime.world.version, elapsedMinutes: 0 });
  }
  move(actorId: string, to: Cell, suppliedId?: string): LegacyMovementResult {
    const commandId = suppliedId ?? `legacy-move:${actorId}:${this.runtime.world.version}`;
    const digest = sha(JSON.stringify({ kind: 'move', actorId, to }));
    const replay = this.replay(actorId, commandId, digest); if (replay) return replay;
    const reason = this.check(actorId); if (reason) return this.reject(actorId, reason);
    const from = this.position(actorId)!;
    let next: LegacyPosition;
    try { next = moveLegacyPosition(from, to, this.closedCells(from.mapId), this.registry()); }
    catch (error) { return this.reject(actorId, (error as Error).message); }
    return this.remember(actorId, commandId, digest, this.land(actorId, next, commandId, 'legacy_cell_moved'));
  }
  door(actorId: string, suppliedId?: string): LegacyMovementResult {
    const commandId = suppliedId ?? `legacy-door:${actorId}:${this.runtime.world.version}`;
    const digest = sha(JSON.stringify({ kind: 'door', actorId }));
    const replay = this.replay(actorId, commandId, digest); if (replay) return replay;
    const reason = this.check(actorId); if (reason) return this.reject(actorId, reason);
    const from = this.position(actorId)!;
    const transition = transitionLegacyDoor(from, this.registry());
    if (!transition) return this.reject(actorId, 'actor_not_at_original_door');
    if (this.closedCells(from.mapId).has(cellKey(from.cell))
      || this.closedCells(transition.to.mapId).has(cellKey(transition.to.cell)))
      return this.reject(actorId, 'original_door_closed');
    return this.remember(actorId, commandId, digest, this.land(actorId, transition.to, commandId, 'legacy_door_crossed'));
  }
  private closedCells(mapId: LegacyMapId): Set<string> {
    return new Set(mapId === 'village' ? this.runtime.world.spatial?.closedCells ?? [] : []);
  }
  walk(actorId: string, to: Cell, suppliedId?: string): LegacyMovementResult {
    const commandId = suppliedId ?? `legacy-walk:${actorId}:${this.runtime.world.version}`;
    const digest = sha(JSON.stringify({ kind: 'walk', actorId, to }));
    const replay = this.replay(actorId, commandId, digest); if (replay) return replay;
    const reason = this.check(actorId); if (reason) return this.reject(actorId, reason);
    const from = this.position(actorId)!;
    const route = findLegacyRoute(from.mapId, from.cell, to, this.closedCells(from.mapId), this.registry());
    if (!route.path) return this.reject(actorId, 'original_route_blocked');
    if (route.path.length < 2) return this.reject(actorId, 'already_at_destination');
    const start = this.runtime.world.simTime, eventIds: string[] = [];
    for (const [index, next] of route.path.slice(1).entries()) {
      const moved = this.move(actorId, next, `${commandId}:step:${index}`);
      eventIds.push(...moved.eventIds);
      const actual = this.position(actorId)!;
      if (moved.status === 'rejected' || actual.mapId !== from.mapId
        || actual.cell.x !== next.x || actual.cell.y !== next.y) return this.remember(actorId, commandId, digest,
        { ...moved, status: 'rejected', reason: `route_interrupted:${moved.reason}:position_checked`, eventIds,
          position: actual, postStateVersion: this.runtime.world.version,
          elapsedMinutes: this.runtime.world.simTime - start });
    }
    return this.remember(actorId, commandId, digest, { status: 'applied', reason: 'original_route_walked',
      eventIds, position: this.position(actorId), postStateVersion: this.runtime.world.version,
      elapsedMinutes: this.runtime.world.simTime - start });
  }
  travelTo(actorId: string, targetLocation: string, suppliedId?: string): LegacyMovementResult {
    const commandId = suppliedId ?? `legacy-travel:${actorId}:${this.runtime.world.version}`;
    const digest = sha(JSON.stringify({ kind: 'travel-to-location', actorId, targetLocation }));
    const replay = this.replay(actorId, commandId, digest); if (replay) return replay;
    const reason = this.check(actorId); if (reason) return this.reject(actorId, reason);
    const target = locationMap(targetLocation), registry = this.registry();
    if (!registry.maps[target]) return this.reject(actorId, 'unknown_original_destination');
    if (this.position(actorId)!.mapId === target) return this.reject(actorId, 'already_in_destination_map');
    const start = this.runtime.world.simTime, eventIds: string[] = [];
    let index = 0;
    const take = (result: LegacyMovementResult): boolean => {
      eventIds.push(...result.eventIds); return result.status !== 'rejected' || result.reason === 'already_at_destination';
    };
    const finish = (status: LegacyMovementResult['status'], reason: string): LegacyMovementResult =>
      this.remember(actorId, commandId, digest, { status, reason, eventIds,
        position: this.position(actorId), postStateVersion: this.runtime.world.version,
        elapsedMinutes: this.runtime.world.simTime - start });
    const from = this.position(actorId)!;
    if (from.mapId !== 'village') {
      const exit = registry.maps[from.mapId].triggers[0];
      if (!take(this.walk(actorId, { x: exit.x, y: exit.y }, `${commandId}:part:${index++}`))
        || !take(this.door(actorId, `${commandId}:part:${index++}`))) return finish('rejected', 'original_exit_interrupted');
    }
    if (target !== 'village') {
      const entry = registry.maps.village.triggers.find(trigger => trigger.target === target)!;
      if (!take(this.walk(actorId, { x: entry.x, y: entry.y }, `${commandId}:part:${index++}`))
        || !take(this.door(actorId, `${commandId}:part:${index++}`))) return finish('rejected', 'original_entry_interrupted');
    }
    return finish(this.position(actorId)!.mapId === target ? 'applied' : 'rejected',
      this.position(actorId)!.mapId === target ? 'original_maps_traversed' : 'route_receipt_position_changed');
  }
}
