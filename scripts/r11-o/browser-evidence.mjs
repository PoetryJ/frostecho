/**
 * R11-O browser evidence: drive the shipped 2D entry and the 3D projection of
 * the SAME authority, take consecutive screenshots and a short video, and keep
 * the control requests that produced them.
 *
 *   node scripts/r11-o/browser-evidence.mjs --base http://127.0.0.1:18772 \
 *     --out artifacts/r11/evidence/browser
 *
 * The page only reads `/api/state` and forwards commands to `/api/command`;
 * this script never mutates the world itself. The screenshots are of a real
 * Chromium (SwiftShader WebGL), not of a JSON projection.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const base = arg('--base', 'http://127.0.0.1:18772');
const out = resolve(arg('--out', 'artifacts/r11/evidence/browser'));
const playwrightPath = arg('--playwright',
  '/data/home/user_00/frostecho-r7/tools/node_modules/playwright-core');
const executablePath = arg('--chrome',
  `${process.env.HOME}/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`);
mkdirSync(out, { recursive: true });

const playwright = await import(`${playwrightPath}/index.js`);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error(`playwright-core did not export chromium: ${playwrightPath}`);
const calls = [];
async function post(path, payload) {
  const response = await fetch(`${base}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await response.json();
  calls.push({ path, payload, status: response.status, body });
  return body;
}

const session = await post('/api/session', { action: 'new' });
if (!session.active) throw new Error(`session did not start: ${JSON.stringify(session)}`);
// One real command through the same queue the page uses.
await post('/api/command', { line: 'move npc_01 warehouse' });

const browser = await chromium.launch({ executablePath, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage',
    // WebGPU via SwiftShader Vulkan; the 3D entry refuses to fake a frame.
    '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPUDeveloperFeatures',
    '--use-angle=vulkan', '--disable-vulkan-surface'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
  recordVideo: { dir: join(out, 'video'), size: { width: 1440, height: 900 } } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => consoleErrors.push(String(error)));

const shots = [];
async function shot(name) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  shots.push(path);
}

// `/api/events` is a long-lived SSE stream, so `networkidle` never fires.
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(3000);
await shot('2d-01-village');
const state2d = await page.evaluate(() => fetch('/api/state').then(r => r.json()));

// Advance the authority a few times so the follow-up frames show real motion.
for (let index = 0; index < 3; index += 1) {
  await post('/api/control', { action: 'run' });
  await page.waitForTimeout(1200);
  await post('/api/control', { action: 'pause' });
  await shot(`2d-0${index + 2}-running`);
}

await page.goto(`${base}/visual/game.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(4000);
await shot('3d-01-same-world');
const webgl = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { canvas: false };
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  return { canvas: true, width: canvas.width, height: canvas.height,
    webgl: Boolean(gl), renderer: gl ? String(gl.getParameter(gl.RENDERER)) : null };
});
for (let index = 0; index < 2; index += 1) {
  await post('/api/control', { action: 'run' });
  await page.waitForTimeout(1200);
  await post('/api/control', { action: 'pause' });
  await shot(`3d-0${index + 2}-running`);
}

await context.close();
await browser.close();
const report = { schema: 'frostecho.r11.browser-evidence/1', base, shots,
  webgl, consoleErrors, calls, state2d: { active: state2d.active,
    simTime: state2d.observation?.simTime, day: state2d.observation?.day,
    npcCount: state2d.observation?.npcs?.length ?? 0 } };
writeFileSync(join(out, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: consoleErrors.length === 0, shots: shots.length,
  webgl, consoleErrors }, null, 2));
