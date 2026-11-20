/**
 * R8 playable entry: one real run from D1 08:00 to the D4 18:00 ending, then
 * (optionally) the reincarnation cycle.
 *
 *   node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --seed r8-1 \
 *     --mode reference --out artifacts/sprint-r8/O/<runId>
 *
 * R11: this file no longer contains a driver. It parses flags, calls the ONE
 * shared four-day loop (`runFourDay`) and writes the R8 report over the result.
 * Everything the R10 runner did inline — the council, the pledges, the D2
 * interference, the survival exit, the routed rescue, the night walk and the
 * clock — lives in `src/r7/integration/fourday.ts`, together with the explicit
 * strategy switches. A policy difference can therefore no longer hide in a
 * second driver.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GOSPEL_PROFILE, REFERENCE_PROFILE, type TimeProfile } from '../../src/r7/contracts';
import type { MemoryPolicyId } from '../../src/r7/agency/options';
import { JointScorerClient, parseScorerCommand } from '../../src/r7/ui/joint-scorer';
import { auditSettlement, saveFourDaySidecars } from '../../src/r7/integration/sidecar';
import { FourDayRunner, holdCouncil, notesFor, presetOf, readFourDayRunnerState, strategiesFromList,
  type DecisionRow, type FourDayMode, type FourDayStrategies, type MemorySelection }
  from '../../src/r7/integration/fourday';

export { notesFor };

type Mode = FourDayMode;

interface Args {
  profile: TimeProfile;
  seed: string;
  mode: Mode;
  out: string;
  lives: number;
  npcCount: number;
  food: number;
  memoryPolicy: MemoryPolicyId;
  memorySelection: MemorySelection;
  scorerCommand: string[] | null;
  originalMap: boolean;
  noCommitments: boolean;
  strategies: FourDayStrategies;
  state: string;
  restore: string | null;
  stopAfterDays: number | null;
  pledgeAfterDay: number | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const profileId = get('--profile') ?? GOSPEL_PROFILE.id;
  const profile = profileId === REFERENCE_PROFILE.id ? REFERENCE_PROFILE : GOSPEL_PROFILE;
  if (profileId !== GOSPEL_PROFILE.id && profileId !== REFERENCE_PROFILE.id) {
    throw new Error(`unknown profile ${profileId}`);
  }
  const mode = (get('--mode') ?? 'reference') as Mode;
  if (mode === 'jev-admitted') {
    throw new Error('admitted mode requires a verified certificate; use jev-experimental');
  }
  if (mode !== 'reference' && mode !== 'jev-experimental') throw new Error(`unknown mode ${mode}`);
  const out = get('--out');
  if (!out) throw new Error('--out <newDir> is required');
  const memorySelection = (get('--memory-selection') ?? 'obligation-first') as MemorySelection;
  if (!['raw-last12', 'obligation-first'].includes(memorySelection)) {
    throw new Error(`unknown memory selection ${memorySelection}`);
  }
  const scorer = get('--scorer-command-json') ?? process.env.FROSTECHO_SCORER_COMMAND_JSON;
  if (mode !== 'reference' && !scorer) {
    throw new Error('jev-experimental requires --scorer-command-json');
  }
  const restore = get('--restore');
  const stopAfterDays = get('--stop-after-days') === undefined
    ? null : Number(get('--stop-after-days'));
  if (stopAfterDays !== null && (!Number.isInteger(stopAfterDays) || stopAfterDays < 1)) {
    throw new Error(`invalid --stop-after-days ${String(stopAfterDays)}`);
  }
  if (restore && stopAfterDays !== null) {
    throw new Error('--restore and --stop-after-days are mutually exclusive');
  }
  const pledgeAfterDay = get('--pledge-after-day') === undefined
    ? null : Number(get('--pledge-after-day'));
  if (pledgeAfterDay !== null && (!Number.isInteger(pledgeAfterDay) || pledgeAfterDay < 1)) {
    throw new Error(`invalid --pledge-after-day ${String(pledgeAfterDay)}`);
  }
  if (restore && pledgeAfterDay !== null) {
    throw new Error('--restore adopts the pledges recorded in the save');
  }
  const preset = get('--strategy');
  const list = get('--strategies');
  if (preset && list) throw new Error('use --strategy (preset) or --strategies (list), not both');
  return {
    profile, seed: get('--seed') ?? 'r8-1', mode, out: resolve(out),
    lives: Number(get('--lives') ?? 1),
    npcCount: Number(get('--npc') ?? 8), food: Number(get('--food') ?? 130),
    memoryPolicy: (get('--memory-policy') ?? 'conditional-experience') as MemoryPolicyId,
    memorySelection,
    // The playable entry runs the frozen reference rules with NO driver policy
    // unless one is asked for; `--strategy reference-survival/1` is the arm that
    // walks home, restarts machines, vetoes the lethal outdoors, withdraws the
    // outdoor board, routes the rescue and records the survival exit.
    strategies: preset ? presetOf(preset)
      : list ? strategiesFromList(list) : presetOf('reference-rule/1'),
    scorerCommand: scorer ? parseScorerCommand(scorer) : null,
    originalMap: argv.includes('--original-map') || argv.includes('--full-map'),
    noCommitments: argv.includes('--no-commitments'),
    state: resolve(get('--state') ?? join(resolve(out), 'state.json')),
    restore: restore ? resolve(restore) : null,
    stopAfterDays, pledgeAfterDay,
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface RunReport {
  schema: 'frostecho.r8.playthrough/1';
  profile: string; seed: string; mode: Mode; memoryPolicy: MemoryPolicyId;
  sourceHEAD: string | null; startedAt: string; lives: number;
  strategy: string; strategiesOn: string[];
  originalMap: boolean; mapProfile: string | null;
  endings: { lifeNumber: number; ending: string; survivors: number;
    elapsed: number; at: number }[];
  decisions: number; executed: number; rejected: number;
  rejections: { code: string; reason: string }[];
  settlement?: {
    intents: number; pending: number;
    terminal: { applied: number; rejected: number; cancelled: number; unresolved: number };
    decisionStates: Record<string, number>; receipts: number;
    rejectedAtSettlement: { actorId: string; intentId: string; action: string;
      reason: string | null }[];
    unsettledWork: { actorId: string; selectedId: string | null; requestId: string }[];
    scope: 'fresh-run' | 'restored-process';
    reconciled: boolean;
  };
  council: FourDayRunner['council'];
  /** Set when this process continued another process's save (D2 story). */
  restore?: { from: string; savedAt: string | null; clock: number;
    commitments: number; pendingIntents: number;
    commitmentsCarried: { commitmentId: string; goal: string; status: string;
      revision: number; promisorId: string }[] };
  files: Record<string, string>;
  environment: Record<string, unknown>;
  stopped?: { requestedDay: number; day: number; simTime: number; pending: number;
    state: string };
}

/**
 * Compatible wrapper kept for `scripts/play-sprint.ts`: the same board, reached
 * through the shared module instead of a private copy.
 */
export function runCouncilIfDue(runtime: Parameters<typeof holdCouncil>[0],
  _decisions: unknown[] = [], _seed = ''): void {
  holdCouncil(runtime);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const runId = `${args.mode}-${args.seed}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const service = args.mode === 'reference' ? null
    : new JointScorerClient(process.cwd(), args.scorerCommand!,
      Number(process.env.FROSTECHO_SCORER_TIMEOUT_MS ?? 300000),
      join(args.out, `scorer-${runId}.jsonl`));
  const runner = new FourDayRunner({
    seed: args.seed, npcCount: args.npcCount, food: args.food, lives: args.lives,
    profile: args.profile, mode: args.mode, memoryPolicy: args.memoryPolicy,
    memorySelection: args.memorySelection, strategies: args.strategies,
    originalMap: args.originalMap, commitments: !args.noCommitments,
    interference: true, scorer: service, outDir: args.out,
    statePath: args.state, restoreFrom: args.restore,
    stopAfterDays: args.stopAfterDays, pledgeAfterDay: args.pledgeAfterDay,
  });
  let result: Awaited<ReturnType<FourDayRunner['run']>>;
  try {
    result = await runner.run();
  } catch (error) {
    writeFileSync(join(args.out, `failure-${runId}.json`), `${JSON.stringify({
      error: (error as Error).message, decisions: runner.decisions.length,
      simTime: runner.runtime.world.simTime, mode: args.mode,
      countsAsAdmitted: false }, null, 2)}\n`);
    try { saveFourDaySidecars(runner.runtime, runner.play, join(args.out, `partial-${runId}.json`)); }
    catch { /* a crash before the session exists has nothing to save */ }
    service?.close();
    throw error;
  } finally { service?.close(); }

  const summary = result.summary;
  const intents = [...result.runtime.intents.values()];
  const decisionStates: Record<string, number> = { ...summary.decisionStates };
  const unsettled = runner.decisions.filter(row => row.executionStatus === 'working')
    .filter(row => !intents.some(intent => intent.actorId === row.actorId
      && intent.candidateId === row.selectedId && intent.status !== 'working'))
    .map(row => ({ actorId: row.actorId, selectedId: row.selectedId, requestId: row.requestId }));
  const settlementRejections = intents.filter(intent => intent.status === 'rejected');
  const audit = auditSettlement(result.runtime, result.play);
  const report: RunReport = {
    schema: 'frostecho.r8.playthrough/1', profile: args.profile.id, seed: args.seed,
    mode: args.mode, memoryPolicy: args.memoryPolicy,
    sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
    startedAt: new Date().toISOString(), lives: args.lives,
    strategy: summary.strategyLabel, strategiesOn: summary.strategiesOn,
    originalMap: summary.originalMap, mapProfile: summary.mapProfile,
    endings: summary.endings,
    decisions: summary.decisions,
    executed: summary.decisionStates.applied ?? 0,
    rejected: (summary.decisionStates.rejected ?? 0) + settlementRejections.length,
    rejections: result.runtime.rejections.map(entry => ({ code: entry.code,
      reason: entry.reason })),
    settlement: { intents: summary.intents, pending: summary.terminal
      ? intents.filter(intent => intent.status === 'working').length : 0,
      terminal: summary.terminal, decisionStates, receipts: result.runtime.committedEvents().length,
      rejectedAtSettlement: summary.rejectedAtSettlement, unsettledWork: unsettled,
      scope: args.restore ? 'restored-process' : 'fresh-run',
      reconciled: unsettled.length === 0 && (args.restore ? audit.ok : true) },
    council: summary.council,
    files: { ...summary.files },
    environment: { node: process.version, platform: process.platform,
      originalMap: args.originalMap, strategy: summary.strategyLabel,
      scorerIdentity: { ...(service?.identity ?? { scorerId: 'reference-rule/1' }) },
      duplicateDemands: result.runtime.duplicateDemands.length,
      rescues: summary.rescues.length, nightWalks: summary.nightWalks.length,
      weatherVetoes: summary.weatherVetoes.length,
      outdoorWithdrawals: summary.outdoorWithdrawals.length },
  };
  if (args.restore) {
    const saved = readFourDayRunnerState(args.restore);
    report.restore = {
      from: args.restore, savedAt: saved.savedAt,
      clock: result.runtime.world.simTime,
      commitments: result.play.commitments.all().length,
      pendingIntents: intents.filter(intent => intent.status === 'working').length,
      commitmentsCarried: result.play.commitments.all().map(row => ({
        commitmentId: row.commitmentId, goal: row.goal, status: row.status,
        revision: row.revision, promisorId: row.promisorId })),
    };
  }
  if (runner.runner.stopAfterDays !== null && !summary.ending) {
    report.stopped = { requestedDay: runner.runner.stopAfterDays,
      day: summary.endedAt > 0 ? Math.floor(summary.endedAt / args.profile.minutesPerDay)
        + args.profile.startDay : 0,
      simTime: summary.endedAt,
      pending: intents.filter(intent => intent.status === 'working').length,
      state: args.state };
  }
  const summaryPath = join(args.out, `summary-${runId}.json`);
  const auditPath = join(args.out, `settlement-audit-${runId}.json`);
  const runtimePath = join(args.out, `runtime-${runId}.json`);
  writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  writeFileSync(runtimePath, `${JSON.stringify(result.runtime.toDocument(), null, 2)}\n`, 'utf8');
  report.files.summary = summaryPath;
  report.files.settlementAudit = auditPath;
  report.files.runtimeDocument = runtimePath;
  report.files.trajectorySha256 = summary.trajectorySha256;
  report.files.clockSha256 = summary.clockSha256;
  writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const last = summary.endings.at(-1);
  console.log(JSON.stringify({ ok: Boolean(last) || Boolean(report.stopped),
    profile: args.profile.id, seed: args.seed, mode: args.mode, lives: args.lives,
    strategy: summary.strategyLabel, originalMap: summary.originalMap,
    ending: last?.ending ?? null, survivors: last?.survivors ?? null,
    elapsed: last?.elapsed ?? null, decisions: report.decisions,
    executed: report.executed, rejected: report.rejected, out: args.out,
    summary: summaryPath, state: args.state, stopped: report.stopped ?? null,
    clockSha256: summary.clockSha256, settlementAuditOk: audit.ok }, null, 2));
  if (!last && !report.stopped) process.exitCode = 1;
  if (!audit.ok) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exit(1);
});

export type { DecisionRow };
