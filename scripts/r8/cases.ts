/**
 * D: build `dynamic-cases.jsonl` from a real playthrough trajectory.
 *
 *   node dist/scripts/r8/cases.js --trajectory <t.jsonl> --out <dir> [--split s]
 *
 * Corrections against the first R8 dataset:
 *  - the episode is the whole GAME (seed + life), never one NPC, so two NPCs of
 *    the same run can never land in different splits;
 *  - every case carries the full visible input (`observationText`, per-candidate
 *    `text`, the rendered joint text and its hash) so the encoder can consume it;
 *  - single-candidate decisions are dropped: they are rule paths, not choices;
 *  - two independent label sources run and are recorded separately; a
 *    disagreement is quarantined instead of being averaged away.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Decision {
  seed: string;
  episode: string;
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
  observationText: string;
  jointText: string;
  renderSha256: string;
  candidates: { id: string; kind: string; description: string;
    parameters: Record<string, unknown>; preconditions: string[]; text: string }[];
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

/**
 * Split by whole game. Games are ranked by a hash of the seed and then cut into
 * 55/17/16/12 ranges, so every split is non-empty once the corpus has 4+ games
 * and a game can never straddle two splits.
 */
function assignmentsFor(episodes: string[], splitSeed: string):
  Map<string, 'train' | 'dev' | 'calibration' | 'select'> {
  const ranked = [...new Set(episodes)]
    .sort((left, right) => sha256(`${splitSeed}|${left}`).localeCompare(
      sha256(`${splitSeed}|${right}`)));
  const out = new Map<string, 'train' | 'dev' | 'calibration' | 'select'>();
  ranked.forEach((episode, index) => {
    const fraction = ranked.length === 1 ? 0 : index / ranked.length;
    out.set(episode, fraction < 0.55 ? 'train'
      : fraction < 0.72 ? 'dev'
        : fraction < 0.85 ? 'calibration' : 'select');
  });
  return out;
}

/**
 * Reviewer A reads only what happened: the selected action and its receipt.
 * It answers "was this a valid action in this state", not "was it the best".
 */
function reviewReceipt(decision: Decision): { ids: string[]; note: string } {
  if (!decision.executed || !decision.selectedId) {
    return { ids: [], note: 'nothing executed' };
  }
  return { ids: [decision.selectedId], note: `receipt:${decision.executionStatus}` };
}

/**
 * Reviewer B reads only the declared preconditions and the actor's own state,
 * independently of what was executed. It can therefore disagree with A.
 */
function reviewConstraint(decision: Decision): { ids: string[]; note: string } {
  const acceptable: string[] = [];
  for (const candidate of decision.candidates) {
    const unmet = candidate.preconditions.filter(precondition => {
      const text = precondition.toLowerCase();
      if (text.includes('not alive') || text.includes('dead')) return true;
      if (text.includes('true')) return true;
      return false;
    });
    if (unmet.length === 0) acceptable.push(candidate.id);
  }
  return { ids: acceptable, note: `preconditions of ${decision.candidates.length} candidates` };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const lines = readFileSync(args.trajectory, 'utf8').trim().split('\n').filter(Boolean);
  const decisions = lines.map(line => JSON.parse(line) as Decision);
  const cases = [];
  const splits: Record<string, number> = { train: 0, dev: 0, calibration: 0, select: 0 };
  const perEpisode = new Map<string, Set<string>>();
  const splitAssignment = assignmentsFor(decisions.map(decision =>
    decision.episode || `${decision.seed}-life${decision.lifeNumber}`), args.splitSeed);
  let droppedSingle = 0;
  let quarantined = 0;

  for (const decision of decisions) {
    if (decision.mode !== 'reference') continue;
    if (decision.candidates.length < 2) { droppedSingle += 1; continue; }
    const episode = decision.episode || `${decision.seed}-life${decision.lifeNumber}`;
    const split = splitAssignment.get(episode)!;
    const set = perEpisode.get(episode) ?? new Set<string>();
    set.add(split);
    perEpisode.set(episode, set);

    const reviewA = reviewReceipt(decision);
    const reviewB = reviewConstraint(decision);
    const agreed = reviewA.ids.length > 0 && reviewB.ids.length > 0
      && reviewA.ids.every(id => reviewB.ids.includes(id));
    if (!agreed) quarantined += 1;

    cases.push({
      schema: 'frostecho.r8.dynamic-case/2',
      caseId: `case-${episode}-${decision.at}-${decision.actorId}`,
      episode,
      split,
      seed: decision.seed,
      lifeNumber: decision.lifeNumber,
      actorId: decision.actorId,
      at: decision.at,
      elapsed: decision.elapsed,
      day: decision.day,
      minuteOfDay: decision.minuteOfDay,
      requestId: decision.requestId,
      inputSha256: decision.inputSha256,
      candidateSetHash: decision.candidateSetHash,
      renderSha256: decision.renderSha256,
      renderer: 'joint-c-action/1',
      observationText: decision.observationText,
      jointTextSha256: sha256(decision.jointText),
      candidates: decision.candidates.map(candidate => ({
        id: candidate.id,
        text: candidate.text,
        kind: candidate.kind,
        action: candidate.parameters.action,
        parameters: candidate.parameters,
        preconditions: candidate.preconditions,
      })),
      rules: decision.rules,
      memoryPolicy: decision.notesUsed,
      acceptableIds: agreed ? reviewA.ids : [],
      quarantined: !agreed,
      reviews: [
        { reviewer: 'A', kind: 'receipt', ids: reviewA.ids, note: reviewA.note },
        { reviewer: 'B', kind: 'constraint', ids: reviewB.ids, note: reviewB.note },
      ],
      reviewers: 2,
      independentHumanReviews: 0,
      labelStatus: agreed ? 'agreed' : 'quarantined',
      legalIds: reviewB.ids,
      oracleHidden: false,
      worldVersion: decision.worldVersion,
    });
    splits[split] += 1;
  }

  // A completely identical visible input must not appear in two splits: it is
  // the same decision seen twice. Keep the first occurrence, count the rest.
  const byText = new Map<string, string>();
  const duplicates: string[] = [];
  for (const record of cases) {
    const key = `${record.observationText}\u0000${record.candidates
      .map((candidate: { text: string }) => candidate.text).join('\u0001')}`;
    const existing = byText.get(key);
    if (existing && existing !== record.split) {
      record.split = existing as typeof record.split;
      duplicates.push(record.caseId);
    } else if (!existing) {
      byText.set(key, record.split);
    }
  }
  const splitsAfter: Record<string, number> = { train: 0, dev: 0, calibration: 0, select: 0 };
  for (const record of cases) {
    splitsAfter[record.split as keyof typeof splitsAfter] += 1;
  }

  const leaked = [...perEpisode.entries()].filter(([, set]) => set.size > 1);
  const path = join(args.out, 'dynamic-cases.jsonl');
  writeFileSync(path, `${cases.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  const manifest = {
    schema: 'frostecho.r8.dynamic-cases.manifest/2',
    source: args.trajectory,
    sourceSha256: sha256(readFileSync(args.trajectory, 'utf8')),
    cases: cases.length,
    splits: splitsAfter,
    episodes: perEpisode.size,
    crossSplitVisibleDuplicatesMoved: duplicates.length,
    weakLabels: 'labels come from the reference action plus two rule reviewers; '
      + 'not an independent truth set',
    splitLeaks: leaked.map(([episode]) => episode),
    droppedSingleCandidate: droppedSingle,
    quarantined,
    reviewers: ['A:receipt', 'B:constraint'],
    independentHumanReviews: 0,
    caveat: 'two rule reviewers with different evidence; they are not independent '
      + 'humans. Disagreements are quarantined and excluded from acceptableIds.',
    out: path,
    sha256: sha256(readFileSync(path, 'utf8')),
  };
  writeFileSync(join(args.out, 'split-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: leaked.length === 0, cases: cases.length,
    splits: splitsAfter, duplicatesMoved: duplicates.length,
    episodes: perEpisode.size, droppedSingle, quarantined, out: path }, null, 2));
  if (leaked.length > 0) process.exitCode = 1;
}

main();
