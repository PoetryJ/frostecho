#!/usr/bin/env node
/**
 * R2 world evidence: the original fixed 9-group matrix rerun with the correct
 * scenarioDays (32x30 = 30 days, settled on day 30), written under
 * artifacts/sprint-r2/world/. The R1 days4 evidence is never overwritten.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorldV2, runEightNpcDay } from '../dist/src/survival/world-v2.js';

const outDir = join(process.cwd(), 'artifacts/sprint-r2/world');
mkdirSync(outDir, { recursive: true });

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function simulate(count, days, seed) {
  const ids = Array.from({ length: count }, (_, index) => `npc_${index + 1}`);
  let state = createWorldV2({ npcIds: ids, days, rngSeed: seed });
  const trace = [];
  for (let day = 1; day <= days; day += 1) {
    const before = state.simTime;
    const result = runEightNpcDay(state, day);
    state = result.state;
    trace.push({ day, hoursAdded: (state.simTime - before) / 60,
      ending: state.ending, alive: state.dead.length === 0 });
  }
  return { state, trace };
}

const matrix = [];
const failures = [];
for (const [count, days] of [[8, 4], [16, 4], [32, 30]]) {
  for (const seed of ['17', '29', '43']) {
    const left = simulate(count, days, seed);
    const right = simulate(count, days, seed);
    const hours = left.state.simTime / 60;
    const expectedHours = days * 24;
    const alive = Object.values(left.state.npcs).filter(npc => npc.alive).length;
    const replay = sha(left.state) === sha(right.state);
    const scenarioDays = left.state.scenarioDays;
    const ok = hours === expectedHours && scenarioDays === days && replay
      && left.state.ending === 'survived' && alive === count;
    const row = {
      count, days, seed, scenarioDays, elapsedHours: hours, expectedHours,
      finalDay: left.state.day, ending: left.state.ending, alive,
      events: left.trace.length, replay,
      stateSha256: sha(left.state), traceSha256: sha(left.trace),
      resources: left.state.resources,
    };
    matrix.push(row);
    if (!ok) failures.push(row);
    writeFileSync(join(outDir, `${count}x${days}-seed${seed}.json`),
      `${JSON.stringify({ summary: row, trace: left.trace }, null, 2)}\n`, 'utf8');
  }
}

// Settling check: a 32x30 run must NOT settle before day 30.
const probe = simulate(32, 30, 'settle');
const settledAt = probe.trace.find(entry => entry.ending !== 'none');
const settleOk = settledAt?.day === 30;
if (!settleOk) failures.push({ check: 'settle-at-day-30', settledAt });

const summary = {
  schema: 'frostecho.r2.world-matrix/1',
  at: new Date().toISOString(),
  mode: 'fixture scheduling (runEightNpcDay rules); not model throughput',
  note: 'R1 32x30 artifacts used scenarioDays=4; this run uses scenarioDays=30 per 01-CONTRACT §5',
  groups: matrix.length,
  settleAtDay30: settleOk,
  failures,
  matrix,
};
writeFileSync(join(outDir, 'matrix.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ groups: matrix.length, settleAtDay30: settleOk,
  failures: failures.length, path: join(outDir, 'matrix.json') }));
process.exit(failures.length === 0 ? 0 : 1);
