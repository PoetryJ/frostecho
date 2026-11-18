/**
 * D (R10) web evidence: one real story over the shipped `public/r7` HTTP entry —
 * free dispatch, negotiation (propose -> answer), cancellation, autonomous
 * execution, a crisis, SAVE, a hard process kill, a NEW process, CONTINUE, and a
 * real delivery receipt that closes the promise.
 *
 * Every request/response pair is appended to <out>/web-story.jsonl before the
 * next step, so a failure still leaves the raw trace (no curated summary only).
 *
 *   node scripts/r10/d-web-story.mjs --out artifacts/r10/d/web --port 18761
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const out = resolve(arg('--out', 'artifacts/r10/d/web'));
const port = Number(arg('--port', 18761));
mkdirSync(out, { recursive: true });
const tracePath = join(out, 'web-story.jsonl');
const trace = createWriteStream(tracePath, { flags: 'w' });
const events = [];
const record = (entry) => {
  const row = { at: new Date().toISOString(), ...entry };
  events.push(row);
  trace.write(`${JSON.stringify(row)}\n`);
};

const base = `http://127.0.0.1:${port}`;
let server = null;
let failures = 0;

function startServer(tag) {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [join('scripts', 'r10', 'd-web-server.cjs'),
      '--port', String(port), '--saves', join(out, 'saves')], { cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) reject(new Error('server start timeout')); }, 15_000);
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      record({ kind: 'server', tag, line: text.trim() });
      if (!settled && text.includes('listening')) {
        settled = true;
        clearTimeout(timer);
        resolveStart(child);
      }
    });
    child.stderr.on('data', chunk => record({ kind: 'server-stderr', tag, line: String(chunk).trim() }));
    child.once('exit', code => {
      if (!settled) { clearTimeout(timer); reject(new Error(`server exited ${code}`)); }
    });
  });
}

/**
 * The trace keeps every request and the response fields the story depends on,
 * not the whole 10 MB world dump per call: a full state body on every step made
 * the raw trace 60 MB of duplicated world, which is evidence nobody can read.
 * Event payloads are reduced to their type list plus ids; the decoded values are
 * still in the CLI's own `web-cli.jsonl` beside the save that the run leaves.
 */
function slimState(body) {
  const observation = body?.observation ?? {};
  return { active: body?.active, sessionId: body?.sessionId, savedAt: body?.savedAt,
    lastError: body?.lastError, canContinue: body?.canContinue,
    simTime: observation.simTime, day: observation.day, weather: observation.weather,
    resources: observation.resources, furnace: observation.furnace,
    ending: body?.status?.ending ?? null,
    npcs: (observation.npcs ?? []).map(npc => ({ id: npc.id, location: npc.location,
      alive: npc.alive, health: npc.health, hunger: npc.hunger, stamina: npc.stamina,
      bodyTemp: npc.bodyTemp })),
    commitments: body?.status?.commitments ?? [],
    tasks: (body?.status?.tasks ?? []).map(task => ({ taskId: task.taskId,
      actorId: task.actorId, kind: task.kind, status: task.status })),
    positions: body?.positions ?? {} };
}

function slimBody(path, body) {
  if (!body || typeof body !== 'object') return body;
  if (path === '/api/state') return slimState(body);
  if (body.state) body = { ...body, state: slimState(body.state) };
  const result = body.result ?? body;
  if (result && typeof result === 'object' && Array.isArray(result.events)) {
    return { ...body, result: { ...result, events: result.events.map(event => ({
      eventId: event.eventId, type: event.type, actorId: event.actorId,
      simTime: event.simTime })) } };
  }
  if (result && typeof result === 'object' && Array.isArray(result.segments)) {
    return { ...body, result: { ...result, segments: result.segments.map(segment => ({
      from: segment.from, to: segment.to, minutes: segment.minutes,
      applied: segment.applied })) } };
  }
  return body;
}

async function api(path, payload) {
  const response = await fetch(`${base}${path}`, payload === undefined ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload) });
  const body = await response.json();
  record({ kind: 'api', path, payload, status: response.status, body: slimBody(path, body) });
  return body;
}

async function command(line, { allowError = false } = {}) {
  const body = await api('/api/command', { line });
  const error = body?.result?.error ?? body?.error;
  if (error && !allowError) {
    failures += 1;
    throw new Error(`command refused: ${line} -> ${error}`);
  }
  return body;
}

const fingerprint = (state) => ({
  simTime: state?.observation?.simTime ?? null,
  version: state?.observation?.version ?? null,
  ending: state?.status?.ending ?? null,
  day: state?.observation?.day ?? null,
  locations: Object.fromEntries(Object.entries(state?.positions ?? {})
    .map(([id, row]) => [id, row?.location ?? null])),
  commitments: (state?.status?.commitments ?? []).map(row => ({ id: row.commitmentId,
    status: row.status, revision: row.revision })),
});

async function main() {
  // ---------------- process 1 -------------------------------------------
  server = await startServer('one');
  const state = await api('/api/session', { action: 'new' });
  const first = fingerprint(state);
  record({ kind: 'step', step: 'new-session', fingerprint: first });
  const alive = (state?.observation?.npcs ?? []).filter(npc => npc.alive).map(npc => npc.id);
  record({ kind: 'step', step: 'roster', alive });

  // free dispatch of two different work kinds
  await command('assign npc_01 gather-wood');
  await command('assign npc_02 heating');

  // negotiation: raise a change, answer it, then a real cancellation
  const promise = await command('request npc_03 deliver-meal');
  const commitmentId = promise?.result?.commitment?.commitmentId;
  if (!commitmentId) throw new Error('no commitment id from request');
  await command(`propose-change ${commitmentId} warehouse-empty gather`);
  await command(`respond-change ${commitmentId} reject`);
  const second = await command('request npc_05 supply-warehouse');
  const cancelledId = second?.result?.commitment?.commitmentId;
  if (cancelledId) await command(`cancel-commitment ${cancelledId}`);

  // autonomous execution: the shipped scheduler, not a test loop
  await api('/api/control', { action: 'run' });
  await new Promise(resolveWait => setTimeout(resolveWait, 2500));
  await api('/api/control', { action: 'pause' });
  const afterRun = await api('/api/state');
  record({ kind: 'step', step: 'autonomous', simTime: afterRun?.observation?.simTime });

  // crisis: day 2 with a resident standing in the open village.
  // The original maps are the only way out of a room from this entry, so the
  // resident really exits through the door and walks to the lumber camp.
  await command('r8-map-enable');
  // warehouse interior door cell is (4,7) in the original map
  await command('r8-walk npc_01 4 7', { allowError: true });
  await command('r8-door npc_01', { allowError: true });
  await command('r8-walk npc_01 5 5', { allowError: true });   // lumber camp
  const outdoor = await api('/api/state');
  record({ kind: 'step', step: 'outdoor-position',
    npc01: outdoor?.positions?.npc_01 ?? null,
    location: outdoor?.observation?.npcs?.find(npc => npc.id === 'npc_01')?.location ?? null });
  await command('advance 1320');            // D1 08:00 -> D2 06:00
  await command('advance 600');             // D2 06:00 -> 16:00 outdoors
  // The domain crisis ledger is only exposed by `r8-status` (the runtime
  // document); the web `records` list is the CLI transport log.
  const runtimeDoc = await command('r8-status', { allowError: true });
  const document = runtimeDoc?.result?.runtime ?? {};
  const crises = document?.states?.crises ?? {};
  const journal = (document?.journal ?? []).filter(entry =>
    String(entry.type).startsWith('crisis') || entry.type === 'rescue_needed'
    || entry.type === 'npc_died' || entry.type === 'npc_hypothermic');
  const crisisState = await api('/api/state');
  const npc01 = crisisState?.observation?.npcs?.find(npc => npc.id === 'npc_01') ?? null;
  record({ kind: 'step', step: 'crisis', location: npc01?.location ?? null,
    active: crises.active ?? [], history: (crises.history ?? []).slice(-4),
    journal: journal.slice(-8), npc01 });

  const saved = await command('save');
  const beforeKill = fingerprint(await api('/api/state'));
  record({ kind: 'step', step: 'saved', saved: saved?.result?.saved ?? null, beforeKill });

  // ---------------- hard kill, new process -------------------------------
  server.kill('SIGKILL');
  server = null;
  await new Promise(resolveWait => setTimeout(resolveWait, 800));
  server = await startServer('two');
  const restored = await api('/api/session', { action: 'continue' });
  const afterRestore = fingerprint(restored);
  record({ kind: 'step', step: 'restored', afterRestore });
  const same = JSON.stringify({ ...beforeKill, version: null })
    === JSON.stringify({ ...afterRestore, version: null });
  record({ kind: 'assert', name: 'save->restore identity', same, beforeKill, afterRestore });
  if (!same) failures += 1;

  // continue: drive the promisor through the REAL decision/settlement path so
  // the delivery lands as a queued work receipt (a direct `deliver` command is
  // a spatial command and, as recorded in D-R10.md, does not close a promise).
  const steps = [];
  for (let round = 0; round < 30; round += 1) {
    const step = await command('r8-step npc_03', { allowError: true });
    const decision = step?.result?.decisions?.[0] ?? null;
    steps.push({ round, status: decision?.executionStatus ?? step?.result?.status ?? null,
      id: decision?.selectedId ?? null });
    await command('advance 15', { allowError: true });
    const probe = await command('commitment-status', { allowError: true });
    const rows = probe?.result?.commitments ?? probe?.result?.rows ?? [];
    const found = rows.find(row => row.commitmentId === commitmentId);
    if (found && ['fulfilled', 'cancelled', 'failed'].includes(found.status)) break;
  }
  const status = await command('commitment-status');
  const rows = status?.result?.commitments ?? status?.result?.rows ?? [];
  const target = rows.find(row => row.commitmentId === commitmentId);
  record({ kind: 'step', step: 'delivery', steps, commitment: target ?? null });
  const fulfilled = target?.status === 'fulfilled';
  record({ kind: 'assert', name: 'promise fulfilled by a real receipt',
    fulfilled, status: target?.status ?? null,
    evidence: target?.evidenceEventIds ?? [] });
  if (!fulfilled) failures += 1;

  // the guaranteed crisis of the original: the day-4 lockdown broadcast
  await command('advance 2329', { allowError: true });   // D2 16:31 -> D4 08:00
  const finalDoc = await command('r8-status', { allowError: true });
  const finalDocument = finalDoc?.result?.runtime ?? {};
  const finalJournal = (finalDocument?.journal ?? []).filter(entry =>
    String(entry.type).startsWith('crisis') || entry.type === 'ending_reached');
  const finalCrises = finalDocument?.states?.crises ?? {};
  record({ kind: 'step', step: 'day4-crisis',
    active: finalCrises.active ?? [], history: (finalCrises.history ?? []).slice(-6),
    journal: finalJournal.slice(-8),
    survivors: (finalDocument?.states?.life ?? null) });

  await command('save');
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({
    schema: 'frostecho.r10.d-web-story/1', port, out, tracePath,
    steps: events.filter(row => row.kind === 'step').length,
    assertions: events.filter(row => row.kind === 'assert'),
    failures, passed: failures === 0,
  }, null, 2)}\n`, 'utf8');
  trace.end();
  console.log(JSON.stringify({ ok: failures === 0, failures, trace: tracePath }, null, 2));
  if (failures > 0) process.exitCode = 1;
}

main().catch(async error => {
  failures += 1;
  record({ kind: 'failure', message: error.message, stack: error.stack });
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({
    schema: 'frostecho.r10.d-web-story/1', out, tracePath, failures,
    passed: false, error: error.message }, null, 2)}\n`, 'utf8');
  trace.end();
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (server) server.kill('SIGKILL');
});
