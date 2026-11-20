#!/usr/bin/env node
/**
 * R11-A evidence: one clock, planned travel, exactly-once settlement.
 *
 *   node artifacts/r11/A/run.cjs --emit fixed      # the A acceptance controls
 *   node artifacts/r11/A/run.cjs --emit replay     # R9 seven counterexamples
 *   node artifacts/r11/A/run.cjs --emit crash      # small stack + fresh process
 *   node artifacts/r11/A/run.cjs --emit all        # fixed + replay + crash
 *
 * `baseline.json` is captured from the FROZEN tree, never from the fixed one:
 *
 *   FROSTECHO_REPO_ROOT=/path/to/frozen-worktree \
 *   FROSTECHO_AUDIT_OUT=/tmp/r11a-base-out \
 *     node artifacts/r11/A/run.cjs --emit baseline
 *
 * CPU only: no model, no network, no GPU.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(process.env.FROSTECHO_REPO_ROOT || path.join(__dirname, '../../..'));
const out = path.resolve(process.env.FROSTECHO_AUDIT_OUT || path.join(root, 'artifacts/r11/A'));
const rawDir = path.join(out, 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const { R8Runtime } = require(path.join(root, 'dist/src/r7/integration/runtime.js'));
const { PlaySession } = require(path.join(root, 'dist/src/application-v2/session.js'));

const candidate = (name, parameters = {}) => ({
  id: `r11-${name}`, kind: name, description: `R11-A ${name}`,
  parameters: { action: name, ...parameters }, preconditions: [],
  expectedEffects: {}, utilityComponents: {},
});
const moveTo = (to, purpose = 'travel') => candidate('move', { to, purpose });
const write = (name, value) => {
  const file = path.join(out, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const head = () => {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return (run.stdout || '').trim();
};

function rawRun(name, args) {
  // The frozen scripts write whole save bundles; keep them out of the tree and
  // copy back only the small JSON evidence.
  const auditOut = fs.mkdtempSync(path.join(os.tmpdir(), `frostecho-r11a-${name}-`));
  const started = Date.now();
  const run = spawnSync(process.execPath, args,
    { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, FROSTECHO_AUDIT_OUT: auditOut, FROSTECHO_REPO_ROOT: root } });
  fs.mkdirSync(path.join(rawDir, name), { recursive: true });
  for (const file of ['extra.json', 'independent-runtime.json']) {
    const from = path.join(auditOut, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(rawDir, name, file));
  }
  fs.rmSync(auditOut, { recursive: true, force: true });
  return { exit: run.status, signal: run.signal, ms: Date.now() - started,
    stdout: run.stdout.slice(0, 20000), stderr: run.stderr.slice(0, 4000) };
}

function baseline() {
  const extra = rawRun('extra', ['artifacts/r10-independent-audit/runtime/extra.cjs']);
  const fullmap = rawRun('fullmap', ['artifacts/r10-independent-audit/runtime/extra.cjs', '--fullmap']);
  const r9 = rawRun('r9-regression', ['artifacts/r10-independent-audit/runtime/r9-regression.cjs']);
  const extraJson = path.join(rawDir, 'extra', 'extra.json');
  const fullmapOut = (() => { try { return JSON.parse(fullmap.stdout.trim().split('\n').pop()); }
    catch { return null; } })();
  const extraDoc = fs.existsSync(extraJson) ? JSON.parse(fs.readFileSync(extraJson, 'utf8')) : null;
  const findings = {};
  if (extraDoc) for (const entry of extraDoc.cases ?? []) findings[entry.name] = entry;
  return write('baseline.json', {
    schema: 'frostecho.r11a.baseline/1',
    head: head(), tree: root, at: new Date().toISOString(), gpuCalls: 0,
    frozenAuditScripts: {
      extra: { exit: extra.exit, ms: extra.ms },
      extraFullmap: { exit: fullmap.exit, ms: fullmap.ms, stdout: fullmap.stdout.slice(0, 4000) },
      r9Regression: { exit: r9.exit, ms: r9.ms, stdout: r9.stdout.slice(0, 4000) },
    },
    extraFindings: {
      moveReentrancy: fullmapOut,
      undefinedGrantGather: findings['correct-place-undefined-grant-bypasses-time'] ?? null,
      memoryBudget: findings['first-oversized-memory-bypasses-budget'] ?? null,
    },
  });
}

function fixed() {
  const cases = [];
  const unsupported = typeof R8Runtime.create({ seed: 'probe' }).queueAction !== 'function';
  if (unsupported) return write('fixed.json', { schema: 'frostecho.r11a.fixed/1', head: head(),
    tree: root, unsupported: 'this tree has no queued travel phase (pre-R11 source)' });

  // 1. single move: clock, coordinates, terminal state, receipts
  {
    const runtime = R8Runtime.create({ seed: 'r11a-single' });
    runtime.enableLegacySpatial();
    const startedAt = runtime.world.simTime;
    const begun = runtime.beginIntent({ intentId: 'move-warehouse', commandId: 'move-warehouse',
      actorId: 'npc_01', candidate: moveTo('warehouse'), minutes: 15 });
    const intent = begun.intent;
    const midway = startedAt + Math.floor(intent.move.plannedMinutes / 2);
    runtime.advanceWorld(midway);
    const mid = { clock: runtime.world.simTime, status: intent.status, leg: intent.move.leg,
      progress: intent.move.progress, workLog: runtime.workLog.length,
      position: runtime.legacyPosition('npc_01') };
    runtime.advanceWorld(intent.dueAt);
    cases.push({ name: 'single-move', startedAt, dueAt: intent.dueAt,
      plannedMinutes: intent.move.plannedMinutes, requestedMinutes: intent.move.requestedMinutes,
      pathLegs: intent.move.path.length, midway: mid,
      final: { clock: runtime.world.simTime, due: intent.dueAt, status: intent.status,
        position: runtime.legacyPosition('npc_01'), location: runtime.world.npcs.npc_01.location,
        workLog: runtime.workLog.length, receipts: intent.move.legReceiptIds.length,
        settledAt: intent.settledAt },
      verdict: intent.status === 'applied' && runtime.world.simTime === intent.dueAt
        && runtime.workLog.length === 1 && intent.move.legReceiptIds.length === intent.move.path.length });
  }

  // 2. two NPCs in parallel
  {
    const runtime = R8Runtime.create({ seed: 'r11a-parallel' });
    runtime.enableLegacySpatial();
    const first = runtime.beginIntent({ intentId: 'p1', commandId: 'p1', actorId: 'npc_01',
      candidate: moveTo('kitchen'), minutes: 15 }).intent;
    const second = runtime.beginIntent({ intentId: 'p2', commandId: 'p2', actorId: 'npc_02',
      candidate: moveTo('medical'), minutes: 15 }).intent;
    runtime.advanceWorld(Math.max(first.dueAt, second.dueAt));
    cases.push({ name: 'two-parallel-moves',
      first: { due: first.dueAt, status: first.status, receipts: first.move.legReceiptIds.length,
        position: runtime.legacyPosition('npc_01') },
      second: { due: second.dueAt, status: second.status, receipts: second.move.legReceiptIds.length,
        position: runtime.legacyPosition('npc_02') },
      clock: runtime.world.simTime, workLog: runtime.workLog.length,
      verdict: first.status === 'applied' && second.status === 'applied'
        && runtime.workLog.length === 2 });
  }

  // 3. a move and a rest that fall due together
  {
    const runtime = R8Runtime.create({ seed: 'r11a-same-due' });
    runtime.enableLegacySpatial();
    const move = runtime.beginIntent({ intentId: 'sd-move', commandId: 'sd-move',
      actorId: 'npc_01', candidate: moveTo('dorm-b'), minutes: 15 }).intent;
    const rest = runtime.beginIntent({ intentId: 'sd-rest', commandId: 'sd-rest',
      actorId: 'npc_02', candidate: candidate('rest', { minutes: move.move.plannedMinutes }),
      minutes: move.move.plannedMinutes }).intent;
    runtime.advanceWorld(move.dueAt);
    cases.push({ name: 'move-and-rest-same-due', due: move.dueAt, restDue: rest.dueAt,
      clock: runtime.world.simTime, moveStatus: move.status, restStatus: rest.status,
      rested: runtime.committedEvents().filter(event => event.type === 'rested').length,
      workLog: runtime.workLog.map(entry => ({ intentId: entry.intentId, status: entry.status,
        settledAt: entry.settledAt })),
      verdict: move.dueAt === rest.dueAt && move.status === 'applied'
        && rest.status === 'applied' && runtime.workLog.length === 2 });
  }

  // 4. road closed mid-route
  {
    const runtime = R8Runtime.create({ seed: 'r11a-closure' });
    runtime.enableLegacySpatial();
    const intent = runtime.beginIntent({ intentId: 'cl-move', commandId: 'cl-move',
      actorId: 'npc_01', candidate: moveTo('medical'), minutes: 15 }).intent;
    const ahead = intent.move.path.findIndex((leg, index) => index > 2
      && leg.kind === 'cell' && leg.mapId === 'village');
    runtime.advanceWorld(intent.startedAt + 3);
    const walked = intent.move.leg;
    const blocked = intent.move.path[ahead];
    runtime.session.submitWorldCommand({ commandId: 'cl-close', type: 'close-road',
      cells: [{ x: blocked.cell.x, y: blocked.cell.y }] });
    const position = runtime.legacyPosition('npc_01');
    runtime.advanceWorld(intent.dueAt);
    runtime.advanceWorld(intent.dueAt + 120);
    cases.push({ name: 'road-closed-mid-route', closedAt: blocked.cell, walkedBefore: walked,
      status: intent.status, failureReason: intent.failureReason, leg: intent.move.leg,
      progress: intent.move.progress, receipts: intent.receiptIds.length,
      clock: runtime.world.simTime, dueAt: intent.dueAt,
      positionBeforeClose: position, positionAfter: runtime.legacyPosition('npc_01'),
      verdict: intent.status === 'rejected' && intent.move.leg === walked
        && JSON.stringify(runtime.legacyPosition('npc_01')) === JSON.stringify(position) });
  }

  // 5. cancel mid-route
  {
    const runtime = R8Runtime.create({ seed: 'r11a-cancel' });
    runtime.enableLegacySpatial();
    const intent = runtime.beginIntent({ intentId: 'cx-move', commandId: 'cx-move',
      actorId: 'npc_01', candidate: moveTo('workshop'), minutes: 15 }).intent;
    runtime.advanceWorld(intent.startedAt + 4);
    const walked = intent.move.leg;
    const position = runtime.legacyPosition('npc_01');
    const cancelled = runtime.cancelIntent(intent.intentId, 'player_cancelled');
    runtime.advanceWorld(intent.dueAt + 60);
    cases.push({ name: 'cancel-mid-route', cancelled, cancelAt: intent.move.cancelAt,
      walkedBefore: walked, leg: intent.move.leg, receipts: intent.receiptIds.length,
      status: intent.status, clock: runtime.world.simTime,
      positionBeforeCancel: position, positionAfter: runtime.legacyPosition('npc_01'),
      workLog: runtime.workLog.filter(entry => entry.intentId === intent.intentId).length,
      verdict: cancelled && intent.move.leg === walked
        && JSON.stringify(runtime.legacyPosition('npc_01')) === JSON.stringify(position) });
  }

  // 6. save mid-route, continue in a fresh process
  {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frostecho-r11a-'));
    const save = path.join(directory, 'midway.json');
    const runtime = R8Runtime.create({ seed: 'r11a-resume' });
    runtime.enableLegacySpatial();
    const intent = runtime.beginIntent({ intentId: 'rs-move', commandId: 'rs-move',
      actorId: 'npc_01', candidate: moveTo('warehouse'), minutes: 15 }).intent;
    runtime.advanceWorld(intent.startedAt + 7);
    runtime.save(save);
    const saved = { clock: runtime.world.simTime, leg: intent.move.leg };
    const child = spawnSync(process.execPath, ['-e', `
      const {R8Runtime}=require(process.argv[1]);
      const r=R8Runtime.load(process.argv[2]);
      const i=r.intents.get('rs-move');
      const before=r.committedEvents().map(e=>e.eventId);
      r.advanceWorld(i.dueAt);
      const added=new Set(r.committedEvents().map(e=>e.eventId));
      console.log(JSON.stringify({clock:r.world.simTime,status:i.status,leg:i.move.leg,
        receipts:i.move.legReceiptIds,newEventIds:[...added].filter(id=>!before.includes(id)).length,
        workLog:r.workLog.filter(x=>x.intentId==='rs-move').length,
        position:r.legacyPosition('npc_01'),savedLeg:${saved.leg},savedClock:${saved.clock}}));
    `, path.join(root, 'dist/src/r7/integration/runtime.js'), save],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    cases.push({ name: 'save-mid-route-new-process', saved,
      childExit: child.status, childError: child.stderr.slice(0, 800),
      resumed: child.status === 0 ? JSON.parse(child.stdout) : null,
      verdict: child.status === 0 && JSON.parse(child.stdout || '{}').status === 'applied'
        && JSON.parse(child.stdout || '{}').leg === intent.move.path.length
        && JSON.parse(child.stdout || '{}').workLog === 1 });
    fs.rmSync(directory, { recursive: true, force: true });
  }

  // 7. authority boundary: un-granted inline work is refused
  {
    const runtime = R8Runtime.create({ seed: 'r11a-authority' });
    runtime.session.submitWorldCommand({ commandId: 'au-village', type: 'move',
      actorId: 'npc_01', to: 'village' });
    const before = { clock: runtime.world.simTime, wood: runtime.world.resources.firewood };
    const gather = candidate('gather', { resource: 'firewood', amount: 2 });
    const inline = runtime.session.executeCandidate('npc_01', gather, 'au-inline');
    const afterRefusal = { clock: runtime.world.simTime, wood: runtime.world.resources.firewood,
      gathered: runtime.committedEvents().filter(event => event.type === 'gathered').length };
    const queued = runtime.queueAction({ intentId: 'au-queued', commandId: 'au-queued',
      actorId: 'npc_01', candidate: gather, taskId: null, taskType: 'COLLECT_WOOD' });
    runtime.advanceWorld(before.clock + 30);
    const gathered = runtime.committedEvents().filter(event => event.type === 'gathered');
    cases.push({ name: 'authority-boundary', before, inline: { status: inline.status,
      reason: inline.reason }, afterRefusal,
      queued: { status: queued.status, intentId: queued.intent?.intentId,
        dueAt: queued.intent?.dueAt },
      after: { clock: runtime.world.simTime, wood: runtime.world.resources.firewood,
        gathered: gathered.length }, yield: gathered.reduce((sum, event) =>
        sum + Number(event.payload.amount), 0),
      verdict: inline.status === 'rejected' && /work_requires_intent/.test(inline.reason || '')
        && afterRefusal.clock === before.clock && afterRefusal.wood === before.wood
        && afterRefusal.gathered === 0 && gathered.length === 1
        && runtime.world.simTime === before.clock + 30 });
  }

  // 8. nested clock advance is refused
  {
    const runtime = R8Runtime.create({ seed: 'r11a-nested' });
    const intent = runtime.beginIntent({ intentId: 'np-rest', commandId: 'np-rest',
      actorId: 'npc_01', candidate: candidate('rest', { minutes: 10 }), minutes: 10 }).intent;
    let threw = null;
    runtime.registerIntentGuard(() => {
      try { runtime.advanceWorld(runtime.world.simTime + 60); }
      catch (error) { threw = String(error.message); }
      return null;
    });
    runtime.advanceWorld(490);
    cases.push({ name: 'nested-advance-refused', threw, clock: runtime.world.simTime,
      status: intent.status, settledAt: intent.settledAt,
      // The nested call is refused; the OUTER span remains the only one charged,
      // and the guard that tried to re-enter still settles under the real clock.
      verdict: /reentrant_advance_world/.test(threw || '') && runtime.world.simTime === 490
        && intent.settledAt === 490 && runtime.workLog.length === 1 });
  }

  return write('fixed.json', { schema: 'frostecho.r11a.fixed/1', head: head(), tree: root,
    at: new Date().toISOString(), gpuCalls: 0, cases,
    ok: cases.every(entry => entry.verdict === true) });
}

function replay() {
  const run = rawRun('r9-regression', ['artifacts/r10-independent-audit/runtime/r9-regression.cjs']);
  const file = path.join(rawDir, 'r9-regression', 'independent-runtime.json');
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const counterexamples = (doc?.cases ?? []).filter(entry => 'issueReproduced' in entry)
    .map(entry => ({ name: entry.name, issueReproduced: entry.issueReproduced }));
  const positives = (doc?.cases ?? []).filter(entry => !('issueReproduced' in entry))
    .map(entry => ({ name: entry.name, ok: entry.ok ?? null }));
  const delivery = (doc?.cases ?? []).find(entry => entry.name === 'pending-delivery-hook-lost-on-restore');
  return write('replay.json', {
    schema: 'frostecho.r11a.replay/1', head: head(), tree: root, at: new Date().toISOString(),
    exit: run.exit, gpuCalls: 0,
    counterexamples, positives,
    counterexamplesClean: counterexamples.every(entry => entry.issueReproduced === false),
    positivesIntact: positives.every(entry => entry.ok !== false),
    deliveryReceipts: {
      continuous: delivery?.continuous?.receipts?.length ?? null,
      resumed: delivery?.resumed?.receipts?.length ?? null,
      child: delivery?.child?.receipts?.length ?? null,
      statuses: [delivery?.continuous?.commitment?.status, delivery?.resumed?.commitment?.status,
        delivery?.child?.commitments?.[0]?.status],
    },
    frozenScriptStdout: run.stdout.slice(0, 4000),
  });
}

function crash() {
  const fullmap = rawRun('crash-fullmap', ['artifacts/r10-independent-audit/runtime/extra.cjs', '--fullmap']);
  const small = spawnSync(process.execPath, ['--stack-size=128',
    'artifacts/r10-independent-audit/runtime/extra.cjs', '--fullmap'],
  { cwd: root, encoding: 'utf8', timeout: 60000 });
  const guard = spawnSync(process.execPath, ['-e', `
    const {R8Runtime}=require(process.argv[1]);
    const r=R8Runtime.create({seed:'r11a-crash'});
    const c={id:'x',kind:'rest',description:'x',parameters:{action:'rest',minutes:10},
      preconditions:[],expectedEffects:{},utilityComponents:{}};
    r.beginIntent({intentId:'i',commandId:'i',actorId:'npc_01',candidate:c,minutes:10});
    let message=null;
    r.registerIntentGuard(()=>{ try{ r.advanceWorld(r.world.simTime+60); }catch(e){ message=e.message; } return null;});
    r.advanceWorld(490);
    console.log(JSON.stringify({message,clock:r.world.simTime,status:r.intents.get('i').status}));
  `, path.join(root, 'dist/src/r7/integration/runtime.js')], { encoding: 'utf8', timeout: 60000 });
  return write('crash.json', {
    schema: 'frostecho.r11a.crash/1', head: head(), tree: root, at: new Date().toISOString(),
    normalStack: { exit: fullmap.exit, signal: fullmap.signal,
      stdout: fullmap.stdout.slice(0, 4000) },
    smallStack: { exit: small.status, signal: small.signal, stderr: small.stderr.slice(0, 800),
      stdout: small.stdout.slice(0, 4000) },
    reentrancyGuard: guard.status === 0 ? JSON.parse(guard.stdout) : { error: guard.stderr },
  });
}

const mode = process.argv[2] === '--emit' ? process.argv[3] : 'all';
const emitted = {};
// Deliberately not part of `all`: the baseline must come from the frozen tree.
if (mode === 'baseline') emitted.baseline = baseline();
if (mode === 'all' || mode === 'fixed') emitted.fixed = fixed();
if (mode === 'all' || mode === 'replay') emitted.replay = replay();
if (mode === 'all' || mode === 'crash') emitted.crash = crash();
console.log(JSON.stringify({ schema: 'frostecho.r11a.evidence/1', head: head(), tree: root,
  mode, emitted }, null, 2));
