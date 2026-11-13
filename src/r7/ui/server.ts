import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { BUILDINGS } from '../../spatial-v2/map';
import { CliBridge } from './cli-bridge';

const NPCS = [
  ['li_shen', '李婶', '物资总管 / 炊事长', '李婶'],
  ['zhao_chef', '赵铁柱', '伐木工 / 锅炉工', '赵大厨'],
  ['wang_teacher', '王策', '技师 / 规划师', '王老师'],
  ['old_qian', '老钱', '镇长 / 精神领袖', '老钱'],
  ['su_doctor', '苏岩', '医官', '苏医生'],
  ['lu_chen', '陆辰', '采集工 / 建筑工', '陆辰'],
  ['ling_yue', '歆玥', '侦察员 / 急救兵', '歆玥'],
  ['qing_xuan', '清璇', '药剂师学徒 / 陷阱工', '清璇'],
].map(([legacyId, name, occupation, sprite], index) => ({
  id: `npc_${String(index + 1).padStart(2, '0')}`, legacyId, name, occupation,
  portrait: `/assets/asset/character/${encodeURIComponent(sprite)}/portrait.png`,
}));

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon' };

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16_384) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function json(res: ServerResponse, value: unknown, code = 200): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createPlayWebServer(root: string, saveRoot?: string) {
  const bridge = new CliBridge(root, saveRoot);
  const publicRoot = join(root, 'public', 'r7');
  const assetRoot = join(root, 'handoff', '20261113-r7-full-goal', 'reference-extracted', 'assets');
  const clients = new Set<ServerResponse>();
  const broadcast = (name: string, value: unknown) => {
    const message = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of clients) client.write(message);
  };
  bridge.on('state', state => broadcast('state', state));
  bridge.on('record', record => broadcast('record', record));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST') {
        // A local game should not accept commands submitted by arbitrary websites.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return json(res, { error: 'Origin rejected.' }, 403);
        if (!String(req.headers['content-type']).startsWith('application/json')) {
          return json(res, { error: 'JSON request required.' }, 415);
        }
      }
      if (url.pathname === '/api/catalog' && req.method === 'GET') {
        return json(res, { npcs: NPCS, buildings: BUILDINGS,
          assetsReady: existsSync(join(assetRoot, 'asset', 'map', 'village_base_clean.png')),
          identitySource: 'gospel-5.8.19/data/npc-configs.js (ordered mapping; authority IDs unchanged)' });
      }
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, bridge.snapshot());
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          Connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(bridge.snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const input = await body(req);
        if (!['new', 'continue'].includes(input.action)) throw new Error('Unknown session action.');
        return json(res, await bridge.start(input.action === 'new'));
      }
      if (url.pathname === '/api/command' && req.method === 'POST') {
        const input = await body(req);
        const line = String(input.line ?? '').trim();
        if (line === 'quit') {
          await bridge.stop(true);
          return json(res, { bye: true, state: bridge.snapshot() });
        }
        const result = await bridge.command(line);
        await bridge.refresh();
        return json(res, { result, state: bridge.snapshot() });
      }
      if (url.pathname === '/api/control' && req.method === 'POST') {
        const input = await body(req);
        if (input.action === 'pause') bridge.pause();
        else if (input.action === 'run') bridge.run();
        else if (input.action === 'speed') bridge.setSpeed(Number(input.value));
        else throw new Error('Unknown control action.');
        return json(res, bridge.snapshot());
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, { error: 'Not found.' }, 404);
      const assets = url.pathname.startsWith('/assets/');
      const base = assets ? assetRoot : publicRoot;
      const relative = decodeURIComponent(assets ? url.pathname.slice(8) : url.pathname.slice(1) || 'index.html');
      const file = resolve(base, relative);
      if (!file.startsWith(resolve(base) + sep) || !existsSync(file) || !statSync(file).isFile()) {
        return json(res, { error: 'Not found.' }, 404);
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Content-Length': statSync(file).size, 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': assets ? 'public, max-age=3600' : 'no-cache' });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).pipe(res);
    } catch (error) { json(res, { error: (error as Error).message }, 400); }
  });
  return { server, bridge, async close() {
    await bridge.close();
    for (const client of clients) client.end();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
