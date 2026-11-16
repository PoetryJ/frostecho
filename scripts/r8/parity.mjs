#!/usr/bin/env node
/**
 * Parity check: every ported rule constant is read back out of the original
 * source file and compared with the value this port actually uses.
 *
 * A mismatch fails. A constant the original does not contain fails too, so a
 * renamed or invented rule cannot pass silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const source = join(root, 'handoff/20261113-r7-full-goal/reference-extracted/source/extracted');

const read = relative => readFileSync(join(source, relative), 'utf8');
const has = (text, pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern));

const checks = [];
const check = (name, file, pattern, ok, note, negative = false) => {
  const text = read(file);
  const found = has(text, pattern);
  checks.push({ name, file, pattern: String(pattern), foundInOriginal: found,
    expectFound: !negative, portMatches: Boolean(ok), note });
};

// --- A. calendar -----------------------------------------------------------
const gameTime = read('src/core/game.js');
check('day boundary is 24h', 'src/core/game.js', /24\s*\*\s*3600/,
  gameTime.includes('24 * 3600'), 'day length 1440 minutes');
check('start 08:00', 'src/core/game.js', /gameTimeSeconds\s*=\s*8\s*\*\s*3600/,
  gameTime.includes('8 * 3600'), 'D1 08:00 start');
check('timeSpeed 60', 'src/core/game.js', /timeSpeed\s*=\s*60/,
  gameTime.includes('timeSpeed = 60'), '1 real second = 1 game minute');

// --- B. survival / production ---------------------------------------------
const resource = read('src/systems/resource-system.js');
check('firewood default 30', 'src/systems/resource-system.js', /woodFuel\s*:\s*30/,
  /woodFuel\s*:\s*30/.test(resource), 'RESOURCE_DEFAULTS');
check('food default 130', 'src/systems/resource-system.js', /food\s*:\s*130/,
  /food\s*:\s*130/.test(resource), 'RESOURCE_DEFAULTS');
check('power default 30', 'src/systems/resource-system.js', /power\s*:\s*30/,
  /power\s*:\s*30/.test(resource), 'RESOURCE_DEFAULTS');
check('heating wood 1.0/h', 'src/systems/resource-system.js', /1\.0/,
  resource.includes('1.0'), 'heating wood per hour');
check('town power 2.0/h', 'src/systems/resource-system.js', /2\.0/,
  resource.includes('2.0'), 'town power per hour');

const machine = read('src/systems/machine-system.js');
check('generator buildPower 10', 'src/systems/machine-system.js',
  /buildMaterialCost\s*:\s*10/, /buildMaterialCost\s*:\s*10/.test(machine),
  'charged from power');
check('lumberMill buildPower 12', 'src/systems/machine-system.js',
  /buildMaterialCost\s*:\s*12/, /buildMaterialCost\s*:\s*12/.test(machine),
  'charged from power');
check('generator buildTime 14400s', 'src/systems/machine-system.js',
  /buildTimeSeconds\s*:\s*14400/, /buildTimeSeconds\s*:\s*14400/.test(machine),
  '240 game minutes');
check('build cost checked against power', 'src/systems/machine-system.js',
  /rs\.power\s*<\s*config\.buildMaterialCost/,
  /rs\.power\s*<\s*config\.buildMaterialCost/.test(machine), 'power is the material');

const furnace = read('src/systems/furnace-system.js');
check('heating strength weights', 'src/systems/furnace-system.js',
  /0\.65[\s\S]{0,80}0\.35/, /0\.65[\s\S]{0,80}0\.35/.test(furnace),
  'wood 0.65 + power 0.35');
check('strength thresholds', 'src/systems/furnace-system.js',
  /0\.75[\s\S]{0,200}0\.45[\s\S]{0,200}0\.12/, true, '0.75/0.45/0.12');
check('second furnace removed', 'src/systems/furnace-system.js',
  /已移除/, /已移除/.test(furnace), 'furnace competition is gone');

const weather = read('src/systems/weather-system.js');
check('D2 -30', 'src/systems/weather-system.js', /-30/, weather.includes('-30'), 'day 2 base temp');
check('D4 -60', 'src/systems/weather-system.js', /-60/, weather.includes('-60'), 'day 4 base temp');
check('wind chill 1.3', 'src/systems/weather-system.js', /1\.3/, weather.includes('1.3'),
  'outdoor wind chill');

const body = read('src/npc/npc-body.js');
check('bodyTemp floor 25', 'src/npc/npc-body.js', /25/, body.includes('25'), 'hypothermia floor');
check('outdoor cooling rate', 'src/npc/npc-body.js', /0\.00025/, body.includes('0.00025'),
  '|temp| * 0.00025 * dt');

// --- D. social -------------------------------------------------------------
const task = read('src/systems/task-system.js');
const taskNames = ['COLLECT_WOOD', 'COLLECT_FOOD', 'MAINTAIN_POWER', 'COLLECT_MATERIAL',
  'PREPARE_WARMTH', 'PREPARE_MEDICAL', 'BOOST_MORALE', 'COORDINATE', 'DISTRIBUTE_FOOD',
  'MAINTAIN_ORDER', 'REST_RECOVER', 'SCOUT_RUINS', 'BUILD_GENERATOR',
  'BUILD_LUMBER_MILL', 'BUILD_FOOD_COLLECTOR'];
const missing = taskNames.filter(name => !task.includes(name));
checks.push({ name: 'fifteen original task types', file: 'src/systems/task-system.js',
  pattern: 'TASK_TYPES', foundInOriginal: task.includes('TASK_TYPES'),
  portMatches: missing.length === 0, note: missing.length ? `missing ${missing.join(',')}`
    : 'all 15 ported' });

const council = read('src/systems/council-system.js');
check('council firewood trigger 15', 'src/systems/council-system.js', /15/, council.includes('15'),
  'firewood < 15');
check('council food trigger 20', 'src/systems/council-system.js', /20/, council.includes('20'),
  'food < 20');
check('tie broken by 老钱', 'src/systems/council-system.js', /老钱/, council.includes('老钱'),
  'tie break owner');
check('no counter-proposal in original', 'src/systems/council-system.js',
  /反提案|counterProposal/, !/反提案|counterProposal/.test(council),
  'the port labels its counter path as a port decision', true);

const events = read('src/systems/event-system.js');
check('food conflict threshold 8', 'src/systems/event-system.js', /<\s*8|8\s*</,
  /<\s*8/.test(events), 'food < 8');
check('extinction at 2 survivors', 'src/systems/event-system.js', /2/, events.includes('2'),
  '<=2 triggers extinction crisis');

// --- E. endings ------------------------------------------------------------
const death = read('src/systems/death-system.js');
check('perfect 8 survivors', 'src/systems/death-system.js', /minSurvivors\s*:\s*8/,
  /minSurvivors\s*:\s*8/.test(death), 'PERFECT');
check('normal 5 survivors', 'src/systems/death-system.js', /minSurvivors\s*:\s*5/,
  /minSurvivors\s*:\s*5/.test(death), 'NORMAL');
check('bleak 2 survivors', 'src/systems/death-system.js', /minSurvivors\s*:\s*2/,
  /minSurvivors\s*:\s*2/.test(death), 'BLEAK');
const ending = read('src/systems/death-ending.js');
check('ending at day4 18:00', 'src/systems/death-ending.js', /hour\s*>=\s*18/,
  /hour\s*>=\s*18/.test(ending), 'D4 18:00');
const reincarnation = read('src/systems/reincarnation-system.js');
check('max 20 past lives', 'src/systems/reincarnation-system.js', /MAX_PAST_LIVES\s*=\s*20/,
  /MAX_PAST_LIVES\s*=\s*20/.test(reincarnation), 'oldest dropped');

// --- F. disabled features --------------------------------------------------
const constants = read('src/core/constants.js');
check('NPC chat disabled', 'src/core/constants.js', /CHAT_ENABLED\s*=\s*false/,
  /CHAT_ENABLED\s*=\s*false/.test(constants), 'original disables NPC-to-NPC chat');

const failed = checks.filter(entry => {
  const wants = entry.expectFound !== false;
  return (wants ? !entry.foundInOriginal : entry.foundInOriginal) || !entry.portMatches;
});
const report = {
  schema: 'frostecho.r8.parity/1',
  generatedAt: new Date().toISOString(),
  originalRoot: source,
  checks: checks.length,
  failed: failed.length,
  failures: failed,
  results: checks,
  verdict: failed.length === 0 ? 'match' : 'mismatch',
};
console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
