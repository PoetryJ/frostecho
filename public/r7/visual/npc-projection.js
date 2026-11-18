/**
 * Read-only projection: VisualSnapshot/1 -> what the display may draw.
 *
 * No WebGPU, no DOM, no timers. That is deliberate: the same function is imported
 * headlessly by scripts/r10-e/scene-parity.ts and compared against the 2D page's
 * positions, so the 3D side can be checked on a machine without a browser.
 *
 * This module never decides an action, never advances a clock and never invents a
 * position. If the snapshot has no data for an actor, nothing is drawn for it.
 */

/** One cell is 2 m; identical to FrostEcho-WebGPU `toWorld` at f77bf54. */
export const TILE = 2;
export const ORIGIN = { x: 25, y: 20 };

export function toWorld(gridX, gridY) {
  return { x: (gridX - ORIGIN.x) * TILE, z: (gridY - ORIGIN.y) * TILE };
}

/** Instance stride of the vendored renderer: 4 x vec4 per instance. */
export const INSTANCE_FLOATS = 16;
export const OVERLAY_CAPACITY = 48;

/** mat 7 = plain surface branch in the vendored SOLID shader (no frost/wood/noise). */
const PLAIN_MATERIAL = 7;

const PHASE_COLOR = {
  idle: [0.42, 0.53, 0.63],
  working: [0.96, 0.63, 0.22],
  blocked: [0.82, 0.24, 0.22],
  dead: [0.13, 0.15, 0.17],
};

const RECEIPT_EVENTS = new Set(["task_completed", "refuelled", "heating_settled"]);
const MACHINE_PLACE = { generator: "workshop", lumberMill: "workshop", foodCollector: "kitchen" };

/**
 * @param {object} snapshot VisualSnapshot/1
 * @param {(x:number, z:number)=>number} [groundY] display terrain sampler
 */
export function projectActors(snapshot, groundY = () => 0) {
  const rows = [];
  const actors = snapshot.actors ?? [];
  for (const [index, actor] of actors.entries()) {
    const phase = actor.action?.phase ?? "idle";
    const color = PHASE_COLOR[phase] ?? PHASE_COLOR.idle;
    const flat = actor.placement === "village";
    // Indoor actors share one door in the authority's data (several residents of
    // dorm_a really do report the same cell). A fixed ring of 0.8 m keeps them
    // readable; it is a label offset, not a walk, and it is reported in the
    // evidence as `displayOffset` so nobody mistakes it for movement.
    const angle = (index / Math.max(actors.length, 1)) * Math.PI * 2;
    const offset = flat ? { x: 0, z: 0 }
      : { x: Math.cos(angle) * 0.8, z: Math.sin(angle) * 0.8 };
    rows.push({
      id: actor.id,
      name: actor.name,
      phase,
      mapId: actor.mapId,
      indoor: !flat,
      cell: actor.cell,
      x: actor.world.x,
      z: actor.world.z,
      drawX: actor.world.x + offset.x,
      drawZ: actor.world.z + offset.z,
      displayOffset: { x: offset.x, z: offset.z },
      y: groundY(actor.world.x, actor.world.z),
      yaw: 0,
      color,
      emission: 0,
      scale: [0.46, 1.34, 0.32],
      headScale: [0.3, 0.3, 0.28],
      dueAt: actor.action?.dueAt ?? null,
      kind: actor.action?.kind ?? null,
      label: `${actor.name}${flat ? "" : "（室内）"}${
        phase === "working" && actor.action?.dueAt ? ` · ${actor.action.dueAt} 分完成` : ""
      }`,
    });
  }
  return rows;
}

function pushInstance(target, cursor, row) {
  if ((cursor + 1) * INSTANCE_FLOATS > target.length) return cursor;
  const base = cursor * INSTANCE_FLOATS;
  target.set([row.x, row.y, row.z, row.yaw], base);
  target.set(row.scale, base + 4);
  target.set([...row.color, row.emission], base + 8);
  target.set([PLAIN_MATERIAL, 0, 0, 0], base + 12);
  return cursor + 1;
}

/**
 * Builds the 16-float-per-instance buffer for the vendored renderer's static
 * batch path. Unused slots stay at zero scale, so they cannot be seen.
 */
export function overlayBatch(snapshot, options = {}) {
  const groundY = options.groundY ?? (() => 0);
  const capacity = options.capacity ?? OVERLAY_CAPACITY;
  const data = new Float32Array(capacity * INSTANCE_FLOATS);
  const rows = projectActors(snapshot, groundY);
  let cursor = 0;
  for (const row of rows) {
    const drawn = { ...row, x: row.drawX, z: row.drawZ };
    cursor = pushInstance(data, cursor, { ...drawn, y: row.y + 0.72, scale: row.scale });
    cursor = pushInstance(data, cursor, { ...drawn, y: row.y + 1.72, scale: row.headScale });
    if (row.phase === "working" || row.phase === "blocked") {
      cursor = pushInstance(data, cursor, { ...drawn, y: row.y + 2.06,
        scale: [0.14, 0.14, 0.14], color: row.color, emission: 1.1 });
    }
  }

  // Furnace: one glow volume whose brightness is the authority's warmth, never a
  // locally simulated fire.
  const kitchen = (snapshot.map?.buildings ?? []).find(building => building.id === "kitchen");
  if (kitchen) {
    const furnace = snapshot.furnace ?? {};
    const strength = typeof furnace.heatingStrength === "number" ? furnace.heatingStrength : 1;
    const glow = Math.max(0, Math.min(1.4,
      ((furnace.warmth ?? 0) / 25) * (furnace.lit ? 1 : 0.12) * (0.5 + strength * 0.5)));
    cursor = pushInstance(data, cursor, {
      x: kitchen.doorWorld.x, z: kitchen.doorWorld.z,
      y: groundY(kitchen.doorWorld.x, kitchen.doorWorld.z) + 0.35,
      yaw: 0, scale: [0.55, 0.55, 0.55], color: [1, 0.42, 0.1], emission: glow,
    });
  }
  // Production: a marker per running machine, at the building it belongs to.
  for (const [machine, state] of Object.entries(snapshot.production?.machines ?? {})) {
    if (state === "absent") continue;
    const building = (snapshot.map?.buildings ?? []).find(entry => entry.id === MACHINE_PLACE[machine]);
    if (!building) continue;
    cursor = pushInstance(data, cursor, {
      x: building.doorWorld.x + 1.2, z: building.doorWorld.z,
      y: groundY(building.doorWorld.x, building.doorWorld.z) + 0.5,
      yaw: 0, scale: [0.28, 0.55, 0.28], color: [0.35, 0.85, 0.92], emission: 0.9,
    });
  }
  // Receipt echo: the last committed receipts only, tagged with the actor the
  // authority named. This is display of a finished event, not a new claim.
  const actors = new Map((snapshot.actors ?? []).map(actor => [actor.id, actor]));
  const receipts = (snapshot.recentEvents ?? []).filter(event => RECEIPT_EVENTS.has(event.type)).slice(-3);
  for (const event of receipts) {
    const actor = actors.get(event.actorId);
    if (!actor) continue;
    cursor = pushInstance(data, cursor, {
      x: actor.world.x, z: actor.world.z,
      y: groundY(actor.world.x, actor.world.z) + 2.34,
      yaw: 0, scale: [0.2, 0.2, 0.2], color: [0.45, 0.9, 1], emission: 1.4,
    });
  }
  return { data, capacity, active: cursor };
}

/** Text the HUD may show. Kept pure so the parity script can assert on it. */
export function describeHud(snapshot, connection = "live") {
  const phases = { idle: 0, working: 0, blocked: 0, dead: 0 };
  for (const actor of snapshot.actors ?? []) phases[actor.action?.phase ?? "idle"] += 1;
  const furnace = snapshot.furnace ?? {};
  const tasks = snapshot.tasks ?? [];
  return {
    connection,
    clock: `第 ${snapshot.day ?? 0} 天 · ${snapshot.simTime ?? 0} 分 · v${snapshot.worldVersion ?? 0}`,
    resources: Object.entries(snapshot.resources ?? {})
      .map(([key, value]) => `${key} ${Math.round(Number(value) * 10) / 10}`).join(" · "),
    furnace: `炉火 ${furnace.lit ? "点着" : "熄灭"} · 燃料 ${furnace.fuel ?? 0} · 暖度 ${
      Math.round((furnace.warmth ?? 0) * 10) / 10}${
      typeof furnace.heatingStrength === "number"
        ? ` · 供热 ${Math.round(furnace.heatingStrength * 100) / 100}` : ""}`,
    phases: `空闲 ${phases.idle} / 工作 ${phases.working} / 受阻 ${phases.blocked} / 死亡 ${phases.dead}`,
    tasks: tasks.map(task => `${task.taskId} ${task.type} ${task.status}${
      task.assigneeId ? ` @${task.assigneeId}` : ""}`),
    lastReceipts: (snapshot.recentEvents ?? []).slice(-3)
      .map(event => `${event.eventId} @${event.simTime}`),
  };
}
