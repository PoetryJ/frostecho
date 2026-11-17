/**
 * Sprint R2 black-box regressions (owner-integrated):
 *  - stdin save/quit/EOF barriers never drop an accepted step;
 *  - a cancel accepted before a step starts revokes that step's commit right;
 *  - a retry replays the first receipt and never downgrades a confirmed applied;
 *  - durable (journal) recovery keeps the persisted evidence verdict and
 *    refuses a legacy void callback, and the digest includes stateVersion.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlaySession } from '../src/application-v2/session';
import type { Candidate } from '../src/decision/contracts';
import { makeChoiceRequest, makeChoiceResult } from '../src/decision/contracts';
import { ChoiceJournal, requestDigest, runChoice, type ScorerBinding } from '../src/decision/runtime';

function helpCandidate(promiseId: string): Candidate {
  return { id: `c-help-${promiseId}`, kind: 'help', description: '留饭',
    parameters: { action: 'reserve', amount: 1, forId: 'player' },
    preconditions: ['food >= 1'], expectedEffects: { food: -1 },
    utilityComponents: { obligation: 1 } };
}

function parseRows(stdout: string): Record<string, any>[] {
  return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('R2-A1: piped step/save/quit settles the step before saving (real subprocess)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-stdin-'));
  const state = join(dir, 'session.json');
  try {
    const run = spawnSync(process.execPath,
      ['dist/scripts/play-sprint.js', '--state', state, '--fresh', '--npc', '2'],
      { input: 'promise npc_01\nstep\nsave\nquit\n', encoding: 'utf8', cwd: process.cwd() });
    assert.equal(run.status, 0, run.stderr);
    const rows = parseRows(run.stdout);
    const step = rows.find(row => row.command === 'step');
    assert.ok(step?.jobId, 'step must carry a jobId');
    assert.ok(Array.isArray(step.decisions) && step.decisions.length >= 1);
    assert.ok(Array.isArray(step.outcomes) && step.outcomes.length >= 1,
      'step must surface real scheduler outcomes');
    const save = rows.find(row => row.command === 'save');
    assert.ok(save && save.version > 0, 'save must see the step effects');
    assert.equal(save.pending, 0, 'no accepted job may remain pending at save');
    const doc = JSON.parse(readFileSync(state, 'utf8'));
    assert.ok(Object.keys(doc.outcomes).length >= 1, 'saved session contains step receipts');
    assert.ok(doc.world.version > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-A2: EOF (no quit) drains accepted jobs and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-eof-'));
  try {
    const run = spawnSync(process.execPath,
      ['dist/scripts/play-sprint.js', '--state', join(dir, 's.json'), '--fresh', '--npc', '2'],
      { input: 'promise npc_01\nstep\n', encoding: 'utf8', cwd: process.cwd() });
    assert.equal(run.status, 0, run.stderr);
    const rows = parseRows(run.stdout);
    const exit = rows.find(row => row.event === 'exit');
    assert.ok(exit, 'EOF must emit an exit record');
    assert.equal(rows.some(row => row.event === 'incomplete'), false);
    assert.ok(exit.jobs >= 2 && exit.completed === exit.jobs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-B: a cancel accepted before a queued step starts revokes its choice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-cancel-'));
  try {
    const run = spawnSync(process.execPath,
      ['dist/scripts/play-sprint.js', '--state', join(dir, 's.json'), '--fresh', '--npc', '2', '--food', '2'],
      { input: 'promise npc_01\nstep npc_01\ncancel npc_01\nknowledge\nsave\nquit\n',
        encoding: 'utf8', cwd: process.cwd() });
    assert.equal(run.status, 0, run.stderr);
    const rows = parseRows(run.stdout);
    const step = rows.find(row => row.command === 'step');
    assert.ok(step, 'step row present');
    assert.equal(step.decisions[0].executed, false, 'cancel must revoke the queued choice');
    const knowledge = rows.find(row => row.command === 'knowledge');
    assert.ok(knowledge, 'knowledge row present');
    assert.equal(knowledge.knowledge.npc_01.promises[0].status, 'cancelled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-C: duplicate commandId replays the first receipt across save/load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-receipt-'));
  const state = join(dir, 'session.json');
  try {
    const session = PlaySession.create(2, { seed: 'receipt', food: 1 });
    const { promiseId } = session.playerPromise('npc_01');
    const candidate = helpCandidate(promiseId);
    const applied = session.executeCandidate('npc_01', candidate, 'cmd-once');
    assert.equal(applied.status, 'applied');
    const duplicate = session.executeCandidate('npc_01', candidate, 'cmd-once');
    assert.equal(duplicate.status, 'applied', 'retry must not become unknown');
    assert.deepEqual(duplicate.eventIds, applied.eventIds);
    assert.equal(duplicate.postStateVersion, applied.postStateVersion);
    assert.equal(session.world.resources.food, 0, 'reserve happens once');
    session.save(state);
    const restored = PlaySession.load(state);
    assert.deepEqual(restored.outcomes['cmd-once'].eventIds, applied.eventIds);
    assert.equal(restored.outcomes['cmd-once'].postStateVersion, applied.postStateVersion);
    // Same id, different content: explicit conflict, ledger stays applied.
    const conflicting = { ...candidate, parameters: { action: 'reserve', amount: 2, forId: 'player' } };
    restored.world = { ...restored.world, resources: { ...restored.world.resources, food: 5 } };
    const conflict = restored.executeCandidate('npc_01', conflicting, 'cmd-once');
    assert.equal(conflict.status, 'rejected');
    assert.equal(conflict.reason, 'command_id_conflict');
    assert.equal(restored.outcomes['cmd-once'].status, 'applied');
    assert.equal(restored.world.resources.food, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const candidates = ['a', 'b'].map(id => ({ id, kind: 'wait', description: id,
  parameters: {}, preconditions: [], expectedEffects: {}, utilityComponents: {} }));
const binding: ScorerBinding = { model: 'fake', head: 'head', tokenizer: 'none',
  renderer: 'fake/1', task: 'choose_action', k: 2, memoryPolicyVersion: 'memory/1' };

function choiceRequest(id: string, stateVersion = 1) {
  return makeChoiceRequest({ requestId: id, actorId: 'npc-a', task: 'choose_action',
    stateVersion, observation: {}, question: 'choose', candidates, memoryFacts: [],
    memorySnapshotHash: 'mem-1', memoryPolicyVersion: 'memory/1' });
}

function scorer(counter: { calls: number }) {
  return { id: 'fake', mode: 'json' as const, score(r: ReturnType<typeof choiceRequest>) {
    counter.calls += 1;
    return makeChoiceResult({ request: r, scorerId: 'fake',
      scores: [{ candidateId: 'a', logit: 1 }, { candidateId: 'b', logit: 0 }],
      selectedId: r.stateVersion === 1 ? 'a' : 'b', disposition: 'accept', reason: 'CPU fixture' });
  } };
}

test('R2-D1: a recovered scored entry keeps retrieval=error and does not execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-journal-'));
  try {
    const request = choiceRequest('evidence');
    const counter = { calls: 0 };
    let submits = 0;
    const options = { journalPath: join(dir, 'journal.json'),
      execution: { commandId: () => 'cmd-1',
        async submit() { submits += 1; return { status: 'applied' as const,
          eventIds: ['ev-1'], postStateVersion: 2, reason: null }; },
        async query() { return { status: 'unknown' as const, eventIds: [],
          postStateVersion: null, reason: 'absent' }; } },
      retrieval: () => 'error' as const };
    const original = ChoiceJournal.prototype.append;
    let fired = false;
    ChoiceJournal.prototype.append = function (this: ChoiceJournal,
      entry: Parameters<ChoiceJournal['append']>[0]) {
      if (!fired && entry.phase === 'scored') {
        fired = true;
        original.call(this, entry);
        throw new Error('injected crash after durable scored');
      }
      return original.call(this, entry);
    };
    try {
      await runChoice(request, scorer(counter), binding, options);
    } catch {
      // expected injected crash
    } finally {
      ChoiceJournal.prototype.append = original;
    }
    const recovered = await runChoice(request, scorer(counter), binding, options);
    assert.equal(recovered.audit.retrieval, 'error', 'evidence verdict is persisted');
    assert.equal(recovered.audit.evidenceGate, 'blocked');
    assert.equal(recovered.audit.executed, false);
    assert.equal(submits, 0, 'a blocked evidence gate never submits');
    assert.equal(counter.calls, 1, 'no model re-call and no second scoring');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-D2: journal mode refuses a legacy void callback (fail closed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-legacy-'));
  try {
    const request = choiceRequest('legacy');
    const counter = { calls: 0 };
    const effectsFile = join(dir, 'effects.json');
    let effects = 0;
    const options = { journalPath: join(dir, 'legacy.json'),
      execute: () => { effects += 1; writeFileSync(effectsFile, JSON.stringify({ effects })); } };
    const first = await runChoice(request, scorer(counter), binding, options);
    const second = await runChoice(request, scorer(counter), binding, options);
    assert.equal(first.result.disposition, 'unavailable');
    assert.match(String(first.result.reason), /legacy_execute_refused_in_journal_mode/);
    assert.equal(effects, 0, 'no effect may be produced by a legacy durable path');
    assert.equal(existsSync(effectsFile), false);
    assert.equal(second.audit.executed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-D3: the request digest includes stateVersion (no stale replay)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-digest-'));
  try {
    const first = choiceRequest('same-id', 1);
    const second = choiceRequest('same-id', 2);
    const counter = { calls: 0 };
    const score = scorer(counter);
    assert.notEqual(requestDigest(first, binding, score), requestDigest(second, binding, score));
    const options = { journalPath: join(dir, 'digest.json') };
    await runChoice(first, score, binding, options);
    const after = await runChoice(second, score, binding, { ...options, currentStateVersion: 2 });
    assert.equal(after.result.selectedId, 'b');
    assert.equal(after.audit.recovered, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
