/**
 * Thin CLI entry over the ONE shared four-day driver.
 *
 * R10 shipped this file as a second driver with three undisclosed policies
 * (night walk, day-4 outdoor veto, day-4 outdoor withdrawal) hidden inside the
 * loop. That is why the same seed produced 8/8 here and 4/8 in
 * `scripts/r8/playthrough.ts`. R11 keeps the entry, deletes the second loop:
 * everything below parses flags and calls `runFourDay`.
 *
 *   node dist/scripts/r10/d-fourday.js --seed r11 --out artifacts/r11/d/run \
 *     --strategies reference-survival/1
 *   node dist/scripts/r10/d-fourday.js --seed r11 --out ... --strategies all
 *   node dist/scripts/r10/d-fourday.js --seed r11 --out ... --strategies none
 *
 * `--strategy <preset>` selects `reference-rule/1`, `reference-driver/1` or
 * `reference-survival/1`; `--strategies` takes an explicit comma list and is
 * what the same-seed ablation uses.
 */
import { resolve } from 'node:path';
import { GOSPEL_PROFILE, REFERENCE_PROFILE, type TimeProfile } from '../../src/r7/contracts';
import type { MemoryPolicyId } from '../../src/r7/agency/options';
import { runFourDay, presetOf, strategiesFromList, strategyLabel,
  type FourDayMode, type FourDayStrategies } from '../../src/r7/integration/fourday';

interface Args {
  seed: string; out: string; npc: number; food: number; lives: number;
  memoryPolicy: MemoryPolicyId;
  memorySelection: 'raw-last12' | 'obligation-first';
  commitments: boolean; interference: boolean; originalMap: boolean;
  strategies: FourDayStrategies; mode: FourDayMode; profile: TimeProfile;
  statePath: string; restore: string | null;
  stopAfterDays: number | null; pledgeAfterDay: number | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const out = get('--out');
  if (!out) throw new Error('--out <dir> is required');
  const preset = get('--strategy');
  const list = get('--strategies');
  if (preset && list) throw new Error('use --strategy (preset) or --strategies (list), not both');
  const strategies = preset ? presetOf(preset)
    : list ? strategiesFromList(list) : presetOf('reference-rule/1');
  const profileId = get('--profile') ?? GOSPEL_PROFILE.id;
  const profile = profileId === REFERENCE_PROFILE.id ? REFERENCE_PROFILE : GOSPEL_PROFILE;
  if (profileId !== GOSPEL_PROFILE.id && profileId !== REFERENCE_PROFILE.id) {
    throw new Error(`unknown profile ${profileId}`);
  }
  const mode = (get('--mode') ?? 'reference') as FourDayMode;
  if (mode !== 'reference' && mode !== 'jev-experimental') {
    throw new Error(`unknown mode ${mode}; admitted requires a certificate`);
  }
  const stop = get('--stop-after-days');
  const pledge = get('--pledge-after-day');
  return {
    seed: get('--seed') ?? 'r10-d', out: resolve(out),
    npc: Number(get('--npc') ?? 8), food: Number(get('--food') ?? 130),
    lives: Number(get('--lives') ?? 1),
    memoryPolicy: (get('--memory-policy') ?? 'conditional-experience') as MemoryPolicyId,
    memorySelection: (get('--memory-selection') ?? 'obligation-first') as
      'raw-last12' | 'obligation-first',
    commitments: !argv.includes('--no-commitments'),
    interference: !argv.includes('--no-interference'),
    originalMap: argv.includes('--original-map') || argv.includes('--full-map'),
    strategies, mode, profile,
    statePath: resolve(get('--state') ?? `${resolve(out)}/state.json`),
    restore: get('--restore') ? resolve(get('--restore')!) : null,
    stopAfterDays: stop === undefined ? null : Number(stop),
    pledgeAfterDay: pledge === undefined ? null : Number(pledge),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runFourDay({
    seed: args.seed, npcCount: args.npc, food: args.food, lives: args.lives,
    profile: args.profile, mode: args.mode,
    memoryPolicy: args.memoryPolicy, memorySelection: args.memorySelection,
    strategies: args.strategies, originalMap: args.originalMap,
    commitments: args.commitments, interference: args.interference,
    outDir: args.out, statePath: args.statePath, restoreFrom: args.restore,
    stopAfterDays: args.stopAfterDays, pledgeAfterDay: args.pledgeAfterDay,
  });
  const summary = result.summary;
  const payload = {
    schema: summary.schema, seed: summary.seed, strategy: summary.strategyLabel,
    strategiesOn: summary.strategiesOn, originalMap: summary.originalMap,
    mapProfile: summary.mapProfile,
    ending: summary.ending, survivors: summary.survivors,
    decisions: summary.decisions, decisionStates: summary.decisionStates,
    terminal: summary.terminal, endingCount: summary.endings.length,
    rescues: summary.rescues.length, nightWalks: summary.nightWalks.length,
    weatherVetoes: summary.weatherVetoes.length,
    outdoorWithdrawals: summary.outdoorWithdrawals.length,
    councilRows: summary.council.length, machineEvents: summary.machineEvents.length,
    clockSha256: summary.clockSha256,
    settlementOk: summary.settlement?.ok ?? null,
    out: args.out,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!summary.ending) process.exitCode = 1;
  if (summary.settlement && !summary.settlement.ok) process.exitCode = 1;
  void strategyLabel;
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exit(1);
});
