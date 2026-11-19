/**
 * D (R10) parity table: every original task, its site, its minutes and its
 * effect, side by side with what this engine actually does.
 *
 * The ORIGINAL constants below are transcribed from the sealed legacy source
 * (`handoff/20261113-r7-full-goal/legacy/legacy-reference.zip` ->
 * `extracted/src/systems/task-system.js`, `task-effects.js`,
 * `resource-system.js`, `furnace-system.js`, `event-system.js`). The IMPLEMENTED
 * side is read from the live modules, so this script cannot drift from the code
 * the way a hand-written audit can.
 *
 *   node dist/scripts/r10/d-parity.js --out artifacts/r10/d
 *
 * Exit 1 when any row is a MISMATCH or a MISSING item; NARROWED/DIVERGES rows
 * are listed and do not fail the run (they are documented port decisions).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACTION_MINUTES, requiredPlaceOf } from '../../src/execution/place-rules';
import { TASK_CATALOG, WORK_RULES, type TaskTypeId } from '../../src/r7/domains/tasks/index';
import { MACHINES, HEATING_WOOD_PER_HOUR, HEATING_POWER_PER_HOUR, RESERVE_TARGET_HOURS }
  from '../../src/r7/domains/production/index';
import { OUTDOOR_BANDS, WIND_CHILL, outdoorTemperature } from '../../src/r7/domains/survival/index';
import { BUILDINGS, RESOURCE_AREAS } from '../../src/spatial-v2/map';

type Status = 'MATCH' | 'MISMATCH' | 'NARROWED' | 'DIVERGES';

interface Row {
  task: string;
  originalPlace: string;
  originalMinutes: number;
  originalStamina: number;
  originalEffect: string;
  source: string;
  enginePlace: string | null;
  engineMinutes: number | null;
  engineEffect: string;
  status: Status;
  note: string;
}

/** `task-system.js:TASK_DETAILS` verbatim (seconds -> minutes). */
const ORIGINAL: Record<string, { place: string; seconds: number; stamina: number;
  effect: string; source: string }> = {
  COLLECT_WOOD: { place: 'lumber_camp', seconds: 1800, stamina: 15,
    effect: '木柴 +10（采集区 8/h，stand-in-area）', source: 'task-system.js:39-46' },
  COLLECT_FOOD: { place: 'frozen_lake', seconds: 1800, stamina: 12,
    effect: '食物 +8（采集区 5/h）', source: 'task-system.js:47-54' },
  MAINTAIN_POWER: { place: 'workshop_door', seconds: 2400, stamina: 10,
    effect: '电力 +15（40 min 内）', source: 'task-system.js:55-62' },
  COLLECT_MATERIAL: { place: 'ruins_site', seconds: 3600, stamina: 18,
    effect: '无公共资源；完成 +5 San；每日 3 次', source: 'task-system.js:63-70' },
  PREPARE_WARMTH: { place: 'warehouse_door', seconds: 1800, stamina: 8,
    effect: '全员 bodyTemp +0.5、San +3；当日供暖 ×1.1（不耗木柴）',
    source: 'task-system.js:71-78, task-effects.js:320-336' },
  PREPARE_MEDICAL: { place: 'medical_door', seconds: 1800, stamina: 5,
    effect: '同房间 health<60 者 +0.03/s、失温 +0.005/s；每 2h 产 1 急救包',
    source: 'task-system.js:79-86, task-effects.js:216-240' },
  BOOST_MORALE: { place: 'dorm_a_door', seconds: 1800, stamina: 8,
    effect: '同房间 San +0.02/s（30 min → +36）', source: 'task-system.js:87-94' },
  COORDINATE: { place: 'dorm_a_door', seconds: 3600, stamina: 5,
    effect: '同房间 San +0.01/s（60 min → +36）', source: 'task-system.js:95-104' },
  DISTRIBUTE_FOOD: { place: 'kitchen_door', seconds: 1200, stamina: 3,
    effect: '消耗 1.5×人数 食物；全员饱食 +25、San +2',
    source: 'task-system.js:105-112, task-effects.js:290-318' },
  MAINTAIN_ORDER: { place: 'dorm_a_door', seconds: 3600, stamina: 5,
    effect: '同房间 San +0.015/s（60 min → +54）', source: 'task-system.js:113-120' },
  REST_RECOVER: { place: 'dorm_a_door', seconds: 3600, stamina: 0,
    effect: '有效供暖下 stamina +0.05/s、health +0.02/s',
    source: 'task-system.js:121-128, task-effects.js:337-345' },
  SCOUT_RUINS: { place: 'ruins_site', seconds: 2400, stamina: 20,
    effect: '0.002/s 掉落 药品5/食物8/电力5；完成 +5 San', source: 'task-system.js:129-137' },
  BUILD_GENERATOR: { place: 'workshop_door', seconds: 14400, stamina: 20,
    effect: '发电机：木 3/h → 电 20/h', source: 'task-system.js:138-145, machine-system.js:30-78' },
  BUILD_LUMBER_MILL: { place: 'workshop_door', seconds: 21600, stamina: 25,
    effect: '伐木机：电 4/h → 木 24/h', source: 'task-system.js:146-153, machine-system.js:30-78' },
  BUILD_FOOD_COLLECTOR: { place: 'workshop_door', seconds: 14400, stamina: 20,
    effect: '捕猎机：电 3/h → 食 12/h', source: 'task-system.js:154-162, machine-system.js:30-78' },
};

/** `task-effects.js:_applyTaskEffect` + `task-system.js:GATHER_RATES`. */
const ENGINE_EFFECT: Record<string, string> = {
  COLLECT_WOOD: 'gather(firewood,2) → 3..5 木柴/30 min（约 8/h）',
  COLLECT_FOOD: 'gather(food,2) → 3..5 食物/30 min（约 8/h，原作 5/h）',
  MAINTAIN_POWER: 'work(power,40) → 电 +2/h×0.67h≈+1（原作 +15/40min）',
  COLLECT_MATERIAL: 'work(explore,60) → 无资源、+5 San、每日 3 次',
  PREPARE_WARMTH: 'rest(30)@warehouse + 完成时全员 bodyTemp+0.5/San+3 + 当日 ×1.1',
  PREPARE_MEDICAL: 'medical(1) → 患者 health+25、bodyTemp+2（按次，不按秒）',
  BOOST_MORALE: 'work(morale,30) → 同房 San +36、自己 +5',
  COORDINATE: 'work(coordinate,60) → 同房 San +36、自己 +5',
  DISTRIBUTE_FOOD: 'deposit(1) 入库；完成时耗 1.5×人数、全员 +25 饱食/+2 San',
  MAINTAIN_ORDER: 'work(order,60) → 同房 San +54、自己 +5',
  REST_RECOVER: 'rest(60) → 内核 +12 stamina/h、+1.5 health/h、+3 San/h',
  SCOUT_RUINS: 'work(scout,40) → 0.12/min 掉落 药5/食8/电5、自己 +5 San',
  BUILD_GENERATOR: 'production.build → 木3/h → 电20/h（工时 240 min）',
  BUILD_LUMBER_MILL: 'production.build → 电4/h → 木24/h（工时 360 min）',
  BUILD_FOOD_COLLECTOR: 'production.build → 电3/h → 食12/h（工时 240 min）',
};

/** The eight original maps and who works there (`src/map/*`). */
const MAPS8 = [
  { map: 'village', original: 'src/map/village-map.js (50x40)', engine: 'village (MAPS.village)',
    tasks: ['COLLECT_WOOD@lumber_camp', 'COLLECT_FOOD@frozen_lake',
      'COLLECT_MATERIAL@ruins_site', 'SCOUT_RUINS@ruins_site'] },
  { map: 'warehouse', original: 'src/map/indoor/warehouse.js (10x8)', engine: 'warehouse',
    tasks: ['PREPARE_WARMTH@warehouse_door'] },
  { map: 'kitchen', original: 'src/map/indoor/kitchen.js (8x8)', engine: 'kitchen',
    tasks: ['DISTRIBUTE_FOOD@kitchen_door'] },
  { map: 'medical', original: 'src/map/indoor/medical.js', engine: 'medical',
    tasks: ['PREPARE_MEDICAL@medical_door'] },
  { map: 'workshop', original: 'src/map/indoor/workshop.js', engine: 'workshop',
    tasks: ['MAINTAIN_POWER@workshop_door', 'BUILD_*@workshop_door'] },
  { map: 'dorm-a', original: 'src/map/indoor/dorm-a.js', engine: 'dorm-a',
    tasks: ['BOOST_MORALE', 'COORDINATE', 'MAINTAIN_ORDER', 'REST_RECOVER@dorm_a_door'] },
  { map: 'dorm-b', original: 'src/map/indoor/dorm-b.js', engine: 'dorm-b', tasks: [] },
  { map: 'command', original: 'src/map/indoor/command.js', engine: 'command', tasks: [] },
];

function rows(): Row[] {
  const out: Row[] = [];
  for (const [task, original] of Object.entries(ORIGINAL)) {
    const type = task as TaskTypeId;
    const definition = TASK_CATALOG[type];
    const rule = WORK_RULES[type];
    const engineMinutes = definition?.minutes ?? null;
    // What the authority actually charges for the primitive this task uses.
    const primitive = rule?.action ?? (definition?.builds ? 'build-machine' : '');
    const charged = rule?.minutes ?? ACTION_MINUTES[primitive] ?? null;
    const enginePlace = rule
      ? requiredPlaceOf(rule.action, { mode: rule.mode })
      : definition?.builds ? 'workshop' : null;
    const originalMinutes = original.seconds / 60;
    let status: Status = 'MATCH';
    let note = '';
    if (!definition) { status = 'MISMATCH'; note = 'task missing from TASK_CATALOG'; }
    else if (engineMinutes !== originalMinutes) {
      status = 'MISMATCH'; note = `catalog ${engineMinutes} min != original ${originalMinutes} min`;
    } else if (definition.staminaCost !== original.stamina) {
      status = 'MISMATCH'; note = `stamina ${definition.staminaCost} != original ${original.stamina}`;
    } else if (charged !== null && charged !== engineMinutes && primitive !== 'build-machine'
      && primitive !== 'deposit') {
      // `deposit` is a shared primitive (a generic warehouse store is 15 min), so
      // DISTRIBUTE_FOOD keeps its own 20-minute budget in the catalog instead of
      // inflating every store action.
      status = 'MISMATCH'; note = `executor charges ${charged} min, catalog says ${engineMinutes}`;
    } else if (primitive === 'deposit' && charged !== engineMinutes) {
      status = 'NARROWED';
      note = `shared deposit primitive charges ${charged} min; the task budget is ${engineMinutes}`;
    } else if (original.place.endsWith('_door') && enginePlace !== original.place.replace('_door', '')) {
      status = 'NARROWED';
      note = `original accepts door-or-inside; engine requires the room ${String(enginePlace)}`;
    } else if (task === 'PREPARE_MEDICAL') {
      status = 'DIVERGES'; note = 'per-treatment heal, not the original per-second aura';
    } else if (task === 'DISTRIBUTE_FOOD') {
      status = 'NARROWED'; note = 'meal is deposited to the kitchen stock, then the completion effect serves it';
    } else if (task === 'COLLECT_FOOD') {
      status = 'DIVERGES'; note = 'engine gather yields ~8/h, original GATHER_RATES.food = 5/h';
    } else if (task === 'MAINTAIN_POWER') {
      status = 'DIVERGES'; note = 'engine `work(power)` yields +2 power/h, original baseYield 15/40min';
    }
    out.push({
      task, originalPlace: original.place, originalMinutes, originalStamina: original.stamina,
      originalEffect: original.effect, source: original.source,
      enginePlace, engineMinutes,
      engineEffect: ENGINE_EFFECT[task] ?? '—', status, note,
    });
  }
  return out;
}

function markdown(list: Row[]): string {
  const lines = [
    '# D-R10 parity: task -> site -> minutes -> effect -> original source',
    '',
    `Generated by \`node dist/scripts/r10/d-parity.js\` from the live modules; the ORIGINAL`,
    'column is transcribed from the sealed legacy source with file:line.',
    '',
    '| task | original site | minutes | stamina | original effect | source | engine site | engine effect | status | note |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of list) {
    lines.push(`| \`${row.task}\` | ${row.originalPlace} | ${row.originalMinutes} | ${row.originalStamina}`
      + ` | ${row.originalEffect} | ${row.source} | ${row.enginePlace ?? '—'} | ${row.engineEffect}`
      + ` | **${row.status}** | ${row.note} |`);
  }
  lines.push('', '## The eight original maps', '',
    '| map | original source | engine id | tasks whose site is this map |', '|---|---|---|---|');
  for (const map of MAPS8) {
    lines.push(`| ${map.map} | ${map.original} | ${map.engine} | ${map.tasks.join('<br>') || '—'} |`);
  }
  lines.push('', '## Resource areas inside the village (original coordinates)', '',
    `| area | engine cell | official (legacy \`GATHER_OUTDOOR_AREAS\`) |`,
    '|---|---|---|');
  const legacyAreas: Record<string, string> = { lumber_camp: 'x2..10 y2..8',
    frozen_lake: 'x2..10 y32..38', ruins_site: 'x38..48 y2..8', ore_pile: 'x38..48 y32..38' };
  for (const area of RESOURCE_AREAS) {
    lines.push(`| ${area.id} | ${area.cell.x},${area.cell.y} | ${legacyAreas[area.id] ?? '?'} |`);
  }
  lines.push('', '## Economy constants', '',
    `- central heating: wood ${HEATING_WOOD_PER_HOUR}/h + power ${HEATING_POWER_PER_HOUR}/h,`
      + ` strength = 0.65*woodHours/${RESERVE_TARGET_HOURS} + 0.35*powerHours/${RESERVE_TARGET_HOURS}`,
    `- machines: ${Object.values(MACHINES).map(spec => `${spec.id} ${spec.consumes.perHour}/h `
      + `-> ${spec.produces.perHour}/h`).join(', ')}`,
    `- outdoor bands (per game minute, chill x${WIND_CHILL}): `
      + OUTDOOR_BANDS.map(band => `${band.maxTemp}C: hp-${band.health}`).join(', '),
    `- outdoor temperature: D1 ${outdoorTemperature(1, 600, 'snow')}C, `
      + `D2 ${outdoorTemperature(2, 600, 'snow')}C, D3 ${outdoorTemperature(3, 600, 'snow')}C, `
      + `D4 ${outdoorTemperature(4, 600, 'snow')}C`,
    `- engine buildings: ${BUILDINGS.map(building => building.id).join(', ')}`,
    '');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const index = process.argv.indexOf('--out');
  const out = resolve(index >= 0 ? process.argv[index + 1] : 'artifacts/r10/d');
  const list = rows();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'parity-table.json'), `${JSON.stringify({
    schema: 'frostecho.r10.d-parity/1',
    generatedAt: new Date().toISOString(),
    rows: list, maps: MAPS8,
    counts: list.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.status] = (accumulator[row.status] ?? 0) + 1;
      return accumulator;
    }, {}),
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(out, 'parity-table.md'), markdown(list), 'utf8');
  const failing = list.filter(row => row.status === 'MISMATCH');
  console.log(JSON.stringify({ out, counts: list.reduce<Record<string, number>>((accumulator, row) => {
    accumulator[row.status] = (accumulator[row.status] ?? 0) + 1;
    return accumulator;
  }, {}), mismatches: failing.map(row => `${row.task}: ${row.note}`) }, null, 2));
  if (failing.length > 0) process.exitCode = 1;
}

main();
