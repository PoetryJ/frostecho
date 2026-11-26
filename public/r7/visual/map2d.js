/**
 * FrostEcho · 2D 同状态（E / R11）
 *
 * Reads the SAME `api/visual/state` VisualSnapshot/1 the 3D page reads. It does
 * not send commands, does not keep a second clock and does not interpolate:
 * the anchors it exposes are the snapshot's own world coordinates.
 */
const $ = (id) => document.getElementById(id);
const canvas = $("map");
const ctx = canvas.getContext("2d");
const CELL = 14;
const PAD = 20;
const span = { w: 50, h: 40, tileMeters: 2, origin: { x: 25, y: 20 } };

let snapshot = null;
let selected = null;
let lastError = null;

const short = (value, n = 12) => (value ? String(value).slice(0, n) : "—");
const px = (gridX) => PAD + gridX * CELL;
const py = (gridY) => PAD + gridY * CELL;

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const width = PAD * 2 + span.w * CELL;
  const height = PAD * 2 + span.h * CELL;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0e1a22";
  ctx.fillRect(0, 0, width, height);

  // grid
  ctx.strokeStyle = "#c6d2d614";
  ctx.lineWidth = 1;
  for (let x = 0; x <= span.w; x += 1) {
    ctx.beginPath(); ctx.moveTo(px(x), py(0)); ctx.lineTo(px(x), py(span.h)); ctx.stroke();
  }
  for (let y = 0; y <= span.h; y += 1) {
    ctx.beginPath(); ctx.moveTo(px(0), py(y)); ctx.lineTo(px(span.w), py(y)); ctx.stroke();
  }
  if (!snapshot) return;
  const map = snapshot.map ?? span;

  // buildings + doors (authority catalog)
  for (const building of map.buildings ?? []) {
    ctx.fillStyle = "#1c2f3a";
    ctx.strokeStyle = "#c6d2d644";
    ctx.fillRect(px(building.cell.x), py(building.cell.y), building.size.x * CELL, building.size.y * CELL);
    ctx.strokeRect(px(building.cell.x) + 0.5, py(building.cell.y) + 0.5,
      building.size.x * CELL - 1, building.size.y * CELL - 1);
    ctx.fillStyle = "#e5bd87";
    ctx.fillRect(px(building.door.x) + CELL / 2 - 2, py(building.door.y) + CELL / 2 - 2, 4, 4);
    ctx.fillStyle = "#8fa3ad";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText(building.id, px(building.cell.x) + 3, py(building.cell.y) + 10);
  }

  // the actual walked route of the selected actor (committed legs only)
  const route = (snapshot.routes ?? []).find(row => row.actorId === selected);
  if (route && route.legs.length) {
    ctx.strokeStyle = "#e5bd8799";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const leg of route.legs) {
      if (leg.fromMap !== "village") {
        if (leg.toMap === "village") {
          ctx.moveTo(px(leg.to.x) + CELL / 2, py(leg.to.y) + CELL / 2);
          started = true;
        }
        continue;
      }
      if (!started) { ctx.moveTo(px(leg.from.x) + CELL / 2, py(leg.from.y) + CELL / 2); started = true; }
      ctx.lineTo(px(leg.to.x) + CELL / 2, py(leg.to.y) + CELL / 2);
    }
    ctx.stroke();
  }

  // actors: village cells are metres; indoor actors stand at the real door
  for (const actor of snapshot.actors ?? []) {
    const onVillage = actor.mapId === "village";
    const cell = onVillage ? actor.cell : (map.buildings ?? [])
      .find(building => building.id === actor.doorOf)?.door;
    if (!cell) continue;
    const x = px(cell.x) + CELL / 2, y = py(cell.y) + CELL / 2;
    ctx.beginPath();
    ctx.arc(x, y, selected === actor.id ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = !actor.alive ? "#79868d" : actor.action?.phase === "working" ? "#e5bd87"
      : actor.action?.phase === "blocked" ? "#d98a86" : "#9ec8a4";
    ctx.fill();
    if (selected === actor.id) {
      ctx.strokeStyle = "#fff4e2";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = "#dfe9ec";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(actor.name + (onVillage ? "" : "·门"), x + 8, y + 3);
  }
}

function renderText() {
  if (!snapshot) {
    $("meta").textContent = lastError ? "错误：" + lastError : "连接中…";
    return;
  }
  $("meta").textContent = `D${snapshot.day} · simTime ${snapshot.simTime} · v${snapshot.worldVersion}`
    + ` · ${snapshot.sessionId ? short(snapshot.sessionId, 16) : "无会话"}`;
  $("session").textContent = `${snapshot.profile} / ${snapshot.mode} · ${snapshot.runner}\n`
    + `scorer ${snapshot.scorer?.scorerId ?? "?"} · 存档 ${snapshot.save?.savedAt ? "有" : "无"}`;
  $("roster").replaceChildren(...(snapshot.actors ?? []).map(actor => {
    const li = document.createElement("li");
    li.textContent = `${actor.name} · ${actor.mapId} (${actor.cell.x},${actor.cell.y}) · ${
      actor.action?.phase ?? "idle"}`;
    li.dataset.npc = actor.id;
    li.style.cursor = "pointer";
    li.onclick = () => { selected = selected === actor.id ? null : actor.id; draw(); };
    return li;
  }));
  const stock = snapshot.stock ?? {};
  $("stock").textContent = `仓库 ${stock.warehouse?.remaining ?? "未核实"}`
    + `${stock.warehouse?.eventId ? " · " + short(stock.warehouse.eventId, 26) : ""}`
    + ` · 公共 ${Object.entries(stock.public ?? {}).map(([k, v]) => k + " " + v).join(" / ")}`;
  $("commitments").replaceChildren(...(snapshot.obligations ?? []).map(row => {
    const li = document.createElement("li");
    li.textContent = `${row.goal} · ${row.status} · r${row.revision ?? "?"} · ${
      short(row.commitmentId, 12)}${row.evidenceEventIds.length ? " · " + short(row.evidenceEventIds.at(-1), 22) : ""}`;
    li.dataset.status = row.status;
    return li;
  }));
  const route = (snapshot.routes ?? []).find(row => row.actorId === selected);
  $("route").textContent = route
    ? `${route.summary.fromMap} (${route.summary.from?.x},${route.summary.from?.y}) → ${
      route.summary.toMap} (${route.summary.to?.x},${route.summary.to?.y}) · ${
      route.summary.tiles} 格 + ${route.summary.doors} 门 · ${route.summary.minutes} 分`
    : "（选择一名居民查看已提交路段）";
}

async function poll() {
  try {
    const response = await fetch("api/visual/state", { cache: "no-store" });
    const body = await response.json();
    if (!body.snapshot) throw new Error(body.error || "no snapshot");
    snapshot = body.snapshot;
    span.w = snapshot.map?.w ?? span.w;
    span.h = snapshot.map?.h ?? span.h;
    span.origin = snapshot.map?.origin ?? span.origin;
    lastError = null;
    if (selected && !snapshot.actors?.some(actor => actor.id === selected)) selected = null;
    renderText();
    draw();
  } catch (error) {
    lastError = String(error.message || error);
    $("meta").textContent = "断开：" + lastError;
  } finally {
    setTimeout(poll, 700);
  }
}

window.frostEcho2d = {
  ready: true,
  select: (id) => { selected = id; draw(); renderText(); },
  selected: () => selected,
  /** Same shape as window.frostEcho.anchors(), from this page's own snapshot. */
  anchors: () => snapshot ? {
    sessionId: snapshot.sessionId, worldVersion: snapshot.worldVersion, simTime: snapshot.simTime,
    tileMeters: snapshot.map?.tileMeters, origin: snapshot.map?.origin,
    actors: (snapshot.actors ?? []).map(actor => ({ id: actor.id, mapId: actor.mapId,
      cell: actor.cell, placement: actor.placement, world: actor.world, doorOf: actor.doorOf })),
    obligations: (snapshot.obligations ?? []).map(row => ({ id: row.commitmentId, status: row.status,
      revision: row.revision, evidence: row.evidenceEventIds })),
    stock: snapshot.stock,
    tasks: (snapshot.tasks ?? []).map(task => ({ id: task.taskId, status: task.status,
      assignee: task.assigneeId })),
  } : null,
};

draw();
void poll();
