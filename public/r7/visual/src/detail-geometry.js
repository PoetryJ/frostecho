import { Mesh, fbm } from "./math.js";

function randomStream(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
}
const quad = (m, points) => m.quad(...points.map((p) => m.v(...p)));

// Radial branch fans replace the continuous cone silhouette. Snow rests on branch tops.
// The far mesh retains the same branches, with fewer sections and no fine sidelets.
export function coniferMeshes() {
  const leaf = new Mesh(),
    snow = new Mesh(),
    farLeaf = new Mesh(),
    farSnow = new Mesh();
  const random = randomStream(81473);
  function frond(target, caps, origin, angle, length, width, phase, sections) {
    const along = [Math.cos(angle), Math.sin(angle)],
      side = [-along[1], along[0]];
    const rings = [];
    for (let i = 0; i <= sections; i++) {
      const t = i / sections;
      const bow = Math.sin(t * Math.PI) * 0.022;
      const y = origin[1] - bow + t * t * 0.012;
      const x = origin[0] + along[0] * length * t,
        z = origin[2] + along[1] * length * t;
      const w =
        width *
        Math.pow(Math.sin(Math.PI * Math.max(0.03, t)), 0.65) *
        (i % 2 ? 1.12 : 0.72);
      rings.push([
        [x, y + 0.009 * (1 - t), z],
        [x + side[0] * w, y - 0.005, z + side[1] * w],
        [x, y - 0.012, z],
        [x - side[0] * w, y - 0.005, z - side[1] * w],
      ]);
    }
    for (let i = 0; i < sections; i++) {
      for (let face = 0; face < 4; face++)
        quad(target, [
          rings[i][face],
          rings[i + 1][face],
          rings[i + 1][(face + 1) % 4],
          rings[i][(face + 1) % 4],
        ]);
      if (phase > 0.18 && i < sections - 1) {
        // Rounded uneven snow shelves leave green tips exposed.
        const t = (i + 0.5) / sections,
          coverage = 0.58 + 0.22 * Math.sin(t * 6 + phase * 7);
        const top = (p) => [
          p[0],
          p[1] + 0.007 + 0.005 * Math.sin(t * Math.PI),
          p[2],
        ];
        const left = rings[i][1].map(
          (v, k) => rings[i][0][k] + (v - rings[i][0][k]) * coverage,
        );
        if (sections >= 3) {
          const t = (i + 0.65) / sections;
          const root = [
            origin[0] + along[0] * length * t,
            origin[1] - 0.018 * Math.sin(t * Math.PI),
            origin[2] + along[1] * length * t,
          ];
          for (const sign of [-1, 1])
            for (let fan = 0; fan < 4; fan++) {
              const a = angle + sign * (0.7 + fan * 0.19),
                len = width * (0.75 + 0.3 * Math.sin(t * 7 + fan));
              const start = [
                root[0] + side[0] * sign * width * 0.18,
                root[1] + fan * 0.001,
                root[2] + side[1] * sign * width * 0.18,
              ];
              const tip = [
                start[0] + Math.cos(a) * len,
                start[1] + 0.006 * Math.sin(fan * 2),
                start[2] + Math.sin(a) * len,
              ];
              const w = 0.0014;
              const ids = [
                [
                  start[0] + side[0] * w,
                  start[1] + 0.001,
                  start[2] + side[1] * w,
                ],
                tip,
                [
                  start[0] - side[0] * w,
                  start[1] - 0.001,
                  start[2] - side[1] * w,
                ],
              ].map((p) => target.v(...p));
              target.tri(...ids);
            }
        }
        const right = rings[i][3].map(
          (v, k) => rings[i][0][k] + (v - rings[i][0][k]) * coverage,
        );
        const nextLeft = rings[i + 1][1].map(
          (v, k) => rings[i + 1][0][k] + (v - rings[i + 1][0][k]) * coverage,
        );
        const nextRight = rings[i + 1][3].map(
          (v, k) => rings[i + 1][0][k] + (v - rings[i + 1][0][k]) * coverage,
        );
        quad(caps, [
          top(left),
          top(nextLeft),
          top(rings[i + 1][0]),
          top(rings[i][0]),
        ]);
        quad(caps, [
          top(rings[i][0]),
          top(rings[i + 1][0]),
          top(nextRight),
          top(right),
        ]);
      }
    }
  }
  for (let tier = 0; tier < 13; tier++) {
    const h = 0.13 + tier * 0.063,
      branches = Math.max(4, 10 - Math.floor(tier * 0.38)),
      twist = tier * 2.399;
    for (let arm = 0; arm < branches; arm++) {
      const angle = (arm / branches) * Math.PI * 2 + twist + random() * 0.23;
      const length = Math.pow(1 - h, 1.15) * (0.29 + random() * 0.09),
        width = length * (0.17 + random() * 0.08),
        phase = random();
      const origin = [0, h + (random() - 0.5) * 0.027, 0];
      frond(leaf, snow, origin, angle, length, width, phase, 5);
      frond(farLeaf, farSnow, origin, angle, length, width, phase, 2);
      if (tier < 10)
        for (const direction of [-1, 1]) {
          const t = 0.44 + random() * 0.12,
            ox = Math.cos(angle) * length * t,
            oz = Math.sin(angle) * length * t;
          frond(
            leaf,
            snow,
            [ox, origin[1] - 0.012, oz],
            angle + direction * 0.68,
            length * 0.47,
            width * 0.56,
            phase,
            3,
          );
        }
    }
  }
  return {
    pine: leaf.build(),
    pineSnow: snow.build(),
    pineFar: farLeaf.build(),
    pineSnowFar: farSnow.build(),
  };
}

export function roundedRoofSnow() {
  const m = new Mesh(),
    nx = 24,
    nz = 28;
  const height = (x, z) =>
    0.5 -
    Math.abs(x) +
    0.014 +
    0.024 * fbm(x * 9 + 5, 3, z * 8, 3) +
    0.012 * Math.sin(z * 8 + x * 5) +
    0.014 * (x + 0.5);
  for (let z = 0; z <= nz; z++)
    for (let x = 0; x <= nx; x++) {
      const X = x / nx - 0.5,
        Z = z / nz - 0.5;
      m.v(X, height(X, Z), Z);
    }
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const a = z * (nx + 1) + x;
      m.quad(a, a + nx + 1, a + nx + 2, a + 1);
    }
  for (const z of [-0.5, 0.5])
    for (let x = 0; x < nx; x++) {
      const x0 = x / nx - 0.5,
        x1 = (x + 1) / nx - 0.5,
        y0 = height(x0, z),
        y1 = height(x1, z);
      quad(m, [
        [x0, y0, z],
        [x1, y1, z],
        [x1, y1 - 0.045, z],
        [x0, y0 - 0.045, z],
      ]);
    }
  for (const x of [-0.5, 0.5])
    for (let z = 0; z < nz; z++) {
      const z0 = z / nz - 0.5,
        z1 = (z + 1) / nz - 0.5,
        y0 = height(x, z0),
        y1 = height(x, z1);
      quad(m, [
        [x, y0, z0],
        [x, y1, z1],
        [x, y1 - 0.045, z1],
        [x, y0 - 0.045, z0],
      ]);
    }
  return m.build();
}

export function snowDriftMesh() {
  const m = new Mesh(),
    segments = 24,
    rings = 8;
  for (let r = 0; r <= rings; r++)
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2,
        t = r / rings,
        x = Math.cos(a) * t,
        z = Math.sin(a) * t;
      const y =
        Math.pow(Math.max(0, 1 - t * t), 1.25) *
        (0.46 + 0.06 * Math.sin(a * 3 + t * 8));
      m.v(x, y, z);
    }
  for (let r = 0; r < rings; r++)
    for (let i = 0; i < segments; i++)
      m.quad(
        r * segments + i,
        (r + 1) * segments + i,
        (r + 1) * segments + ((i + 1) % segments),
        r * segments + ((i + 1) % segments),
      );
  return m.build();
}

export function mountainRidgeMesh() {
  const m = new Mesh(),
    n = 44;
  for (let z = 0; z <= n; z++)
    for (let x = 0; x <= n; x++) {
      const X = (x / n) * 2 - 1,
        Z = (z / n) * 2 - 1;
      const edge = Math.max(0, 1 - Math.max(Math.abs(X), Math.abs(Z)));
      const peaks = 0.25 + 0.9 * fbm(X * 2.2 + 12, 4, Z * 2.8 + 8, 4);
      const ridge = Math.pow(
        Math.max(0, 1 - Math.abs(Z + 0.2 * Math.sin(X * 5))),
        1.7,
      );
      m.v(X, Math.pow(edge, 0.6) * peaks * ridge, Z);
    }
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x;
      m.quad(a, a + n + 1, a + n + 2, a + 1);
    }
  return m.build();
}
