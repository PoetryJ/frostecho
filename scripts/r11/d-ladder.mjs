#!/usr/bin/env node
/**
 * Same-seed strategy ladder for the ONE four-day driver.
 *
 *   node scripts/r11/d-ladder.mjs --seeds r11-d-base,r11-d-2 --out artifacts/r11/d/ladder
 *   node scripts/r11/d-ladder.mjs --seeds r11-d-base --out ... --original-map
 *
 * Every row runs `dist/scripts/r10/d-fourday.js` with a different explicit
 * strategy set. The output is the difference table: what each switch adds to
 * survival, and which authority receipt proves it. It never edits a rule and
 * never passes `--food` beyond the shared default, so a row cannot "win" by
 * being handed more resources.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PRESETS = ['reference-rule/1', 'reference-schedule/1', 'reference-driver/1',
  'reference-survival/1'];

function args(argv) {
  const get = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    seeds: (get('--seeds') ?? 'r11-d-base').split(',').map(part => part.trim()).filter(Boolean),
    presets: get('--presets')
      ? get('--presets').split(',').map(part => part.trim())
      : get('--arms') ? [] : PRESETS.slice(),
    // Per-switch ablation: each arm is an explicit `--strategies` list.
    arms: get('--arms') ? get('--arms').split('|').map(part => part.trim()) : [],
    out: resolve(get('--out') ?? 'artifacts/r11/d/ladder'),
    originalMap: argv.includes('--original-map'),
    food: get('--food') ?? '130',
  };
}

function run(seed, preset, dir, options) {
  const explicit = options.arms.length > 0;
  const flags = ['dist/scripts/r10/d-fourday.js', '--seed', seed, '--out', dir,
    explicit ? '--strategies' : '--strategy', preset, '--food', options.food];
  if (options.originalMap) flags.push('--original-map');
  const result = spawnSync(process.execPath, flags, { encoding: 'utf8' });
  const summaryPath = join(dir, 'summary.json');
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch {
    return { seed, preset, out: dir, error: (result.stderr || result.stdout || '').slice(-800),
      exitCode: result.status };
  }
  const terminal = summary.terminal;
  return {
    seed, preset, out: dir,
    strategy: summary.strategyLabel,
    strategiesOn: summary.strategiesOn,
    mapProfile: summary.mapProfile,
    ending: summary.ending?.ending ?? null,
    survivors: summary.survivors,
    dead: summary.dead,
    decisions: summary.decisions,
    decisionStates: summary.decisionStates,
    terminal,
    intents: summary.intents,
    rescues: summary.rescues.length,
    nightWalks: summary.nightWalks.length,
    outdoorReturns: (summary.outdoorReturns ?? []).length,
    strandedAtNight: summary.strandedAtNight.length,
    weatherVetoes: summary.weatherVetoes.length,
    outdoorWithdrawals: summary.outdoorWithdrawals.length,
    machineEvents: (summary.machineEvents ?? []).length,
    survivalExits: (summary.survivalExits ?? []).length,
    council: summary.council.reduce((acc, row) => {
      acc[row.verdict] = (acc[row.verdict] ?? 0) + 1; return acc;
    }, {}),
    clockSha256: summary.clockSha256,
    trajectorySha256: summary.trajectorySha256,
    settlementOk: summary.settlement?.ok ?? null,
  };
}

const options = args(process.argv.slice(2));
mkdirSync(options.out, { recursive: true });
const rows = [];
const arms = options.arms.length > 0 ? options.arms : options.presets;
for (const seed of options.seeds) {
  for (const arm of arms) {
    const dir = join(options.out, `${seed}--${arm.replace(/[^a-z0-9]+/gi, '_')}`);
    const row = run(seed, arm, dir, options);
    rows.push(row);
    process.stdout.write(`${seed} ${arm}: survivors=${row.survivors ?? 'ERR'} `
      + `ending=${row.ending ?? 'ERR'} clock=${(row.clockSha256 ?? '').slice(0, 12)}\n`);
  }
}

const lines = [];
lines.push('# Four-day strategy ladder (same seed, one driver)');
lines.push('');
lines.push(`Driver: \`src/r7/integration/fourday.ts\`, entry \`dist/scripts/r10/d-fourday.js\`.`);
lines.push(`Map profile: ${options.originalMap ? 'original 50x40 village + 7 interiors' : 'engine 3-map (frozen)'}.`);
lines.push(`Food: ${options.food} (shared default; no row is handed extra).`);
lines.push('');
lines.push('| seed | strategy | ending | survivors | decisions | applied/rejected/cancelled | rescues | nightWalks | outdoorReturns | vetoes | withdrawals | council accept/decline/counter/reassigned | clockSha256 |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  if (row.error) {
    lines.push(`| ${row.seed} | ${row.preset} | ERROR | | | | | | | | | | \`${String(row.error).replace(/\|/g, '/').slice(0, 120)}\` |`);
    continue;
  }
  const t = row.terminal ?? {};
  const c = row.council ?? {};
  lines.push(`| ${row.seed} | \`${row.strategy}\` | ${row.ending} | ${row.survivors} | `
    + `${row.decisions} | ${t.applied ?? 0}/${t.rejected ?? 0}/${t.cancelled ?? 0} | `
    + `${row.rescues} | ${row.nightWalks} | ${row.outdoorReturns} | ${row.weatherVetoes} | `
    + `${row.outdoorWithdrawals} | ${c.accept ?? 0}/${c.decline ?? 0}/${c.counter ?? 0}/${c.reassigned ?? 0} | `
    + `\`${(row.clockSha256 ?? '').slice(0, 16)}\` |`);
}
lines.push('');
lines.push('## What each switch adds (per seed)');
lines.push('');
for (const seed of options.seeds) {
  const forSeed = rows.filter(row => row.seed === seed && !row.error);
  if (forSeed.length < 2) continue;
  lines.push(`### ${seed}`);
  lines.push('');
  for (let index = 1; index < forSeed.length; index += 1) {
    const before = forSeed[index - 1];
    const after = forSeed[index];
    const added = after.strategiesOn.filter(id => !before.strategiesOn.includes(id));
    lines.push(`- \`${after.strategy}\` vs \`${before.strategy}\`: survivors `
      + `${before.survivors} -> ${after.survivors}, ending ${before.ending} -> ${after.ending}; `
      + `adds ${added.length ? added.map(id => `\`${id}\``).join(', ') : '(nothing)'}; `
      + `receipts: rescues ${before.rescues}->${after.rescues}, `
      + `nightWalks ${before.nightWalks}->${after.nightWalks}, `
      + `outdoorReturns ${before.outdoorReturns}->${after.outdoorReturns}, `
      + `vetoes ${before.weatherVetoes}->${after.weatherVetoes}, `
      + `withdrawals ${before.outdoorWithdrawals}->${after.outdoorWithdrawals}.`);
  }
  lines.push('');
}
writeFileSync(join(options.out, 'ladder.json'), `${JSON.stringify({ options, rows }, null, 2)}\n`);
writeFileSync(join(options.out, 'LADDER.md'), `${lines.join('\n')}\n`);
process.stdout.write(`\n${lines.join('\n')}\n`);
