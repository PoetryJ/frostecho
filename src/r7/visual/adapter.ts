/**
 * Display adapter (E): one HTTP surface that a WebGPU page can use without ever
 * gaining control of the simulation.
 *
 * - It reads the game server's existing `/api/state` and derives VisualSnapshot/1.
 * - It forwards menu commands verbatim to the existing `/api/command`, which is
 *   the same transport the 2D page and the CLI use. No second world, no second
 *   clock, no extra save file.
 * - It refuses to serve a snapshot that moves backwards (see VisualVersionGate).
 *
 * The game server keeps rejecting cross-origin POSTs. Because this adapter is
 * same-origin with the page it serves, the browser never needs a loosened CORS
 * rule: the forwarding hop is server-side loopback.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { assertNoPrivateMemory, buildVisualSnapshot, VisualVersionGate,
  type Catalog, type VisualSnapshot } from './snapshot';

export interface VisualAdapterOptions {
  /** Loopback base URL of the authoritative game server, e.g. http://127.0.0.1:1234 */
  gameBaseUrl: string;
  /** Directory that holds the (vendored) display, i.e. public/r7/visual */
  publicRoot: string;
  /** Cache for GET /api/visual/state so a polling page cannot flood the CLI. */
  cacheMs?: number;
  /** Forwarded command timeout. A batch step may legitimately wait on a scorer. */
  commandTimeoutMs?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const MAX_BODY = 32 * 1024;

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error('request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, value: unknown, code = 200): void {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function createVisualAdapter(options: VisualAdapterOptions) {
  const base = options.gameBaseUrl.replace(/\/+$/, '');
  const publicRoot = resolve(options.publicRoot);
  const cacheMs = options.cacheMs ?? 250;
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  const gate = new VisualVersionGate();
  let catalog: Catalog | null = null;
  let cached: { at: number; snapshot: VisualSnapshot; verdict: string; reason: string } | null = null;
  let lastSent: VisualSnapshot | null = null;

  const gameJson = async (path: string, init?: RequestInit, timeout = 20_000): Promise<any> => {
    const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(timeout) });
    const text = await response.text();
    if (!response.ok) throw new Error(`game_${response.status}:${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };

  const loadCatalog = async (): Promise<Catalog> => {
    if (catalog) return catalog;
    const raw = await gameJson('/api/catalog');
    catalog = { npcs: raw.npcs ?? [], buildings: raw.buildings ?? [] };
    return catalog;
  };

  /** Reads only what the CLI already emitted; never mutates game state. */
  const derive = async (): Promise<{ snapshot: VisualSnapshot; verdict: string; reason: string }> => {
    const now = Date.now();
    if (cached && now - cached.at < cacheMs) return cached;
    const [bridge, table] = await Promise.all([gameJson('/api/state'), loadCatalog()]);
    const { snapshot } = buildVisualSnapshot(bridge, table);
    assertNoPrivateMemory(snapshot);
    const verdict = gate.accept(snapshot);
    if (verdict.verdict === 'stale' && lastSent) {
      // Never rewind the picture: keep serving the newest frame already shown and
      // say out loud that an older snapshot arrived.
      cached = { at: now, snapshot: lastSent, verdict: verdict.verdict, reason: verdict.reason };
      return cached;
    }
    if (verdict.verdict === 'resync-required') gate.reset();
    lastSent = snapshot;
    cached = { at: now, snapshot, verdict: verdict.verdict, reason: verdict.reason };
    return cached;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      if (path.startsWith('/api/visual/')) {
        if (path === '/api/visual/health' && req.method === 'GET') {
          return sendJson(res, { ok: true, schema: 'frostecho.visual/1', gameBaseUrl: base,
            browser: process.env.FROSTECHO_VISUAL_BROWSER ?? null });
        }
        if (path === '/api/visual/catalog' && req.method === 'GET') {
          return sendJson(res, await gameJson('/api/catalog'));
        }
        if (path === '/api/visual/state' && req.method === 'GET') {
          if (url.searchParams.get('reset') === '1') { gate.reset(); cached = null; }
          const state = await derive();
          return sendJson(res, { ...state, receivedAt: new Date().toISOString() });
        }
        if (path === '/api/visual/command' && req.method === 'POST') {
          const input = await readJson(req);
          const line = String(input?.line ?? '').trim();
          if (!line) return sendJson(res, { error: 'line_required' }, 400);
          // Verbatim forwarding: the CLI decides validity, authority and clock.
          const result = await gameJson('/api/command', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line }) },
            commandTimeoutMs);
          cached = null;
          const state = await derive();
          return sendJson(res, { line, cli: result.result ?? null, error: result.error ?? null,
            state });
        }
        if ((path === '/api/visual/session' || path === '/api/visual/control') && req.method === 'POST') {
          const input = await readJson(req);
          const target = path.endsWith('/session') ? '/api/session' : '/api/control';
          const result = await gameJson(target, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
          if (path.endsWith('/session')) { gate.reset(); lastSent = null; }
          cached = null;
          const state = await derive();
          return sendJson(res, { game: result, state });
        }
        return sendJson(res, { error: 'not_found' }, 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, { error: 'not_found' }, 404);
      // `/` is the game view. The untouched upstream free-flight study stays
      // reachable at /index.html so both can be checked against one snapshot.
      const relative = decodeURIComponent(path === '/' ? '/game.html' : path);
      const file = resolve(publicRoot, `.${relative}`);
      if (!file.startsWith(publicRoot + sep) || !existsSync(file) || !statSync(file).isFile()) {
        return sendJson(res, { error: 'not_found', path: relative }, 404);
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Content-Length': statSync(file).size, 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).pipe(res);
    } catch (error) {
      sendJson(res, { error: (error as Error).message }, 400);
    }
  });

  return {
    server,
    /** Exposed for evidence scripts: the same derivation the page receives. */
    snapshot: () => derive(),
    state: () => ({ catalog, lastSent }),
    async close() {
      await new Promise<void>((done, fail) =>
        server.close(error => (error ? fail(error) : done())));
    },
  };
}

export type VisualAdapter = ReturnType<typeof createVisualAdapter>;
