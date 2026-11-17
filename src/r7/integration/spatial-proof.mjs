#!/usr/bin/env node
/** Persist the real original-map/D2 process-restore story and its authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { R8Runtime } = require('../../../dist/src/r7/integration/runtime.js');
const { legacyMapCatalog } = require('../../../dist/src/spatial-v2/legacy-profile.js');
const args = process.argv.slice(2), get = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
if (!get('--out')) throw new Error('--out <new-directory> required');
const out = resolve(get('--out'));
if (existsSync(out)) throw new Error('Refusing existing evidence output');
mkdirSync(out, { recursive: true });
const resume = get('--resume');
const runtime = resume ? R8Runtime.load(resolve(resume)) : R8Runtime.create({ seed: 'original-map-proof-v1' });
const project = () => ({ world: runtime.world, states: runtime.states, committed: runtime.committedEvents(),
  journal: runtime.journal, knowledge: runtime.session.knowledge(), ended: runtime.ended, endingKind: runtime.endingKind });
const encode = (_key, value) => value === -Infinity ? { $frostechoNumber: '-Infinity' } : value;
const decode = (_key, value) => value && value.$frostechoNumber === '-Infinity' ? -Infinity : value;
const write = (name, value) => writeFileSync(resolve(out, name), JSON.stringify(value, encode, 2) + '\n', { flag: 'wx' });
const trace = [];
function call(name, action) {
  const before = { version: runtime.world.version, time: runtime.world.simTime,
    position: runtime.legacyPosition('npc_01'), npc: structuredClone(runtime.world.npcs.npc_01) };
  const result = action();
  trace.push({ name, before, result, after: { version: runtime.world.version, time: runtime.world.simTime,
    position: runtime.legacyPosition('npc_01'), npc: structuredClone(runtime.world.npcs.npc_01) } });
  return result;
}
if (!resume) {
  call('enable-original-maps', () => runtime.enableLegacySpatial());
  for (const target of ['village', 'medical']) assert.equal(call(`walk-${target}`,
    () => runtime.travelLegacyTo('npc_01', target, `before-save-${target}`)).status, 'applied');
  const before = JSON.stringify(project());
  assert.equal(call('wall-negative-control', () => runtime.walkLegacy('npc_01', { x: 0, y: 0 })).status, 'rejected');
  assert.equal(JSON.stringify(project()), before);
  runtime.advanceWorld(1440 + 480);
  runtime.save(resolve(out, 'day2.json'));
  write('day2-authority.json', project());
} else {
  const before = JSON.stringify(project());
  const replay = runtime.travelLegacyTo('npc_01', 'medical', 'before-save-medical');
  assert.equal(replay.status, 'duplicate'); assert.equal(JSON.stringify(project()), before);
}
for (const target of ['kitchen', 'warehouse', 'dorm-a']) {
  call(`rest-${target}`, () => runtime.session.submitWorldCommand({ commandId: `rest-before-${target}`,
    type: 'rest', actorId: 'npc_01', minutes: 120 }));
  call(`rest-clock-${target}`, () => runtime.advanceWorld(runtime.world.simTime + 120));
  assert.equal(call(`walk-${target}`, () => runtime.travelLegacyTo('npc_01', target, `after-save-${target}`)).status, 'applied');
}
write('route-trace.json', trace); write('final-authority.json', project());
let restoredEqual = null;
if (!resume) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--resume', resolve(out, 'day2.json'),
    '--out', resolve(out, 'restored-process')], { encoding: 'utf8', timeout: 30000 });
  write('restore-process.json', { status: child.status, stdout: child.stdout, stderr: child.stderr });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resolve(out, 'restored-process/final-authority.json'), 'utf8'), decode), project());
  restoredEqual = true;
  write('map-catalog.json', legacyMapCatalog());
}
const allMoves = runtime.committedEvents().filter(event => ['legacy_cell_moved', 'legacy_door_crossed'].includes(event.type));
const summary = { ok: true, evidenceClass: 'real-engine-original-map-rollout', modelCalls: 0,
  restoredEqual, finalDay: runtime.world.day, finalMinute: runtime.world.simTime,
  finalPosition: runtime.legacyPosition('npc_01'), authoritativeMoves: allMoves.length,
  doorsCrossed: allMoves.filter(event => event.type === 'legacy_door_crossed').length,
  finalWorldVersion: runtime.world.version,
  authoritySha256: createHash('sha256').update(JSON.stringify(project(), encode)).digest('hex'),
  limitations: ['Source command room has no indoor PNG.', 'This is reference-engine navigation, not a model quality result.',
    'Old teleport rescue is rejected when original-map profile is enabled.', 'Gate closing is supported by geometry but not automatically scheduled by this route proof.'] };
write('summary.json', summary); console.log(JSON.stringify(summary));
