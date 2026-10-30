/**
 * G04 batch CLI.
 * Default: offline reference fixture (zero HTTP). --live uses the HTTP provider.
 * --verify settles an existing batch read-only (never rewrites evidence).
 * Exit: 0 all episodes pass, 1 behavior/configuration failure or interruption,
 * 2 missing configuration / bad arguments.
 */
import { runG04Batch, verifyG04Batch } from '../src/reactive/eval';

interface CliArgs {
  live: boolean;
  verify: boolean;
  batch: string;
  out: string;
  scenarios?: string[];
  orders?: string[];
  policies?: string[];
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const args: CliArgs = { live: false, verify: false, batch: `g04-fixture-${stamp}`, out: 'artifacts/g04', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') args.live = true;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--batch') args.batch = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '--scenario') args.scenarios = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (arg === '--order') args.orders = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (arg === '--policy') args.policies = (argv[++i] ?? '').split(',').filter(Boolean);
    else { console.error(`unknown argument ${arg}`); process.exit(2); }
  }
  if (!args.batch) { console.error('--batch requires a value'); process.exit(2); }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string): void => { if (!args.quiet) console.log(line); };
  if (args.verify) {
    const { exitCode, summary } = verifyG04Batch(`${args.out}/${args.batch}`);
    log(`verify ${args.batch}: ${exitCode === 0 ? 'ok' : 'FAILED'} (${summary.totals.pass}/${summary.rows.length} pass)`);
    for (const row of summary.rows) {
      log(`  ${row.episodeId}: ${row.verdict}${row.valid ? '' : ' [invalid]'} calls=${row.calls}${row.detail ? ` — ${row.detail}` : ''}`);
      for (const issue of row.issues) log(`    ! ${issue}`);
    }
    process.exitCode = exitCode;
    return;
  }
  if (args.live && (!process.env.FROSTECHO_LLM_URL || !process.env.FROSTECHO_LLM_MODEL)) {
    console.error('live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL in the environment');
    process.exitCode = 2;
    return;
  }
  const result = await runG04Batch({
    artifactsRoot: args.out,
    batch: args.batch,
    mode: args.live ? 'live' : 'fixture',
    ...(args.scenarios !== undefined ? { scenarios: args.scenarios } : {}),
    ...(args.orders !== undefined ? { orders: args.orders } : {}),
    ...(args.policies !== undefined ? { policies: args.policies } : {}),
  });
  log(`${result.exitCode === 0 ? 'PASS' : 'FAIL'} ${result.batchDir}: ${result.message}`);
  if (result.health) log(`  health: ${result.health.ok ? 'ok' : 'FAIL'} model=${result.health.expectedModel} modelsPath=${result.health.modelsUrlPath}`);
  process.exitCode = result.exitCode;
}

void main();
