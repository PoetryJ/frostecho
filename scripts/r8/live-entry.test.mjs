import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { openCli } from './cli-session.mjs';
const require = createRequire(import.meta.url);
const { createPlayWebServer } = require('../../dist/src/r7/ui/server.js');
const root = process.cwd();
const out = resolve('artifacts/r8-live-entry', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const fixture = JSON.stringify([process.execPath, 'scripts/r8/joint-fixture.mjs']);
const until = async (condition, bound = 5000) => {
  const end = Date.now() + bound;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};

test('persistent joint envelope -> runtime commits -> complete new-process restore', { timeout: 30000 }, () => {
  const dir = join(out, 'online');
  const result = spawnSync(process.execPath, ['scripts/r8/online-play.mjs', '--out', dir,
    '--fresh', '--steps', '3', '--mode', 'jev-experimental'], { cwd: root, encoding: 'utf8',
    timeout: 25000, env: { ...process.env, FROSTECHO_SCORER_COMMAND_JSON: fixture } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(readFileSync(join(dir, 'online-report.json'), 'utf8'));
  const trace = readFileSync(join(dir, 'scorer.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const requests = trace.filter(row => row.event === 'score_request');
  assert.equal(report.executed, 3);
  assert.equal(report.restoreEqual, true);
  assert.ok(report.documentsCompared.includes('.r8.json'));
  assert.ok(report.documentsCompared.includes('.commitments.json'));
  assert.equal(requests.length, 3);
  assert.equal(trace.filter(row => row.event === 'score_reply').length, 3);
  for (const [index, row] of requests.entries()) {
    assert.equal(row.envelope.inputSha256, report.decisions[index].records[0].inputSha256);
    assert.ok(row.envelope.request.candidates.length >= 2);
  }
});

test('live CLI cancellation revokes both in-flight and queued R8 work; new generation commits', { timeout: 15000 }, async () => {
  const state = join(out, 'cancel', 'session.json');
  mkdirSync(join(out, 'cancel'), { recursive: true });
  const transcript = state + '.scores.jsonl';
  const cli = openCli(root, ['--profile', 'gospel-5.8.19', '--fresh', '--state', state,
    '--mode', 'jev-experimental', '--scorer-command-json',
    JSON.stringify([process.execPath, 'scripts/r8/joint-fixture.mjs', '700'])]);
  try {
    await cli.ready;
    const first = cli.send('r8-step npc_01');
    await until(() => existsSync(transcript) && readFileSync(transcript, 'utf8').includes('score_request'));
    const queued = cli.send('r8-step npc_02');
    await cli.send('cancel npc_01');
    await cli.send('cancel npc_02');
    const stale = await first, skipped = await queued;
    assert.equal(stale.executed, 0);
    assert.deepEqual(stale.records[0].eventIds, []);
    assert.equal(skipped.executed, 0);
    assert.equal(skipped.records[0].reason, 'generation_changed_before_start');
    const newer = await cli.send('r8-step npc_01');
    assert.equal(newer.executed, 1);
    assert.notEqual(newer.records[0].requestId, stale.records[0].requestId);
    const requests = readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(row => row.event === 'score_request');
    assert.equal(requests.length, 2, 'cancelled queued actor must not reach encoder');
    assert.deepEqual(requests.map(row => row.envelope.request.actorId), ['npc_01', 'npc_01']);
    await cli.send('save');
    writeFileSync(join(out, 'cancel', 'cli.json'), JSON.stringify(cli.records, null, 2));
    await cli.close();
  } finally { if (cli.child.exitCode === null) cli.kill(); }
});

test('HTTP single-step and autoplay use Gospel runtime, with save/continue preserving its full state', { timeout: 30000 }, async () => {
  const app = createPlayWebServer(root, join(out, 'web'), { profile: 'gospel-5.8.19' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  try {
    const catalogResponse = await fetch(url + '/api/catalog');
    const catalog = await catalogResponse.json();
    assert.equal(Object.keys(catalog.legacyMaps.maps).length, 8);
    assert.equal(catalog.legacyMaps.maps.command.assetFile, null);
    for (const map of Object.values(catalog.legacyMaps.maps)) {
      if (!map.assetFile) continue;
      const response = await fetch(url + '/assets/' + map.assetFile, { method: 'HEAD' });
      assert.equal(response.status, 200, `missing actual map asset ${map.assetFile}`);
      assert.equal(response.headers.get('content-type'), 'image/png');
    }
    const started = await post('/api/session', { action: 'new' });
    assert.equal(started.observation.simTime, 480);
    assert.equal(started.profile, 'gospel-5.8.19');
    const step = await post('/api/command', { line: 'game-step npc_01' });
    assert.equal(step.result.profile, 'gospel-5.8.19');
    assert.equal(step.result.executed, 1);
    assert.ok(step.state.status.r8.committed.length > 0);
    assert.ok(step.state.status.r8.states.council.meetings.length > 0);
    const before = app.bridge.snapshot().records.filter(row => row.command === 'game-step').length;
    await post('/api/control', { action: 'run' });
    await until(() => app.bridge.snapshot().records.filter(row => row.command === 'game-step').length > before);
    await post('/api/control', { action: 'pause' });
    await post('/api/command', { line: 'save' });
    const saved = app.bridge.snapshot();
    const document = saved.status.r8;
    await post('/api/command', { line: 'quit' });
    const restored = await post('/api/session', { action: 'continue' });
    assert.equal(restored.sessionId, started.sessionId);
    assert.deepEqual(restored.status.r8, document);
    assert.equal(restored.observation.simTime, document.clock);
    writeFileSync(join(out, 'web-state.json'), JSON.stringify({ started, saved, restored }, null, 2));
  } finally { await app.close(); }
});

test('legacy profile keeps its original clock and game-step command', { timeout: 10000 }, async () => {
  mkdirSync(join(out, 'legacy'), { recursive: true });
  const cli = openCli(root, ['--profile', 'legacy', '--fresh', '--state', join(out, 'legacy/session.json')]);
  try {
    const ready = await cli.ready;
    assert.equal(ready.simTime, 0);
    const result = await cli.send('game-step');
    assert.equal(result.mode, 'reference-rules/1');
    await cli.close();
  } finally { if (cli.child.exitCode === null) cli.kill(); }
});

test('HTTP original-map clicks cross three rooms through doors and restore the same authority', { timeout: 30000 }, async () => {
  const app = createPlayWebServer(root, join(out, 'map-web'), { profile: 'gospel-5.8.19' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const command = line => post('/api/command', { line });
  try {
    const catalog = await (await fetch(url + '/api/catalog')).json();
    await post('/api/session', { action: 'new' });
    const enabled = await command('r8-map-enable');
    let position = enabled.state.positions.npc_01.legacyPosition;
    assert.ok(position);
    const initialTime = enabled.state.observation.simTime;
    const wall = catalog.legacyMaps.maps[position.mapId].solids[0];
    const blocked = await command(`r8-walk npc_01 ${wall.x} ${wall.y}`);
    assert.equal(blocked.result.status, 'rejected');
    assert.equal(blocked.state.observation.simTime, initialTime);
    assert.deepEqual(blocked.state.positions.npc_01.legacyPosition, position);
    const trace = [enabled.result, blocked.result];
    const door = async trigger => {
      const walked = await command(`r8-walk npc_01 ${trigger.x} ${trigger.y}`);
      assert.notEqual(walked.result.status, 'rejected', JSON.stringify(walked.result));
      const crossed = await command('r8-door npc_01');
      assert.equal(crossed.result.status, 'applied', JSON.stringify(crossed.result));
      position = crossed.state.positions.npc_01.legacyPosition;
      trace.push(walked.result, crossed.result);
    };
    for (const room of ['warehouse', 'medical', 'kitchen']) {
      if (position.mapId !== 'village')
        await door(catalog.legacyMaps.maps[position.mapId].triggers.find(row => row.target === 'village'));
      await door(catalog.legacyMaps.maps.village.triggers.find(row => row.target === room));
      assert.equal(position.mapId, room);
    }
    const saved = await command('save');
    assert.ok(saved.state.observation.simTime > initialTime);
    const expected = saved.state.status.r8;
    await command('quit');
    const restored = await post('/api/session', { action: 'continue' });
    assert.deepEqual(restored.positions.npc_01.legacyPosition, position);
    assert.deepEqual(restored.status.r8, expected);
    assert.equal(restored.observation.simTime, expected.clock);
    writeFileSync(join(out, 'map-http-chain.json'), JSON.stringify({ trace,
      visited: ['warehouse', 'medical', 'kitchen'], initialTime,
      elapsed: restored.observation.simTime - initialTime, saved: saved.state, restored }, null, 2));
  } finally { await app.close(); }
});

console.log(`Live-entry test evidence: ${out}`);
