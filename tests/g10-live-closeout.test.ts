/**
 * G10 closeout worker D — independent black-box regression locks for the two
 * P2 fixes, asserted as BEHAVIOUR (child processes + real filesystem), never
 * by mirroring the implementation:
 *
 *  A. transient IO: a save failing while --root is a plain file, then the root
 *     recovering before EOF, must still exit 1, put the ORIGINAL cause on
 *     stderr, embed the latched failure in the final run record, and never
 *     claim an evidence file was written.
 *  B. the rehearsal harness must refuse an existing output directory.
 *
 * Pre-fix counterexamples are preserved under
 * handoff/20261105-g10-live/closeout/{prefix-io,prefix-rehearse-overwrite}/.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ApplicationPorts, AppView, FailureEvidence, SaveOutcome } from '../src/application/contracts';
import { createApplicationController, emptyPorts } from '../src/application/session';

const ROOT = process.cwd();
const CLI = join(ROOT, 'dist/scripts/play-g10.js');
const REHEARSE = join(ROOT, 'scripts/g10-live-rehearse.mjs');
const QUIET_ENV = { ...process.env, FROSTECHO_LLM_URL: '', FROSTECHO_LLM_MODEL: '' };

interface RunResult { code: number | null; stdout: string; stderr: string }

interface OpenChild { child: ReturnType<typeof spawn>; stdout(): string; result(): Promise<RunResult>; stdin: NodeJS.WritableStream }

function openCli(args: string[]): OpenChild {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: QUIET_ENV });
  let stdout = '';
  let stderr = '';
  const done = new Promise<RunResult>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  if (child.stdin === null) throw new Error('child stdin missing');
  const stdin: NodeJS.WritableStream = child.stdin;
  return { child, stdout: () => stdout, result: () => done, stdin };
}

async function waitFor(child: OpenChild, text: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!child.stdout().includes(text)) {
    if (Date.now() > deadline) throw new Error(`child did not say ${JSON.stringify(text)}: ${child.stdout().slice(-400)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function runRehearse(outDir: string): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [REHEARSE, outDir], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function readPayload(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8')).payload;
}

function runRecordPath(root: string, slot = 'demo'): string {
  const found = readdirSync(root).sort().find(name => name === `${slot}-run.run.json`);
  if (found === undefined) throw new Error(`no ${slot}-run.run.json in ${root}: ${readdirSync(root).join(',')}`);
  return join(root, found);
}

test('A transient save IO then recovery before EOF: exit 1, stderr cause, record carries the failure, no false claim', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'frostecho-closeout-io-')), 'root');
  const child = openCli(['--root', root, '--slot', 'demo']);
  await waitFor(child, '输入 help');
  writeFileSync(root, 'blocked'); // the root path becomes a plain file
  child.stdin.write('save broken\n');
  await waitFor(child, '持久化失败');
  assert.ok(child.stdout().includes('失败证据未能落盘'), 'must not claim the evidence file was saved');
  // recovery: the root becomes a directory again before EOF
  const { rmSync } = await import('node:fs');
  rmSync(root, { force: true });
  mkdirSync(root);
  child.stdin.end();
  const run = await child.result();
  assert.equal(run.code, 1, `stdout tail: ${run.stdout.slice(-300)}`);
  assert.match(run.stderr, /EEXIST|ENOTDIR/, 'the ORIGINAL cause must reach stderr at least once');
  const payload = readPayload(runRecordPath(root));
  const failures: FailureEvidence[] | undefined = payload.failures;
  assert.ok(Array.isArray(failures) && failures.length === 1, 'exactly one latched failure in the run record');
  assert.match(failures![0]!.message, /EEXIST|ENOTDIR/);
  assert.equal(failures![0]!.evidencePath, null, 'the evidence never landed; the record must say so');
  assert.equal(readdirSync(root).some(name => name.endsWith('.failure.json')), false, 'no evidence file was possible while the root was a file');
});

test('A permanent final-record IO on EOF: exit 1, stderr cause, no "run record ->" claim', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'frostecho-closeout-final-')), 'gone');
  const child = openCli(['--root', root, '--slot', 'demo']);
  await waitFor(child, '输入 help');
  writeFileSync(root, 'blocked');
  child.stdin.end();
  const run = await child.result();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /EEXIST|ENOTDIR/);
  assert.equal(run.stdout.includes('运行记录 ->'), false, 'must not report a saved run record');
});

test('A ordinary refusals (EXISTS / INVALID_SLOT) never escalate to a latched failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frostecho-closeout-refuse-'));
  const child = openCli(['--root', root, '--slot', 'demo']);
  await waitFor(child, '输入 help');
  child.stdin.end('save same\nsave same\nsave BAD_SLOT\nquit\n');
  const run = await child.result();
  assert.equal(run.code, 0, `a plain refusal is not a failed run: ${run.stdout.slice(-300)}`);
  assert.match(run.stdout, /EXISTS/);
  const payload = readPayload(runRecordPath(root));
  assert.equal(payload.failures, undefined, 'no failure latched → the compatible field must not exist');
  assert.equal(run.stderr.includes('[run:'), false);
});

test('A one process, one exclusive run record; a second process gets a new ordinal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frostecho-closeout-record-'));
  const first = await (async () => {
    const child = openCli(['--root', root, '--slot', 'demo']);
    await waitFor(child, '输入 help');
    child.stdin.end('quit\n');
    return child.result();
  })();
  assert.equal(first.code, 0);
  const record = runRecordPath(root);
  const bytes = readFileSync(record);
  const second = await (async () => {
    const child = openCli(['--root', root, '--slot', 'demo']);
    await waitFor(child, '输入 help');
    child.stdin.end('quit\n');
    return child.result();
  })();
  assert.equal(second.code, 0);
  assert.deepEqual(readFileSync(record), bytes, 'the first record is immutable');
  assert.ok(readdirSync(root).some(name => name.startsWith('demo-run-2')), 'the second run uses a new ordinal');
});

/* ------------------------- unit layer (ports contract) ------------------------- */

function stubGame(behaviour: { advance?: () => Promise<unknown> } = {}): any {
  return {
    isClosed: () => false,
    advance: behaviour.advance ?? (async () => { throw new Error('boom: provider unreachable'); }),
    close: async () => undefined,
    playerLine: () => ({ ok: true, detail: 'ok' }),
    worldAdvanceTime: () => ({ ok: true, before: 0, after: 1 }),
    worldRestock: () => ({ ok: true }),
    submitGoalRequest: () => ({ ok: true }),
    goalRequests: () => ({ requests: {}, processed: [] }),
    sessionsOf: () => [],
    snapshot: () => ({ actors: {}, commands: [], events: [] }),
    world: { getState: () => ({ simTime: 0, tick: 0, npcs: { npc_b: { location: 'kitchen', hunger: 40 } }, food: { kitchen: 1, dorm: 0 } }), getLog: () => [] },
  };
}

interface RecordingPorts extends ApplicationPorts { failuresReceived: FailureEvidence[] | undefined; failureCalls: unknown[] }

function recordingPorts(saveOutcome: SaveOutcome): RecordingPorts {
  const ports: RecordingPorts = {
    save: () => saveOutcome,
    failure(error) { ports.failureCalls.push(error); return null; },
    budget: () => null,
    writeRunRecord(_view: AppView, failures?: FailureEvidence[]) {
      ports.failuresReceived = failures;
      return { ok: true, path: '/recorded/run.json', code: 'OK', cause: null, issues: [] };
    },
    now: () => Date.now(),
    failureCalls: [],
    failuresReceived: undefined,
  };
  return ports;
}

const META = {
  schema: 'frostecho.g10.app/2' as const,
  episodeId: 'demo',
  providerKind: 'reference' as const,
  fixtureId: null,
  goalMode: 'legacy' as const,
  candidateSet: 'choice' as const,
  satiety: 40 as const,
  scripted: true,
  campaign: null,
};

test('A unit: a fatal save failure latches with the original cause, evidence miss recorded as null', async () => {
  const ports = recordingPorts({ ok: false, path: null, code: 'IO_ERROR', fatal: true, issues: ['EEXIST, file exists'], cause: 'EEXIST, file exists' });
  const controller = createApplicationController({
    game: stubGame(), config: { mode: 'reference', requestModel: null, thinking: true, timeoutMs: 1000 },
    root: '/r', slot: 'demo', meta: META, ports,
  });
  const result = await controller.execute({ kind: 'save', slot: 'broken' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PERSISTENCE_FAILED');
  assert.equal(result.evidencePath, null, 'evidence miss must be reported, never faked');
  assert.equal(controller.hasFailed(), true);
  const final = await controller.finalize();
  assert.equal(final.exitCode, 1);
  assert.equal(final.failures.length, 1);
  assert.equal(final.failures[0]!.code, 'IO_ERROR');
  assert.match(final.failures[0]!.message, /EEXIST/);
  assert.equal(final.failures[0]!.evidencePath, null);
  assert.deepEqual(ports.failuresReceived, final.failures, 'the run record writer receives the latched failures');
});

test('A unit: an EXISTS refusal is not a failure; a provider throw latches PROVIDER_ERROR', async () => {
  const ports = recordingPorts({ ok: false, path: null, code: 'EXISTS', fatal: false, issues: ['slot exists'], cause: 'slot exists' });
  const controller = createApplicationController({
    game: stubGame(), config: { mode: 'reference', requestModel: null, thinking: true, timeoutMs: 1000 },
    root: '/r', slot: 'demo', meta: META, ports,
  });
  const refused = await controller.execute({ kind: 'save', slot: 'same' });
  assert.equal(refused.code, 'SAVE_FAILED');
  assert.equal(refused.evidencePath, undefined);
  assert.equal(controller.hasFailed(), false, 'a named refusal must not latch a failure');
  assert.equal(ports.failureCalls.length, 0);

  const thrown = await controller.execute({ kind: 'step' });
  assert.equal(thrown.code, 'PROVIDER_ERROR');
  assert.equal(thrown.evidencePath, null);
  const final = await controller.finalize();
  assert.equal(final.exitCode, 1);
  assert.equal(final.failures.length, 1, 'only the provider failure is latched');
  assert.equal(final.failures[0]!.code, 'PROVIDER_ERROR');
  assert.match(final.failures[0]!.message, /boom: provider unreachable/);
});

/* --------------------------- B: rehearsal exclusivity --------------------------- */

function treeHashes(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (statSync(path).isDirectory()) walk(path, rel);
      else hashes.set(rel, createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(dir, '');
  return hashes;
}

test('B independent check: an existing directory (sentinel or empty) is refused, bytes untouched', async () => {
  const base = mkdtempSync(join(tmpdir(), 'frostecho-closeout-b-'));
  const withSentinel = join(base, 'sentinel');
  mkdirSync(withSentinel);
  writeFileSync(join(withSentinel, 'old.json'), 'old evidence\n');
  const before = treeHashes(withSentinel);
  const refused = await runRehearse(withSentinel);
  assert.equal(refused.code, 2);
  assert.deepEqual(treeHashes(withSentinel), before);
  assert.match(refused.stderr, /refusing to overwrite/i);

  const empty = join(base, 'empty');
  mkdirSync(empty);
  const refusedEmpty = await runRehearse(empty);
  assert.equal(refusedEmpty.code, 2);
  assert.deepEqual(readdirSync(empty), []);
});

/* keep the empty-ports contract compiling: the optional failures parameter */
test('ports contract: emptyPorts writeRunRecord accepts the optional failures parameter', () => {
  const ports = emptyPorts();
  const result = ports.writeRunRecord({} as AppView, [{ code: 'IO_ERROR', message: 'x', evidencePath: null }]);
  assert.equal(result.ok, false);
});
