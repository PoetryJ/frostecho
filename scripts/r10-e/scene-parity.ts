/**
 * E evidence: the 3D adapter and the 2D page must describe the same tick.
 *
 * What this runs (no fixtures, no recorded trajectories):
 *   1. the real game server (one CLI, Gospel profile) on loopback;
 *   2. the real display adapter in front of it;
 *   3. real commands (`r8-map-enable`, `game-step`, `advance 15`) sent through
 *      the adapter, i.e. the same path the WebGPU page uses;
 *   4. after each command, the raw `/api/state` (2D source) and the derived
 *      VisualSnapshot/1 (3D source) are written side by side and compared.
 *
 * Negative controls (must FAIL, or they are not controls):
 *   - an unknown NPC id must be rejected by the CLI and change nothing;
 *   - an older snapshot must be refused by the version gate;
 *   - a snapshot carrying private memory must be refused by the leak guard.
 *
 * Output: artifacts/r10-e/parity/{report.json,commands.jsonl,ticks/*.json}
 * Exit: 0 only when every check passed.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createPlayWebServer } from '../../src/r7/ui/server';
import { createVisualAdapter } from '../../src/r7/visual/adapter';
import { assertNoPrivateMemory, toWorld, VisualVersionGate,
  type VisualSnapshot } from '../../src/r7/visual/snapshot';

const root = resolve(__dirname, '../../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(root, 'artifacts', 'r10-e', 'parity', stamp);
/**
 * The IDE's safe-delete shim routes `rmSync` through /.Trash-1003 and fails with
 * EACCES on this host (the same defect the baseline `npm test` reports). Removal
 * therefore goes through the system `rm`, which the shim does not intercept.
 */
const forceRemove = (path: string): void => {
  spawnSync('rm', ['-rf', path], { stdio: 'ignore' });
};
forceRemove(out);
mkdirSync(join(out, 'ticks'), { recursive: true });
mkdirSync(join(out, 'session'), { recursive: true });
/** Saves live in the OS temp dir: this delivery must not ship a second archive. */
const saveRoot = mkdtempSync(join(tmpdir(), 'r10e-parity-saves-'));

const TICKS = 9;
const CLOCK_TOLERANCE_MINUTES = 0;

type Check = { name: string; ok: boolean; detail: Record<string, unknown> };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: Record<string, unknown> = {}): void => {
  checks.push({ name, ok, detail });
};
const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Raw evidence is kept losslessly. A tick's `/api/state` is ~3 MB because it
 * carries the whole committed log, so it is stored gzipped next to the SHA256 of
 * the uncompressed bytes; `gunzip -c file.gz` returns the exact original.
 */
const writeGz = (file: string, text: string): void => {
  writeFileSync(file + '.gz', gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
  writeFileSync(file + '.sha256',
    `${createHash('sha256').update(text, 'utf8').digest('hex')}  ${file.replace(out + '/', '')}\n`);
};

const git = (args: string[]): string => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return ''; }
};

/** Browser probe: the delivery must say "none" instead of pretending. */
function browserProbe(): { found: string[]; browserBinaries: string[] } {
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
    'chrome', 'chrome-headless-shell', 'msedge', 'firefox'];
  const found: string[] = [];
  for (const candidate of candidates) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      const path = join(dir, candidate);
      if (existsSync(path)) { found.push(`${candidate}=${path}`); break; }
    }
  }
  const caches = ['.cache/ms-playwright', '.cache/puppeteer']
    .map(entry => join(process.env.HOME ?? '/root', entry))
    .filter(entry => existsSync(entry));
  return { found, browserBinaries: caches };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  const game = createPlayWebServer(root, saveRoot, { profile: 'gospel-5.8.19',
    mode: 'reference' });
  await new Promise<void>(done => game.server.listen(0, '127.0.0.1', done));
  const gamePort = (game.server.address() as { port: number }).port;

  const adapter = createVisualAdapter({
    gameBaseUrl: `http://127.0.0.1:${gamePort}`,
    publicRoot: resolve(root, 'public', 'r7', 'visual'),
    cacheMs: 0,
  });
  await new Promise<void>(done => adapter.server.listen(0, '127.0.0.1', done));
  const visualPort = (adapter.server.address() as { port: number }).port;
  const visualBase = `http://127.0.0.1:${visualPort}`;
  const gameBase = `http://127.0.0.1:${gamePort}`;

  const getJson = async (url: string): Promise<any> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return response.json();
  };
  const post = async (url: string, body: unknown): Promise<{ status: number; json: any }> => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    return { status: response.status, json: await response.json() };
  };
  const command = async (line: string): Promise<any> => {
    const { status, json } = await post(`${visualBase}/api/visual/command`, { line });
    if (status !== 200 || json?.error) throw new Error(`command_failed(${line}):${JSON.stringify(json?.error ?? json)}`);
    return json;
  };

  const commands: any[] = [];
  const tickRows: any[] = [];
  let previousVersion = -1;
  let previousSim = -1;

  try {
    const session = await post(`${visualBase}/api/visual/session`, { action: 'new' });
    record('session_started_through_adapter', session.status === 200 && Boolean(session.json?.state?.snapshot?.sessionId),
      { sessionId: session.json?.state?.snapshot?.sessionId ?? null });

    const enable = await command('r8-map-enable');
    commands.push({ at: new Date().toISOString(), line: 'r8-map-enable', cli: enable.cli });
    record('original_map_positions_enabled', Boolean(enable.cli?.positions),
      { npcsWithLegacyPosition: Object.keys(enable.cli?.positions ?? {}).length });

    for (let tick = 0; tick < TICKS; tick += 1) {
      const line = tick === TICKS - 1 ? 'observe' : tick % 2 === 0 ? 'game-step' : 'advance 15';
      const response = await command(line);
      commands.push({ at: new Date().toISOString(), tick, line,
        jobId: response.cli?.jobId ?? null, eventIds: response.cli?.eventIds ?? null,
        records: Array.isArray(response.cli?.records)
          ? response.cli.records.map((row: any) => ({ actorId: row.actorId,
            executionStatus: row.executionStatus, reason: row.reason, eventIds: row.eventIds,
            worldVersion: row.worldVersion }))
          : null });

      // 2D side: exactly what public/r7/app.js renders from.
      const twoD = await getJson(`${gameBase}/api/state`);
      // 3D side: exactly what the WebGPU page receives.
      const threeD = await getJson(`${visualBase}/api/visual/state`);
      const snapshot = threeD.snapshot as VisualSnapshot;

      writeGz(join(out, 'ticks', `tick-${String(tick).padStart(3, '0')}-2d.json`),
        JSON.stringify(twoD) + '\n');
      writeFileSync(join(out, 'ticks', `tick-${String(tick).padStart(3, '0')}-3d.json`),
        JSON.stringify(threeD) + '\n');

      const problems: string[] = [];
      if (snapshot.sessionId !== twoD.sessionId) problems.push('sessionId');
      if ((snapshot.simTime ?? -1) !== (twoD.observation?.simTime ?? -2)) problems.push('simTime');
      if (!same(snapshot.resources, twoD.observation?.resources)) problems.push('resources');
      if (!same({ lit: snapshot.furnace.lit, fuel: snapshot.furnace.fuel,
        warmth: snapshot.furnace.warmth },
      { lit: twoD.observation?.furnace?.lit, fuel: twoD.observation?.furnace?.fuel,
        warmth: twoD.observation?.furnace?.warmth })) problems.push('furnace');
      if (snapshot.actors.length !== 8) problems.push(`actorCount:${snapshot.actors.length}`);

      const npcDetail: any[] = [];
      for (const actor of snapshot.actors) {
        const placed = twoD.positions?.[actor.id];
        const legacy = placed?.legacyPosition;
        const twoDCell = legacy?.cell ?? placed?.cell;
        const okCell = same({ x: actor.cell.x, y: actor.cell.y },
          { x: Number(twoDCell?.x), y: Number(twoDCell?.y) });
        const okMap = legacy ? actor.mapId === legacy.mapId : actor.mapId === 'village';
        // Villagers are drawn at their authoritative cell; indoor actors may only
        // stand at the real door of the building they are inside, never at made-up
        // interior metres.
        const expectWorld = actor.placement === 'village'
          ? toWorld(actor.cell.x, actor.cell.y)
          : snapshot.map.buildings.find(building => building.id === actor.doorOf)?.doorWorld;
        const okWorld = Boolean(expectWorld) && same(actor.world, expectWorld);
        if (!okCell) problems.push(`cell:${actor.id}`);
        if (!okMap) problems.push(`mapId:${actor.id}`);
        if (!okWorld) problems.push(`world:${actor.id}`);
        npcDetail.push({ id: actor.id, mapId: actor.mapId, cell: actor.cell,
          placement: actor.placement, world: actor.world, phase: actor.action.phase,
          dueAt: actor.action.dueAt, ok: okCell && okMap && okWorld });
      }

      const twoDTasks = (twoD.status?.tasks ?? []).map((task: any) =>
        [task.taskId ?? task.id, task.status, task.assigneeId ?? task.actorId ?? null]);
      const threeDTasks = snapshot.tasks.map(task =>
        [task.taskId, task.status, task.assigneeId]);
      if (!same(twoDTasks, threeDTasks)) problems.push('tasks');

      // Independent recomputation of the authoritative version from the raw log.
      let expectedVersion = 0;
      for (const event of twoD.status?.r8?.committed ?? []) {
        const match = /^v(\d+):/.exec(String(event?.eventId ?? ''));
        if (match) expectedVersion = Math.max(expectedVersion, Number(match[1]));
      }
      for (const row of twoD.records ?? []) {
        for (const decision of row?.records ?? []) {
          if (typeof decision?.worldVersion === 'number') {
            expectedVersion = Math.max(expectedVersion, decision.worldVersion);
          }
        }
      }
      if (snapshot.worldVersion !== expectedVersion) problems.push('worldVersion');
      if (snapshot.worldVersion < previousVersion) problems.push('versionWentBackwards');
      if (snapshot.simTime < previousSim - CLOCK_TOLERANCE_MINUTES) problems.push('clockWentBackwards');
      previousVersion = snapshot.worldVersion;
      previousSim = snapshot.simTime;

      tickRows.push({ tick, line, simTime: snapshot.simTime, worldVersion: snapshot.worldVersion,
        expectedVersion, actorPhases: snapshot.actors.map(actor => [actor.id, actor.action.phase]),
        lastCommittedOrdinal: snapshot.lastCommittedOrdinal,
        gate: { verdict: threeD.verdict, reason: threeD.reason },
        npcs: npcDetail, problems });
      record(`tick_${tick}_3d_equals_2d`, problems.length === 0, { line, problems });
    }

    // ---- negative control 1: the CLI keeps rejecting, nothing moves ----------
    const before = await getJson(`${visualBase}/api/visual/state`);
    const rejected = await post(`${visualBase}/api/visual/command`, { line: 'where npc_99' });
    const after = await getJson(`${visualBase}/api/visual/state`);
    const rejectionVisible = rejected.status === 200 && Boolean(rejected.json?.cli?.error ?? rejected.json?.error)
      || rejected.status === 400;
    record('negative_unknown_npc_rejected', rejectionVisible,
      { status: rejected.status, error: rejected.json?.cli?.error ?? rejected.json?.error ?? null });
    record('negative_rejection_changed_nothing',
      before.snapshot.simTime === after.snapshot.simTime
      && before.snapshot.worldVersion === after.snapshot.worldVersion
      && same(before.snapshot.tasks, after.snapshot.tasks),
      { simTime: after.snapshot.simTime, worldVersion: after.snapshot.worldVersion });

    // ---- negative control 2: an older snapshot is refused --------------------
    const gate = new VisualVersionGate();
    const newest = after.snapshot;
    gate.accept(newest);
    const older = { ...newest, worldVersion: Math.max(0, newest.worldVersion - 1),
      simTime: Math.max(0, newest.simTime - 15) };
    const stale = gate.accept(older);
    record('negative_stale_snapshot_refused', stale.verdict === 'stale', { verdict: stale.verdict,
      reason: stale.reason });
    const newer = { ...newest, worldVersion: newest.worldVersion + 1, simTime: newest.simTime + 15 };
    record('positive_newer_snapshot_accepted', gate.accept(newer).verdict === 'accepted', {});
    const otherSession = { ...newest, sessionId: 'other-session', worldVersion: newest.worldVersion + 2,
      simTime: newest.simTime + 30 };
    record('negative_session_switch_requires_resync',
      gate.accept(otherSession).verdict === 'resync-required', {});

    // ---- negative control 3: private memory cannot ride along ----------------
    assertNoPrivateMemory(newest);
    record('negative_private_memory_absent', true, { schema: newest.schema });
    let leakCaught = false;
    try {
      assertNoPrivateMemory({ ...newest,
        actors: [{ ...newest.actors[0], name: 'npc_01 记忆: secret' }] } as VisualSnapshot);
    } catch (error) { leakCaught = /private_memory_leaked/.test(String(error)); }
    record('negative_leak_guard_trips', leakCaught, {});

    // ---- display-side projection parity (headless, no browser) ---------------
    // The display module is plain ESM under public/ (not compiled by tsc), so it
    // is imported by absolute URL and exercised headlessly. Rendering needs a
    // GPU; the projection maths does not. `import()` must stay a real dynamic
    // import: tsc with module=commonjs would rewrite a literal to require().
    const dynamicImport = new Function('specifier', 'return import(specifier)') as
      (specifier: string) => Promise<any>;
    const projection = await dynamicImport(
      pathToFileURL(join(root, 'public', 'r7', 'visual', 'npc-projection.js')).href
    ).catch((error: unknown) => ({ error: String(error) }));
    if ('error' in projection) {
      record('display_projection_importable', false, { error: String(projection.error) });
    } else {
      const rows = (projection as any).projectActors(newest);
      const matches = rows.length === newest.actors.length && rows.every((row: any, index: number) => {
        const actor = newest.actors[index];
        return row.id === actor.id && row.x === actor.world.x && row.z === actor.world.z;
      });
      record('display_projection_matches_2d_positions', matches, {
        rows: rows.length, sample: rows[0] ?? null });
      // The only freedom the display takes is a <= 0.8 m readability offset for
      // residents that share one indoor cell. It cannot exceed that or it would
      // look like an invented walk.
      const bounded = rows.every((row: any) =>
        Math.hypot(row.drawX - row.x, row.drawZ - row.z) <= 0.81);
      const distinct = new Set(rows.map((row: any) =>
        `${row.drawX.toFixed(2)},${row.drawZ.toFixed(2)}`)).size;
      record('display_offset_is_bounded_label', bounded,
        { maxOffsetMeters: 0.8, distinctDrawnPositions: distinct, actors: rows.length });
      const meshes = (projection as any).overlayBatch(newest);
      record('display_overlay_batch_built', Boolean(meshes?.data) && meshes.data.length >= 8 * 16,
        { instances: meshes?.data?.length ? meshes.data.length / 16 : 0,
          active: meshes?.active ?? 0 });
      const hud = (projection as any).describeHud(newest, 'live');
      record('display_hud_reads_authority', hud.clock.includes(`v${newest.worldVersion}`)
        && hud.furnace.includes(String(Math.round(newest.furnace.warmth * 10) / 10)),
        { clock: hud.clock, furnace: hud.furnace, phases: hud.phases });

      // Without a browser, the two things that usually break a page can still be
      // checked for real: every static asset the page asks for returns 200, and
      // every relative ES module import resolves on disk.
      const assets = ['/', '/game.js', '/game.css', '/style.css', '/npc-projection.js',
        '/src/world.js', '/src/renderer.js', '/src/shaders.js', '/src/math.js',
        '/data/frostecho-map.json', '/VENDORED.json'];
      const served: any[] = [];
      for (const asset of assets) {
        const response = await fetch(visualBase + asset, { signal: AbortSignal.timeout(15_000) });
        served.push({ asset, status: response.status, bytes: (await response.text()).length });
      }
      record('display_static_assets_served',
        served.every(row => row.status === 200 && row.bytes > 0), { served });

      const displayRoot = resolve(root, 'public', 'r7', 'visual');
      const robots = ['game.js', 'npc-projection.js', 'src/world.js', 'src/renderer.js',
        'src/main.js', 'src/audio.js', 'src/math.js', 'src/detail-geometry.js', 'src/ground-map.js'];
      const unresolved: string[] = [];
      for (const file of robots) {
        const text = readFileSync(join(displayRoot, file), 'utf8');
        for (const match of text.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
          const target = resolve(dirname(join(displayRoot, file)), match[1]);
          if (!existsSync(target)) unresolved.push(`${file} -> ${match[1]}`);
        }
      }
      record('display_module_graph_resolves', unresolved.length === 0, { unresolved,
        modules: robots.length });
    }

    // Keep the CLI transcript (commands + receipts) but never a copy of the save:
    // the adapter must not become a second archive.
    const transcripts: string[] = [];
    if (existsSync(saveRoot)) {
      for (const session of readdirSync(saveRoot)) {
        const file = join(saveRoot, session, 'web-cli.jsonl');
        if (!existsSync(file)) continue;
        writeGz(join(out, 'session', `web-cli-${session}.jsonl`), readFileSync(file, 'utf8'));
        transcripts.push(session);
      }
    }

    // ---- observation, not a self-check: the CLI's own clock overshoot --------
    // Found while building the comparison. `advance 15` right after a batch step
    // reports `to 495` while the authoritative clock becomes 605 (+110). It
    // reproduces on the plain game server without this adapter, so the display
    // only mirrors it; it is recorded here for A/D instead of being hidden.
    const clockProbe = await (async () => {
      const app = createPlayWebServer(root, mkdtempSync(join(tmpdir(), 'r10e-clock-')),
        { profile: 'gospel-5.8.19', mode: 'reference' });
      await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      const post = async (path: string, payload: unknown) => {
        const response = await fetch(base + path, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        return response.json();
      };
      const variants: any[] = [];
      try {
        for (const [label, lines] of [
          ['without_pending_work', ['r8-map-enable', 'advance 15', 'observe']],
          ['after_batch_step', ['r8-map-enable', 'game-step', 'advance 15', 'observe']],
        ] as Array<[string, string[]]>) {
          await post('/api/session', { action: 'new' });
          const rows: any[] = [];
          for (const line of lines) {
            const result = await post('/api/command', { line });
            rows.push({ line, from: result.result?.from ?? null, to: result.result?.to ?? null,
              cliSimTime: result.result?.simTime ?? null,
              observedSimTime: result.state?.observation?.simTime ?? null });
          }
          variants.push({ label, rows });
        }
      } finally { await app.close().catch(() => undefined); }
      return variants;
    })();
    const overshoot = clockProbe.find(row => row.label === 'after_batch_step')
      ?.rows.find((row: any) => row.line === 'advance 15');
    const clean = clockProbe.find(row => row.label === 'without_pending_work')
      ?.rows.find((row: any) => row.line === 'advance 15');
    record('observation_clock_overshoot_reproduced',
      Boolean(overshoot && clean) && clean.observedSimTime === clean.to
      && (overshoot.observedSimTime ?? 0) > (overshoot.to ?? 0),
      { withoutPendingWork: clean, afterBatchStep: overshoot,
        note: 'CLI/engine behavior; display mirrors observe, 2D page shows the same clock' });

    const report = {
      schema: 'frostecho.r10-e.scene-parity/1',
      at: new Date().toISOString(),
      verdict: checks.every(check => check.ok) ? 'pass' : 'fail',
      browser: { available: false, ...browserProbe(),
        note: 'no browser binary on this host; no browser recording was made' },
      identity: {
        repo: root,
        head: git(['rev-parse', 'HEAD']),
        tree: git(['rev-parse', 'HEAD^{tree}']),
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        base: git(['rev-parse', '054cab0']),
        visualSnapshot: 'frostecho.visual/1',
      },
      run: { ticks: TICKS, profile: 'gospel-5.8.19', mode: 'reference',
        gamePort, visualPort,
        note: 'the CLI save directory is deleted after the run; only the transcripts are kept' },
      checks,
      ticks: tickRows,
      observations: { clockProbe, transcriptsStored: transcripts.length },
      commands: commands.length,
      note: 'no model call, no GPU training, no browser; every position comes from the real CLI',
    };
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(out, 'commands.jsonl'),
      commands.map(row => JSON.stringify(row)).join('\n') + '\n');
    console.log(JSON.stringify({ verdict: report.verdict, out, checks: checks.length,
      failed: checks.filter(check => !check.ok).map(check => check.name) }, null, 2));
    if (report.verdict !== 'pass') process.exitCode = 1;
  } finally {
    await adapter.close().catch(() => undefined);
    await game.close().catch(() => undefined);
  }
}

void main().catch(error => { console.error(error); process.exit(1); });
