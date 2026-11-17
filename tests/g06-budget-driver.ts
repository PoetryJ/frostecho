/**
 * G06 worker D — budget-boundary resume driver (spawned as a real subprocess).
 *
 * save mode: build a single-actor game with an invalid-output provider, take
 * N steps (each one a real model call that submits nothing), export and save
 * the checkpoint.
 * resume mode: load the file in THIS NEW PROCESS, restore with a counting
 * invalid-output provider, take M more steps, then report the final checkpoint
 * and how many provider calls happened after restore. Restore must not reset
 * the 5-call session budget: the fifth call lands exactly once, and an
 * exhausted session never calls again.
 */
import { writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createNeedsGame, buildNeedsWorld } from '../src/needs/game';
import { exportGameCheckpoint, restoreNeedsGame } from '../src/reactive/checkpoint';
import { saveCheckpoint, loadCheckpoint } from '../src/persistence/file-store';
import type { GameCheckpoint } from '../src/persistence/contracts';

function invalidProvider(counter: { calls: number }): { decide: () => Promise<string> } {
  return {
    decide: async () => {
      counter.calls += 1;
      return 'not-json';
    },
  };
}

function exportOf(game: unknown): GameCheckpoint {
  const r = exportGameCheckpoint(game);
  if (!r.ok) throw new Error(`export: ${r.code} ${(r.issues ?? []).join('; ')}`);
  return r.value;
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i], argv[++i] ?? '');
  }
  const mode = args.get('--mode') ?? '';
  const file = args.get('--file') ?? '';
  const steps = Number(args.get('--steps') ?? '0');
  const counter = { calls: 0 };

  if (mode === 'save') {
    const game = createNeedsGame({
      episodeId: 'g06-budget',
      initialState: buildNeedsWorld({ kitchenFood: 0, hunger: { npc_a: 40, npc_c: 40, npc_b: 40 } }),
      actorIds: ['npc_a'],
      providerFor: () => invalidProvider(counter),
      mode: 'reference',
      needPolicy: 'one-shot',
    });
    for (let i = 0; i < steps; i += 1) await game.advance();
    const checkpoint = exportOf(game);
    const saved = saveCheckpoint(dirname(file), basename(file).replace(/\.g06\.json$/, ''), checkpoint);
    if (!saved.ok) throw new Error(`save: ${saved.code}`);
    writeFileSync(join(dirname(file), 'save-report.json'), JSON.stringify({ providerCalls: counter.calls, totalCalls: checkpoint.totalCalls, status: checkpoint.cycles.npc_a[0].session.status }) + '\n');
    console.log(`saved ${saved.value.path} providerCalls=${counter.calls}`);
    return;
  }
  if (mode === 'resume') {
    const loaded = loadCheckpoint(file);
    if (!loaded.ok) throw new Error(`load: ${loaded.code}`);
    const restored = restoreNeedsGame(loaded.value, { providerFor: () => invalidProvider(counter) });
    if (!restored.ok) throw new Error(`restore: ${restored.code} ${(restored.issues ?? []).join('; ')}`);
    const game = restored.value;
    const outcomes: string[] = [];
    for (let i = 0; i < steps; i += 1) {
      const outcome = await game.advance();
      outcomes.push(outcome.kind);
    }
    const final = exportOf(game);
    writeFileSync(join(dirname(file), 'resume-report.json'), JSON.stringify({
      providerCallsAfterRestore: counter.calls,
      outcomes,
      totalCalls: final.totalCalls,
      sessionProviderCalls: final.cycles.npc_a[0].session.providerCalls,
      sessionStatus: final.cycles.npc_a[0].session.status,
      actorState: final.states.npc_a,
    }, null, 2) + '\n');
    console.log(`resumed: providerCallsAfterRestore=${counter.calls} status=${final.cycles.npc_a[0].session.status}`);
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

void main().catch(err => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
