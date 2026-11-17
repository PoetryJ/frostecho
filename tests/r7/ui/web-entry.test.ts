import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPlayWebServer } from '../../../src/r7/ui/server';

test('browser entry sends real commands, changes the authority and restores the saved world', { timeout: 30_000 }, async () => {
  const root = resolve(__dirname, '../../../..');
  const saveRoot = mkdtempSync(join(tmpdir(), 'frostecho-web-'));
  const app = createPlayWebServer(root, saveRoot);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, value: unknown) => {
    const response = await fetch(base + path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200);
    return response.json() as Promise<Record<string, any>>;
  };
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /FROSTECHO/);
    const catalog = await (await fetch(base + '/api/catalog')).json() as any;
    assert.equal(catalog.npcs.length, 8);
    assert.equal(catalog.npcs[0].name, '李婶');
    assert.equal(catalog.npcs[0].id, 'npc_01');
    const created = await post('/api/session', { action: 'new' });
    assert.equal(created.observation.npcs.length, 8);
    const moved = await post('/api/command', { line: 'travel npc_01 warehouse' });
    assert.equal(moved.result.status, 'applied');
    assert(moved.result.events.some((event: any) => event.type === 'traveled'));
    assert.equal(moved.state.positions.npc_01.location, 'warehouse');
    assert(moved.state.observation.simTime > 0);
    const requested = await post('/api/command', { line: 'request npc_01 supply-warehouse' });
    assert(requested.state.status.commitments.length > 0);
    const saved = await post('/api/command', { line: 'save' });
    const before = saved.state.observation;
    const commitments = saved.state.status.commitments;
    await post('/api/command', { line: 'quit' });
    const restored = await post('/api/session', { action: 'continue' });
    assert.deepEqual(restored.observation.npcs, before.npcs);
    assert.deepEqual(restored.observation.resources, before.resources);
    assert.equal(restored.observation.simTime, before.simTime);
    assert.deepEqual(restored.status.commitments, commitments);
    const trace = readFileSync(join(saveRoot, restored.sessionId, 'web-cli.jsonl'), 'utf8');
    assert.match(trace, /web_input/);
    assert.match(trace, /traveled/);
    assert.match(trace, /"restored":true/);
    const rejected = await fetch(base + '/api/command', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://unrelated.invalid' },
      body: JSON.stringify({ line: 'advance 99' }) });
    assert.equal(rejected.status, 403);
  } finally { await app.close(); }
});

test('autoplay advances the existing world and pause stops scheduling new decisions', { timeout: 30_000 }, async () => {
  const root = resolve(__dirname, '../../../..');
  const app = createPlayWebServer(root, mkdtempSync(join(tmpdir(), 'frostecho-autoplay-')));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    await app.bridge.start(true);
    const before = app.bridge.snapshot().observation.simTime;
    const advanced = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The world never advanced.')), 8000);
      const listener = (state: any) => {
        if (state.observation?.simTime > before) {
          clearTimeout(timeout); app.bridge.off('state', listener); resolve();
        }
      };
      app.bridge.on('state', listener);
    });
    app.bridge.run();
    await advanced;
    app.bridge.pause();
    assert.equal(app.bridge.snapshot().running, false);
    await app.bridge.refresh();
    const snapshot = app.bridge.snapshot().observation.simTime;
    await new Promise(resolve => setTimeout(resolve, 1900));
    assert.equal(app.bridge.snapshot().observation.simTime, snapshot);
  } finally { await app.close(); }
});
