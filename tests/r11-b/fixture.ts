/**
 * Fixtures shared by the R11-B tests. They only build state; every number the
 * tests assert is produced by the shipped modules, never by this file.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate, ChoiceRequest } from '../../src/decision/contracts';
import { makeChoiceResult } from '../../src/decision/contracts';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import { executeCandidate } from '../../src/r7/integration/step';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { DEFAULT_WAREHOUSE_FOOD } from '../../src/survival/world-v2';

export function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `r11b-${tag}-`));
}

/** One actor with one oversized promise plus a few ordinary records. */
export function oversizedFixture(seed = 'r11b-oversized'): {
  runtime: R8Runtime; play: GameplayLoop; longText: string; commitmentId: string;
} {
  const runtime = R8Runtime.create({ seed });
  const play = new GameplayLoop(runtime.session);
  const longText = '本次送饭任务的条件及解释。'.repeat(500);
  runtime.session.memories.get('npc_01')!.append({
    eventId: 'long-promise', observerId: 'npc_01', occurredAt: 480, observedAt: 482,
    kind: 'commitment_accepted', source: 'player_statement', authority: 'player',
    subjectIds: ['npc_01', 'player'], speakerId: 'player',
    payload: { text: longText, commitmentId: 'cpu-c1', revision: 1 },
  });
  for (let index = 0; index < 6; index += 1) {
    runtime.session.ingestTeamEvent('team_chatter', { index }, runtime.world.simTime);
  }
  return { runtime, play, longText, commitmentId: 'cpu-c1' };
}

/** Several oversized records of different kinds, and one ordinary record. */
export function multiOversizedFixture(seed = 'r11b-multi'): {
  runtime: R8Runtime; play: GameplayLoop; ids: string[];
} {
  const runtime = R8Runtime.create({ seed });
  const play = new GameplayLoop(runtime.session);
  const store = runtime.session.memories.get('npc_01')!;
  const ids: string[] = [];
  const kinds = ['commitment_accepted', 'task_accepted', 'commitment_change_proposed'];
  kinds.forEach((kind, index) => {
    const eventId = `bulk-${index}`;
    ids.push(eventId);
    store.append({ eventId, observerId: 'npc_01', occurredAt: 480 + index,
      observedAt: 480 + index, kind, source: 'player_statement', authority: 'player',
      subjectIds: ['npc_01', 'player'], speakerId: 'player',
      payload: { text: `第${index}条长文本。`.repeat(400), commitmentId: `cpu-c${index}`,
        revision: index + 1 } });
  });
  store.append({ eventId: 'small-note', observerId: 'npc_01', occurredAt: 490, observedAt: 490,
    kind: 'stock_withdrawn', source: 'engine', authority: 'engine',
    subjectIds: ['npc_01'], payload: { place: 'warehouse', amount: 1, remaining: 0 } });
  return { runtime, play, ids };
}

/** A witnessed shortage: one note source AND one memory entry. */
export function shortageFixture(seed = 'r11b-shortage'): {
  runtime: R8Runtime; play: GameplayLoop; stock: number; receipts: string[];
} {
  const runtime = R8Runtime.create({ seed });
  const play = new GameplayLoop(runtime.session);
  runtime.session.submitWorldCommand({ commandId: 'r11b-move', type: 'move',
    actorId: 'npc_01', to: 'warehouse' } as
    Parameters<typeof runtime.session.submitWorldCommand>[0]);
  const stock = runtime.world.spatial?.stocks.warehouse.food ?? DEFAULT_WAREHOUSE_FOOD;
  const first = direct(runtime, 'npc_01', 'withdraw', { place: 'warehouse', amount: stock });
  const empty = direct(runtime, 'npc_01', 'withdraw', { place: 'warehouse', amount: 1 });
  play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  return { runtime, play, stock, receipts: [...first.eventIds, ...empty.eventIds] };
}

export function direct(runtime: R8Runtime, actorId: string, action: string,
  parameters: Record<string, unknown>): { status: string; eventIds: string[] } {
  const candidate: Candidate = { id: `r11b-${action}`, kind: action as Candidate['kind'],
    description: action, parameters: { action, ...parameters }, preconditions: [],
    expectedEffects: {}, utilityComponents: {} };
  return executeCandidate(runtime, actorId, candidate,
    `${actorId}-r11b-${action}-${runtime.world.version}`);
}

/** Abstain on every request: the state never moves, so two probes compare. */
export function abstainScorer(box: { request?: ChoiceRequest } = {}) {
  return {
    identity: referenceAgencyScorer().identity,
    score(request: ChoiceRequest) {
      box.request = request;
      return makeChoiceResult({ request, scorerId: 'r11b-abstain',
        scores: request.candidates.map(row => ({ candidateId: row.id, logit: 0 })),
        disposition: 'abstain', selectedId: null, reason: 'r11b capture only' });
    },
  };
}
