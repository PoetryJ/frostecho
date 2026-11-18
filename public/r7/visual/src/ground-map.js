// Decorative compacted snow and footsteps. Navigation still uses the original FrostEcho grid.
export function groundDetailMap(roadCells, toWorld, approach) {
  const size = 1024,
    span = 220,
    data = new Uint8Array(size * size * 4),
    texels = size / span;
  function stamp(x, z, rx, rz, channel, strength, angle = 0) {
    const px = (x / span + 0.5) * size,
      pz = (z / span + 0.5) * size,
      r = Math.ceil(Math.max(rx, rz) * texels) + 1,
      c = Math.cos(angle),
      s = Math.sin(angle);
    for (
      let y = Math.max(0, Math.floor(pz - r));
      y < Math.min(size, Math.ceil(pz + r));
      y++
    )
      for (
        let k = Math.max(0, Math.floor(px - r));
        k < Math.min(size, Math.ceil(px + r));
        k++
      ) {
        const dx = (k + 0.5 - px) / texels,
          dz = (y + 0.5 - pz) / texels,
          u = (c * dx + s * dz) / rx,
          v = (-s * dx + c * dz) / rz,
          q = u * u + v * v;
        if (q >= 1) continue;
        const a = (1 - q) * (1 - q) * strength * 255,
          index = (k + y * size) * 4 + channel;
        data[index] = Math.max(data[index], a);
      }
  }
  let foot = 0;
  for (const cell of roadCells) {
    const [x, y] = cell.split(",").map(Number),
      [X, Z] = toWorld(x + 0.5, y + 0.5);
    stamp(X, Z, 1.85, 1.85, 0, 0.8);
    stamp(X + (foot % 2 ? 0.23 : -0.23), Z, 0.17, 0.37, 1, 0.65);
    foot++;
  }
  // A softly worn approach beyond the south gate belongs to this visual scene, not the source map.
  for (let i = 0; i < approach.length - 1; i++) {
    const a = approach[i],
      b = approach[i + 1],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz),
      angle = Math.atan2(dz, dx);
    for (let d = 0; d < length; d += 0.55) {
      const t = d / length,
        x = a[0] + dx * t,
        z = a[1] + dz * t;
      stamp(x, z, 1.6, 1.6, 0, 0.7);
      const side = foot++ % 2 ? 0.22 : -0.22;
      stamp(
        x - (dz / length) * side,
        z + (dx / length) * side,
        0.34,
        0.16,
        1,
        0.78,
        angle,
      );
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { size, span, data };
}
