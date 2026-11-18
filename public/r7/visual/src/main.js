import { makeWorld } from "./world.js";
import { Renderer } from "./renderer.js";
import { Ambience } from "./audio.js";
import { clamp } from "./math.js";

const $ = (id) => document.getElementById(id),
  canvas = $("scene");
const params = new URLSearchParams(location.search);
const ambience = new Ambience();
const camera = { x: 0, y: 5, z: 25, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0 };
const modes = [
  {
    name: "静雪守夜",
    kicker: "01 / THE LIGHT WE KEEP",
    title: "风雪很远，<br>灯火很近。",
    description: "一片无声的松林，一栋仍有温度的小屋。<br>循着灯光，走进雪原。",
    skyLow: [0.055, 0.1, 0.17],
    skyHigh: [0.012, 0.03, 0.07],
    light: [0.18, 0.25, 0.38],
    fog: [0.065, 0.12, 0.18, 0.014],
    snow: 0.35,
    exposure: 1,
    view: "cabin",
  },
  {
    name: "微缩雪镇",
    kicker: "02 / A SMALL WORLD BELOW",
    title: "把世界，<br>放轻一点。",
    description:
      "雪后的村庄像一张摊开的地图。<br>看见每一条道路，和每一处归途。",
    skyLow: [0.48, 0.62, 0.71],
    skyHigh: [0.24, 0.42, 0.6],
    light: [1.12, 0.94, 0.72],
    fog: [0.48, 0.62, 0.71, 0.0045],
    snow: 0.12,
    exposure: 0.95,
    view: "village",
  },
  {
    name: "白障风暴",
    kicker: "03 / WHEN THE WORLD DISAPPEARS",
    title: "世界隐去，<br>还有一盏灯。",
    description: "风把远方抹成白色。<br>在失去方向之前，找到那扇暖窗。",
    skyLow: [0.16, 0.22, 0.27],
    skyHigh: [0.035, 0.065, 0.1],
    light: [0.16, 0.2, 0.25],
    fog: [0.2, 0.28, 0.34, 0.041],
    snow: 0.92,
    exposure: 0.95,
    view: "forest",
  },
];
let renderer,
  world,
  mode = params.has("mode") ? clamp(Number(params.get("mode")) || 0, 0, 2) : 2,
  snow = modes[mode].snow,
  view = "cabin",
  last = 0,
  time = 0,
  hudTime = 0,
  tour = false,
  tourTime = 0,
  dead = false;
const errors = [],
  keys = new Set();
let dragging = false,
  dragX = 0,
  dragY = 0;
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
addEventListener("unhandledrejection", (e) =>
  fail(e.reason?.message || String(e.reason)),
);
function toast(text) {
  $("notice").textContent = text;
  $("notice").classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("notice").classList.remove("visible"), 2600);
}
function setPose(id) {
  if (!world?.poses[id]) return;
  const p = world.poses[id];
  camera.x = p[0];
  camera.y = p[1];
  camera.z = p[2];
  const dx = p[3] - p[0],
    dy = p[4] - p[1],
    dz = p[5] - p[2];
  camera.yaw = Math.atan2(dx, -dz);
  camera.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  camera.vx = camera.vy = camera.vz = 0;
  view = id;
  tour = false;
  $("tour").textContent = "自动环游";
  for (const b of $("views").children)
    b.classList.toggle("active", b.dataset.view === id);
}
function setMode(n, move = true) {
  mode = n;
  const m = modes[n];
  snow = m.snow;
  ambience.mode = n;
  ambience.snow = snow;
  $("scene-kicker").textContent = m.kicker;
  $("scene-title").innerHTML = m.title;
  $("scene-description").innerHTML = m.description;
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
  const u = renderer.uniforms,
    cp = Math.cos(camera.pitch),
    fy = Math.sin(camera.pitch),
    rx = Math.cos(camera.yaw),
    rz = Math.sin(camera.yaw),
    fx = cp * rz,
    fz = -cp * rx,
    ux = -rz * fy,
    uy = cp,
    uz = rx * fy;
  const aspect = renderer.width / renderer.height,
    tan = mode === 1 ? 0.43 : 0.6,
    sx = 1 / (tan * aspect),
    sy = 1 / tan;
  u[0] = rx * sx;
  u[4] = 0;
  u[8] = rz * sx;
  u[12] = -(rx * camera.x + rz * camera.z) * sx;
  u[1] = ux * sy;
  u[5] = uy * sy;
  u[9] = uz * sy;
  u[13] = -(ux * camera.x + uy * camera.y + uz * camera.z) * sy;
  u[2] = u[6] = u[10] = 0;
  u[14] = 0.08;
  u[3] = fx;
  u[7] = fy;
  u[11] = fz;
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
  u.set(
    [renderer.width, renderer.height, 1 / renderer.width, 1 / renderer.height],
    72,
  );
  u.set(
    [
      world.hero.x,
      world.hero.z,
      world.hero.width / 2 - 0.25,
      world.hero.depth / 2 - 0.25,
    ],
    76,
  );
}
function shadowMatrix() {
  const u = renderer.uniforms;
  let lx = 0.3,
    ly = 0.85,
    lz = -0.43,
    l = Math.hypot(lx, ly, lz);
  lx /= l;
  ly /= l;
  lz /= l;
  u.set([lx, ly, lz, 0], 48);
  let rx = ly,
    ry = -lx,
    rz = 0;
  l = Math.hypot(rx, ry);
  rx /= l;
  ry /= l;
  const ux = ly * rz - lz * ry,
    uy = lz * rx - lx * rz,
    uz = lx * ry - ly * rx,
    R = 180,
    d0 = -150,
    d1 = 180;
  u[16] = rx / R;
  u[20] = ry / R;
  u[24] = rz / R;
  u[28] = 0;
  u[17] = ux / R;
  u[21] = uy / R;
  u[25] = uz / R;
  u[29] = 0;
  u[18] = -lx / (d1 - d0);
  u[22] = -ly / (d1 - d0);
  u[26] = -lz / (d1 - d0);
  u[30] = d1 / (d1 - d0);
  u[19] = u[23] = u[27] = 0;
  u[31] = 1;
  for (let i = 0; i < world.lights.length; i++)
    u.set(world.lights[i], 80 + i * 4);
  u.set(world.chimney, 208);
}
function updateCamera(dt) {
  if (tour) {
    tourTime += dt;
    const a = tourTime * 0.06,
      c = world.hero;
    camera.x = c.x + Math.sin(a) * 26;
    camera.z = c.z + Math.cos(a) * 29;
    camera.y = 5 + Math.sin(a * 0.7) * 1.8;
    camera.yaw = Math.atan2(c.x - camera.x, -(c.z - camera.z));
    camera.pitch = Math.atan2(
      2.8 - camera.y,
      Math.hypot(c.x - camera.x, c.z - camera.z),
    );
    return;
  }
  const k = 1 - Math.exp(-dt * 7),
    speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 23 : 7,
    f = Number(keys.has("KeyW")) - Number(keys.has("KeyS")),
    r = Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
    up = Number(keys.has("KeyE")) - Number(keys.has("KeyQ"));
  const cp = Math.cos(camera.pitch),
    sy = Math.sin(camera.yaw),
    cy = Math.cos(camera.yaw);
  camera.vx += ((sy * cp * f + cy * r) * speed - camera.vx) * k;
  camera.vy += ((Math.sin(camera.pitch) * f + up) * speed - camera.vy) * k;
  camera.vz += ((-cy * cp * f + sy * r) * speed - camera.vz) * k;
  camera.x = clamp(camera.x + camera.vx * dt, -195, 195);
  camera.z = clamp(camera.z + camera.vz * dt, -175, 175);
  camera.y = clamp(
    camera.y + camera.vy * dt,
    world.terrainHeight(camera.x, camera.z) + 0.75,
    120,
  );
}
function frame(now) {
  if (dead) return;
  requestAnimationFrame(frame);
  const frameMs = now - last,
    dt = Math.min(frameMs / 1000, 0.05);
  last = now;
  if (document.hidden) return;
  time += dt;
  updateCamera(dt);
  fillUniforms();
  renderer.frame(dt, camera, frameMs);
  const h = world.hero,
    indoor =
      Math.abs(camera.x - h.x) < h.width / 2 &&
      Math.abs(camera.z - h.z) < h.depth / 2 &&
      camera.y < 5;
  ambience.inside = indoor
    ? 1
    : Math.max(0, 1 - Math.hypot(camera.x - h.x, camera.z - h.z) / 14) * 0.2;
  hudTime += dt;
  if (hudTime > 0.5) {
    hudTime = 0;
    $("telemetry").textContent =
      `${modes[mode].name}  /  ${renderer.width} × ${renderer.height}  /  ${renderer.timed ? "GPU " + renderer.gpuMs.toFixed(1) + " ms" : "GPU 计时不可用"}  /  ${world.trees} 株松树  /  高度 ${camera.y.toFixed(1)} m`;
    const marker = $("camera-dot");
    marker.setAttribute("cx", (camera.x / 2 + 25) * 3);
    marker.setAttribute("cy", (camera.z / 2 + 20) * 3);
    $("telemetry").dataset.gpuMs = renderer.gpuMs.toFixed(3);
    $("telemetry").dataset.frameCount = String(renderer.frameCount);
    $("telemetry").dataset.errors = String(errors.length);
    $("telemetry").dataset.camera = [camera.x, camera.y, camera.z]
      .map((x) => x.toFixed(3))
      .join(",");
    $("telemetry").dataset.mode = String(mode);
    $("telemetry").dataset.view = view;
    $("telemetry").dataset.drawCalls = String(renderer.drawCalls);
    $("telemetry").dataset.treeDetailDistance =
      renderer.treeDetailDistance.toFixed(1);
  }
}
function initMap() {
  const NS = "http://www.w3.org/2000/svg",
    svg = $("map");
  for (const b of world.buildings) {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", (b.x / 2 + 25 - b.w / 2) * 3);
    r.setAttribute("y", (b.z / 2 + 20 - b.h / 2) * 3);
    r.setAttribute("width", b.w * 3);
    r.setAttribute("height", b.h * 3);
    r.setAttribute("fill", b.id === "kitchen" ? "#e3bd87" : "#76939f");
    r.setAttribute("opacity", b.id === "kitchen" ? "1" : ".6");
    svg.append(r);
  }
  const dot = document.createElementNS(NS, "circle");
  dot.id = "camera-dot";
  dot.setAttribute("r", "2");
  dot.setAttribute("fill", "#f5eee1");
  svg.append(dot);
}
for (const b of $("modes").children)
  b.onclick = () => {
    setMode(Number(b.dataset.mode));
    document.body.classList.add("exploring");
  };
for (const b of $("views").children)
  b.onclick = () => {
    setPose(b.dataset.view);
    document.body.classList.add("exploring");
  };
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
  } catch (e) {
    toast("声音未启动：" + e.message);
  }
};
$("enter").onclick = () => {
  document.body.classList.add("exploring");
  canvas.focus();
  if (!ambience.enabled) $("sound").click();
  canvas.requestPointerLock?.();
  toast("WASD 飞行，Q/E 升降；Esc 释放鼠标，H 隐藏界面");
};
$("hide-ui").onclick = () => document.body.classList.toggle("clean");
$("tour").onclick = () => {
  tour = !tour;
  tourTime = 0;
  $("tour").textContent = tour ? "停止环游" : "自动环游";
  document.body.classList.add("exploring");
};
canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragX = e.clientX;
  dragY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add("exploring");
  canvas.focus();
  tour = false;
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
  dragX = e.clientX;
  dragY = e.clientY;
});
document.addEventListener("pointerlockchange", () =>
  document.body.classList.toggle(
    "flying",
    document.pointerLockElement === canvas,
  ),
);
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
    keys.add(code);
    tour = false;
    $("tour").textContent = "自动环游";
    document.body.classList.add("exploring");
    e.preventDefault();
  }
});
addEventListener("keyup", (e) => keys.delete(keyboardCode(e)));
addEventListener("blur", () => {
  keys.clear();
  dragging = false;
});
addEventListener("resize", () => renderer?.resize());

try {
  const response = await fetch("data/frostecho-map.json");
  if (!response.ok) throw new Error("地图数据加载失败");
  const mapData = await response.json();
  $("load-message").textContent = "按 FrostEcho 原地图搭建村庄…";
  world = makeWorld(mapData);
  $("load-message").textContent = "编译光照、雪雾与风雪着色器…";
  renderer = await Renderer.create(canvas, world, fail);
  initMap();
  setMode(mode);
  if (params.has("view")) setPose(params.get("view"));
  shadowMatrix();
  fillUniforms();
  renderer.bakeShadow();
  renderer.frame(1 / 60, camera);
  await renderer.device.queue.onSubmittedWorkDone();
  $("gpu-status").textContent = "WEBGPU / LIVE";
  $("loading").classList.add("ready");
  // Local diagnostics for verification and later handoff; no network telemetry is sent.
  window.frostEcho = {
    ready: true,
    errors,
    world,
    camera,
    renderer,
    setMode,
    setPose,
    stats: () => renderer.stats(),
    get state() {
      return {
        mode,
        view,
        snow,
        audio: ambience.enabled,
        camera: { ...camera },
      };
    },
  };
  canvas.dataset.ready = "true";
  last = performance.now();
  requestAnimationFrame(frame);
} catch (e) {
  fail(e.message || String(e));
}
