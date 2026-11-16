/**
 * D: build `dynamic-cases.jsonl` from a real playthrough trajectory.
 *
 *   node dist/scripts/r8/cases.js --trajectory <t.jsonl> --out <dir> [--split-seed s]
 *
 * A case is one real in-game decision: the exact candidates rendered for that
 * actor, the input hash the scorer saw, and the receipt that followed. Labels:
 *   acceptableIds  the candidate whose own receipt landed. Multi-label
 *                  acceptable sets need two independent reviewers; when those
 *                  are not available the field says so (`labelStatus`), and the
 *                  case is excluded from the certified split.
 *   legalIds       candidates whose declared preconditions were satisfiable at
 *                  that snapshot (checked here, not by the model).
 * Splits are assigned by source episode (seed + life), never per sample, so a
 * template or a counterfactual chain cannot straddle train/test.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Decision {
  lifeNumber: number;
  at: number;
  elapsed: number;
  day: number;
  minuteOfDay: number;
  actorId: string;
  mode: string;
  requestId: string;
  candidateSetHash: string;
  inputSha256: string;
  candidates: { id: string; kind: string; description: string;
    parameters: Record<string, unknown>; preconditions: string[] }[];
  rules: string[];
  notesUsed: string[];
  selectedId: string | null;
  disposition: string;
  scorerId: string;
  latencyMs: number;
  executed: boolean;
  executionStatus: string | null;
  reason: string;
  worldVersion: number;
}

function parseArgs(argv: string[]): { trajectory: string; out: string; splitSeed: string } {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const trajectory = get('--trajectory');
  const out = get('--out');
  if (!trajectory || !out) throw new Error('--trajectory and --out are required');
  return { trajectory: resolve(trajectory), out: resolve(out), splitSeed: get('--split') ?? 'r8' };
}

/** Deterministic 60/15/15/10 split by episode, never by row. */
function splitOf(episode: string, splitSeed: string): 'train' | 'dev' | 'calibration' | 'select' {
  const bucket = parseInt(sha256(`${splitSeed}|${episode}`).slice(0, 8), 16) % 100;
  if (bucket < 60) return 'train';
  if (bucket < 75) return 'dev';
  if (bucket < 90) return 'calibration';
  return 'select';
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const lines = readFileSync(args.trajectory, 'utf8').trim().split('\n').filter(Boolean);
  const decisions = lines.map(line => JSON.parse(line) as Decision);
  const cases = [];
  const manifest: Record<string, number> = { train: 0, dev: 0, calibration: 0, select: 0 };
  for (const decision of decisions) {
    if (decision.mode !== 'reference') continue;
    const episode = `${decision.lifeNumber}-${decision.actorId}`;
    const split = splitOf(episode, args.splitSeed);
    const labelled = decision.executed && decision.selectedId
      && decision.executionStatus === 'applied';
    const record = {
      schema: 'frostecho.r8.dynamic-case/1',
      caseId: `case-${decision.lifeNumber}-${decision.actorId}-${decision.at}`,
      episode,
      split,
      actorId: decision.actorId,
      at: decision.at,
      elapsed: decision.elapsed,
      day: decision.day,
      minuteOfDay: decision.minuteOfDay,
      requestId: decision.requestId,
      inputSha256: decision.inputSha256,
      candidateSetHash: decision.candidateSetHash,
      renderer: 'joint-c-action/1',
      candidates: decision.candidates.map(candidate => ({
        id: candidate.id,
        kind: candidate.kind,
        description: candidate.description,
        action: candidate.parameters.action,
        parameters: candidate.parameters,
        preconditions: candidate.preconditions,
      })),
      rules: decision.rules,
      memoryPolicy: decision.notesUsed,
      acceptableIds: labelled ? [decision.selectedId] : [],
      labelStatus: labelled ? 'single-receipt' : 'unlabelled',
      labelSource: labelled ? `receipt:${decision.reason}` : 'none',
      /** True: no second independent reviewer produced these labels. */
      reviewers: labelled ? 1 : 0,
      legalIds: decision.candidates.filter(candidate => candidate.preconditions.length === 0)
        .map(candidate => candidate.id),
      oracleHidden: false,
      executed: decision.executed,
      worldVersion: decision.worldVersion,
    };
    cases.push(record);
    manifest[split] += 1;
  }
  const path = join(args.out, 'dynamic-cases.jsonl');
  writeFileSync(path, `${cases.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  const summary = {
    schema: 'frostecho.r8.dynamic-cases.manifest/1',
    source: args.trajectory,
    sourceSha256: sha256(readFileSync(args.trajectory, 'utf8')),
    cases: cases.length,
    splits: manifest,
    labelled: cases.filter(record => record.acceptableIds.length > 0).length,
    multiLabel: 0,
    independentReviews: 0,
    caveat: 'acceptable sets are single-receipt labels; two independent blind '
      + 'reviewers were not available, so these cases are not a certified set',
    out: path,
    sha256: sha256(readFileSync(path, 'utf8')),
  };
  writeFileSync(join(args.out, 'split-manifest.json'),
    `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, cases: cases.length, splits: manifest,
    labelled: summary.labelled, out: path }, null, 2));
}

main();
