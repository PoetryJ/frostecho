/**
 * 8-NPC / 4-day offline fixture. Writes the raw trace, not just a summary.
 * Run: node dist/scripts/survival-fixture.js [npcCount] [days]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorldV2, runEightNpcDay, type WorldV2 } from '../src/survival/world-v2';

const count = Number(process.argv[2] ?? 8);
const days = Number(process.argv[3] ?? 4);
if (![8, 16, 32].includes(count)) {
  console.error('npc count must be 8, 16 or 32');
  process.exit(2);
}

const ids = Array.from({ length: count }, (_, index) => `npc_${String(index + 1).padStart(2, '0')}`);
const startedAt = Date.now();
let state: WorldV2 = createWorldV2({ npcIds: ids, rngSeed: `fixture-${count}-${days}` });
const perDay: unknown[] = [];
let events = 0;

for (let day = 1; day <= days; day += 1) {
  const result = runEightNpcDay(state, day);
  state = result.state;
  events += result.events.length;
  perDay.push({
    day,
    simTime: state.simTime,
    version: state.version,
    weather: state.weather,
    alive: Object.values(state.npcs).filter(npc => npc.alive).length,
    resources: { ...state.resources },
    furnace: { ...state.furnace },
    eventCount: result.events.length,
    hungerMean: Number((Object.values(state.npcs).reduce((sum, npc) => sum + npc.hunger, 0) / count).toFixed(2)),
    minHealth: Math.min(...Object.values(state.npcs).map(npc => npc.health)),
  });
}

const nested = `${count}x${days}`;
const outDir = join(process.cwd(), 'artifacts/sprint-1116/survival');
mkdirSync(outDir, { recursive: true });
const payload = {
  schema: 'frostecho.survival-fixture/1',
  mode: 'fixture',
  fixture: nested,
  npcCount: count,
  days,
  events,
  wallMs: Date.now() - startedAt,
  final: {
    ending: state.ending,
    day: state.day,
    version: state.version,
    alive: state.dead.length === 0 ? count : count - state.dead.length,
    dead: state.dead,
    resources: state.resources,
    furnace: state.furnace,
    npcs: Object.values(state.npcs),
  },
  perDay,
  stateSha256: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
};
const path = join(outDir, `${nested}.json`);
writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ path, fixture: nested, ending: state.ending, events,
  wallMs: payload.wallMs, stateSha256: payload.stateSha256 }, null, 2));
