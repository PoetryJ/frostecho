/**
 * A: capture the REAL controller -> Provider DecideInput boundary offline.
 *
 * Uses the shipped fixture providers (no socket, no model, no HTTP) and wraps
 * only the provider object in memory. It records a PROJECTION of the input,
 * never a label, and proves two zero-call boundaries (a closed game and an
 * already-satisfied actor).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createG10Runtime } from '../../../../src/application/adapters';
import { createApplicationController } from '../../../../src/application/session';
import { parseInput } from '../../../../src/application/commands';
import type { ApplicationController } from '../../../../src/application/contracts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const OUT = join(__dirname, 'captures.json');
const captures: Record<string, unknown>[] = [];

async function open(fixture: 'w1' | 'w2' | 'cooperate' | 'decline' | 'violate', startHunger?: number) {
  const root = mkdtempSync(join(tmpdir(), 'jevcap-'));
  const built = createG10Runtime({
    root, slot: 'cap', goals: 'negotiated', candidates: 'choice', satiety: 40,
    fixture, live: false, http: '', model: null, campaign: null, campaignLimit: null,
    ...(startHunger !== undefined ? { startHunger } : {}),
  });
  if (!built.ok) throw new Error(`runtime refused: ${(built.issues ?? []).join('; ')}`);
  const runtime = built.value;
  const game = runtime.game as unknown as { options: { providerFor: () => { decide: (input: any, signal?: unknown) => Promise<string> } } };
  const original = game.options.providerFor;
  let calls = 0;
  const wrap = (inner: { decide: (input: any, signal?: unknown) => Promise<string> }) => ({
    async decide(input: any, signal?: unknown) {
      calls += 1;
      captures.push({
        fixture,
        phase: input.goalChoice !== undefined ? 'goal' : 'action',
        projection: {
          observation: input.observation,
          goal: input.goal,
          activeGoal: input.activeGoal ?? null,
          goalLine: input.goalLine ?? null,
          feedback: input.feedback,
          allowedActions: input.allowedActions ?? null,
          goalOptions: input.goalChoice?.options ?? null,
          requestText: input.goalChoice?.text ?? null,
          inputSha256: sha256(JSON.stringify(input)),
        },
      });
      return inner.decide(input, signal);
    },
  });
  // Cycles that already exist were built in the constructor: wrap them too.
  const sessions = (game as any).sessionsOf?.() ?? [];
  for (const entry of sessions) {
    const session = entry.session as any;
    if (session?.options?.provider) session.options.provider = wrap(session.options.provider);
  }
  game.options.providerFor = () => wrap(original());
  const controller: ApplicationController = createApplicationController({
    game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot, meta: runtime.meta, ports: runtime.ports,
  });
  const exec = async (line: string): Promise<void> => {
    const parsed = parseInput(line);
    if (!parsed.ok) throw new Error(parsed.message);
    await controller.execute(parsed.command);
  };
  return { exec, calls: () => calls, controller };
}

async function main(): Promise<void> {
  for (const fixture of ['w1', 'w2', 'cooperate', 'decline', 'violate'] as const) {
    const opened = await open(fixture);
    await opened.exec('request npc_a yield_once');
    await opened.exec('run 1');
    const afterGoal = opened.calls();
    await opened.exec('run 1');
    const afterAction = opened.calls();
    const beforeQuit = opened.calls();
    await opened.exec('quit');
    await opened.exec('run 1');
    captures.push({
      fixture, zeroCall: 'closed_game', providerCallsBeforeQuit: beforeQuit,
      providerCallsAfterQuitRun: opened.calls(), delta: opened.calls() - beforeQuit,
      phases: { goal: afterGoal, action: afterAction },
    });
    await opened.controller.finalize();
  }
  // Already-satisfied actor: the cycle must not open a provider call.
  const satisfied = await open('w1', 100);
  await satisfied.exec('run 1');
  captures.push({ fixture: 'w1', zeroCall: 'already_satisfied', providerCalls: satisfied.calls(), delta: satisfied.calls() });
  await satisfied.controller.finalize();

  const goals = captures.filter(row => row.phase === 'goal').length;
  const actions = captures.filter(row => row.phase === 'action').length;
  const summary = {
    schema: 'frostecho.jev01.capture/1',
    at: new Date().toISOString(),
    source: 'real ApplicationController -> Provider boundary, fixture providers, no model/HTTP',
    capturedInputs: goals + actions,
    goalInputs: goals,
    actionInputs: actions,
    naturalLanguageEntry: 'the fixed G09 S1 request text only',
    limitation: 'existing natural semantic coverage is insufficient; the 640-case semantic set is synthetic/annotated',
    zeroCallBoundaries: captures.filter(row => row.zeroCall !== undefined),
    captures,
  };
  mkdirSync(__dirname, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ capturedInputs: summary.capturedInputs, zeroCall: summary.zeroCallBoundaries,
    out: OUT }, null, 1));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
