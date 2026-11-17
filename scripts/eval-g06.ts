/**
 * G06 worker D — paired continuous / cross-process-resume comparison.
 *
 * For every scenario (R1-R4) × rotation order (ac/ca):
 *   continuous branch: play to the save point, export the checkpoint, continue
 *   with the scenario tail, export the final checkpoint.
 *   resume branch: the save point is written to an exclusive checkpoint file,
 *   then THIS PROCESS SPAWNS A NEW NODE PROCESS that loads the file, restores
 *   (no model call, no command replay, no new cycle), runs the same tail and
 *   writes its final checkpoint. No in-process clone stands in for a restart.
 *
 * The diff covers the whole checkpoint: engine (state, events, log, processed
 * dedupe index), NPC lifecycle states, cycles/turns, per-session
 * round/feedback/steps/providerCalls, rotation cursor, player/world counters,
 * closed/interrupted and budgets. Excluded: wall-clock timing only.
 *
 * Reference provider is exact — every diff entry is a failure. Exit 0 = 8/8,
 * 1 = a pair diverged, 2 = usage/IO errors.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createNeedsGame, buildNeedsWorld, type NeedsGame } from '../src/needs/game';
import { exportGameCheckpoint, restoreNeedsGame } from '../src/reactive/checkpoint';
import { saveCheckpoint, loadCheckpoint } from '../src/persistence/file-store';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { GameCheckpoint, GameCycleCheckpoint } from '../src/persistence/contracts';

type ScenarioKind = 'r1' | 'r2' | 'r3' | 'r4';
type Chain = 'ac' | 'ca';

const KINDS: readonly ScenarioKind[] = ['r1', 'r2', 'r3', 'r4'];
const CHAINS: readonly Chain[] = ['ac', 'ca'];

const providerFor = () => createReferenceProvider();

function makeGame(kind: ScenarioKind, chain: Chain, episodeId: string): NeedsGame {
  const actorIds = chain === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
  const world = buildNeedsWorld({
    kitchenFood: kind === 'r2' ? 0 : 2,
    hunger: kind === 'r3'
      ? { npc_a: 70, npc_c: 70, npc_b: 40 }
      : { npc_a: 40, npc_c: 40, npc_b: 40 },
  });
  return createNeedsGame({
    episodeId,
    initialState: world,
    actorIds,
    providerFor,
    mode: 'reference',
    needPolicy: 'recurring',
  });
}

/** Actions up to the save point (identical in both branches). */
async function preSave(game: NeedsGame, kind: ScenarioKind): Promise<void> {
  if (kind === 'r1' || kind === 'r4') {
    await game.advance(); // one NPC turn: first actor eats (40→70, food 2→1)
  } else if (kind === 'r2') {
    await game.runUntilIdle(); // both stop hungry on an empty kitchen → waiting
  } else {
    await game.advance(); // goal pre-check at 70: satisfied with zero calls
    game.worldAdvanceTime(2); // 70 → 50
  }
}

/** The tail executed after the save point (identical in both branches). */
async function tail(game: NeedsGame, kind: ScenarioKind): Promise<void> {
  if (kind === 'r1') {
    await game.runUntilIdle(); // the other NPC eats to 70, food 0
  } else if (kind === 'r2') {
    for (let i = 0; i < 100; i += 1) await game.advance(); // 100 idle pumps, no calls
    game.worldRestock('kitchen', 2);
    await game.runUntilIdle(); // both eat to 70, food 0
  } else if (kind === 'r3') {
    for (let i = 0; i < 10; i += 1) await game.advance(); // no calls at hunger 50
    game.worldAdvanceTime(1); // 50 → 40: recurring reactivation opens a new cycle
    await game.runUntilIdle(); // both eat to 70, food 0
  } else {
    const player = game.playerLine('player eat'); // player takes the last food
    if (!player.ok) throw new Error(`r4 player eat rejected: ${player.detail}`);
    await game.runUntilIdle(); // the other NPC finds an empty kitchen → waiting
  }
}

/** Strip wall-clock timing; everything else is compared byte-for-byte. */
function comparable(checkpoint: GameCheckpoint): unknown {
  const clone = JSON.parse(JSON.stringify(checkpoint)) as GameCheckpoint;
  delete (clone as { startedAt?: number }).startedAt;
  for (const list of Object.values(clone.cycles)) {
    for (const cycle of list as GameCycleCheckpoint[]) {
      delete (cycle.session as { timing?: unknown }).timing;
    }
  }
  return clone;
}

function diffValues(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= 40) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of keys) {
      diffValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((item, i) => diffValues(item, b[i], `${path}[${i}]`, out));
    return;
  }
  out.push(`${path}: continuous=${JSON.stringify(a)?.slice(0, 200)} resume=${JSON.stringify(b)?.slice(0, 200)}`);
}

function exportFinal(game: NeedsGame): GameCheckpoint {
  const exported = exportGameCheckpoint(game);
  if (!exported.ok) throw new Error(`export failed: ${exported.code} ${(exported.issues ?? []).join('; ')}`);
  return exported.value;
}

/* ------------------------------------------------------------------ */
/* resume phase: runs in a FRESH node process                          */
/* ------------------------------------------------------------------ */

async function resumePhase(input: string, output: string, kind: ScenarioKind): Promise<number> {
  const loaded = loadCheckpoint(input);
  if (!loaded.ok) {
    console.error(`[resume] load rejected: ${loaded.code} ${(loaded.issues ?? []).join('; ')}`);
    return 2;
  }
  const restored = restoreNeedsGame(loaded.value, { providerFor });
  if (!restored.ok) {
    console.error(`[resume] restore rejected: ${restored.code} ${(restored.issues ?? []).join('; ')}`);
    return 2;
  }
  const game = restored.value as NeedsGame;
  await tail(game, kind);
  const final = exportFinal(game);
  writeFileSync(output, JSON.stringify(final, null, 2) + '\n');
  console.log(`[resume] restored ${final.episodeId} and completed tail '${kind}' (totalCalls=${final.totalCalls})`);
  return 0;
}

function spawnResume(input: string, output: string, kind: ScenarioKind): Promise<{ code: number | null; stderr: string }> {
  const self = resolve(__filename);
  const child = spawn(process.execPath, [self, '--phase', 'resume', '--input', input, '--output', output, '--kind', kind]);
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c; });
  child.stdout.on('data', () => undefined);
  return new Promise(r => child.on('close', code => r({ code, stderr })));
}

/* ------------------------------------------------------------------ */
/* main matrix                                                         */
/* ------------------------------------------------------------------ */

interface PairResult {
  caseId: string;
  kind: ScenarioKind;
  chain: Chain;
  pass: boolean;
  savepointCalls: number;
  finalCalls: number;
  diffs: string[];
  finalStates: Record<string, string>;
  food: number;
  playerHunger: number | null;
}

async function runPair(kind: ScenarioKind, chain: Chain, caseDir: string): Promise<PairResult> {
  const caseId = `${kind}-${chain}`;
  mkdirSync(caseDir, { recursive: true });
  const episodeId = `g06-${caseId}`;

  // Continuous branch: pre → savepoint export → tail → final export.
  const game = makeGame(kind, chain, episodeId);
  await preSave(game, kind);
  const savepoint = exportFinal(game);
  const savepointCalls = savepoint.totalCalls;
  const saved = saveCheckpoint(caseDir, 'savepoint', savepoint);
  if (!saved.ok) throw new Error(`savepoint write failed: ${saved.code} ${(saved.issues ?? []).join('; ')}`);
  await tail(game, kind);
  const continuous = exportFinal(game);
  writeFileSync(join(caseDir, 'continuous.json'), JSON.stringify(continuous, null, 2) + '\n');

  // Resume branch: a NEW process loads the savepoint file and runs the tail.
  const resumePath = join(caseDir, 'resume.json');
  const child = await spawnResume(saved.value.path, resumePath, kind);
  if (child.code !== 0) throw new Error(`resume subprocess exited ${String(child.code)}: ${child.stderr}`);
  const resume = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(resumePath, 'utf8'))) as GameCheckpoint;

  const diffs: string[] = [];
  diffValues(comparable(continuous), comparable(resume), '$', diffs);
  writeFileSync(join(caseDir, 'diff.json'), JSON.stringify({ caseId, pass: diffs.length === 0, diffs }, null, 2) + '\n');
  return {
    caseId,
    kind,
    chain,
    pass: diffs.length === 0,
    savepointCalls,
    finalCalls: continuous.totalCalls,
    diffs,
    finalStates: Object.fromEntries(Object.entries(continuous.states)),
    food: continuous.engine.state.food.kitchen,
    playerHunger: continuous.engine.state.npcs.npc_b?.hunger ?? null,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) args.set(key, argv[++i] ?? '');
  }
  const phase = args.get('--phase') ?? 'matrix';
  if (phase === 'resume') {
    const input = args.get('--input') ?? '';
    const output = args.get('--output') ?? '';
    const kind = args.get('--kind') as ScenarioKind;
    if (!input || !output || !KINDS.includes(kind)) {
      console.error('usage: --phase resume --input <checkpoint> --output <final.json> --kind r1|r2|r3|r4');
      process.exit(2);
    }
    process.exit(await resumePhase(input, output, kind));
  }

  const out = args.get('--out') ?? 'artifacts/g06';
  const batch = args.get('--batch') ?? 'g06-r1';
  const only = args.get('--case');
  const batchDir = join(out, batch);
  mkdirSync(batchDir, { recursive: true });
  const results: PairResult[] = [];
  for (const kind of KINDS) {
    for (const chain of CHAINS) {
      if (only !== undefined && only !== `${kind}-${chain}`) continue;
      const result = await runPair(kind, chain, join(batchDir, `${kind}-${chain}`));
      results.push(result);
      console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.caseId}: savepointCalls=${result.savepointCalls} finalCalls=${result.finalCalls} food=${result.food} states=${JSON.stringify(result.finalStates)} player=${String(result.playerHunger)}${result.pass ? '' : `\n  ${result.diffs.join('\n  ')}`}`);
    }
  }
  const passed = results.filter(r => r.pass).length;
  const summary = {
    schema: 'frostecho.g06.eval/1',
    batch,
    generatedAt: new Date().toISOString(),
    totals: { pairs: results.length, passed, failed: results.length - passed },
    comparison: 'full checkpoint (engine incl. processed dedupe, states, cycles/turns, sessions round/feedback/steps, cursor, player/world counters, budgets); wall-clock timing excluded',
    crossProcess: 'resume branch = save file → exit → new node process loads and continues',
    pairs: results,
  };
  writeFileSync(join(batchDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${passed}/${results.length} pairs identical — evidence in ${batchDir}`);
  process.exit(passed === results.length ? 0 : 1);
}

void main().catch(err => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
