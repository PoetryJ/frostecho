/**
 * G05 batch CLI.
 * Default: offline reference fixture (zero HTTP, all 12 trajectories).
 * --live uses the HTTP provider (bounded comparison, default cap 60 calls).
 * --verify settles an existing batch read-only.
 * Exit: 0 all scenario judges pass, 1 failure/interruption/budget stop,
 * 2 missing configuration / bad arguments.
 */
import { runFixtureBatch, runLiveBatch } from '../src/needs/eval';
import { verifyNeedsBatch } from '../src/needs/record';

interface CliArgs {
  live: boolean;
  verify: boolean;
  batch: string;
  out: string;
  chains?: ('ac' | 'ca')[];
  maxTotalCalls?: number;
  timeoutMs?: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 8);
  const args: CliArgs = { live: false, verify: false, batch: `g05-fixture-${stamp}`, out: 'artifacts/g05', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') args.live = true;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--batch') args.batch = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '--chain') {
      const chains = (argv[++i] ?? '').split(',').filter(Boolean) as ('ac' | 'ca')[];
      if (chains.some(c => c !== 'ac' && c !== 'ca')) { console.error('--chain accepts ac,ca'); process.exit(2); }
      args.chains = chains;
    } else if (arg === '--max-calls') args.maxTotalCalls = Number(argv[++i]);
    else if (arg === '--timeout') args.timeoutMs = Number(argv[++i]);
    else { console.error(`unknown argument ${arg}`); process.exit(2); }
  }
  if (!args.batch) { console.error('--batch requires a value'); process.exit(2); }
  if (args.maxTotalCalls !== undefined && !Number.isFinite(args.maxTotalCalls)) { console.error('--max-calls requires a number'); process.exit(2); }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string): void => { if (!args.quiet) console.log(line); };
  if (args.verify) {
    const result = verifyNeedsBatch(`${args.out}/${args.batch}`);
    log(`verify ${args.batch}: ${result.ok ? 'ok' : 'FAILED'} (${result.episodes} episodes, httpCalls=${result.httpCalls})`);
    for (const issue of result.issues) log(`  ! ${issue}`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const options = {
    artifactsRoot: args.out,
    batchId: args.batch,
    ...(args.chains !== undefined ? { chains: args.chains } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  };
  if (args.live) {
    const result = await runLiveBatch({
      ...options,
      maxTotalCalls: args.maxTotalCalls ?? 60,
    });
    if (result.aborted !== undefined && result.runs.length === 0) {
      console.error(`FAIL ${result.aborted}`);
      process.exitCode = 2;
      return;
    }
    log(`${result.aborted === undefined ? 'PASS' : 'FAIL'} ${args.batch}: episodes=${result.summary.totals.episodes} scenarioPass=${result.scenarioPass} httpCalls=${result.totalCalls}${result.aborted !== undefined ? ` — ${result.aborted}` : ''}`);
    if (result.health !== undefined) log(`  health: ${result.health.ok ? 'ok' : 'FAIL'} model=${result.health.expectedModel}`);
    process.exitCode = result.aborted === undefined && result.scenarioPass === result.summary.totals.episodes ? 0 : 1;
    return;
  }
  const result = await runFixtureBatch(options);
  log(`${result.scenarioPass === result.summary.totals.episodes ? 'PASS' : 'FAIL'} ${args.batch}: episodes=${result.summary.totals.episodes} scenarioPass=${result.scenarioPass} referenceDecisions=${result.totalCalls}`);
  process.exitCode = result.scenarioPass === result.summary.totals.episodes ? 0 : 1;
}

void main();
