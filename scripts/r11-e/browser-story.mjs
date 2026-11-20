/**
 * E (R11) real-browser acceptance.
 *
 * One Chrome tab plays the shipped page. Every action is a click on the page,
 * which posts one line to the existing CLI. The run:
 *   1. takes the remaining 4 warehouse meals out through 李婶's real route,
 *   2. asks 王策 to promise a meal, walks him into the warehouse along the
 *      original map, discovers the shortage, agrees to the new source,
 *      gathers and deposits,
 *   3. saves at D2 with the promise still in flight, kills the game service,
 *      starts a NEW process, continues, withdraws and delivers the meal,
 *   4. advances to D4 and shows the crisis + final receipt,
 *   5. compares the 3D and 2D pages reading the same VisualSnapshot/1.
 *
 * Evidence: report.json, operations.jsonl, screenshots/, video/, anchors-*.json,
 * SHA256SUMS.txt. Failures are recorded, not smoothed over.
 *
 *   node scripts/r11-e/browser-story.mjs [--out artifacts/r11-e/browser]
 *        [--port 18780] [--timeout-ms 240000]
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const root = resolve(__dirname, '../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let out = resolve(arg('--out', join(root, 'artifacts', 'r11-e', 'browser')));
// The IDE safe-delete shim cannot move files to /.Trash-1003 on this host, so a
// rerun never deletes an older evidence directory: it writes a sibling instead.
if (existsSync(out) && readdirSync(out).length > 0) out = `${out}-${stamp}`;
// 0 lets the OS pick a free loopback port; the server prints the real URL.
const port = Number(arg('--port', 0));
const timeoutMs = Number(arg('--timeout-ms', 240_000));
const saves = join(out, 'saves');
const shotDir = join(out, 'screenshots');
const videoDir = join(out, 'video');
for (const dir of [out, saves, shotDir, videoDir]) mkdirSync(dir, { recursive: true });

const playwrightPath = process.env.FROSTECHO_PLAYWRIGHT
  ?? '/data/home/user_00/frostecho-r7/tools/node_modules/playwright';
if (!existsSync(playwrightPath)) {
  console.error(`playwright not found at ${playwrightPath}; set FROSTECHO_PLAYWRIGHT`);
  process.exit(2);
}
const requireFrom = createRequire(import.meta.url);
const { chromium } = requireFrom(playwrightPath);

const atSpi = '/data/home/user_00/frostecho-r7/browser/root/usr/lib64';
if (existsSync(atSpi)) process.env.LD_LIBRARY_PATH = [atSpi, process.env.LD_LIBRARY_PATH]
  .filter(Boolean).join(':');
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ??= '1';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/data/home/user_00/.cache/ms-playwright';

const git = (command) => {
  try { return execSync(`git ${command}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim() || null; } catch { return null; }
};

const report = {
  schema: 'frostecho.r11-e.browser-story/1',
  source: { commit: git('rev-parse HEAD'), tree: git('rev-parse HEAD^{tree}'),
    dirty: Boolean(git('status --porcelain --untracked-files=no')),
    dirtyFiles: (git('status --porcelain --untracked-files=no') ?? '').split('\n').filter(Boolean).slice(0, 40) },
  stamp, out, startedAt: new Date().toISOString(),
  url: null, port, saves,
  servers: [], pids: [], browser: null, webgpu: null,
  profile: null, mode: null, runner: null, scorer: null,
  steps: [], assertions: [], operations: [], failures: [],
  restore: null, frames: null, screenshots: [], video: null,
  anchors: null, rawTranscripts: [],
};
const operations = [];
const assert = (name, ok, detail) => {
  report.assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) report.failures.push(name);
  return Boolean(ok);
};
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const short = (value, n = 40) => value ? String(value).slice(0, n) : '—';

/* ------------------------------------------------------------- server ---- */

let server = null;
let serverLog = '';

function startServer(tag) {
  serverLog = '';
  return new Promise((resolveStart, reject) => {
    const env = { ...process.env, PATH: `/data/home/user_00/.local/node22/bin:${process.env.PATH}` };
    const child = spawn(process.execPath,
      [join('dist', 'scripts', 'r11-e', 'visual-server.js'), '--port', String(port),
        '--saves', saves, '--browser-tag', 'chromium-headless-swiftshader'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`visual server did not start: ${serverLog.slice(-800)}`));
    }, 25_000);
    child.stdout.on('data', (chunk) => {
      serverLog += String(chunk);
      const match = /FROSTECHO_VISUAL_READY (\{.*\})/.exec(serverLog);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        const ready = JSON.parse(match[1]);
        report.url = ready.url;
        report.servers.push({ tag, pid: child.pid, startedAt: new Date().toISOString(),
          url: ready.url, profile: ready.profile, mode: ready.mode, runner: ready.runner, saves: ready.saves });
        report.pids.push(child.pid);
        report.profile = ready.profile;
        report.mode = ready.mode;
        report.runner = ready.runner;
        resolveStart({ child, ready });
      }
    });
    child.stderr.on('data', (chunk) => { serverLog += String(chunk); });
    child.once('exit', (code, signal) => {
      if (!settled) { clearTimeout(timer); reject(new Error(`server exited ${code ?? signal}: ${serverLog.slice(-500)}`)); }
    });
  });
}

async function stopServer(tag, signal = 'SIGTERM') {
  if (!server?.child) return null;
  const child = server.child;
  const exited = new Promise(resolveExit => child.once('exit', (code, sig) => resolveExit({ code, sig })));
  child.kill(signal);
  const result = await Promise.race([exited, new Promise(resolveWait =>
    setTimeout(() => resolveWait({ timeout: true }), 20_000))]);
  report.servers.at(-1).stoppedAt = new Date().toISOString();
  report.servers.at(-1).signal = signal;
  report.servers.at(-1).exit = result;
  server = null;
  return result;
}

/* --------------------------------------------------------- page helpers --- */

let browser = null;
let context = null;
let page = null;
let consoleErrors = [];
let opsSeen = 0;
let selectedId = null;

async function openPage(label) {
  if (!page || page.isClosed()) {
    page = await context.newPage();
    cdp = null;
    page.on('crash', () => trace('page:crash'));
    page.on('close', () => trace('page:close'));
    page.on('console', (message) => {
      if (["error"].includes(message.type())) consoleErrors.push({ label, text: message.text() });
    });
    page.on('pageerror', (error) => consoleErrors.push({ label, text: `pageerror: ${error.message}` }));
  }
  await page.goto(report.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.frostEcho?.ready === true, null, { timeout: 90_000 });
  return page;
}

async function evalTimed(fn, argValue, ms = 15_000) {
  return Promise.race([
    page.evaluate(fn, argValue),
    new Promise((_, reject) => setTimeout(() => reject(new Error('page_evaluate_timeout')), ms)),
  ]);
}

/** The authority lives in the CLI; a wedged view can be replaced without it. */
async function recoverPage(reason) {
  const entry = { at: new Date().toISOString(), reason };
  report.recoveries ??= [];
  report.recoveries.push(entry);
  trace('page:recover', { reason });
  try { await page?.close(); } catch { /* already gone */ }
  page = null;
  cdp = null;
  opsSeen = 0;
  await openPage('recovered');
  entry.reopened = true;
  if (selectedId) {
    try {
      await page.click(`#hud-npcs li[data-npc="${selectedId}"]`, { timeout: 15_000 });
      entry.reselected = selectedId;
    } catch { entry.reselected = false; }
  }
  return entry;
}

async function waitFor(fn, argValue, label, timeout = timeoutMs) {
  const started = Date.now();
  let last = null, wedged = 0;
  while (Date.now() - started < timeout) {
    try {
      last = await evalTimed(fn, argValue);
      wedged = 0;
      if (last) return last;
    } catch {
      wedged += 1;
      if (wedged >= 3) {
        await recoverPage(`wait-timeout:${label}`).catch(() => {});
        wedged = 0;
      }
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)?.slice(0, 400)}`);
}

const snapshot = () => evalTimed(() => window.frostEcho.snapshot(), null, 30_000);

function fingerprint() {
  return evalTimed(() => {
    const s = window.frostEcho.snapshot();
    if (!s) return null;
    return {
      sessionId: s.sessionId, simTime: s.simTime, day: s.day, worldVersion: s.worldVersion,
      profile: s.profile, mode: s.mode, scorer: s.scorer,
      positions: Object.fromEntries((s.actors ?? []).map(actor =>
        [actor.id, `${actor.mapId}(${actor.cell.x},${actor.cell.y})`])),
      alive: Object.fromEntries((s.actors ?? []).map(actor => [actor.id, actor.alive])),
      tasks: (s.tasks ?? []).map(task => ({ id: task.taskId, type: task.type, status: task.status,
        assignee: task.assigneeId, commitmentId: task.commitmentId })),
      obligations: (s.obligations ?? []).map(row => ({ id: row.commitmentId, goal: row.goal,
        status: row.status, revision: row.revision, taskId: row.taskId,
        evidence: row.evidenceEventIds, changes: row.changes.map(c => `${c.kind}:${c.status}`) })),
      stock: s.stock, resources: s.resources, save: s.save,
      crises: s.crises,
    };
  }, null, 30_000);
}

const trace = (label, extra) => console.log(`[trace] ${new Date().toISOString()} ${label}`,
  extra === undefined ? '' : JSON.stringify(extra)?.slice(0, 300));

async function ensurePageAlive(where) {
  try {
    await evalTimed(() => 1 + 1, null, 5000);
    return false;
  } catch {
    await recoverPage(`unresponsive:${where}`).catch(() => {});
    return true;
  }
}

async function clickButton(label, stepName) {
  trace('click:start', { label, stepName });
  await ensurePageAlive(`click:${label}`);
  const locator = page.locator('#hud-npcs, #task-actions, #commitment-actions, #move-actions, .command-row')
    .locator('button', { hasText: label });
  const count = await locator.count();
  if (count === 0) throw new Error(`button not found: ${label}`);
  let target = locator.first();
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible() && !(await candidate.isDisabled())) { target = candidate; break; }
  }
  if (await target.isDisabled()) throw new Error(`button disabled: ${label}`);
  const expectedLine = await target.getAttribute('data-line');
  const before = await evalTimed(() => window.frostEcho.ops().length);
  let clickMode = 'locator';
  try {
    await target.scrollIntoViewIfNeeded();
    await target.click({ timeout: 15_000 });
  } catch (error) {
    // SwiftShader screenshots can starve the compositor long enough for
    // Playwright's "stable box" check to expire. The page still receives a real
    // mouse press at the button's centre; the mode is recorded as evidence.
    const box = await target.boundingBox();
    if (!box) throw error;
    clickMode = 'mouse';
    try {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } catch {
      clickMode = 'dispatch';
      await target.dispatchEvent('click');
    }
  }
  try {
    await waitFor((n) => window.frostEcho.ops().length > n, before,
      `operation for ${stepName ?? label}`, 60_000);
  } catch (error) {
    await recoverPage(`click-timeout:${label}`);
    const retryBefore = await evalTimed(() => window.frostEcho.ops().length);
    await page.locator('button', { hasText: label }).first().click({ timeout: 15_000 });
    await waitFor((n) => window.frostEcho.ops().length > n, retryBefore,
      `operation retry for ${stepName ?? label}`, 60_000);
  }
  await waitFor((expected) => !expected || window.frostEcho.lastCommand()?.line === expected,
    expectedLine, `authority line ${expectedLine ?? label}`, 30_000).catch(() => {});
  const record = await evalTimed(() => window.frostEcho.lastCommand());
  const fp = await fingerprint();
  if (expectedLine && record?.line !== expectedLine) {
    report.failures.push(`line_mismatch:${stepName ?? label}:${record?.line ?? 'null'}!=${expectedLine}`);
  }
  trace('click:done', { label, line: record?.line, v: record?.worldVersion, t: record?.simTime });
  operations.push({ step: stepName ?? label, label, clickMode, ...record, fingerprint: fp });
  report.operations.push({ step: stepName ?? label, label, clickMode, line: record?.line, ok: record?.ok,
    jobId: record?.jobId, worldVersion: record?.worldVersion, simTime: record?.simTime,
    eventIds: record?.eventIds, commitmentIds: record?.commitmentIds, error: record?.error });
  return record;
}

async function typeCommand(line, stepName) {
  await ensurePageAlive(`type:${stepName ?? line}`);
  const before = await evalTimed(() => window.frostEcho.ops().length);
  try {
    await page.fill('#command', line);
    await page.press('#command', 'Enter');
  } catch {
    await evalTimed((value) => {
      const input = document.getElementById('command');
      input.value = value;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, line);
  }
  try {
    await waitFor((n) => window.frostEcho.ops().length > n, before, `operation for ${stepName ?? line}`, 60_000);
  } catch (error) {
    await recoverPage(`type-timeout:${stepName ?? line}`);
    await page.fill('#command', line);
    await page.press('#command', 'Enter');
    await waitFor((n) => window.frostEcho.ops().length > n, before,
      `operation retry for ${stepName ?? line}`, 60_000);
  }
  const record = await evalTimed(() => window.frostEcho.lastCommand());
  const fp = await fingerprint();
  operations.push({ step: stepName ?? line, label: line, ...record, fingerprint: fp });
  report.operations.push({ step: stepName ?? line, label: line, line: record?.line, ok: record?.ok,
    jobId: record?.jobId, worldVersion: record?.worldVersion, simTime: record?.simTime,
    eventIds: record?.eventIds, commitmentIds: record?.commitmentIds, error: record?.error });
  return record;
}

async function clickActor(id) {
  trace('actor:start', { id });
  await ensurePageAlive(`actor:${id}`);
  await page.click(`#hud-npcs li[data-npc="${id}"]`);
  await waitFor((wanted) => window.frostEcho.selected() === wanted, id, `select ${id}`, 10_000);
  selectedId = id;
  report.steps.push({ name: `select-${id}`, at: new Date().toISOString(),
    selected: true, fingerprint: await fingerprint() });
  trace('actor:done', { id });
}

let cdp = null;

/** The 2D page reads the same snapshot; capture it at the same tick per step. */
async function capture2d(name, expected) {
  const viewer = await context.newPage();
  try {
    await viewer.goto(report.url.replace(/\/$/, '') + '/2d.html', { waitUntil: 'load' });
    await viewer.waitForFunction(() => window.frostEcho2d?.anchors()?.sessionId != null, null,
      { timeout: 20_000 });
    let anchors = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      anchors = await Promise.race([
        viewer.evaluate(() => window.frostEcho2d?.anchors() ?? null),
        new Promise((_, reject) => setTimeout(() => reject(new Error('2d_eval_timeout')), 10_000)),
      ]);
      if (anchors && expected && anchors.worldVersion === expected.worldVersion
        && anchors.simTime === expected.simTime) break;
      await viewer.waitForTimeout(120);
    }
    const path2d = join(shotDir, `${String(report.screenshots.length + 1).padStart(2, '0')}-${name}-2d.png`);
    await viewer.screenshot({ path: path2d, timeout: 20_000 });
    report.screenshots.push({ name: `${name}-2d`, path: path2d.replace(root + '/', ''),
      sha256: sha256(path2d), worldVersion: anchors?.worldVersion ?? null, simTime: anchors?.simTime ?? null });
    report.twoD ??= [];
    report.twoD.push({ name, worldVersion: anchors?.worldVersion ?? null,
      simTime: anchors?.simTime ?? null, expected });
  } finally {
    await viewer.close().catch(() => {});
  }
}

async function shot(name) {
  trace('shot:start', { name });
  const path = join(shotDir, `${String(report.screenshots.length + 1).padStart(2, '0')}-${name}.png`);
  const capture = async () => {
    const health = await evalTimed(() => ({
      errors: window.frostEcho?.errors ?? [],
      loading: document.getElementById('loading')?.className ?? '',
    }), null, 10_000);
    if (health.errors.length > 0 || !/ready/.test(health.loading)) {
      throw new Error(`page_unhealthy:${JSON.stringify(health).slice(0, 160)}`);
    }
    // Freeze GPU submission for the still; the last presented frame stays.
    await evalTimed(() => window.frostEcho.pauseRender(true), null, 5000);
    await page.waitForTimeout(200);
    await page.screenshot({ path, timeout: 45_000 });
  };
  try {
    await capture();
  } catch (first) {
    // One retry on a fresh tab at the same authority state; the 3D surface can
    // stall the compositor once, and the evidence should not lose the step.
    await recoverPage(`screenshot:${name}`).catch(() => {});
    try {
      await capture();
      report.recoveredShots = [...(report.recoveredShots ?? []), { name, first: first.message.split('\n')[0] }];
    } catch (second) {
      report.screenshotFailures ??= [];
      report.screenshotFailures.push({ name, error: second.message.split('\n')[0] });
    }
  } finally {
    try { await evalTimed(() => window.frostEcho.pauseRender(false), null, 5000); } catch { /* page gone */ }
    await ensurePageAlive(`post-shot:${name}`);
  }
  const captured = existsSync(path) && statSync(path).size > 1000;
  if (captured) {
    report.screenshots.push({ name, path: path.replace(root + '/', ''), sha256: sha256(path) });
  }
  try {
    const expected = await evalTimed(() => {
      const s = window.frostEcho.snapshot();
      return s ? { worldVersion: s.worldVersion, simTime: s.simTime } : null;
    }, null, 10_000);
    if (expected) await capture2d(name, expected);
  } catch (error) {
    report.screenshotFailures ??= [];
    report.screenshotFailures.push({ name: `${name}-2d`, error: error.message.split('\n')[0] });
  }
  trace('shot:done', { name, captured });
  return path;
}

const eventsOf = (name) => report.operations
  .filter(row => row.step === name).flatMap(row => row.eventIds ?? []);
const deliverRow = (fp) => (fp?.obligations ?? []).find(row => row.goal === 'deliver-meal') ?? null;
const hasReceipt = (type) => report.operations
  .flatMap(row => row.eventIds ?? []).some(id => String(id).includes(`:${type}:`));

/* -------------------------------------------------------------- story ----- */

async function main() {
  server = await startServer('one');
  browser = await chromium.launch({ headless: true, channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu',
      '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=vulkan',
      '--disable-vulkan-surface', '--force-device-scale-factor=1'] });
  report.browser = { name: 'chromium', version: browser.version() };
  // Continuous screenshots are the evidence here. A Playwright video capture on
  // top of the SwiftShader WebGPU surface repeatedly wedged the page's main
  // thread after a few PNG captures, so no video is claimed.
  context = await browser.newContext({ viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1 });
  await openPage('one');

  const gpu = await evalTimed(() => window.frostEcho.gpu);
  const ua = await evalTimed(() => navigator.userAgent);
  report.webgpu = { userAgent: ua, ...gpu };
  assert('browser_is_real_chromium', /HeadlessChrome|Chrome\//.test(ua), ua);
  assert('webgpu_adapter_present', Boolean(gpu?.adapter), gpu);
  assert('webgpu_adapter_software_swiftshader',
    gpu?.adapter?.architecture === 'swiftshader' || gpu?.adapter?.vendor === 'google',
    gpu?.adapter);

  const initialStats = await evalTimed(() => window.frostEcho.stats());
  assert('webgpu_frame_drawn', initialStats.drawCalls > 0, initialStats);

  // 1. new session
  await clickButton('新游戏', 'new-session');
  await waitFor(() => window.frostEcho.snapshot()?.sessionId != null, null, 'session id', 60_000);
  const start = await fingerprint();
  report.steps.push({ name: 'new-session', at: new Date().toISOString(), fingerprint: start });
  assert('session_starts_day1_0800', start.day === 1 && start.simTime === 480, start.simTime);
  assert('eight_residents_with_positions', Object.keys(start.positions).length === 8, start.positions);
  await clickButton('启用原图', 'enable-original-maps');
  const mapped = await evalTimed(() => window.frostEcho.snapshot()?.actors?.map(actor =>
    `${actor.id}:${actor.mapId}`));
  assert('original_maps_enabled',
    mapped.every(value => /:(village|dorm_a|dorm_b|warehouse|kitchen|medical|workshop|command)$/.test(value))
    && mapped.some(value => /:dorm_/.test(value)), mapped);
  await shot('new-session');

  // 2. 李婶 walks the original map into the warehouse and takes the 4 meals
  await clickActor('npc_01');
  await clickButton('原图进仓', 'li_shen-walks-to-warehouse');
  await waitFor(() => window.frostEcho.snapshot()?.actors?.find(a => a.id === 'npc_01')?.mapId === 'warehouse',
    null, 'npc_01 in warehouse', 120_000);
  const inWarehouse = await fingerprint();
  assert('original_map_route_walked',
    (await evalTimed(() => { const s = window.frostEcho.snapshot();
      const r = (s.routes ?? []).find(row => row.actorId === 'npc_01');
      return r ? { tiles: r.summary.tiles, doors: r.summary.doors, minutes: r.summary.minutes } : null; }))
      ?.doors >= 1, inWarehouse.positions.npc_01);
  await shot('li-shen-in-warehouse');

  await clickButton('取走全部', 'take-all-four-meals');
  const afterWithdraw = await fingerprint();
  assert('warehouse_depleted_to_zero', afterWithdraw.stock?.warehouse?.remaining === 0,
    afterWithdraw.stock?.warehouse);
  assert('withdraw_receipt', (eventsOf('take-all-four-meals') ?? []).length >= 0
    && report.operations.find(row => row.step === 'take-all-four-meals')?.line === 'withdraw npc_01 4',
    report.operations.find(row => row.step === 'take-all-four-meals'));
  await shot('warehouse-empty');

  // 3. 王策 accepts the meal-delivery promise and walks in
  await clickActor('npc_03');
  await clickButton('接取送饭承诺', 'promise-deliver-meal');
  const promised = await fingerprint();
  const promise = promised.obligations.find(row => row.goal === 'deliver-meal');
  assert('promise_active', promise?.status === 'active' && promise?.revision === 1, promise);
  assert('promise_task_linked',
    promised.tasks.some(task => task.commitmentId === promise?.id && task.assignee === 'npc_03'),
    promised.tasks.filter(task => task.assignee === 'npc_03'));
  await shot('promise-accepted');

  await clickButton('原图进仓', 'wangce-walks-to-warehouse');
  await waitFor(() => window.frostEcho.snapshot()?.actors?.find(a => a.id === 'npc_03')?.mapId === 'warehouse',
    null, 'npc_03 in warehouse', 120_000);
  const walked = await evalTimed(() => { const s = window.frostEcho.snapshot();
    const r = (s.routes ?? []).find(row => row.actorId === 'npc_03');
    return r ? { ...r.summary, legs: r.legs.slice(0, 4).map(l => `${l.fromMap}(${l.from.x},${l.from.y})->${l.toMap}(${l.to.x},${l.to.y})`) } : null; });
  assert('promisor_walked_original_route', walked?.tiles > 0 && walked?.doors >= 1, walked);
  report.steps.push({ name: 'promisor-route', at: new Date().toISOString(), route: walked,
    fingerprint: await fingerprint() });
  await shot('promisor-in-warehouse');

  await clickButton('核实库存', 'inspect-empty-warehouse');
  const observed = await fingerprint();
  assert('shortage_seen_by_promisor', observed.stock?.warehouse?.remaining === 0
    && ['warehouse_stock_observed', 'out_of_stock'].includes(observed.stock?.warehouse?.source),
    observed.stock?.warehouse);
  await shot('shortage-observed');

  // 4. discover -> propose -> player agrees to the new source
  await clickButton('让他决定', 'discover-shortage');
  await waitFor(() => window.frostEcho.snapshot()?.obligations?.[0]?.status === 'pending-change',
    null, 'pending-change', 120_000);
  const pending = await fingerprint();
  const change = pending.obligations[0].changes[0];
  assert('alt_source_proposed', pending.obligations[0].status === 'pending-change'
    && change === 'alt-source:open', change);
  await shot('pending-change');

  await clickButton('同意改源', 'player-accepts-change');
  const accepted = await fingerprint();
  assert('player_accepted_change', accepted.obligations[0].status === 'active'
    && accepted.obligations[0].revision === 2
    && accepted.obligations[0].changes.includes('alt-source:accepted'), accepted.obligations[0]);
  await shot('change-accepted');

  // 5. gather + deposit (still in flight), then D2 save
  const receipts = [];
  for (let round = 0; round < 8; round += 1) {
    const before = await evalTimed(() => window.frostEcho.snapshot()?.simTime);
    await clickButton('让他决定', `promisor-step-${round}`);
    const hasWork = await evalTimed(() => (window.frostEcho.snapshot()?.work ?? [])
      .some(entry => entry.actorId === 'npc_03' && entry.endsAt));
    if (hasWork) await clickButton('等到当前工时', `promisor-wait-${round}`);
    const fp = await fingerprint();
    const recent = (await evalTimed(() => window.frostEcho.snapshot()?.recentEvents ?? []))
      .map(event => event.type);
    receipts.push(...recent.filter(type => ['gathered', 'stock_deposited', 'out_of_stock',
      'warehouse_stock_observed', 'stock_withdrawn', 'meal_delivered'].includes(type)));
    if (hasReceipt('stock_deposited') && recent.includes('stock_deposited')) break;
    if (deliverRow(fp)?.status === 'fulfilled') break;
    if (fp.simTime === before && !hasWork) break;
  }
  const deposited = await fingerprint();
  assert('gathered_by_promisor', receipts.includes('gathered') || hasReceipt('gathered'),
    { receipts, opEvents: report.operations.flatMap(row => row.eventIds ?? []).slice(-6) });
  assert('stock_deposited_by_promisor', receipts.includes('stock_deposited')
    || hasReceipt('stock_deposited'), receipts);
  assert('promise_still_in_flight_before_save', deliverRow(deposited)?.status === 'active',
    deliverRow(deposited));
  await shot('deposited-in-flight');

  // 6. advance to D2 08:00 with the promise in flight, then save
  const gap = 1920 - (await evalTimed(() => window.frostEcho.snapshot()?.simTime));
  if (gap > 0) await typeCommand(`advance ${gap}`, 'advance-to-d2-0800');
  const atD2 = await fingerprint();
  assert('save_point_is_day2', atD2.day === 2, { day: atD2.day, simTime: atD2.simTime });
  assert('save_point_promise_in_flight', deliverRow(atD2)?.status === 'active', deliverRow(atD2));
  assert('save_point_position_warehouse', atD2.positions.npc_03.startsWith('warehouse'),
    atD2.positions.npc_03);
  await clickButton('保存', 'save-at-d2');
  const saved = await fingerprint();
  assert('save_written', Boolean(saved.save?.savedAt), saved.save);
  await shot('d2-saved');

  // 3D anchors at the save point
  const anchors3d = await evalTimed(() => window.frostEcho.anchors());
  writeFileSync(join(out, 'anchors-3d.json'), `${JSON.stringify(anchors3d, null, 2)}\n`);

  // 7. kill the game service, start a new process, restore in a fresh tab
  const firstPid = report.pids[0];
  const exit = await stopServer('one', 'SIGTERM');
  assert('service_stopped', !exit?.timeout, exit);
  await page.close();
  page = null;
  cdp = null;
  server = await startServer('two');
  assert('new_process_pid', report.pids[1] !== firstPid, { firstPid, secondPid: report.pids[1] });
  page = await openPage('two');
  await clickButton('继续存档', 'continue-saved-session');
  await waitFor((expected) => window.frostEcho.snapshot()?.sessionId === expected, saved.sessionId,
    'restored session', 60_000);
  const restored = await fingerprint();
  const identityKeys = ['sessionId', 'simTime', 'day', 'positions', 'alive', 'tasks', 'obligations',
    'stock', 'scorer'];
  const restoredEqual = identityKeys.every(key => JSON.stringify(restored[key])
    === JSON.stringify(saved[key]));
  report.restore = { before: saved, after: restored, equal: restoredEqual,
    compared: identityKeys.filter(key => JSON.stringify(restored[key]) === JSON.stringify(saved[key])) };
  assert('restore_same_task_commitment_position', restoredEqual,
    identityKeys.filter(key => JSON.stringify(restored[key]) !== JSON.stringify(saved[key])));
  // A new tab has no local selection; the player picks the same resident again.
  await clickActor('npc_03');
  await shot('restored-d2');

  // 8. finish: withdraw + deliver through the same page
  const afterRestoreReceipts = [];
  for (let round = 0; round < 8; round += 1) {
    await clickButton('让他决定', `continue-step-${round}`);
    const hasWork = await evalTimed(() => (window.frostEcho.snapshot()?.work ?? [])
      .some(entry => entry.actorId === 'npc_03' && entry.endsAt));
    if (hasWork) await clickButton('等到当前工时', `continue-wait-${round}`);
    const recent = (await evalTimed(() => window.frostEcho.snapshot()?.recentEvents ?? []))
      .map(event => event.type);
    afterRestoreReceipts.push(...recent.filter(type => ['stock_withdrawn', 'meal_delivered'].includes(type)));
    const fp = await fingerprint();
    if (deliverRow(fp)?.status === 'fulfilled') break;
  }
  const fulfilled = await fingerprint();
  const row = deliverRow(fulfilled);
  assert('withdrawn_after_restore', afterRestoreReceipts.includes('stock_withdrawn')
    || hasReceipt('stock_withdrawn'), afterRestoreReceipts);
  assert('meal_delivered_after_restore', afterRestoreReceipts.includes('meal_delivered')
    || hasReceipt('meal_delivered'), afterRestoreReceipts);
  assert('promise_fulfilled_with_receipt', row?.status === 'fulfilled'
    && row.evidence.some(id => id.includes(':meal_delivered:')), row);
  await shot('meal-delivered');

  // 9. D4 crisis and final state
  // 4320 is D4 00:00; the broadcast is settled on the first span after it, so
  // the player advances to the original 08:00 morning, not one minute before.
  const toD4 = 4800 - (await evalTimed(() => window.frostEcho.snapshot()?.simTime));
  if (toD4 > 0) await typeCommand(`advance ${toD4}`, 'advance-to-day4-0800');
  const d4 = await fingerprint();
  const crisis = d4.crises?.active?.map(entry => entry.kind) ?? [];
  assert('day4_reached', d4.day === 4, { day: d4.day, simTime: d4.simTime });
  assert('day4_crisis_visible', crisis.includes('day4_warning'), crisis);
  assert('final_receipt_still_visible', deliverRow(d4)?.status === 'fulfilled', deliverRow(d4));
  // Measure the live 3D page BEFORE the last still: a still can occasionally
  // stall the SwiftShader compositor, and the measurement must not depend on it.
  await ensurePageAlive('d4-measure');
  const anchors3dLate = await evalTimed(() => window.frostEcho.anchors(), null, 30_000);
  writeFileSync(join(out, 'anchors-3d.json'), `${JSON.stringify(anchors3dLate, null, 2)}\n`);
  const measure = () => evalTimed(() => new Promise((done) => {
    const samples = [];
    let previous = performance.now();
    const tick = (now) => {
      samples.push(now - previous);
      previous = now;
      if (samples.length >= 120) {
        const sorted = [...samples].sort((a, b) => a - b);
        done({ samples: samples.length, p50: sorted[Math.floor(samples.length * 0.5)],
          p95: sorted[Math.floor(samples.length * 0.95)], max: sorted.at(-1),
          min: sorted[0] });
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), null, 120_000);
  let frames = null;
  try { frames = await measure(); } catch {
    await recoverPage('frames');
    try { frames = await measure(); } catch { frames = null; }
  }
  assert('frames_measured', Boolean(frames) && frames.p50 > 0 && frames.samples >= 60, frames);
  let stats = null, telemetry = null;
  try {
    stats = await evalTimed(() => window.frostEcho.stats());
    telemetry = await page.textContent('#telemetry');
  } catch {
    await recoverPage('stats');
    try {
      stats = await evalTimed(() => window.frostEcho.stats());
      telemetry = await page.textContent('#telemetry');
    } catch { stats = null; }
  }
  report.frames = { raf: frames, renderer: stats ? { drawCalls: stats.drawCalls, gpuMs: stats.gpuMs,
    timed: stats.gpuTimestamp, width: stats.width, height: stats.height } : null, telemetry };
  assert('gpu_timer_or_honest_fallback', Boolean(stats)
    && (stats.gpuTimestamp || /GPU 计时不可用/.test(telemetry ?? '')),
    { timed: stats?.gpuTimestamp ?? null, telemetry });
  await shot('day4');

  // 10. 2D page reads the same snapshot at the same tick
  const page2d = await context.newPage();
  page2d.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push({ label: '2d', text: message.text() });
  });
  page2d.on('pageerror', (error) => consoleErrors.push({ label: '2d', text: `pageerror: ${error.message}` }));
  await page2d.goto(report.url.replace(/\/$/, '') + '/2d.html', { waitUntil: 'load' });
  let anchors2d = null;
  try {
    await page2d.waitForFunction(() => window.frostEcho2d?.anchors()?.sessionId != null, null,
      { timeout: 45_000 });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      anchors2d = await Promise.race([
        page2d.evaluate(() => window.frostEcho2d?.anchors() ?? null),
        new Promise((_, reject) => setTimeout(() => reject(new Error('2d_evaluate_timeout')), 15_000)),
      ]);
      if (anchors2d && anchors3dLate && anchors2d.worldVersion === anchors3dLate.worldVersion
        && anchors2d.simTime === anchors3dLate.simTime) break;
      await page2d.waitForTimeout(200);
    }
  } catch (error) {
    assert('2d_page_ready', false, { error: error.message.split('\n')[0], url: report.url,
      console: consoleErrors.filter(row => row.label === '2d').slice(-4) });
  }
  writeFileSync(join(out, 'anchors-2d.json'), `${JSON.stringify(anchors2d, null, 2)}\n`);
  const parityKey = (a) => JSON.stringify({ sessionId: a.sessionId, worldVersion: a.worldVersion,
    simTime: a.simTime, tileMeters: a.tileMeters, origin: a.origin,
    actors: a.actors.map(x => ({ id: x.id, mapId: x.mapId, cell: x.cell, world: x.world,
      placement: x.placement, doorOf: x.doorOf })),
    obligations: a.obligations, stock: a.stock });
  const parity = Boolean(anchors3dLate && anchors2d)
    && parityKey(anchors3dLate) === parityKey(anchors2d);
  report.anchors = { at3d: anchors3dLate, at2d: anchors2d, equal: parity };
  assert('2d_and_3d_same_state', parity, { v3d: anchors3dLate?.worldVersion ?? null,
    v2d: anchors2d?.worldVersion ?? null, sim3d: anchors3dLate?.simTime ?? null,
    sim2d: anchors2d?.simTime ?? null });

  const shot2d = join(shotDir, `${String(report.screenshots.length + 1).padStart(2, '0')}-2d-same-tick.png`);
  try {
    await page2d.screenshot({ path: shot2d, timeout: 45_000 });
    report.screenshots.push({ name: '2d-same-tick', path: shot2d.replace(root + '/', ''), sha256: sha256(shot2d) });
  } catch (error) {
    report.screenshotFailures ??= [];
    report.screenshotFailures.push({ name: '2d-same-tick', error: error.message.split('\n')[0] });
  }
  await page2d.close();

  // final scorer identity used by THIS whole run
  report.scorer = restored.scorer;
  assert('scorer_identity_recorded', Boolean(report.scorer?.scorerId), report.scorer);

  await context.close();
  const videos = readdirSync(videoDir).filter(name => name.endsWith('.webm'));
  report.video = videos.length ? { file: `video/${videos[0]}`, size: statSync(join(videoDir, videos[0])).size,
    sha256: sha256(join(videoDir, videos[0])) } : null;
  report.evidenceMode = report.video ? 'video+screenshots' : 'continuous-screenshots';
  if ((report.screenshotFailures ?? []).length > 2) {
    report.failures.push(`screenshot_gaps:${report.screenshotFailures.length}`);
  }
  if ((report.recoveries ?? []).length > 0) {
    report.notes = [...(report.notes ?? []),
      'view tab was reopened after a compositor stall; authority/CLI state was not reset'];
  }
  assert('continuous_screenshots', report.screenshots.length >= 8, { count: report.screenshots.length });

  // raw authoritative transcript (engine-side only; never served to the page)
  const sessionDirs = readdirSync(saves).filter(name => statSync(join(saves, name)).isDirectory());
  for (const dirName of sessionDirs) {
    for (const file of ['web-cli.jsonl', 'session.json', 'session.json.r8.json']) {
      const path = join(saves, dirName, file);
      if (!existsSync(path)) continue;
      report.rawTranscripts.push({ file: path.replace(root + '/', ''), size: statSync(path).size,
        sha256: sha256(path) });
    }
  }

  report.consoleErrors = consoleErrors;
  return report;
}

/* ----------------------------------------------------------- finish up ---- */

let exitCode = 0;
try {
  await main();
} catch (error) {
  report.failures.push(`exception: ${error.message}`);
  report.error = { message: error.message, stack: error.stack };
  console.error(error);
  exitCode = 1;
} finally {
  report.consoleErrors = consoleErrors;
  try {
    report.pageErrors = await evalTimed(() => ({
      errors: window.frostEcho?.errors ?? null,
      loading: document.getElementById('loading')?.className ?? null,
      dead: !!window.frostEcho?.errors?.length,
      connection: document.getElementById('connection')?.textContent ?? null,
    }), null, 10_000);
  } catch (error) { report.pageErrors = { error: error.message }; }
  try { await context?.close(); } catch { /* already closed */ }
  try { await browser?.close(); } catch { /* already closed */ }
  if (server?.child) await stopServer('finally', 'SIGTERM').catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.passed = report.failures.length === 0 && exitCode === 0;
  report.stepCount = report.steps.length;
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, 'operations.jsonl'),
    report.operations.map(row => JSON.stringify(row)).join('\n') + '\n');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (!path.includes('/saves')) walk(path); continue; }
      if (['report.json', 'SHA256SUMS.txt', 'operations.jsonl'].includes(name)) continue;
      files.push(path);
    }
  };
  walk(out);
  writeFileSync(join(out, 'SHA256SUMS.txt'),
    files.sort().map(path => `${sha256(path)}  ${path.replace(root + '/', '')}`).join('\n') + '\n');
  console.log(JSON.stringify({ passed: report.passed, failures: report.failures,
    out, steps: report.stepCount, assertions: report.assertions.length,
    video: report.video?.file ?? null, frames: report.frames?.raf }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
