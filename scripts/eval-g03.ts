/**
 * G03 eval CLI. Default: offline fixture (12 episodes). --live contacts the
 * configured server (env FROSTECHO_LLM_URL/FROSTECHO_LLM_MODEL). Exit codes:
 * 0 all passed (no pending/interrupted, replay consistent); 1 behavior or
 * execution failure; 2 missing config / precondition failure.
 */
import { runG03Batch, verifyG03Batch, type G03Order } from '../src/multi/eval';

interface Args {
  mode: 'fixture' | 'live';
  batch: string | null;
  order: G03Order | null;
  verify: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'fixture', batch: null, order: null, verify: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') args.mode = 'live';
    else if (arg === '--fixture') args.mode = 'fixture';
    else if (arg === '--batch') args.batch = argv[++i] ?? '';
    else if (arg === '--order') {
      const value = argv[++i];
      if (value !== 'ac' && value !== 'ca') { console.error('--order must be ac or ca'); process.exit(2); }
      args.order = value;
    }
    else if (arg === '--verify') args.verify = argv[++i] ?? '';
    else { console.error(`unknown argument ${arg}`); process.exit(2); }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify !== null) {
    const result = verifyG03Batch(args.verify);
    console.log(result.message);
    process.exit(result.exitCode);
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const batch = args.batch ?? (args.mode === 'live' ? `g03-live-${stamp}` : `g03-fixture-${stamp}`);
  const result = await runG03Batch({
    artifactsRoot: 'artifacts/g03',
    batch,
    mode: args.mode,
    order: args.order ?? undefined,
  });
  console.log(result.message);
  process.exit(result.exitCode);
}

void main();
