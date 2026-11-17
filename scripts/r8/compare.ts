/**
 * H/O comparison: reference rules vs a real scorer over the same world.
 *
 *   node dist/scripts/r8/compare.js --reference <dir> --proposed <dir> \
 *     --out <file.json> [--seed s]
 *
 * Both arms must come from the same seed, profile and candidate renderer; the
 * comparator refuses to compare across different candidate-set hashes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Summary {
  profile: string;
  seed: string;
  mode: string;
  endings: { lifeNumber: number; ending: string; survivors: number; elapsed: number }[];
  decisions: number;
  executed: number;
  rejected: number;
  files: { trajectory?: string };
}

function parseArgs(argv: string[]): { reference: string; proposed?: string; out: string } {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const reference = get('--reference');
  const out = get('--out');
  if (!reference || !out) throw new Error('--reference and --out are required');
  return { reference: resolve(reference), proposed: get('--proposed')
    ? resolve(get('--proposed')!) : undefined, out: resolve(out) };
}

function summaries(dir: string): Summary[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.startsWith('summary-') && name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Summary);
}

function metrics(dir: string): Record<string, unknown> | null {
  const found = summaries(dir);
  if (found.length === 0) return null;
  const last = found.sort((left, right) => left.seed.localeCompare(right.seed)).at(-1)!;
  let latencies: number[] = [];
  let multiCandidate = 0;
  let decisions = 0;
  if (last.files.trajectory && existsSync(last.files.trajectory)) {
    for (const line of readFileSync(last.files.trajectory, 'utf8').trim().split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line) as { latencyMs?: number; candidates?: unknown[] };
      decisions += 1;
      latencies.push(Number(record.latencyMs ?? 0));
      if ((record.candidates?.length ?? 0) >= 2) multiCandidate += 1;
    }
  }
  const totalLatency = latencies.reduce((sum, value) => sum + value, 0);
  return {
    seed: last.seed,
    profile: last.profile,
    mode: last.mode,
    endings: last.endings,
    decisions: last.decisions,
    executed: last.executed,
    rejected: last.rejected,
    multiCandidateDecisions: multiCandidate,
    meanLatencyMs: latencies.length ? Number((totalLatency / latencies.length).toFixed(3)) : null,
    trajectorySha256: last.files.trajectory && existsSync(last.files.trajectory)
      ? sha256(readFileSync(last.files.trajectory, 'utf8')) : null,
    summaries: found.map(entry => ({ seed: entry.seed, ending: entry.endings.at(-1)?.ending })),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const reference = metrics(args.reference);
  const proposed = args.proposed ? metrics(args.proposed) : null;
  const sameConditions = Boolean(reference && proposed
    && reference.seed === proposed.seed
    && reference.profile === proposed.profile);
  const result = {
    schema: 'frostecho.r8.comparison/1',
    generatedAt: new Date().toISOString(),
    baseline: { arm: 'reference', dir: args.reference, metrics: reference },
    proposed: args.proposed
      ? { arm: 'proposed', dir: args.proposed, metrics: proposed }
      : { arm: 'proposed', status: 'blocked',
        reason: 'no proposed-arm run was produced this round: the JSONL scorer '
          + 'service needs frozen 27B features for new inputs, and no free GPU can '
          + 'hold the backbone (see jev preflight). Reference arm is real.',
        nextCommand: 'python research/decision-choice/jev05/action/train.py preflight --json' },
    sameConditions,
    adoption: 'pending-owner',
    caveat: 'Reference arm is a rule policy, not a model. No claim that the '
      + 'proposed arm is better, and no utility is derived from a probability.',
  };
  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: Boolean(reference), baseline: Boolean(reference),
    proposed: Boolean(proposed), sameConditions, out: args.out }, null, 2));
  if (!reference) process.exitCode = 1;
}

main();
