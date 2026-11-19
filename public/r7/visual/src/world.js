import { Mesh, icosphere, rnd, rr, rseed, fbm, clamp, sstep } from "./math.js";
import {
  coniferMeshes,
  roundedRoofSnow,
  snowDriftMesh,
  mountainRidgeMesh,
} from "./detail-geometry.js";
import { groundDetailMap } from "./ground-map.js";

export const TILE = 2;
export const toWorld = (x, y) => [(x - 25) * TILE, (y - 20) * TILE];
export function buildingPlacement(b) {
  const [x, z] = toWorld(b.x + b.w / 2, b.y + b.h / 2);
  return {
    ...b,
    x,
    z,
    width: b.w * TILE,
    depth: b.h * TILE,
    door: toWorld(b.doorX + 0.5, b.doorY),
  };
}

// Paths follow the original four-neighbour walkability grid, never the decorative snow mesh.
export function gridPath(map, start, goal) {
  const key = (x, y) => y * map.w + x,
    queue = [start],
    parent = new Map([[key(...start), null]]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    if (x === goal[0] && y === goal[1]) {
      const path = [];
      let p = key(x, y);
      while (p !== null) {
        path.push([p % map.w, Math.floor(p / map.w)]);
        p = parent.get(p);
      }
      return path.reverse();
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy,
        k = key(nx, ny);
      if (
        nx < 0 ||
        nx >= map.w ||
        ny < 0 ||
        ny >= map.h ||
        map.blockedRows[ny][nx] === "#" ||
        parent.has(k)
      )
        continue;
      parent.set(k, key(x, y));
      queue.push([nx, ny]);
    }
  }
  return [];
}

export function makeWorld(mapData) {
  rseed(41);
  const buildings = mapData.village.buildings.map(buildingPlacement);
  const hero = buildings.find((b) => b.id === "kitchen");
  const forestPose = [hero.x - 11, 2.65, hero.z + 36, hero.x, 2.6, hero.z];
  const paths = buildings.map((b) =>
    gridPath(mapData.village, [24, 24], [b.doorX, b.doorY]),
  );
  const roadCells = new Set(paths.flat().map(([x, y]) => `${x},${y}`));
  const approach = [
    [-28, 64],
    [-25, 54],
    [-18, 44],
    [-9, 33],
    [-1, 24],
  ];
  const groundMap = groundDetailMap(roadCells, toWorld, approach);
  const roadAt = (x, z) =>
    roadCells.has(`${Math.floor(x / TILE + 25)},${Math.floor(z / TILE + 20)}`);
  const terrainHeight = (x, z) => {
    const outside = sstep(38, 72, Math.max(Math.abs(x), Math.abs(z) * 1.15));
    return (
      -0.15 +
      (fbm(x * 0.034, 7, z * 0.034, 3) - 0.5) * (0.32 + outside * 6) +
      outside * outside * 2 +
      Math.sin(x * 0.19 + z * 0.29 + fbm(x * 0.04, 3, z * 0.04, 2) * 3) * 0.1
    );
  };

  const meshes = new Map();
  const batches = new Map();
  const lights = [];
  function put(
    mesh,
    x,
    y,
    z,
    sx,
    sy,
    sz,
    color,
    mat = 0,
    emission = 0,
    yaw = 0,
  ) {
    const cell = `${Math.floor(x / 20)},${Math.floor(z / 20)}`,
      key = mesh + ":" + cell;
    if (!batches.has(key))
      batches.set(key, {
        mesh,
        data: [],
        x: Math.floor(x / 20) * 20 + 10,
        z: Math.floor(z / 20) * 20 + 10,
        radius: 25,
      });
    const batch = batches.get(key);
    batch.radius = Math.max(
      batch.radius,
      Math.hypot(x - batch.x, z - batch.z) + Math.max(sx, sz),
    );
    batch.data.push(
      x,
      y,
      z,
      yaw,
      sx,
      sy,
      sz,
      0,
      ...color,
      emission,
      mat,
      rnd(),
      mesh === "pine" || mesh === "pineSnow" ? 1 : 0,
      0,
    );
  }
  const snow = [0.68, 0.76, 0.8],
    wood = [0.2, 0.1, 0.052],
    trim = [0.105, 0.062, 0.038],
    stone = [0.22, 0.25, 0.27],
    metal = [0.08, 0.11, 0.14];
  const warm = [1, 0.39, 0.075],
    pine = [0.038, 0.085, 0.078];
  function quad(m, a, b, c, d) {
    const ids = [a, b, c, d].map((p) => m.v(...p));
    m.quad(...ids);
  }
  const cube = new Mesh();
  quad(
    cube,
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  );
  quad(
    cube,
    [0.5, -0.5, -0.5],
    [-0.5, -0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [0.5, 0.5, -0.5],
  );
  quad(
    cube,
    [0.5, -0.5, 0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [0.5, 0.5, 0.5],
  );
  quad(
    cube,
    [-0.5, -0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [-0.5, 0.5, 0.5],
    [-0.5, 0.5, -0.5],
  );
  quad(
    cube,
    [-0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
  );
  quad(
    cube,
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, -0.5, 0.5],
    [-0.5, -0.5, 0.5],
  );
  meshes.set("cube", cube.build());
  const roof = new Mesh();
  quad(roof, [-0.5, 0, 0.5], [0, 0.5, 0.5], [0, 0.5, -0.5], [-0.5, 0, -0.5]);
  quad(roof, [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [0, 0.5, -0.5]);
  for (const z of [-0.5, 0.5]) {
    const a = roof.v(-0.5, 0, z),
      b = roof.v(0.5, 0, z),
      c = roof.v(0, 0.5, z);
    if (z > 0) roof.tri(a, b, c);
    else roof.tri(c, b, a);
  }
  meshes.set("roof", roof.build());
  meshes.set("roofSnow", roundedRoofSnow());
  meshes.set("drift", snowDriftMesh());
  meshes.set("mountain", mountainRidgeMesh());
  const cylinder = new Mesh();
  cylinder.tube(
    [
      [0, -0.5, 0],
      [0, 0.5, 0],
    ],
    0.5,
    10,
    true,
    () => 1,
  );
  meshes.set("cylinder", cylinder.build());
  const log = new Mesh();
  log.tube(
    [
      [0, 0, -0.5],
      [0, 0, 0.5],
    ],
    0.5,
    12,
    true,
    () => 1,
  );
  meshes.set("log", log.build());
  meshes.set(
    "rock",
    icosphere(2, (x, y, z) => {
      const r = 0.85 + 0.24 * fbm(x * 3, 7 + y * 3, z * 3, 2);
      return [x * r, y * r, z * r];
    }).build(),
  );

  for (const [name, mesh] of Object.entries(coniferMeshes()))
    meshes.set(name, mesh);
  const ground = new Mesh(),
    N = 240,
    span = 420;
  for (let z = 0; z <= N; z++)
    for (let x = 0; x <= N; x++) {
      const X = (x / N - 0.5) * span,
        Z = (z / N - 0.5) * span;
      ground.v(X, terrainHeight(X, Z), Z);
    }
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++) {
      const a = z * (N + 1) + x;
      ground.quad(a, a + N + 1, a + N + 2, a + 1);
    }
  meshes.set("terrain", ground.build());
  put("terrain", 0, 0, 0, 1, 1, 1, snow, 8);

  function box(x, y, z, sx, sy, sz, col = wood, mat = 2, em = 0, yaw = 0) {
    put("cube", x, y, z, sx, sy, sz, col, mat, em, yaw);
  }
  for (const b of buildings) {
    const { x, z, width: w, depth: d } = b,
      base = terrainHeight(x, z),
      H = b.id === "command" ? 3.6 : 3.1,
      eave = base + H + 0.35;
    box(x, base + 0.2, z, w + 0.18, 0.5, d + 0.18, stone, 3);
    box(x, base + 0.48, z, w - 0.4, 0.16, d - 0.4, [0.26, 0.15, 0.08], 2);
    // Walls assembled from horizontal timber. Front doorway is a real opening, aligned to the grid door.
    const doorX = b.door[0],
      front = z + d / 2,
      doorW = 1.35,
      doorTop = base + 2.58;
    // Continuous wall cores sit behind the visible timbers: their seams must not expose the sky.
    box(x, base + 1.95, z - d / 2 + 0.08, w, 3.0, 0.14, wood);
    box(x - w / 2 + 0.08, base + 1.95, z, 0.14, 3.0, d, wood);
    box(x + w / 2 - 0.08, base + 1.95, z, 0.14, 3.0, d, wood);
    const leftWidth = doorX - doorW / 2 - (x - w / 2);
    const rightWidth = x + w / 2 - (doorX + doorW / 2);
    box(
      x - w / 2 + leftWidth / 2,
      base + 1.95,
      front - 0.08,
      leftWidth,
      3.0,
      0.14,
      wood,
    );
    box(
      doorX + doorW / 2 + rightWidth / 2,
      base + 1.95,
      front - 0.08,
      rightWidth,
      3.0,
      0.14,
      wood,
    );
    box(doorX, base + 3.0, front - 0.08, doorW, 0.9, 0.14, wood);
    box(x, eave - 0.1, z, w - 0.2, 0.14, d - 0.2, trim);
    for (let i = 0; i < 12; i++) {
      const y = base + 0.55 + i * 0.235,
        h = 0.22,
        grain = i % 2 ? 0.9 : 1;
      const col = wood.map((c) => c * grain * (b.id === "kitchen" ? 1.2 : 1));
      box(x, y, z - d / 2, w, h, 0.3, col);
      box(x - w / 2, y, z, 0.32, h, d, col);
      box(x + w / 2, y, z, 0.32, h, d, col);
      if (y > doorTop) box(x, y, front, w, h, 0.3, col);
      else {
        const L = doorX - doorW / 2 - (x - w / 2),
          R = x + w / 2 - (doorX + doorW / 2);
        if (L > 0) box(x - w / 2 + L / 2, y, front, L, h, 0.3, col);
        if (R > 0) box(doorX + doorW / 2 + R / 2, y, front, R, h, 0.3, col);
      }
    }
    for (const dx of [-w / 2, w / 2])
      for (const dz of [-d / 2, d / 2])
        box(x + dx, base + 1.9, z + dz, 0.3, 2.8, 0.3, trim);
    box(doorX - doorW / 2, base + 1.6, front + 0.1, 0.15, 2.35, 0.25, trim);
    box(doorX + doorW / 2, base + 1.6, front + 0.1, 0.15, 2.35, 0.25, trim);
    box(doorX, doorTop + 0.12, front + 0.1, doorW + 0.3, 0.24, 0.28, trim);
    // Open inward door and a warm threshold; free flight is deliberately not gameplay movement.
    box(
      doorX - 0.57,
      base + 1.6,
      front - 0.6,
      0.13,
      2.2,
      1.12,
      [0.13, 0.07, 0.035],
      2,
    );
    box(doorX, base + 0.3, front + 0.68, 1.9, 0.22, 1.35, stone, 3);
    box(doorX, base + 0.15, front + 1.2, 2.2, 0.13, 1.2, snow, 1);
    put("roof", x, eave, z, w + 1, 3.5, d + 1.1, [0.1, 0.13, 0.15], 4);
    put("roofSnow", x, eave + 0.16, z, w + 1.2, 3.6, d + 1.3, snow, 1);
    for (const [bankX, bankWidth] of [
      [x - w / 2 + leftWidth / 2, leftWidth],
      [doorX + doorW / 2 + rightWidth / 2, rightWidth],
    ]) {
      put(
        "drift",
        bankX,
        terrainHeight(bankX, front + 0.2) - 0.03,
        front + 0.2,
        bankWidth * 0.54,
        0.65,
        0.75,
        snow,
        1,
      );
    }
    for (const dx of [-1, 1]) {
      const xx = x + dx * (w / 2 + 0.1);
      put(
        "drift",
        xx,
        terrainHeight(xx, z) - 0.04,
        z,
        0.8,
        0.6,
        d * 0.54,
        snow,
        1,
      );
    }
    box(x, eave - 0.06, front + 0.55, w + 1.3, 0.18, 0.15, trim);
    box(x, eave - 0.06, z - d / 2 - 0.55, w + 1.3, 0.18, 0.15, trim);
    // Snow lip and short icicles under the eaves.
    for (let k = 0; k < 15; k++) {
      const xx = x + (k / 14 - 0.5) * (w + 1);
      put(
        "cylinder",
        xx,
        eave - 0.12 - rr(0.06, 0.18),
        front + 0.57,
        0.045,
        rr(0.13, 0.42),
        0.045,
        [0.54, 0.68, 0.75],
        4,
      );
    }
    const window = (wx, wz, side) => {
      const wy = base + 1.95,
        ww = 1.3,
        wh = 1.12;
      box(
        wx,
        wy,
        wz,
        side ? 0.075 : ww,
        wh,
        side ? ww : 0.075,
        [0.045, 0.027, 0.02],
        2,
      );
      box(
        wx + (side ? 0.045 : 0),
        wy,
        wz + (side ? 0 : 0.045),
        side ? 0.04 : ww - 0.18,
        wh - 0.18,
        side ? ww - 0.18 : 0.04,
        warm,
        9,
        2.25,
      );
      for (const s of [-1, 1]) {
        box(
          wx + (side ? 0 : (s * ww) / 2),
          wy + (side ? (s * wh) / 2 : 0),
          wz,
          side ? 0.2 : 0.12,
          side ? 0.12 : wh + 0.18,
          side ? ww + 0.2 : 0.2,
          trim,
        );
        box(
          wx,
          wy + (side ? 0 : (s * wh) / 2),
          wz + (side ? (s * ww) / 2 : 0),
          side ? 0.2 : ww + 0.2,
          side ? wh + 0.18 : 0.12,
          side ? 0.12 : 0.2,
          trim,
        );
      }
      box(
        wx,
        wy,
        wz + (side ? 0 : 0.08),
        side ? 0.22 : 0.065,
        wh,
        side ? 0.065 : 0.2,
        trim,
      );
      box(
        wx,
        wy,
        wz + (side ? 0 : 0.08),
        side ? 0.22 : ww,
        0.065,
        side ? ww : 0.2,
        trim,
      );
      box(
        wx,
        wy - wh / 2 - 0.13,
        wz + (side ? 0 : 0.12),
        side ? 0.38 : ww + 0.3,
        0.13,
        side ? ww + 0.3 : 0.38,
        snow,
        1,
      );
      if (lights.length < 24)
        lights.push([wx + (side ? 0.6 : 0), wy, wz + (side ? 0 : 0.6), 1.1]);
    };
    for (const dx of [-w * 0.31, w * 0.31])
      if (Math.abs(x + dx - doorX) > 1.7) window(x + dx, front + 0.2, false);
    for (const dz of [-d * 0.25, d * 0.25])
      window(x + w / 2 + 0.2, z + dz, true);
    // Chimney, warm stove and sparse furnishings; kitchen table/stove use source relative furniture coordinates below.
    box(x - w * 0.25, eave + 1.55, z - d * 0.18, 0.7, 2.6, 0.7, stone, 3);
    box(x - w * 0.25, eave + 2.9, z - d * 0.18, 0.94, 0.2, 0.94, snow, 1);
    box(doorX, base + 0.55, front - 0.5, 1.25, 0.02, 1, warm, 5, 0.35);
    for (let i = 0; i < 4; i++)
      box(
        x - w / 2 + 0.65,
        base + 0.95,
        z - d / 2 + 0.8 + i * 0.5,
        0.8,
        0.15,
        0.42,
        wood,
      );
    const stoveX = x - w * 0.28,
      stoveZ = z - d * 0.25;
    box(stoveX, base + 1, stoveZ, 1, 0.95, 0.8, metal, 4);
    box(
      stoveX,
      base + 0.92,
      stoveZ + 0.42,
      0.65,
      0.37,
      0.03,
      [1, 0.22, 0.025],
      5,
      5,
    );
    put("cylinder", stoveX, base + 2, stoveZ, 0.12, 1.6, 0.12, metal, 4);
    lights.push([stoveX, base + 1.3, stoveZ + 0.65, 1.4]);
    if (b.id === "kitchen") {
      for (const f of mapData.kitchen.furniture) {
        const fx = x - w / 2 + ((f.x + f.w / 2) / mapData.kitchen.w) * w,
          fz = z - d / 2 + ((f.y + f.h / 2) / mapData.kitchen.h) * d;
        if (f.name === "餐桌") {
          box(
            fx,
            base + 1.16,
            fz,
            (f.w / mapData.kitchen.w) * w,
            0.16,
            (f.h / mapData.kitchen.h) * d,
            [0.29, 0.17, 0.085],
          );
          for (const dx of [-1, 1])
            for (const dz of [-1, 1])
              box(
                fx + dx * 1.5,
                base + 0.77,
                fz + dz * 0.55,
                0.12,
                0.7,
                0.12,
                trim,
              );
          box(fx, base + 0.8, fz + 1.35, 3.5, 0.14, 0.45, wood);
        } else if (f.name === "食材架") {
          box(fx, base + 1.3, fz, 1.8, 1.6, 0.5, trim);
          for (let i = 0; i < 4; i++)
            box(
              fx,
              base + 0.7 + i * 0.4,
              fz + 0.3,
              1.9,
              0.08,
              0.8,
              [0.27, 0.16, 0.08],
            );
        }
      }
      // Woodpile and small lantern beside the front door.
      for (let j = 0; j < 3; j++)
        for (let i = 0; i < 5 - j; i++)
          put(
            "log",
            x - w * 0.35 + i * 0.31 + j * 0.15,
            base + 0.36 + j * 0.28,
            front + 0.62,
            0.27,
            0.27,
            0.85,
            [0.22, 0.12, 0.06],
            2,
            0,
            Math.PI / 2,
          );
      // A snow-capped porch, timber joints and small metal fasteners add close-view scale cues.
      for (let k = 0; k < 9; k++)
        box(
          doorX - 1.35 + k * 0.34,
          base + 0.37,
          front + 1.0,
          0.32,
          0.15,
          1.65,
          [0.22, 0.13, 0.075],
        );
      for (const dx of [-1.7, 1.7]) {
        box(doorX + dx, base + 1.53, front + 1.8, 0.15, 2.5, 0.15, trim);
        box(doorX + dx, base + 1.35, front + 1.2, 0.1, 0.12, 1.2, wood);
      }
      box(doorX, base + 2.87, front + 1.8, 3.6, 0.18, 0.2, trim);
      put("roofSnow", doorX, base + 2.88, front + 1.0, 3.9, 0.6, 2.4, snow, 1);
      for (const dx of [-w / 2, w / 2])
        for (let k = 0; k < 11; k++)
          put(
            "rock",
            x + dx,
            base + 0.6 + k * 0.235,
            front + 0.18,
            0.035,
            0.035,
            0.025,
            metal,
            4,
          );
      for (const dx of [-w / 2 - 0.35, w / 2 + 0.35])
        for (let k = 0; k < 3; k++) {
          const zz = front - 0.7 - k * 0.8;
          put(
            "drift",
            x + dx,
            terrainHeight(x + dx, zz),
            zz,
            0.85,
            0.55,
            1.1,
            snow,
            1,
          );
        }
    }
  }
  // Village wall footprint follows the original wall bounds and two gate gaps.
  const wb = mapData.village.wallBounds;
  for (let gy = wb.y1; gy <= wb.y2; gy++)
    for (let gx = wb.x1; gx <= wb.x2; gx++) {
      if (gx !== wb.x1 && gx !== wb.x2 && gy !== wb.y1 && gy !== wb.y2)
        continue;
      if (
        mapData.village.gates.some(
          (g) => gy === g.y && gx >= g.x && gx < g.x + g.w,
        )
      )
        continue;
      const [x, z] = toWorld(gx + 0.5, gy + 0.5),
        y = terrainHeight(x, z);
      box(
        x,
        y + 0.75,
        z,
        1.65,
        1.65,
        0.45,
        [0.16, 0.2, 0.21],
        3,
        0,
        gx === wb.x1 || gx === wb.x2 ? Math.PI / 2 : 0,
      );
      box(
        x,
        y + 1.63,
        z,
        1.75,
        0.18,
        0.55,
        snow,
        1,
        0,
        gx === wb.x1 || gx === wb.x2 ? Math.PI / 2 : 0,
      );
    }

  let trees = 0;
  function tree(x, z, h) {
    const y = terrainHeight(x, z),
      a = rr(0, Math.PI * 2),
      sc = rr(0.85, 1.15);
    put(
      "cylinder",
      x,
      y + h * 0.32,
      z,
      h * 0.045,
      h * 0.65,
      h * 0.045,
      [0.13, 0.105, 0.08],
      2,
    );
    put(
      "pine",
      x,
      y,
      z,
      h * sc,
      h,
      h * sc,
      pine.map((c) => c * rr(0.8, 1.2)),
      6,
      0,
      a,
    );
    put("pineSnow", x, y, z, h * sc, h, h * sc, snow, 1, 0, a);
    put("drift", x, y - 0.04, z, h * 0.1, 0.4, h * 0.085, snow, 1);
    trees++;
  }
  for (const d of mapData.village.decorations.filter(
    (d) => d.type === "tree",
  )) {
    const [x, z] = toWorld(d.x + 0.5, d.y + 0.5);
    tree(x, z, rr(7, 12));
  }
  rseed(42);
  for (const [x, z, h] of [
    [-37, 44, 12],
    [-36, 36, 13],
    [-18, 55, 10],
    [-39, 59, 15],
    [-8, 49, 12],
    [-5, 61, 14],
    [-30, 68, 13],
  ])
    tree(x, z, h);
  for (let i = 0; i < 1550; i++) {
    const x = rr(-155, 155),
      z = rr(-135, 135),
      r = Math.hypot(x, z);
    if (
      r > 170 ||
      (Math.abs(x) < 57 && Math.abs(z) < 48) ||
      Math.hypot(x - forestPose[0], z - forestPose[2]) < 7 ||
      rnd() > 0.62 + 0.3 * fbm(x * 0.03, 1, z * 0.03, 2)
    )
      continue;
    // Leave the front approach to the hero cabin and the south gate legible.
    if (z > hero.z && Math.abs(x - hero.x) < 7 && z < 65) continue;
    tree(x, z, rr(6, 16));
  }
  for (let i = 0; i < 180; i++) {
    const x = rr(-105, 105),
      z = rr(-90, 90);
    if ((Math.abs(x) < 44 && Math.abs(z) < 34) || roadAt(x, z)) continue;
    const s = rr(0.3, 1.7);
    put(
      "rock",
      x,
      terrainHeight(x, z),
      z,
      s,
      s * 0.55,
      s,
      [0.25, 0.3, 0.32],
      3,
    );
    put(
      "rock",
      x,
      terrainHeight(x, z) + s * 0.22,
      z,
      s * 0.97,
      s * 0.36,
      s * 0.97,
      snow,
      1,
    );
  }
  // Distant ridges: low-poly geometry softened by the very same fog as the foreground.
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2,
      r = rr(240, 320),
      x = Math.cos(a) * r,
      z = Math.sin(a) * r;
    put(
      "mountain",
      x,
      -8,
      z,
      rr(45, 90),
      rr(30, 80),
      rr(40, 70),
      [0.24, 0.31, 0.38],
      1,
      0,
      a,
    );
  }
  const lampX = hero.door[0] + 2.3,
    lampZ = hero.z + hero.depth / 2 + 2.1,
    ly = terrainHeight(lampX, lampZ);
  box(lampX, ly + 1.15, lampZ, 0.1, 2.4, 0.1, trim);
  box(lampX, ly + 2.2, lampZ, 0.32, 0.45, 0.32, warm, 5, 4);
  box(lampX, ly + 2.48, lampZ, 0.46, 0.08, 0.46, metal, 4);
  lights.push([lampX, ly + 2.2, lampZ, 1.8]);

  const heroFloor = terrainHeight(hero.x, hero.z),
    cx = hero.x,
    cz = hero.z;
  const poses = {
    cabin: [cx + 9, heroFloor + 3.8, cz + 6.4, cx, heroFloor + 2.5, cz],
    village: [67, 70, 83, -2, 0, 2],
    inside: [
      cx + 3.5,
      heroFloor + 2.1,
      cz + 2.1,
      cx - 2,
      heroFloor + 1.8,
      cz - 2,
    ],
    forest: forestPose,
  };
  return {
    meshes,
    batches: [...batches.values()].map((b) => ({
      ...b,
      data: new Float32Array(b.data),
      n: b.data.length / 16,
    })),
    buildings,
    hero,
    terrainHeight,
    groundMap,
    chimney: [
      hero.x - hero.width * 0.25,
      terrainHeight(hero.x, hero.z) + 6.45,
      hero.z - hero.depth * 0.18,
      1,
    ],
    lights: lights.slice(0, 32),
    poses,
    trees,
    paths,
    roadCells,
    source: mapData.source,
  };
}
