/** Bounded player story. Only the configured scorer selects NPC world actions. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openCli } from './cli-session.mjs';
const require = createRequire(import.meta.url);
const { R8Runtime } = require('../../dist/src/r7/integration/runtime.js');
const { GameplayLoop } = require('../../dist/src/gameplay-v2/loop.js');
const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const mode = arg('--mode') ?? process.env.FROSTECHO_MODE ?? 'reference';
if (!['reference', 'jev-experimental'].includes(mode)) throw new Error('mode must be reference or jev-experimental');
const scorerCommand = arg('--scorer-command-json') ?? process.env.FROSTECHO_SCORER_COMMAND_JSON;
if (mode === 'jev-experimental' && !scorerCommand) throw new Error('real scorer command is required; no reference fallback');
const maxSteps = Number(arg('--max-steps') ?? 24);
if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 24) throw new Error('--max-steps must be 1..24');
const timeoutMs = Number(arg('--timeout-ms') ?? process.env.FROSTECHO_SCORER_TIMEOUT_MS ?? 300000);
const seed = arg('--seed') ?? 'bridge-empty-warehouse';
const root = process.cwd();
const out = resolve(arg('--out') ?? `artifacts/live-commitment-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
if (existsSync(out)) throw new Error('output directory already exists; use a new run directory');
mkdirSync(out, { recursive: true });
const state = join(out, 'session.json'), scorerTranscript = join(out, 'scorer.jsonl');
const runtime = R8Runtime.create({ seed, resources: { food: 130 } });
runtime.enableLegacySpatial();
// Frozen, disclosed initial scenario. No in-run restock or hidden resource gift.
runtime.world.spatial = { positions: {}, stocks: { warehouse: { food: 0 } },
  carry: {}, deliveredMeals: 0, closedCells: [] };
const play = new GameplayLoop(runtime.session);
play.save(state); runtime.save(state);
const scenario = { schema: 'frostecho.commitment-story-scenario/1', seed, npcCount: 8,
  fullOriginalMaps: true, publicFood: 130, warehouseFood: 0,
  actorId: 'npc_01', goal: 'deliver-meal', actionScorer: mode,
  playerPolicy: 'request delivery; explicitly accept each offered change; never select an NPC action',
  maxNpcSteps: maxSteps, maximumModelRequests: maxSteps, countsAsAdmitted: false };
writeFileSync(join(out, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
const args = ['--state', state, '--profile', 'gospel-5.8.19', '--mode', mode,
  '--scorer-timeout-ms', String(timeoutMs), '--scorer-transcript', scorerTranscript];
if (scorerCommand) args.push('--scorer-command-json', scorerCommand);
const input = [], decisions = [], playerResponses = [];
const record = row => appendFileSync(join(out, 'cli.jsonl'), JSON.stringify(row) + '\n');
const launch = () => openCli(root, args, { timeoutMs: timeoutMs + 15000, onRecord: record });
let cli = launch(), commitmentId = null, taskId = null, finalStatus = null;
let authority = null, error = null, restoreEqual = false, restoreError = null;
const send = async line => {
  input.push({ line, at: new Date().toISOString() });
  appendFileSync(join(out, 'player-input.jsonl'), JSON.stringify(input.at(-1)) + '\n');
  return cli.send(line);
};

try {
  await cli.ready;
  const requested = await send('request npc_01 deliver-meal');
  commitmentId = requested.commitment.commitmentId;
  taskId = requested.task?.taskId ?? requested.commitment.taskId;
  writeFileSync(join(out, 'request.json'), JSON.stringify(requested, null, 2) + '\n');
  const acceptOfferedChange = async row => {
    const open = row.changes?.find(change => change.status === 'open');
    if (!open) return;
    const response = await send(`respond-change ${commitmentId} accept`);
    playerResponses.push({ changeId: open.changeId, terms: open.terms, response });
    taskId ??= response.commitment.taskId;
  };
  await acceptOfferedChange(requested.commitment);
  for (let index = 0; index < maxSteps; index++) {
    // Exactly one selected actor per scoring job. No scripted action IDs,
    // no reference fallback and no legacy game-step completion.
    const result = await send('r8-step npc_01');
    const row = { index, result };
    decisions.push(row);
    appendFileSync(join(out, 'decisions.jsonl'), JSON.stringify(row) + '\n');
    finalStatus = await send('commitment-status');
    const current = finalStatus.commitments.find(item => item.commitmentId === commitmentId);
    if (!current) throw new Error('original commitment disappeared');
    taskId ??= current.taskId;
    if (current.status === 'fulfilled' || ['cancelled', 'withdrawn', 'declined'].includes(current.status)) break;
    await acceptOfferedChange(current);
  }
} catch (caught) { error = String(caught?.stack ?? caught); }

// Always preserve the actual partial world. Restoration never invokes a scorer.
try {
  finalStatus = await send('commitment-status');
  authority = (await send('r8-status')).runtime;
  await send('save');
  const suffixes = ['', '.r8.json', '.tasks.json', '.experience.json', '.commitments.json', '.council.json', '.decision-memory.json'];
  const saved = new Map(suffixes.filter(suffix => existsSync(state + suffix))
    .map(suffix => [suffix, JSON.parse(readFileSync(state + suffix, 'utf8'))]));
  await cli.close();
  cli = launch(); await cli.ready;
  const restored = await send('commitment-status');
  assert.deepEqual(restored.commitments, finalStatus.commitments, 'restored commitments differ');
  assert.deepEqual(restored.tasks, finalStatus.tasks, 'restored bound tasks differ');
  assert.deepEqual((await send('r8-status')).runtime, authority, 'restored domain authority differs');
  await send('save');
  for (const [suffix, value] of saved)
    assert.deepEqual(JSON.parse(readFileSync(state + suffix, 'utf8')), value, `restored save differs: ${suffix || 'session'}`);
  restoreEqual = true;
} catch (caught) { restoreError = String(caught?.stack ?? caught); }
finally { if (cli.child.exitCode === null) await cli.close().catch(() => cli.kill()); }

const finalCommitment = finalStatus?.commitments.find(row => row.commitmentId === commitmentId) ?? null;
const boundTasks = finalStatus?.tasks.filter(row => row.commitmentId === commitmentId) ?? [];
const receipts = authority?.committed.filter(event => finalCommitment?.evidenceEventIds.includes(event.eventId)) ?? [];
const delivered = receipts.filter(event => event.type === 'meal_delivered' && event.actorId === 'npc_01'
  && event.payload.to === 'kitchen' && event.payload.amount >= 1);
const scorerRows = existsSync(scorerTranscript) ? readFileSync(scorerTranscript, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const requests = scorerRows.filter(row => row.event === 'score_request');
const replies = scorerRows.filter(row => row.event === 'score_reply');
const scorerIdentity = replies.at(-1)?.reply.identity ?? null;
const boundActions = decisions.flatMap(row => row.result.records ?? []).flatMap(record => {
  const candidate = record.candidates.find(item => item.id === record.selectedId);
  return candidate?.parameters.commitmentId === commitmentId
    ? [{ requestId: record.requestId, action: candidate.parameters.action,
      executionStatus: record.executionStatus, eventIds: record.eventIds }] : [];
});
const complete = !error && restoreEqual && finalCommitment?.status === 'fulfilled'
  && boundTasks.length === 1 && boundTasks[0].taskId === taskId && boundTasks[0].status === 'done'
  && delivered.length === 1 && requests.length <= maxSteps;
const report = { schema: 'frostecho.live-commitment-story/1', mode, seed,
  outcome: complete ? 'fulfilled' : error || restoreError ? 'error' : 'incomplete', complete,
  commitmentId, taskId, originalTaskPreserved: boundTasks.length === 1 && boundTasks[0].taskId === taskId,
  npcSteps: decisions.length, modelRequests: requests.length, maximumModelRequests: maxSteps,
  scorerIdentity, realModel: scorerIdentity?.realModel === true,
  evidenceClass: mode === 'reference' ? 'reference' : scorerIdentity?.realModel === true ? 'real-model-experimental' : 'fixture-or-unverified',
  countsAsAdmitted: false, playerResponses, boundActions, receipts, finalCommitment, boundTasks,
  clock: authority?.clock ?? null, restoreEqual, error, restoreError,
  initialScenarioSha256: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'),
  files: { session: state, scorerTranscript, cli: join(out, 'cli.jsonl'), decisions: join(out, 'decisions.jsonl') } };
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outcome: report.outcome, mode, npcSteps: decisions.length,
  modelRequests: requests.length, commitmentId, taskId, restoreEqual, out }));
if (!complete) process.exitCode = error || restoreError ? 1 : 2;
