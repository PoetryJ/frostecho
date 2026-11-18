/**
 * FrostEcho · 游戏画面入口（E）
 *
 * Derived from PoetryJ/FrostEcho-WebGPU @ f77bf5453465d0ade53070c4589498867209aabe
 * `src/main.js` (MIT; see NOTICE.md). The scene, whiteout storm, shaders and
 * ground detail are the vendored upstream files, unmodified. This file replaces
 * only the *state source*: the upstream camera study read nothing, this reads
 * VisualSnapshot/1 from the display adapter and draws the authority's NPCs.
 *
 * Rules kept from docs/r9-audit/WEBGPU-BRIDGE.md:
 *  - the snapshot is read-only; commands are POSTed back to the existing CLI;
 *  - no local path-finding, no local resource change, no local save;
 *  - an out-of-order snapshot is dropped, no rewinding across a save;
 *  - when the connection drops the picture freezes and says so.
 */
import { makeWorld } from "./src/world.js";
import { Renderer } from "./src/renderer.js";
import { Ambience } from "./src/audio.js";
import { clamp } from "./src/math.js";
import { describeHud, overlayBatch } from "./npc-projection.js";

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
const errors = [], keys = new Set();
let dragging = false, dragX = 0, dragY = 0;

/** Last snapshot the display accepted, plus the buffer it is drawn from. */
let snapshot = null;
let overlayBuffer = null;
let overlayCapacity = 0;
let pollTimer = 0;
let connection = "connecting";
const shown = { sessionId: null, worldVersion: -1, simTime: -1 };
const counters = { accepted: 0, stale: 0, resync: 0, polls: 0, failures: 0 };

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
  toast.timer = setTimeout(() => $("notice").classList.remove("visible"), 2600);
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

function frame(now) {
  if (dead) return;
  requestAnimationFrame(frame);
  const frameMs = now - last, dt = Math.min(frameMs / 1000, 0.05);
  last = now;
  if (document.hidden) return;
  time += dt;
  updateCamera(dt);
  fillUniforms();
  renderer.frame(dt, camera, frameMs);
  hudTime += dt;
  if (hudTime > 0.5) {
    hudTime = 0;
    $("telemetry").textContent = `${modes[mode].name} / ${renderer.width} × ${renderer.height} / ${
      renderer.timed ? "GPU " + renderer.gpuMs.toFixed(1) + " ms" : "GPU 计时不可用"} / ${
      renderer.drawCalls} 批次 / 画布 ${overlayCapacity} 实例`;
    $("telemetry").dataset.gpuMs = renderer.gpuMs.toFixed(3);
    $("telemetry").dataset.drawCalls = String(renderer.drawCalls);
    $("telemetry").dataset.errors = String(errors.length);
    $("telemetry").dataset.overlayActive = String(counters.accepted);
  }
}

/* ------------------------------------------------------------------ state --- */

function applySnapshot(next) {
  const batch = overlayBatch(next, {
    groundY: (x, z) => world.terrainHeight(x, z),
    capacity: overlayCapacity,
  });
  // The batch buffer is the vendored static path with a COPY_DST buffer swapped
  // in after Renderer.create; positions therefore come straight from this write.
  renderer.device.queue.writeBuffer(overlayBuffer, 0, batch.data);
  snapshot = next;
  const hud = describeHud(next, connection);
  $("hud-clock").textContent = hud.clock;
  $("hud-resources").textContent = hud.resources;
  $("hud-furnace").textContent = hud.furnace;
  $("hud-phases").textContent = hud.phases;
  $("hud-tasks").replaceChildren(...(hud.tasks.length ? hud.tasks : ["（暂无任务）"])
    .map(text => Object.assign(document.createElement("li"), { textContent: text })));
  $("hud-events").replaceChildren(...(hud.lastReceipts.length ? hud.lastReceipts : ["（暂无回执）"])
    .map(text => Object.assign(document.createElement("li"), { textContent: text })));
  $("hud-npcs").replaceChildren(...(next.actors ?? []).map(actor => {
    const row = document.createElement("li");
    row.dataset.npc = actor.id;
    row.dataset.phase = actor.action?.phase ?? "idle";
    row.textContent = `${actor.name} · ${actor.mapId} (${actor.cell.x},${actor.cell.y}) · ${
      actor.action?.phase ?? "idle"}${actor.action?.dueAt ? " → " + actor.action.dueAt : ""}`;
    return row;
  }));
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
      // A save/restore changed the authority: require a full refresh, never blend.
      counters.resync += 1;
      shown.sessionId = next.sessionId;
      shown.worldVersion = -1;
      shown.simTime = -1;
      toast("检测到新的会话身份，已按全量快照刷新。");
    }
    if (next.worldVersion < shown.worldVersion || next.simTime < shown.simTime) {
      counters.stale += 1; // older snapshot: keep painting the newest accepted one
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

async function sendCommand(line) {
  if (!line.trim()) return;
  const output = $("hud-command-result");
  output.textContent = `→ ${line} …`;
  try {
    const response = await fetch("api/visual/command", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line }) });
    const body = await response.json();
    if (body.error) throw new Error(body.error);
    const cli = body.cli ?? {};
    output.textContent = `← ${line} · job ${cli.jobId ?? "?"} · ${
      cli.executed !== undefined ? `executed ${cli.executed}` : cli.status ? "status" : "ok"}${
      cli.error ? ` · 错误 ${cli.error}` : ""}`;
    if (body.state?.snapshot) applySnapshot(body.state.snapshot);
  } catch (error) {
    output.textContent = `× ${line} · ${error.message || error}`;
  }
}

async function startSession(action) {
  try {
    const response = await fetch("api/visual/session", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    const body = await response.json();
    if (body.error) throw new Error(body.error);
    shown.sessionId = null; shown.worldVersion = -1; shown.simTime = -1;
    if (body.state?.snapshot) applySnapshot(body.state.snapshot);
    toast(action === "new" ? "新游戏已开始（权威 CLI 内）。" : "存档已恢复（同一权威 CLI）。");
  } catch (error) { toast("会话失败：" + (error.message || error)); }
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
  toast("WASD 飞行，Q/E 升降；派工命令回送原 CLI");
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
  dragging = true; dragX = e.clientX; dragY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add("exploring");
  canvas.focus(); tour = false;
});
canvas.addEventListener("pointerup", () => (dragging = false));
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  camera.yaw += e.movementX * 0.0023;
  camera.pitch = clamp(camera.pitch - e.movementY * 0.0023, -1.5, 1.5);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging || document.pointerLockElement === canvas) return;
  camera.yaw += (e.clientX - dragX) * 0.004;
  camera.pitch = clamp(camera.pitch - (e.clientY - dragY) * 0.004, -1.5, 1.5);
  dragX = e.clientX; dragY = e.clientY;
});
document.addEventListener("pointerlockchange", () => document.body.classList.toggle(
  "flying", document.pointerLockElement === canvas));

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

try {
  const response = await fetch("data/frostecho-map.json");
  if (!response.ok) throw new Error("地图数据加载失败");
  const mapData = await response.json();
  $("load-message").textContent = "按 FrostEcho 原地图搭建村庄…";
  world = makeWorld(mapData);

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
    stats: () => renderer.stats(),
    snapshot: () => snapshot,
    counters: () => ({ ...counters }),
    sendCommand,
    get state() { return { mode, view, snow, audio: ambience.enabled, connection,
      camera: { ...camera }, worldVersion: shown.worldVersion, simTime: shown.simTime }; },
  };
  canvas.dataset.ready = "true";
  last = performance.now();
  requestAnimationFrame(frame);
} catch (e) {
  fail(e.message || String(e));
}
