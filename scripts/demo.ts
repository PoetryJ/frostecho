import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine, initialWorld, RULES } from '../src';
const eng = new Engine(initialWorld());
const fmt = (s = eng.getState()) => `kitchen.food=${s.food.kitchen} | ` + Object.values(s.npcs).map(n => `${n.id}@${n.location} hunger=${n.hunger}`).join(' | ');
const lines: string[] = [];
const out = (l: string) => { lines.push(l); console.log(l); };
out(`EXPERIMENTAL RULES: ${JSON.stringify(RULES)}`);
out(`INITIAL: ${fmt()}`);
const cmds: any[] = [
  { commandId: 'c1', actorId: 'npc_a', type: 'move', payload: { to: 'kitchen' } },
  { commandId: 'c2', actorId: 'npc_b', type: 'move', payload: { to: 'kitchen' } },
  { commandId: 'c3', actorId: 'npc_b', type: 'eat', payload: {} },
  { commandId: 'c4', actorId: 'npc_a', type: 'eat', payload: {} },
  { commandId: 'c3', actorId: 'npc_b', type: 'eat', payload: {} },
  { commandId: 'c3', actorId: 'npc_a', type: 'eat', payload: {} },
  { commandId: 'c5', actorId: 'ghost', type: 'move', payload: { to: 'dorm' } },
  { commandId: 'c6', actorId: 'npc_a', type: 'move', payload: { to: 'dorm' } },
];
for (const c of cmds) {
  const r = eng.submit(c);
  out(`#${r.seq} ${c.actorId} ${c.type} ${JSON.stringify(c.payload)} [${c.commandId}] -> ${r.status.toUpperCase()}${r.reason ? ' ' + r.reason : ''}${r.detail ? ' (' + r.detail + ')' : ''}${r.eventIds.length ? ' events=' + r.eventIds.join(',') : ''}`);
  out(`     state: ${fmt()}`);
}
const restored = Engine.restore(JSON.parse(JSON.stringify(eng.save())));
const rr = restored.submit(cmds[2]);
out(`AFTER RESTORE retry c3 -> ${rr.status} ; state: ${fmt(restored.getState())}`);
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/demo-output.txt', lines.join('\n') + '\n');
writeFileSync('artifacts/demo-records.json', JSON.stringify({ initialState: eng.getInitialState(), commandsAndResults: eng.getLog(), events: eng.getEvents(), finalState: eng.getState(), save: eng.save() }, null, 2));
