// Adapted from Abyssal Garden (MIT), Maksymilian Dendura, commit a596354.
// Only reusable noise/quaternion/mesh helpers are retained; world constants are deliberately excluded.
const {
  sin,
  cos,
  sqrt,
  min,
  max,
  abs,
  floor,
  PI,
  pow,
  atan2,
  hypot,
  exp,
  round,
} = Math;
const TAU = PI * 2;
let _seed = 20261110;
const rnd = () => {
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rr = (a, b) => a + (b - a) * rnd();
// each generator system starts its own random stream, so the systems stay independent
const rseed = (s) => {
  _seed = (20261110 + Math.imul(s, 7919)) | 0;
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  x = clamp((x - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};

const ihash = (x, y, z) => {
  let h =
    (Math.imul(x, 374761393) +
      Math.imul(y, 668265263) +
      Math.imul(z, 1274126177)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const vnoise = (x, y, z) => {
  const ix = floor(x),
    iy = floor(y),
    iz = floor(z);
  let fx = x - ix,
    fy = y - iy,
    fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const a = mix(
    mix(ihash(ix, iy, iz), ihash(ix + 1, iy, iz), fx),
    mix(ihash(ix, iy + 1, iz), ihash(ix + 1, iy + 1, iz), fx),
    fy,
  );
  const b = mix(
    mix(ihash(ix, iy, iz + 1), ihash(ix + 1, iy, iz + 1), fx),
    mix(ihash(ix, iy + 1, iz + 1), ihash(ix + 1, iy + 1, iz + 1), fx),
    fy,
  );
  return mix(a, b, fz);
};
const fbm = (x, y, z, o = 4) => {
  let a = 0.5,
    s = 0;
  for (let i = 0; i < o; i++) {
    s += a * vnoise(x, y, z);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 31.7;
    z = z * 2.03 + 5.3;
    a *= 0.5;
  }
  return s / (1 - 2 * a);
};

// quaternion helpers (return plain arrays; load-time only)
const qAxis = (x, y, z, a) => {
  const l = hypot(x, y, z) || 1,
    s = sin(a / 2) / l;
  return [x * s, y * s, z * s, cos(a / 2)];
};
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qRand = () => {
  const q = [rr(-1, 1), rr(-1, 1), rr(-1, 1), rr(-1, 1)];
  const l = hypot(...q) || 1;
  return q.map((v) => v / l);
};
// shortest rotation taking +Y to n
const qFromY = (nx, ny, nz) => {
  if (ny < -0.9999) return [1, 0, 0, 0];
  const q = [nz, 0, -nx, 1 + ny];
  const l = hypot(...q);
  return q.map((v) => v / l);
};

// ---------------------------------------------------------------- mesh builder (solid vertex format: f32x3 pos, snorm8x4 normal+aux)
class Mesh {
  constructor() {
    this.p = [];
    this.i = [];
    this.aux = [];
  }
  v(x, y, z, aux = 1) {
    this.p.push(x, y, z);
    this.aux.push(aux);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  quad(a, b, c, d) {
    this.i.push(a, b, c, a, c, d);
  }
  // box-section sweep along a polyline; faces get their own vertices (hard edges)
  sweep(pts, w, h, upFn, caps = true) {
    const rings = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k],
        a = pts[max(k - 1, 0)],
        b = pts[min(k + 1, pts.length - 1)];
      let tx = b[0] - a[0],
        ty = b[1] - a[1],
        tz = b[2] - a[2];
      const tl = hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const u0 = upFn ? upFn(p, k) : [0, 1, 0];
      let sx = u0[1] * tz - u0[2] * ty,
        sy = u0[2] * tx - u0[0] * tz,
        sz = u0[0] * ty - u0[1] * tx;
      const sl = hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const ux = ty * sz - tz * sy,
        uy = tz * sx - tx * sz,
        uz = tx * sy - ty * sx;
      const ww = typeof w === "function" ? w(k) : w,
        hh = typeof h === "function" ? h(k) : h;
      const c = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([e, f]) => [
        p[0] + (sx * e * ww) / 2 + (ux * f * hh) / 2,
        p[1] + (sy * e * ww) / 2 + (uy * f * hh) / 2,
        p[2] + (sz * e * ww) / 2 + (uz * f * hh) / 2,
      ]);
      const r = [];
      for (let s = 0; s < 4; s++) {
        r.push(this.v(...c[s]), this.v(...c[(s + 1) % 4]));
      }
      rings.push(r);
      if (caps && (k === 0 || k === pts.length - 1)) {
        const q = c.map((cc) => this.v(...cc));
        if (k === 0) this.quad(q[0], q[1], q[2], q[3]);
        else this.quad(q[3], q[2], q[1], q[0]);
      }
    }
    for (let k = 0; k < rings.length - 1; k++)
      for (let s = 0; s < 4; s++) {
        const a = rings[k][s * 2],
          b = rings[k][s * 2 + 1],
          c = rings[k + 1][s * 2 + 1],
          d = rings[k + 1][s * 2];
        this.quad(a, d, c, b);
      }
  }
  // round tube along polyline with radius function
  tube(pts, rad, sides = 6, capEnd = true, auxFn = null) {
    const rings = [];
    let ux = 0.31,
      uy = 0.9,
      uz = 0.3;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k],
        a = pts[max(k - 1, 0)],
        b = pts[min(k + 1, pts.length - 1)];
      let tx = b[0] - a[0],
        ty = b[1] - a[1],
        tz = b[2] - a[2];
      const tl = hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      let sx = uy * tz - uz * ty,
        sy = uz * tx - ux * tz,
        sz = ux * ty - uy * tx;
      const sl = hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      ux = ty * sz - tz * sy;
      uy = tz * sx - tx * sz;
      uz = tx * sy - ty * sx;
      const r = typeof rad === "function" ? rad(k) : rad,
        ring = [];
      for (let s = 0; s < sides; s++) {
        const an = (s / sides) * TAU;
        ring.push(
          this.v(
            p[0] + (sx * cos(an) + ux * sin(an)) * r,
            p[1] + (sy * cos(an) + uy * sin(an)) * r,
            p[2] + (sz * cos(an) + uz * sin(an)) * r,
            auxFn ? auxFn(k) : min(1, 0.35 + (0.65 * k) / (pts.length - 1)),
          ),
        );
      }
      rings.push(ring);
    }
    for (let k = 0; k < rings.length - 1; k++)
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        this.quad(rings[k][s], rings[k][s2], rings[k + 1][s2], rings[k + 1][s]);
      }
    if (capEnd) {
      const e = pts[pts.length - 1],
        c = this.v(e[0], e[1], e[2], auxFn ? auxFn(pts.length - 1) : 1);
      const r = rings[rings.length - 1];
      for (let s = 0; s < sides; s++) this.tri(r[s], r[(s + 1) % sides], c);
    }
  }
  // returns {vb: ArrayBuffer, ib: Uint32Array}; normals area-weighted; aux -> normal.w
  build(nrmFn) {
    const n = this.p.length / 3,
      P = this.p,
      I = this.i,
      N = new Float32Array(n * 3);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3,
        b = I[t + 1] * 3,
        c = I[t + 2] * 3;
      const ux = P[b] - P[a],
        uy = P[b + 1] - P[a + 1],
        uz = P[b + 2] - P[a + 2],
        vx = P[c] - P[a],
        vy = P[c + 1] - P[a + 1],
        vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) {
        N[k] += nx;
        N[k + 1] += ny;
        N[k + 2] += nz;
      }
    }
    const vb = new ArrayBuffer(n * 16),
      f = new Float32Array(vb),
      s = new Int8Array(vb);
    for (let k = 0; k < n; k++) {
      let nx = N[k * 3],
        ny = N[k * 3 + 1],
        nz = N[k * 3 + 2];
      if (nrmFn) {
        const q = nrmFn(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], nx, ny, nz);
        nx = q[0];
        ny = q[1];
        nz = q[2];
      }
      const l = hypot(nx, ny, nz) || 1;
      f[k * 4] = P[k * 3];
      f[k * 4 + 1] = P[k * 3 + 1];
      f[k * 4 + 2] = P[k * 3 + 2];
      s[k * 16 + 12] = round((nx / l) * 127);
      s[k * 16 + 13] = round((ny / l) * 127);
      s[k * 16 + 14] = round((nz / l) * 127);
      s[k * 16 + 15] = round(clamp(this.aux[k], -1, 1) * 127);
    }
    return { vb, ib: new Uint32Array(I), nv: n };
  }
}

// icosphere with shared vertices
function icosphere(sub, fn) {
  const m = new Mesh(),
    t = (1 + sqrt(5)) / 2;
  let V = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => {
    const l = hypot(...v);
    return v.map((c) => c / l);
  });
  let F = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let s = 0; s < sub; s++) {
    const cache = new Map(),
      F2 = [];
    const mid = (a, b) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let r = cache.get(key);
      if (r === undefined) {
        const p = [0, 1, 2].map((k) => V[a][k] + V[b][k]);
        const l = hypot(...p);
        V.push(p.map((c) => c / l));
        r = V.length - 1;
        cache.set(key, r);
      }
      return r;
    };
    for (const [a, b, c] of F) {
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    F = F2;
  }
  for (const v of V) {
    const p = fn ? fn(v[0], v[1], v[2]) : v;
    m.v(p[0], p[1], p[2]);
  }
  for (const f of F) m.tri(f[0], f[1], f[2]);
  return m;
}

export {
  Mesh,
  icosphere,
  rnd,
  rr,
  rseed,
  clamp,
  mix,
  sstep,
  fbm,
  vnoise,
  qAxis,
  qMul,
  qFromY,
};
