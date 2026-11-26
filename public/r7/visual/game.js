/**
 * FrostEcho · 游戏画面入口（E / R11）
 *
 * Derived from PoetryJ/FrostEcho-WebGPU @ f77bf5453465d0ade53070c4589498867209aabe
 * `src/main.js` (MIT; see NOTICE.md). The scene, whiteout storm, shaders and
 * ground detail are the vendored upstream files, unmodified. This file replaces
 * only the *state source*: the upstream camera study read nothing, this reads
 * VisualSnapshot/1 from the display adapter and draws the authority's NPCs.
 *
 * R11 rules kept:
 *  - the snapshot is read-only; every button posts one line to the existing CLI;
 *  - no local path-finding, no local resource change, no local save;
 *  - an out-of-order snapshot is dropped, no rewinding across a save;
 *  - when the connection drops the picture freezes and says so;
 *  - the same snapshot feeds this 3D page and `2d.html`.
 */
import { makeWorld } from "./src/world.js";
import { Renderer } from "./src/renderer.js";
import { Ambience } from "./src/audio.js";
import { clamp } from "./src/math.js";
import { overlayBatch } from "./npc-projection.js";

const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const params = new URLSearchParams(location.search);
const ambience = new Ambience();
const camera = { x: 0, y: 5, z: 25, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0 };

/** Atmosphere presets copied verbatim from upstream `src/main.js:11-52`. */
const modes = [
  { name: "静雪守夜", skyLow: [0.055, 0.1, 0.17], skyHigh: [0.012, 0.03, 0.07],
    light: [0.18, 0.25, 0.38], fog: [0.065, 0.12, 0.18, 0.014], snow: 0.35,
    exposure: 1, view: "cabin" },
  { name: "微缩雪镇", skyLow: [0.48, 0.62, 0.71], skyHigh: [0.24, 0.42, 0.6],
    light: [1.12, 0.94, 0.72], fog: [0.48, 0.62, 0.71, 0.0045], snow: 0.12,
    exposure: 0.95, view: "village" },
  { name: "白障风暴", skyLow: [0.16, 0.22, 0.27], skyHigh: [0.035, 0.065, 0.1],
    light: [0.16, 0.2, 0.25], fog: [0.2, 0.28, 0.34, 0.041], snow: 0.92,
    exposure: 0.95, view: "village" },
];

let renderer, world, mode = 2, snow = modes[2].snow, view = "village", last = 0,
  time = 0, hudTime = 0, tour = false, tourTime = 0, dead = false;
/**
 * Evidence-only freeze: stop submitting GPU frames so a screenshot can take the
 * last presented canvas. It never touches the authority or the clock.
 */
let renderPaused = false;
const errors = [], keys = new Set();
let dragging = false, dragX = 0, dragY = 0, dragMoved = 0;

/** Last snapshot the display accepted, plus the buffer it is drawn from. */
let snapshot = null;
let overlayBuffer = null;
let overlayCapacity = 0;
let pollTimer = 0;
let connection = "connecting";
const shown = { sessionId: null, worldVersion: -1, simTime: -1 };
const counters = { accepted: 0, stale: 0, resync: 0, polls: 0, failures: 0 };

/** Player selection + the honest operation log (what was sent, what came back). */
const ui = { selected: null, taskFilter: null };
const ops = [];
const frameRing = [];
let gpu = null;
let lastCommand = null;

function fail(message) {
  if (dead) return;
  dead = true;
  errors.push(message);
  $("load-message").textContent = message;
  $("loading").classList.remove("ready");
  $("loading").querySelector("h1").textContent = "场景启动遇到问题";
  console.error(message);
}
addEventListener("error", (e) => fail(e.message));
addEventListener("unhandledrejection", (e) => fail(e.reason?.message || String(e.reason)));

function toast(text) {
  $("notice").textContent = text;
  $("notice").classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("notice").classList.remove("visible"), 2800);
}

function setPose(id) {
  if (!world?.poses[id]) return;
  const p = world.poses[id];
  camera.x = p[0]; camera.y = p[1]; camera.z = p[2];
  camera.yaw = Math.atan2(p[3] - p[0], -(p[5] - p[2]));
  camera.pitch = Math.atan2(p[4] - p[1], Math.hypot(p[3] - p[0], p[5] - p[2]));
  camera.vx = camera.vy = camera.vz = 0;
  view = id; tour = false;
  $("tour").textContent = "自动环游";
  for (const b of $("views").children) b.classList.toggle("active", b.dataset.view === id);
}

function setMode(n, move = true) {
  mode = n;
  const m = modes[n];
  snow = m.snow;
  ambience.mode = n;
  ambience.snow = snow;
  $("snow").value = snow;
  $("snow-label").textContent = Math.round(snow * 100) + "%";
  for (const b of $("modes").children) {
    const on = Number(b.dataset.mode) === n;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  if (move) setPose(m.view);
}

function fillUniforms() {
  const u = renderer.uniforms, cp = Math.cos(camera.pitch), fy = Math.sin(camera.pitch),
    rx = Math.cos(camera.yaw), rz = Math.sin(camera.yaw), fx = cp * rz, fz = -cp * rx,
    ux = -rz * fy, uy = cp, uz = rx * fy;
  const aspect = renderer.width / renderer.height, tan = mode === 1 ? 0.43 : 0.6,
    sx = 1 / (tan * aspect), sy = 1 / tan;
  u[0] = rx * sx; u[4] = 0; u[8] = rz * sx;
  u[12] = -(rx * camera.x + rz * camera.z) * sx;
  u[1] = ux * sy; u[5] = uy * sy; u[9] = uz * sy;
  u[13] = -(ux * camera.x + uy * camera.y + uz * camera.z) * sy;
  u[2] = u[6] = u[10] = 0;
  u[14] = 0.08;
  u[3] = fx; u[7] = fy; u[11] = fz;
  u[15] = -(fx * camera.x + fy * camera.y + fz * camera.z);
  u.set([camera.x, camera.y, camera.z, time], 32);
  u.set([rx, 0, rz, tan * aspect], 36);
  u.set([ux, uy, uz, tan], 40);
  u.set([fx, fy, fz, 0.08], 44);
  const m = modes[mode];
  u.set(m.light, 52);
  u.set(m.skyLow, 56);
  u.set(m.skyHigh, 60);
  u.set(m.fog, 64);
  u[67] *= 1 + (snow - m.snow) * 1.4;
  u.set([time, snow, mode === 1 ? 1 : 0, m.exposure], 68);
  u.set([renderer.width, renderer.height, 1 / renderer.width, 1 / renderer.height], 72);
  u.set([world.hero.x, world.hero.z, world.hero.width / 2 - 0.25,
    world.hero.depth / 2 - 0.25], 76);
}

function shadowMatrix() {
  const u = renderer.uniforms;
  let lx = 0.3, ly = 0.85, lz = -0.43, l = Math.hypot(lx, ly, lz);
  lx /= l; ly /= l; lz /= l;
  u.set([lx, ly, lz, 0], 48);
  let rx = ly, ry = -lx, rz = 0;
  l = Math.hypot(rx, ry); rx /= l; ry /= l;
  const ux = ly * rz - lz * ry, uy = lz * rx - lx * rz, uz = lx * ry - ly * rx;
  const R = 180, d0 = -150, d1 = 180;
  u[16] = rx / R; u[20] = ry / R; u[24] = rz / R; u[28] = 0;
  u[17] = ux / R; u[21] = uy / R; u[25] = uz / R; u[29] = 0;
  u[18] = -lx / (d1 - d0); u[22] = -ly / (d1 - d0); u[26] = -lz / (d1 - d0);
  u[30] = d1 / (d1 - d0);
  u[19] = u[23] = u[27] = 0;
  u[31] = 1;
  for (let i = 0; i < world.lights.length; i++) u.set(world.lights[i], 80 + i * 4);
  u.set(world.chimney, 208);
}

function updateCamera(dt) {
  if (tour) {
    tourTime += dt;
    const a = tourTime * 0.06, c = world.hero;
    camera.x = c.x + Math.sin(a) * 26;
    camera.z = c.z + Math.cos(a) * 29;
    camera.y = 5 + Math.sin(a * 0.7) * 1.8;
    camera.yaw = Math.atan2(c.x - camera.x, -(c.z - camera.z));
    camera.pitch = Math.atan2(2.8 - camera.y, Math.hypot(c.x - camera.x, c.z - camera.z));
    return;
  }
  const k = 1 - Math.exp(-dt * 7),
    speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 23 : 7,
    f = Number(keys.has("KeyW")) - Number(keys.has("KeyS")),
    r = Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
    up = Number(keys.has("KeyE")) - Number(keys.has("KeyQ"));
  const cp = Math.cos(camera.pitch), sy = Math.sin(camera.yaw), cy = Math.cos(camera.yaw);
  camera.vx += ((sy * cp * f + cy * r) * speed - camera.vx) * k;
  camera.vy += ((Math.sin(camera.pitch) * f + up) * speed - camera.vy) * k;
  camera.vz += ((-cy * cp * f + sy * r) * speed - camera.vz) * k;
  camera.x = clamp(camera.x + camera.vx * dt, -195, 195);
  camera.z = clamp(camera.z + camera.vz * dt, -175, 175);
  camera.y = clamp(camera.y + camera.vy * dt,
    world.terrainHeight(camera.x, camera.z) + 0.75, 120);
}

/**
 * Display-only world -> screen projection. Uses the same camera parameters the
 * vendored shader receives, so a label sits where the authority's actor is.
 */
function project(point) {
  const cp = Math.cos(camera.pitch), fy = Math.sin(camera.pitch),
    rx = Math.cos(camera.yaw), rz = Math.sin(camera.yaw),
    fx = cp * rz, fz = -cp * rx, ux = -rz * fy, uy = cp, uz = rx * fy;
  const dx = point.x - camera.x, dy = point.y - camera.y, dz = point.z - camera.z;
  const zf = dx * fx + dy * fy + dz * fz;
  if (zf <= 0.2) return null;
  const aspect = renderer.width / renderer.height, tan = mode === 1 ? 0.43 : 0.6;
  const sx = 1 / (tan * aspect), sy = 1 / tan;
  const xr = dx * rx + dz * rz, yu = dx * ux + dy * uy + dz * uz;
  const nx = (xr * sx) / zf, ny = (yu * sy) / zf;
  return { x: (nx * 0.5 + 0.5) * renderer.width, y: (1 - (ny * 0.5 + 0.5)) * renderer.height,
    depth: zf };
}

function updateLabels() {
  const host = $("actor-labels");
  if (!snapshot) return;
  const actors = snapshot.actors ?? [];
  const byId = new Map([...host.children].map(node => [node.dataset.npc, node]));
  for (const actor of actors) {
    let node = byId.get(actor.id);
    if (!node) {
      node = document.createElement("button");
      node.className = "actor-label";
      node.type = "button";
      node.dataset.npc = actor.id;
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        selectActor(actor.id);
      });
      host.append(node);
    }
    const p = project({ x: actor.world.x, y: 1.7, z: actor.world.z });
    const onScreen = p && p.depth < 200 && p.x > -60 && p.x < renderer.width + 60
      && p.y > -40 && p.y < renderer.height + 40;
    node.hidden = !onScreen;
    if (!onScreen) continue;
    node.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-100%)`;
    node.dataset.phase = actor.action?.phase ?? "idle";
    node.dataset.alive = String(actor.alive);
    node.classList.toggle("selected", ui.selected === actor.id);
    node.textContent = `${actor.name}${actor.action?.phase === "working" ? " · 忙" :
      actor.action?.phase === "blocked" ? " · 受阻" : actor.alive ? "" : " · 已故"}`;
  }
  for (const node of [...host.children]) {
    if (!actors.some(actor => actor.id === node.dataset.npc)) node.remove();
  }
}

function frame(now) {
  if (dead) return;
  requestAnimationFrame(frame);
  const frameMs = now - last, dt = Math.min(frameMs / 1000, 0.05);
  last = now;
  if (frameMs > 0 && frameMs < 5000) {
    frameRing.push(frameMs);
    if (frameRing.length > 240) frameRing.shift();
  }
  if (renderPaused) { last = now; return; }
  if (document.hidden) return;
  time += dt;
  updateCamera(dt);
  fillUniforms();
  renderer.frame(dt, camera, frameMs);
  updateLabels();
  hudTime += dt;
  if (hudTime > 0.5) {
    hudTime = 0;
    const sorted = [...frameRing].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    $("telemetry").textContent = `${modes[mode].name} / ${renderer.width} × ${renderer.height} / ${
      renderer.timed ? "GPU " + renderer.gpuMs.toFixed(1) + " ms" : "GPU 计时不可用"} / ${
      renderer.drawCalls} 批次 / 画布 ${overlayCapacity} 实例 / 帧 p50 ${p50.toFixed(1)}ms p95 ${p95.toFixed(1)}ms`;
    $("telemetry").dataset.gpuMs = renderer.gpuMs.toFixed(3);
    $("telemetry").dataset.drawCalls = String(renderer.drawCalls);
    $("telemetry").dataset.errors = String(errors.length);
    $("telemetry").dataset.overlayActive = String(counters.accepted);
    $("telemetry").dataset.frameP50 = p50.toFixed(3);
    $("telemetry").dataset.frameP95 = p95.toFixed(3);
  }
}

/* ------------------------------------------------------------------ state --- */

const short = (value, n = 12) => (value ? String(value).slice(0, n) : "—");
const fmt = (value, digits = 1) => typeof value === "number" && Number.isFinite(value)
  ? value.toFixed(digits) : "—";

function actorOf(id) {
  return snapshot?.actors?.find(actor => actor.id === id) ?? null;
}

function selectedObligations() {
  if (!snapshot || !ui.selected) return [];
  return (snapshot.obligations ?? []).filter(row => row.promisorId === ui.selected
    || row.beneficiaryId === ui.selected);
}

function selectedTasks() {
  if (!snapshot || !ui.selected) return [];
  return (snapshot.tasks ?? []).filter(task => task.assigneeId === ui.selected
    || (task.commitmentId && (snapshot.obligations ?? []).some(row =>
      row.commitmentId === task.commitmentId && row.promisorId === ui.selected)));
}

function selectedRoute() {
  return (snapshot?.routes ?? []).find(route => route.actorId === ui.selected) ?? null;
}

function selectedProjection() {
  return snapshot?.projections?.[ui.selected] ?? null;
}

/**
 * A read-only hint about the next *player* decision. It never drives the world;
 * it only names the button the current authoritative state makes meaningful.
 */
function storyHint() {
  if (!snapshot) return "等待权威快照…";
  if (!snapshot.actors?.length) return "点「新游戏」开始，或「继续存档」恢复。";
  if (!ui.selected) return "点一名居民（或画面标牌）选择。";
  const rows = selectedObligations();
  if (!rows.length) return "没有在途承诺：可点「接取送饭承诺」让这位居民向你承诺送饭。";
  const row = rows[0];
  if (row.status === "pending-change") return "居民提出改源，等待你答复：点「同意改源」。";
  if (row.status === "fulfilled") return `承诺已由回执结清：${short(row.evidenceEventIds.at(-1), 34)}。`;
  if (["cancelled", "withdrawn", "declined"].includes(row.status)) return `承诺已终止：${row.status}。`;
  const change = row.changes.find(c => c.kind === "alt-source" && c.status === "accepted");
  if (change) {
    const stock = snapshot.stock?.warehouse?.remaining;
    if (stock === 0) return "已同意改源（采集后送饭）。点「让他决定」按新来源行动，再「等到当前工时」。";
    return "按新来源：点「让他决定」继续采集/交存/取餐/送达。";
  }
  return "点「让他决定」让居民按自己的候选行动；有工时时点「等到当前工时」。";
}

/**
 * Stable action buttons. Re-creating a button on every poll detaches it from a
 * user's pointer (and from an automated click); only dataset/disabled change, so
 * the same node stays under the cursor for the whole run.
 */
const actionPools = new WeakMap();
function renderActions(host, specs) {
  let pool = actionPools.get(host);
  if (!pool) { pool = new Map(); actionPools.set(host, pool); }
  for (const [label, button] of [...pool]) {
    if (!specs.some(spec => spec.label === label)) { button.remove(); pool.delete(label); }
  }
  specs.forEach((spec, index) => {
    let button = pool.get(spec.label);
    if (!button) {
      button = document.createElement("button");
      button.textContent = spec.label;
      button.dataset.action = spec.label;
      button.addEventListener("click", () => {
        const line = button.dataset.line;
        if (line) sendCommand(line);
      });
      pool.set(spec.label, button);
    }
    button.dataset.line = spec.line ?? "";
    button.disabled = !spec.line || Boolean(spec.disabled);
    // Insert in place; re-appending every poll moves the node and invalidates a
    // pointer press that is already on its way.
    if (host.children[index] !== button) host.insertBefore(button, host.children[index] ?? null);
  });
}

function renderRoster() {
  const host = $("hud-npcs");
  const actors = snapshot?.actors ?? [];
  const existing = new Map([...host.children].map(row => [row.dataset.npc, row]));
  for (const actor of actors) {
    let li = existing.get(actor.id);
    if (!li) {
      li = document.createElement("li");
      li.dataset.npc = actor.id;
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.append(document.createElement("strong"), document.createElement("span"), document.createElement("em"));
      li.onclick = () => selectActor(actor.id);
      li.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") selectActor(actor.id); };
      existing.set(actor.id, li);
    }
    li.dataset.phase = actor.action?.phase ?? "idle";
    li.classList.toggle("selected", ui.selected === actor.id);
    const where = `${actor.mapId} (${actor.cell.x},${actor.cell.y})`;
    const phase = `${actor.action?.phase ?? "idle"}${actor.action?.dueAt ? " → " + actor.action.dueAt : ""}`;
    if (li.children[0].textContent !== actor.name) li.children[0].textContent = actor.name;
    if (li.children[1].textContent !== where) li.children[1].textContent = where;
    if (li.children[2].textContent !== phase) li.children[2].textContent = phase;
  }
  for (const [id, li] of existing) if (!actors.some(actor => actor.id === id)) li.remove();
  actors.forEach((actor, index) => {
    const li = existing.get(actor.id);
    if (host.children[index] !== li) host.insertBefore(li, host.children[index] ?? null);
  });
}

function renderSelected() {
  const actor = actorOf(ui.selected);
  $("selected-name").textContent = actor ? `${actor.name} · ${short(actor.id, 6)}` : "未选择";
  if (!actor) {
    $("selected-vitals").textContent = "点击左侧居民或画面标牌。";
    $("selected-projection").textContent = "";
  } else {
    const v = actor.vitals;
    $("selected-vitals").textContent = `${actor.location} / ${actor.mapId} (${actor.cell.x},${actor.cell.y})`
      + `${actor.doorOf ? " · 门口 " + actor.doorOf : ""} · ${actor.alive ? "存活" : "已故"}`
      + ` · 饥饿 ${fmt(v.hunger, 0)} · 体力 ${fmt(v.stamina, 0)}`
      + ` · 健康 ${fmt(v.health, 0)} · 体温 ${fmt(v.bodyTemp, 1)}℃`;
    const projection = selectedProjection();
    const pct = projection?.tokens != null && projection?.budget
      ? ` (${Math.round((projection.tokens / projection.budget) * 100)}%)` : "";
    $("selected-projection").textContent = projection
      ? `记忆投影 ${projection.selection ?? "?"} · ${projection.counterId ?? "?"} · ${projection.tokens ?? "?"}/${
        projection.budget ?? "?"} 估算${pct} · 保留 ${projection.kept ?? "?"} / 丢弃 ${
        projection.dropped ?? "?"}${projection.suppressed ? ` · 去重 ${projection.suppressed}` : ""}${
        projection.truncated ? ` · 截断 ${projection.truncated}` : ""}${
        projection.blockSha256 ? ` · block ${short(projection.blockSha256, 10)}` : ""}${
        projection.noteIds?.length ? ` · note ${projection.noteIds.join(",")}` : ""}`
      : "记忆投影：该居民尚无决策记录。";
  }
}

function renderTasks() {
  const host = $("hud-tasks");
  const tasks = selectedTasks();
  const signature = JSON.stringify(tasks.map(task => [task.taskId, task.type, task.status, task.commitmentId]));
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature;
    if (!tasks.length) {
      host.replaceChildren(Object.assign(document.createElement("li"), {
        textContent: ui.selected ? "（该居民暂无任务）" : "（先选择居民）", className: "muted" }));
    } else {
      host.replaceChildren(...tasks.map(task => {
        const li = document.createElement("li");
        li.dataset.task = task.taskId;
        li.dataset.status = task.status;
        li.innerHTML = `<strong>${task.type || task.taskId}</strong>`
          + `<span>${task.taskId} · ${task.status}${task.commitmentId ? " · 承诺 " + short(task.commitmentId, 8) : ""}</span>`;
        return li;
      }));
    }
  }
  const actor = actorOf(ui.selected);
  renderActions($("task-actions"), [
    { label: "接取送饭承诺", line: ui.selected ? `request ${ui.selected} deliver-meal` : "",
      disabled: !actor?.alive },
    { label: "指派采集食物", line: ui.selected ? `assign ${ui.selected} gather-food` : "" },
    { label: "指派补仓", line: ui.selected ? `assign ${ui.selected} supply-warehouse` : "" },
    { label: "让他决定", line: ui.selected ? `r8-step ${ui.selected}` : "", disabled: !actor?.alive },
    { label: "等到当前工时", line: (() => {
      const work = (snapshot?.work ?? []).find(entry => entry.actorId === ui.selected && entry.endsAt);
      return work ? `advance ${Math.max(1, work.endsAt - snapshot.simTime)}` : "";
    })() },
  ]);
}

function renderCommitments() {
  const host = $("hud-commitments");
  const rows = selectedObligations();
  const signature = JSON.stringify(rows.map(row => [row.commitmentId, row.status, row.revision,
    row.changes.map(change => `${change.kind}:${change.status}`), row.evidenceEventIds.at(-1)]));
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature;
    if (!rows.length) {
      host.replaceChildren(Object.assign(document.createElement("li"), {
        textContent: ui.selected ? "（该居民没有承诺）" : "（先选择居民）", className: "muted" }));
    } else {
      host.replaceChildren(...rows.map(row => {
        const li = document.createElement("li");
        li.dataset.status = row.status;
        const change = row.changes.find(c => c.status === "open");
        li.innerHTML = `<strong>${row.goal} · ${row.status} · r${row.revision ?? "?"}</strong>`
          + `<span>${short(row.commitmentId, 14)} · ${row.promisorId} → ${row.beneficiaryId}</span>`
          + (change ? `<em>改源待答：${change.source ?? "?"} (${change.reason ?? ""})</em>` : "")
          + (row.evidenceEventIds.length
            ? `<em>回执 ${short(row.evidenceEventIds.at(-1), 34)}</em>` : "");
        return li;
      }));
    }
  }
  const row = rows[0];
  const open = row?.changes?.find(change => change.status === "open");
  const terminal = ["fulfilled", "cancelled", "withdrawn", "declined"].includes(row?.status);
  renderActions($("commitment-actions"), [
    { label: "同意改源", line: open && row ? `respond-change ${row.commitmentId} accept` : "" },
    { label: "拒绝改源", line: open && row ? `respond-change ${row.commitmentId} reject` : "" },
    { label: "取消承诺", line: row && !terminal ? `cancel-commitment ${row.commitmentId}` : "" },
  ]);
  const hint = storyHint();
  if ($("story-hint").textContent !== hint) $("story-hint").textContent = hint;
}

function renderStock() {
  const stock = snapshot?.stock;
  if (!stock) { $("hud-stock").textContent = "等待快照…"; return; }
  const warehouse = stock.warehouse;
  $("hud-stock").textContent = warehouse.remaining === null
    ? "仓库存粮：未核实（尚无权威回执）"
    : `仓库存粮 ${warehouse.remaining} · 回执 ${short(warehouse.eventId, 30)} @${warehouse.simTime}`
      + ` (${warehouse.source})`;
  const lines = [
    `携带（最后出库回执）：${stock.carry?.meals ?? "—"} 份`
      + `${stock.carry?.eventId ? " · " + short(stock.carry.eventId, 26) : ""}`,
    "公共资源：" + Object.entries(stock.public ?? {})
      .map(([key, value]) => `${key} ${typeof value === "number" ? value.toFixed(1) : value}`).join(" · "),
  ];
  $("hud-carry").replaceChildren(...lines.map(text =>
    Object.assign(document.createElement("li"), { textContent: text })));
}

function renderMoveActions() {
  const actor = actorOf(ui.selected);
  const stock = snapshot?.stock?.warehouse?.remaining ?? null;
  const inside = Boolean(actor?.alive && actor.mapId === "warehouse");
  renderActions($("move-actions"), [
    { label: "原图进仓", line: ui.selected ? `travel ${ui.selected} warehouse` : "", disabled: !actor?.alive },
    { label: "回宿舍", line: ui.selected ? `travel ${ui.selected} dorm-a` : "", disabled: !actor?.alive },
    { label: "核实库存", line: ui.selected ? `r8-inspect ${ui.selected}` : "", disabled: !inside },
    { label: "取走 1", line: ui.selected ? `withdraw ${ui.selected} 1` : "",
      disabled: !inside || (stock ?? 0) < 1 },
    { label: "取走全部", line: ui.selected && stock ? `withdraw ${ui.selected} ${stock}` : "",
      disabled: !inside || (stock ?? 0) < 1 },
    { label: "交存 1", line: ui.selected ? `deposit ${ui.selected} 1` : "", disabled: !inside },
  ]);
}

function renderRoute() {
  const route = selectedRoute();
  if (!route || !route.legs.length) {
    $("hud-route").textContent = "尚无已提交的原图行走。";
    $("hud-legs").replaceChildren();
    return;
  }
  const s = route.summary;
  $("hud-route").textContent = `${s.fromMap ?? "?"} (${s.from?.x},${s.from?.y}) → ${
    s.toMap ?? "?"} (${s.to?.x},${s.to?.y}) · ${s.tiles} 格 + ${s.doors} 门 · ${
    s.minutes} 分钟（逐格回执）`;
  const legs = route.legs.slice(-8);
  const legSignature = JSON.stringify(legs.map(leg => leg.eventId));
  if ($("hud-legs").dataset.signature !== legSignature) {
    $("hud-legs").dataset.signature = legSignature;
    $("hud-legs").replaceChildren(...legs.map(leg => {
      const li = document.createElement("li");
      li.dataset.leg = leg.type;
      li.textContent = `${leg.type === "door" ? "门" : "格"} ${leg.fromMap}(${leg.from.x},${leg.from.y})`
        + ` → ${leg.toMap}(${leg.to.x},${leg.to.y}) @${leg.simTime}`;
      return li;
    }));
  }
}

function renderReceipts() {
  const events = snapshot?.recentEvents ?? [];
  const signature = JSON.stringify(events.map(event => event.eventId ?? event));
  if ($("hud-events").dataset.signature === signature) return;
  $("hud-events").dataset.signature = signature;
  $("hud-events").replaceChildren(...(events.length ? events.slice(-10).reverse() : ["（暂无回执）"])
    .map((entry) => {
      const li = document.createElement("li");
      if (typeof entry === "string") { li.textContent = entry; return li; }
      li.dataset.type = entry.type;
      li.dataset.actor = entry.actorId;
      li.textContent = `${short(entry.eventId, 34)} · ${entry.type} · ${entry.actorId} @${entry.simTime}`;
      return li;
    }));
}

function renderSession() {
  if (!snapshot) return;
  $("hud-session").textContent = `${short(snapshot.sessionId, 22)} · ${snapshot.profile} / ${snapshot.mode}`
    + ` · v${snapshot.worldVersion} · ${snapshot.runner}`;
  const scorer = snapshot.scorer ?? {};
  $("hud-scorer").textContent = `scorer ${scorer.scorerId ?? "?"} (${scorer.mode ?? "?"}/${scorer.rendererId ?? "?"})`
    + `${scorer.experimental ? " experimental" : ""}${scorer.countsAsAdmitted ? " admitted" : ""}`
    + ` · 存档 ${snapshot.save?.savedAt ? "有" : "无"}`;
  $("hud-clock").textContent = `D${snapshot.day} ${String(Math.floor((snapshot.simTime % 1440) / 60)).padStart(2, "0")}:${
    String(snapshot.simTime % 60).padStart(2, "0")} · simTime ${snapshot.simTime} · v${snapshot.worldVersion}`
    + `${snapshot.ending && snapshot.ending !== "none" ? " · ending " + snapshot.ending : ""}`;
  $("hud-resources").textContent = Object.entries(snapshot.resources ?? {})
    .map(([key, value]) => `${key} ${typeof value === "number" ? value.toFixed(1) : value}`).join(" · ");
  $("hud-furnace").textContent = `炉火 ${snapshot.furnace?.lit ? "亮" : "灭"} · 燃料 ${
    fmt(snapshot.furnace?.fuel)} · 暖度 ${fmt(snapshot.furnace?.warmth)}`
    + `${snapshot.crises?.active?.length ? " · 危机 " + snapshot.crises.active.map(c => c.kind).join(",") : ""}`;
  canvas.dataset.worldVersion = String(snapshot.worldVersion);
  canvas.dataset.simTime = String(snapshot.simTime);
  canvas.dataset.sessionId = snapshot.sessionId ?? "";
}

function renderAll() {
  renderSession();
  renderRoster();
  renderSelected();
  renderTasks();
  renderCommitments();
  renderStock();
  renderMoveActions();
  renderRoute();
  renderReceipts();
}

function selectActor(id) {
  if (!snapshot?.actors?.some(actor => actor.id === id)) return;
  ui.selected = id;
  renderAll();
}

function applySnapshot(next) {
  const batch = overlayBatch(next, {
    groundY: (x, z) => world.terrainHeight(x, z),
    capacity: overlayCapacity,
  });
  renderer.device.queue.writeBuffer(overlayBuffer, 0, batch.data);
  snapshot = next;
  if (ui.selected && !next.actors?.some(actor => actor.id === ui.selected)) ui.selected = null;
  renderAll();
  canvas.dataset.worldVersion = String(next.worldVersion);
  canvas.dataset.simTime = String(next.simTime);
  canvas.dataset.sessionId = next.sessionId ?? "";
}

function setConnection(state, detail = "") {
  connection = state;
  const badge = $("connection");
  badge.dataset.state = state;
  badge.textContent = state === "live" ? "已连接 · 权威快照"
    : state === "connecting" ? "连接中…" : "已断开 · 画面冻结";
  if (detail) $("hud-error").textContent = detail;
}

async function poll() {
  pollTimer = 0;
  counters.polls += 1;
  try {
    const response = await fetch("api/visual/state", { cache: "no-store" });
    const body = await response.json();
    const next = body.snapshot;
    if (!next) throw new Error(body.error || "no snapshot");
    if (shown.sessionId && next.sessionId !== shown.sessionId) {
      counters.resync += 1;
      shown.sessionId = next.sessionId;
      shown.worldVersion = -1;
      shown.simTime = -1;
      toast("检测到新的会话身份，已按全量快照刷新。");
    }
    if (next.worldVersion < shown.worldVersion || next.simTime < shown.simTime) {
      counters.stale += 1;
    } else {
      counters.accepted += 1;
      shown.sessionId = next.sessionId;
      shown.worldVersion = next.worldVersion;
      shown.simTime = next.simTime;
      applySnapshot(next);
    }
    setConnection("live");
  } catch (error) {
    counters.failures += 1;
    setConnection("offline", String(error.message || error));
  }
  pollTimer = setTimeout(poll, 700);
}

/** Every command this page ever sends is one line, recorded with its answer. */
async function sendCommand(line) {
  if (!line || !line.trim()) return null;
  const output = $("hud-command-result");
  output.textContent = `→ ${line} …`;
  const at = new Date().toISOString();
  try {
    const response = await fetch("api/visual/command", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line }) });
    const body = await response.json();
    if (body.error) throw new Error(body.error);
    const cli = body.cli ?? {};
    const state = body.state?.snapshot ?? null;
    if (state) applySnapshot(state);
    const eventIds = collectEventIds(cli);
    const record = {
      at, line, ok: !cli.error,
      jobId: cli.jobId ?? null, command: cli.command ?? line.split(/\s+/)[0],
      error: cli.error ?? null,
      worldVersion: state?.worldVersion ?? null, simTime: state?.simTime ?? null,
      sessionId: state?.sessionId ?? null,
      eventIds,
      commitmentIds: (state?.obligations ?? []).map(row => `${row.commitmentId}:${row.status}:r${row.revision}`),
      selected: ui.selected,
    };
    lastCommand = record;
    ops.push(record);
    if (ops.length > 200) ops.shift();
    output.textContent = `← ${line} · job ${short(cli.jobId, 10)} · v${record.worldVersion} @${
      record.simTime}${eventIds.length ? " · 回执 " + eventIds.slice(-2).map(id => short(id, 30)).join(",") : ""}${
      cli.error ? " · 错误 " + cli.error : ""}`;
    if (cli.error) $("hud-error").textContent = `${line}: ${cli.error}`;
    return { cli, state, record };
  } catch (error) {
    output.textContent = `× ${line} · ${error.message || error}`;
    const record = { at, line, ok: false, error: String(error.message || error), jobId: null,
      eventIds: [], worldVersion: snapshot?.worldVersion ?? null, simTime: snapshot?.simTime ?? null };
    lastCommand = record;
    ops.push(record);
    return { error: record.error, record };
  }
}

/** The id-like values the CLI itself returned. No parsing of CLI text. */
function collectEventIds(cli) {
  const found = [];
  const push = (value) => {
    if (typeof value === "string" && /^[a-z0-9_-]+:.*/.test(value) && !found.includes(value)) found.push(value);
  };
  for (const decision of cli.records ?? []) for (const id of decision.eventIds ?? []) push(id);
  for (const event of cli.events ?? []) { push(event.eventId); }
  for (const id of cli.eventIds ?? []) push(id);
  if (cli.event?.eventId) push(cli.event.eventId);
  return found.slice(0, 12);
}

async function startSession(action) {
  const at = new Date().toISOString();
  try {
    const response = await fetch("api/visual/session", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    const body = await response.json();
    if (body.error) throw new Error(body.error);
    if (body.game?.error) throw new Error(body.game.error);
    counterReset();
    if (body.state?.snapshot) applySnapshot(body.state.snapshot);
    const state = body.state?.snapshot ?? snapshot;
    const record = { at, line: `session ${action}`, ok: true, jobId: null, command: "session",
      error: null, worldVersion: state?.worldVersion ?? null, simTime: state?.simTime ?? null,
      sessionId: state?.sessionId ?? null, eventIds: [], commitmentIds: [], selected: ui.selected };
    lastCommand = record;
    ops.push(record);
    toast(action === "new" ? "新游戏已开始（权威 CLI 内）。" : "存档已恢复（同一权威 CLI）。");
    return body;
  } catch (error) {
    const record = { at, line: `session ${action}`, ok: false, jobId: null, command: "session",
      error: String(error.message || error), worldVersion: snapshot?.worldVersion ?? null,
      simTime: snapshot?.simTime ?? null, eventIds: [], commitmentIds: [], selected: ui.selected };
    lastCommand = record;
    ops.push(record);
    toast("会话失败：" + (error.message || error));
    $("hud-error").textContent = `会话失败：${error.message || error}`;
    return { error: String(error.message || error) };
  }
}

function counterReset() {
  shown.sessionId = null; shown.worldVersion = -1; shown.simTime = -1;
  counters.accepted = counters.stale = counters.resync = 0;
}

/* --------------------------------------------------------------- wiring --- */

for (const b of $("modes").children) b.onclick = () => { setMode(Number(b.dataset.mode)); document.body.classList.add("exploring"); };
for (const b of $("views").children) b.onclick = () => { setPose(b.dataset.view); document.body.classList.add("exploring"); };
$("snow").oninput = (e) => {
  snow = Number(e.target.value);
  ambience.snow = snow;
  $("snow-label").textContent = Math.round(snow * 100) + "%";
};
$("sound").onclick = async () => {
  try {
    const on = await ambience.toggle();
    $("sound").textContent = "环境声 " + (on ? "开启" : "关闭");
    $("sound").setAttribute("aria-pressed", String(on));
  } catch (e) { toast("声音未启动：" + e.message); }
};
$("enter").onclick = () => {
  document.body.classList.add("exploring");
  canvas.focus();
  if (!ambience.enabled) $("sound").click();
  canvas.requestPointerLock?.();
  toast("WASD 飞行，Q/E 升降；点击居民标牌选择，右侧按钮回送原 CLI。");
};
$("hide-ui").onclick = () => document.body.classList.toggle("clean");
$("tour").onclick = () => {
  tour = !tour; tourTime = 0;
  $("tour").textContent = tour ? "停止环游" : "自动环游";
  document.body.classList.add("exploring");
};
$("send").onclick = () => { sendCommand($("command").value); $("command").value = ""; };
$("command").addEventListener("keydown", (e) => { if (e.key === "Enter") $("send").click(); });
for (const button of document.querySelectorAll("[data-command]"))
  button.onclick = () => sendCommand(button.dataset.command);
for (const button of document.querySelectorAll("[data-session]"))
  button.onclick = () => startSession(button.dataset.session);

canvas.addEventListener("pointerdown", (e) => {
  dragging = true; dragX = e.clientX; dragY = e.clientY; dragMoved = 0;
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add("exploring");
  canvas.focus(); tour = false;
});
canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  if (dragMoved < 4) pickActorAt(e);
});
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  camera.yaw += e.movementX * 0.0023;
  camera.pitch = clamp(camera.pitch - e.movementY * 0.0023, -1.5, 1.5);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging || document.pointerLockElement === canvas) return;
  camera.yaw += (e.clientX - dragX) * 0.004;
  camera.pitch = clamp(camera.pitch - (e.clientY - dragY) * 0.004, -1.5, 1.5);
  dragMoved += Math.abs(e.clientX - dragX) + Math.abs(e.clientY - dragY);
  dragX = e.clientX; dragY = e.clientY;
});
document.addEventListener("pointerlockchange", () => document.body.classList.toggle(
  "flying", document.pointerLockElement === canvas));

/** Pick the nearest projected actor to the click. Display gesture only. */
function pickActorAt(event) {
  if (!snapshot) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  let best = null;
  for (const actor of snapshot.actors ?? []) {
    const p = project({ x: actor.world.x, y: 1.2, z: actor.world.z });
    if (!p) continue;
    const distance = Math.hypot(p.x - x, p.y - y);
    if (distance < 60 && (!best || distance < best.distance)) best = { id: actor.id, distance };
  }
  if (best) selectActor(best.id);
}

function keyboardCode(e) {
  if (/^[1234]$/.test(e.key)) return "Digit" + e.key;
  if (e.code && e.code !== "Unidentified") return e.code;
  if (/^[wasdqeh]$/i.test(e.key)) return "Key" + e.key.toUpperCase();
  return e.key === "Shift" ? "ShiftLeft" : "";
}
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const code = keyboardCode(e);
  if (code === "KeyH") document.body.classList.toggle("clean");
  if (code === "Digit1") setPose("cabin");
  if (code === "Digit2") setPose("village");
  if (code === "Digit3") setPose("inside");
  if (code === "Digit4") setPose("forest");
  if (code === "Tab" && snapshot?.actors?.length) {
    e.preventDefault();
    const ids = snapshot.actors.map(actor => actor.id);
    const index = ids.indexOf(ui.selected);
    selectActor(ids[(index + 1) % ids.length]);
  }
  if (/^Key[WASDQE]$|Shift/.test(code)) {
    keys.add(code); tour = false;
    $("tour").textContent = "自动环游";
    document.body.classList.add("exploring");
    e.preventDefault();
  }
});
addEventListener("keyup", (e) => keys.delete(keyboardCode(e)));
addEventListener("blur", () => { keys.clear(); dragging = false; });
addEventListener("resize", () => renderer?.resize());
addEventListener("pagehide", () => { if (pollTimer) clearTimeout(pollTimer); });

async function readGpu() {
  if (!navigator.gpu) return { available: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: true, adapter: null };
    return {
      available: true,
      adapter: adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description } : { info: "unavailable" },
      features: [...adapter.features].slice(0, 24),
      limits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxBufferSize: adapter.limits.maxBufferSize, maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX },
    };
  } catch (error) { return { available: true, error: String(error.message || error) }; }
}

try {
  const response = await fetch("data/frostecho-map.json");
  if (!response.ok) throw new Error("地图数据加载失败");
  const mapData = await response.json();
  $("load-message").textContent = "按 FrostEcho 原地图搭建村庄…";
  world = makeWorld(mapData);
  gpu = await readGpu();

  // Dynamic overlay: the vendored renderer only builds static instance buffers,
  // so a zero-scale batch is reserved here and its GPU buffer is replaced after
  // create() with a COPY_DST one. No vendored file is modified.
  overlayCapacity = 48;
  const overlay = { mesh: "cube", data: new Float32Array(overlayCapacity * 16),
    x: 0, z: 0, radius: 400, n: overlayCapacity, dynamic: "npc" };
  world.batches.push(overlay);
  const index = world.batches.indexOf(overlay);

  $("load-message").textContent = "编译光照、雪雾与风雪着色器…";
  renderer = await Renderer.create(canvas, world, fail);
  overlayBuffer = renderer.device.createBuffer({
    size: overlay.data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  renderer.batches[index].buffer = overlayBuffer;
  renderer.batches[index].n = overlayCapacity;

  setMode(mode);
  if (params.has("view")) setPose(params.get("view"));
  shadowMatrix();
  fillUniforms();
  renderer.bakeShadow();
  renderer.frame(1 / 60, camera);
  await renderer.device.queue.onSubmittedWorkDone();
  $("gpu-status").textContent = "WEBGPU / LIVE";
  $("loading").classList.add("ready");
  setConnection("connecting");
  void poll();

  // Local diagnostics only; nothing is uploaded. `overlay` proves the buffer swap.
  window.frostEcho = {
    ready: true, errors, world, camera, renderer, setMode, setPose,
    gpu,
    stats: () => ({ ...renderer.stats(), frameP50: percentile(50), frameP95: percentile(95),
      frames: frameRing.length }),
    snapshot: () => snapshot,
    state: () => ({ mode, view, snow, audio: ambience.enabled, connection,
      camera: { ...camera }, worldVersion: shown.worldVersion, simTime: shown.simTime,
      sessionId: shown.sessionId }),
    counters: () => ({ ...counters }),
    select: (id) => selectActor(id),
    selected: () => ui.selected,
    command: (line) => sendCommand(line),
    session: (action) => startSession(action),
    ops: () => ops.slice(),
    pauseRender: (on) => { renderPaused = Boolean(on); return renderPaused; },
    paused: () => renderPaused,
    lastCommand: () => lastCommand,
    /** The 2D page and this page must return the same anchors for one snapshot. */
    anchors: () => anchorList(snapshot),
    hint: () => storyHint(),
  };
  canvas.dataset.ready = "true";
  last = performance.now();
  requestAnimationFrame(frame);
} catch (e) {
  fail(e.message || String(e));
}

function percentile(p) {
  if (!frameRing.length) return 0;
  const sorted = [...frameRing].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
}

function anchorList(value) {
  if (!value) return null;
  return {
    sessionId: value.sessionId, worldVersion: value.worldVersion, simTime: value.simTime,
    tileMeters: value.map?.tileMeters, origin: value.map?.origin,
    actors: (value.actors ?? []).map(actor => ({ id: actor.id, mapId: actor.mapId,
      cell: actor.cell, placement: actor.placement, world: actor.world, doorOf: actor.doorOf })),
    obligations: (value.obligations ?? []).map(row => ({ id: row.commitmentId, status: row.status,
      revision: row.revision, evidence: row.evidenceEventIds })),
    stock: value.stock,
    tasks: (value.tasks ?? []).map(task => ({ id: task.taskId, status: task.status,
      assignee: task.assigneeId })),
  };
}
