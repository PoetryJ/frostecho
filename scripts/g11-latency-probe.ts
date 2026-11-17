/**
 * G11 latency probe: a SINGLE-FACTOR thinking on/off comparison on two real
 * action inputs, replayed verbatim.
 *
 * This is offline-first research tooling, not a production path:
 *   - `plan`     freezes the two recorded request bodies and the pre-registered
 *                8-request matrix; `authorizedCalls` starts at 0;
 *   - `run`      REFUSES to send anything unless `--authorized` is passed AND
 *                the plan carries authorizedCalls > 0 AND the working tree has
 *                no uncommitted runtime source (an uncommitted run cannot be
 *                attributed to a commit). Otherwise exit 2, zero POST;
 *   - `summarize` recomputes everything from the attempt files on disk: no
 *                cached aggregate, no implicit retry, no second budget system.
 *
 * The only variable between the two arms is `chat_template_kwargs.enable_thinking`.
 * Everything else in the body — model, messages, temperature, max_tokens,
 * stream, and the default reasoning effort (absent) — is byte-identical.
 *
 * Budget: the existing campaign ledger is reused (openCampaign /
 * reserveCampaignChat / finishCampaignChat), reserved BEFORE each POST, never
 * refunded, and capped by the plan's authorizedCalls. Fail-stop: the first
 * transport error, non-200, timeout, unparseable or non-action answer ends the
 * run; later items stay not_run.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openCampaign, reserveCampaignChat, finishCampaignChat, loadCampaign } from '../src/eval/campaign-budget';
import { strictG11Action } from './g11-live-verify';

const PLAN_SCHEMA = 'frostecho.g11-latency.plan/1';
const ATTEMPT_SCHEMA = 'frostecho.g11-latency.attempt/1';
const SUMMARY_SCHEMA = 'frostecho.g11-latency.summary/1';
const RUN_START_SCHEMA = 'frostecho.g11-latency.run-start/1';
/** Frozen envelope of the whole G11 batch; only enable_thinking may differ. */
const FREEZE = { temperature: 0, maxTokens: 1024, stream: false, timeoutMs: 120_000, model: 'qwen3.8-27b' } as const;

export type Arm = 'off' | 'on';
export interface MatrixItem {
  index: number;
  pairId: string;
  inputId: string;
  arm: Arm;
  rep: number;
  /** Pre-registered position in the run order. */
  order: number;
}

export interface LatencyInput {
  inputId: string;
  /** Where the body came from: never trusted, always named. */
  source: { path: string; sha256: string; attemptId: string; phase: string };
  body: Record<string, unknown>;
  bodySha256: string;
  promptSha256: string;
}

export interface LatencyPlan {
  schema: typeof PLAN_SCHEMA;
  at: string;
  dir: string;
  http: string;
  model: string;
  freeze: { temperature: number; maxTokens: number; stream: boolean; timeoutMs: number };
  /** Written down so a reader never has to guess which weights/template ran. */
  identity: Record<string, unknown>;
  inputs: LatencyInput[];
  matrix: MatrixItem[];
  proposedCalls: number;
  authorizedCalls: number;
  limits: { perArm: number; total: number };
}

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const emit = (value: unknown): void => { console.log(JSON.stringify(value)); };
const fail = (message: string): never => { console.error(message); process.exit(2); };

/* ------------------------------------------------------------------ */
/* pure planning                                                       */
/* ------------------------------------------------------------------ */

/**
 * The ONLY difference between the arms is the thinking switch. Returns the two
 * bodies plus the list of JSON paths that differ, so a test can prove the
 * single-factor claim instead of trusting it.
 */
export function buildPair(body: Record<string, unknown>): { on: Record<string, unknown>; off: Record<string, unknown>; differing: string[] } {
  const on = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const off = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const kwargs = { ...(on.chat_template_kwargs as Record<string, unknown> | undefined) };
  kwargs.enable_thinking = true;
  on.chat_template_kwargs = kwargs;
  const offKwargs = { ...kwargs, enable_thinking: false };
  off.chat_template_kwargs = offKwargs;
  const differing: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    const bothObjects = left !== null && right !== null && typeof left === 'object' && typeof right === 'object';
    if (bothObjects) {
      const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)]);
      for (const key of [...keys].sort()) {
        walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path.length === 0 ? key : `${path}.${key}`);
      }
      return;
    }
    if (left !== right) differing.push(path);
  };
  walk(on, off, '');
  return { on, off, differing };
}

/** Pre-registered order: Y1 off→on, N1 on→off, Y2 on→off, N2 off→on. */
export function buildMatrix(inputIds: readonly string[]): MatrixItem[] {
  const [y, n] = inputIds;
  if (y === undefined || n === undefined) throw new Error('the probe needs exactly two inputs (Y and N)');
  const plan: { inputId: string; arm: Arm; rep: number }[] = [
    { inputId: y, arm: 'off', rep: 1 },
    { inputId: y, arm: 'on', rep: 1 },
    { inputId: n, arm: 'on', rep: 1 },
    { inputId: n, arm: 'off', rep: 1 },
    { inputId: y, arm: 'on', rep: 2 },
    { inputId: y, arm: 'off', rep: 2 },
    { inputId: n, arm: 'off', rep: 2 },
    { inputId: n, arm: 'on', rep: 2 },
  ];
  return plan.map((item, index) => ({
    index,
    pairId: `${item.inputId}#${String(item.rep)}`,
    inputId: item.inputId,
    arm: item.arm,
    rep: item.rep,
    order: index + 1,
  }));
}

/* ------------------------------------------------------------------ */
/* identity: never send from an uncommitted runtime                    */
/* ------------------------------------------------------------------ */

export interface CodeIdentity {
  head: string | null;
  dirty: boolean;
  dirtyFiles: string[];
}

/** Tracked runtime source (src/ and scripts/) must be committed before a POST. */
export function codeIdentity(cwd: string): CodeIdentity {
  const git = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const head = git(['rev-parse', 'HEAD']) || null;
  const porcelain = git(['status', '--porcelain', '--', 'src', 'scripts']);
  const dirtyFiles = porcelain.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return { head, dirty: dirtyFiles.length > 0, dirtyFiles };
}

/* ------------------------------------------------------------------ */
/* HTTP transport (one attempt, one POST, no retry)                    */
/* ------------------------------------------------------------------ */

interface AttemptRecord {
  schema: typeof ATTEMPT_SCHEMA;
  attemptId: string | null;
  index: number;
  pairId: string;
  inputId: string;
  arm: Arm;
  rep: number;
  at: string;
  requestBody: Record<string, unknown>;
  requestSha256: string;
  status: number | null;
  responseBody: string | null;
  finishReason: string | null;
  latencyMs: number;
  timeout: boolean;
  usage: { prompt: number | null; completion: number | null; reasoning: number | null; total: number | null };
  parse: { ok: boolean; action: string | null; error: string | null };
  /** Why this attempt stopped the run, if it did. */
  stopReason: string | null;
}

const usageOf = (body: Record<string, any> | null): AttemptRecord['usage'] => {
  const usage = body?.usage ?? null;
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    prompt: number(usage?.prompt_tokens),
    completion: number(usage?.completion_tokens),
    reasoning: number(usage?.completion_tokens_details?.reasoning_tokens),
    total: number(usage?.total_tokens),
  };
};

/** One POST. Everything that can go wrong is recorded, nothing is retried. */
async function post(body: Record<string, unknown>, plan: LatencyPlan): Promise<{
  status: number | null; text: string | null; latencyMs: number; timeout: boolean; error: string | null;
}> {
  const started = Date.now();
  try {
    const response = await fetch(plan.http, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(plan.freeze.timeoutMs),
    });
    const text = await response.text();
    return { status: response.status, text, latencyMs: Date.now() - started, timeout: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout|aborted/i.test(message);
    return { status: null, text: null, latencyMs: Date.now() - started, timeout, error: message };
  }
}

/* ------------------------------------------------------------------ */
/* modes                                                               */
/* ------------------------------------------------------------------ */

/** True only for a throwaway local test server: never the frozen service port. */
export function isTestLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    return local && parsed.port !== '18872';
  } catch {
    return false;
  }
}

/** The identities below are the reviewed att-0002/att-0003 requests. */
const FROZEN_INPUTS = [
  { inputId: 'Y', bodySha256: 'c9dc5449d5f7bee4935203e9be9dd7134786247555f9066a61140493a1f515be',
    promptSha256: '530fa0b3a2763578432bd0b7e76eee8ab2f72b77ead2ee29935c132b592273ae',
    source: { path: 'artifacts/g11-live/g11-live-20261105-r1/w1/w1-prefix-run.run.json',
      sha256: '738275e8ae1c92bec82f2dac69860b8ec126782e219fe933e9f7451d18f53e89', attemptId: 'att-0002', phase: 'action' } },
  { inputId: 'N', bodySha256: '78c3ea73f39baeb215ef4e973a612e1db0f23be44d95fc8af94a68b4e090e09f',
    promptSha256: '7da5399104d6ca82e4ec2b61950b61a1802504546fc4811521dca8015c32ce71',
    source: { path: 'artifacts/g11-live/g11-live-20261105-r1/w1/w1-wait-run.run.json',
      sha256: '9ed53e6c7a1818c4e9321bb5cf07263f3f79054ce315e9e93c130e65852f93d2', attemptId: 'att-0003', phase: 'action' } },
] as const;

/** Fail closed before creating the ledger or reserving any of the eight calls. */
export function validateFrozenPlan(plan: LatencyPlan, testLoopback = false): string[] {
  const reasons: string[] = [];
  if (plan === null || typeof plan !== 'object') return ['plan must be an object'];
  if (plan.schema !== PLAN_SCHEMA) reasons.push('plan schema differs from the frozen schema');
  if (plan.model !== FREEZE.model) reasons.push('plan model differs from the frozen model');
  if (plan.proposedCalls !== 8 || (plan.authorizedCalls !== 0 && plan.authorizedCalls !== 8)) {
    reasons.push('the probe has exactly eight proposed calls and accepts only zero or eight authorized calls');
  }
  if (!isDeepStrictEqual(plan.limits, { perArm: 4, total: plan.authorizedCalls })) {
    reasons.push('plan limits differ from the frozen four-per-arm, eight-total budget');
  }
  const timeoutMs = plan.freeze?.timeoutMs;
  const testTimeout = testLoopback && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= FREEZE.timeoutMs;
  const expectedFreeze = { temperature: FREEZE.temperature, maxTokens: FREEZE.maxTokens,
    stream: FREEZE.stream, timeoutMs: testTimeout ? timeoutMs : FREEZE.timeoutMs };
  if (!isDeepStrictEqual(plan.freeze, expectedFreeze)) reasons.push('plan freeze differs from temperature 0, maxTokens 1024, stream false, timeout 120000');
  if (!isDeepStrictEqual(plan.matrix, buildMatrix(['Y', 'N']))) reasons.push('plan matrix differs from the frozen eight-request order');
  if (!Array.isArray(plan.inputs) || plan.inputs.length !== 2) {
    reasons.push('plan must contain exactly the frozen Y and N inputs');
    return reasons;
  }
  for (const [index, expected] of FROZEN_INPUTS.entries()) {
    const input = plan.inputs[index];
    if (input === null || typeof input !== 'object' || input.inputId !== expected.inputId) {
      reasons.push(`input ${String(index)} differs from frozen ${expected.inputId}`);
      continue;
    }
    const bodyText = JSON.stringify(input.body);
    if (typeof bodyText !== 'string' || sha256(bodyText) !== expected.bodySha256 || input.bodySha256 !== expected.bodySha256) {
      reasons.push(`${expected.inputId}: body/hash differs from the recorded request`);
    }
    if (input.promptSha256 !== expected.promptSha256 || !isDeepStrictEqual(input.source, expected.source)) {
      reasons.push(`${expected.inputId}: source identity differs from the recorded request`);
    }
  }
  return reasons;
}

const dirOf = (args: Map<string, string>): string => {
  const dir = args.get('--dir') ?? '';
  if (dir.length === 0) fail('--dir is required');
  return resolve(dir);
};

function writeExclusive(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
}

function cmdPlan(args: Map<string, string>): number {
  const dir = dirOf(args);
  const inputsDir = args.get('--inputs') ?? join(dir, 'inputs');
  const http = args.get('--http') ?? 'http://127.0.0.1:18872/v1/chat/completions';
  const authorized = Number(args.get('--authorized-calls') ?? '0');
  const planPath = join(dir, 'plan.json');
  if (existsSync(planPath)) fail(`${planPath} already exists: a plan is frozen once`);

  const Y = readJson(join(inputsDir, 'Y.json')) as LatencyInput;
  const N = readJson(join(inputsDir, 'N.json')) as LatencyInput;
  for (const input of [Y, N]) {
    // The stored body is a transcript of a recorded request; re-check its hash.
    const actual = sha256(JSON.stringify(input.body));
    if (input.bodySha256 !== actual) fail(`${input.inputId}: body hash ${input.bodySha256} != ${actual}`);
  }
  const identityPath = join(dir, 'service-identity.json');
  const identity = existsSync(identityPath) ? readJson(identityPath) : { note: 'no service-identity.json recorded' };
  const plan: LatencyPlan = {
    schema: PLAN_SCHEMA,
    at: new Date().toISOString(),
    dir,
    http,
    model: FREEZE.model,
    freeze: { temperature: FREEZE.temperature, maxTokens: FREEZE.maxTokens, stream: FREEZE.stream, timeoutMs: FREEZE.timeoutMs },
    identity,
    inputs: [Y, N],
    matrix: buildMatrix([Y.inputId, N.inputId]),
    proposedCalls: 8,
    authorizedCalls: Number.isInteger(authorized) && authorized > 0 ? authorized : 0,
    limits: { perArm: 4, total: Math.min(8, Number.isInteger(authorized) && authorized > 0 ? authorized : 0) },
  };
  writeExclusive(planPath, plan);
  emit({ mode: 'plan', planPath, proposedCalls: plan.proposedCalls, authorizedCalls: plan.authorizedCalls, matrix: plan.matrix });
  return 0;
}

/** Offline fixture replay: a recorded list of answers, no socket is opened. */
function fixtureAnswers(path: string): { status: number | null; text: string | null; latencyMs: number; timeout: boolean }[] {
  const fixture = readJson(path) as { answers?: unknown };
  const answers = Array.isArray(fixture.answers) ? fixture.answers : [];
  return answers.map(entry => {
    const value = entry as { status?: unknown; text?: unknown; latencyMs?: unknown; timeout?: unknown };
    return {
      status: typeof value.status === 'number' ? value.status : value.status === null ? null : 200,
      text: typeof value.text === 'string' ? value.text : null,
      latencyMs: typeof value.latencyMs === 'number' ? value.latencyMs : 0,
      timeout: value.timeout === true,
    };
  });
}

async function cmdRun(args: Map<string, string>): Promise<number> {
  const dir = dirOf(args);
  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) fail(`no plan at ${planPath}: run plan first`);
  const plan = readJson(planPath) as unknown as LatencyPlan;
  const fixture = args.get('--fixture') ?? null;

  // Two independent gates: an explicit authorization flag AND a positive
  // authorizedCalls in the frozen plan. Neither can be enabled by environment.
  if (!args.has('--authorized')) {
    emit({ mode: 'run', classification: 'unauthorized', reasons: ['no --authorized flag: 0 requests sent'], posts: 0 });
    return 2;
  }
  if (plan.authorizedCalls <= 0) {
    emit({ mode: 'run', classification: 'unauthorized', reasons: ['plan.authorizedCalls is 0: 0 requests sent'], posts: 0 });
    return 2;
  }
  // An uncommitted runtime cannot be attributed to a commit, so a REAL post is
  // refused. `--fixture` is offline by construction; `--test-loopback` may only
  // reach 127.0.0.1 on a port OTHER than the frozen service port 18872.
  const loopbackProbe = args.has('--test-loopback') && isTestLoopback(plan.http);
  const invalidPlan = validateFrozenPlan(plan, loopbackProbe);
  if (invalidPlan.length > 0) {
    emit({ mode: 'run', classification: 'invalid_plan', reasons: invalidPlan, posts: 0 });
    return 2;
  }
  if (fixture === null) {
    const identity = codeIdentity(process.cwd());
    if (identity.dirty && !loopbackProbe) {
      emit({ mode: 'run', classification: 'uncommitted_source', reasons: ['runtime source has uncommitted changes; commit or stash before a real POST'], identity, posts: 0 });
      return 2;
    }
  }

  const startPath = join(dir, 'run-start.json');
  if (existsSync(startPath)) fail(`${startPath} already exists: this probe already started (no re-spend)`);

  // The research ledger is its OWN campaign: never the G11 batch's budget.
  const campaignDir = join(dir, 'campaign');
  const ledger = openCampaign(campaignDir, plan.authorizedCalls, 'g11-latency-probe');
  if (ledger.spent > 0) fail(`campaign ${campaignDir} already spent ${String(ledger.spent)}: refusing a second start`);

  const identity = codeIdentity(process.cwd());
  writeExclusive(startPath, {
    schema: RUN_START_SCHEMA,
    at: new Date().toISOString(),
    planSha256: sha256(readFileSync(planPath)),
    authorizedCalls: plan.authorizedCalls,
    identity,
    fixture,
  });

  const answers = fixture === null ? null : fixtureAnswers(fixture);
  const attemptsDir = join(dir, 'attempts');
  mkdirSync(attemptsDir, { recursive: true });
  let sent = 0;
  let stopReason: string | null = null;
  const results: Record<string, unknown>[] = [];

  for (const item of plan.matrix) {
    const input = plan.inputs.find(candidate => candidate.inputId === item.inputId);
    if (input === undefined) { stopReason = `plan has no input ${item.inputId}`; break; }
    const pair = buildPair(input.body);
    const body = item.arm === 'on' ? pair.on : pair.off;
    const at = new Date().toISOString();

    if (stopReason !== null) {
      results.push({ index: item.index, pairId: item.pairId, arm: item.arm, status: 'not_run' });
      continue;
    }

    // Reserve BEFORE the request: a failed call still costs.
    const reserved = reserveCampaignChat(campaignDir, { batch: 'latency-probe', episodeId: item.pairId, phase: 'action' });
    if (!reserved.ok) { stopReason = reserved.reason; results.push({ index: item.index, pairId: item.pairId, arm: item.arm, status: 'not_run' }); continue; }

    const response = answers === null
      ? await post(body, plan)
      : answers[sent] ?? { status: null, text: null, latencyMs: 0, timeout: true };
    sent += 1;

    let parsedBody: Record<string, any> | null = null;
    try {
      parsedBody = response.text === null ? null : JSON.parse(response.text) as Record<string, any>;
    } catch { parsedBody = null; }
    const content = parsedBody?.choices?.[0]?.message?.content;
    const strict = typeof content === 'string' ? strictG11Action(content) : { ok: false as const, error: 'no message content' };
    const usage = usageOf(parsedBody);
    const action = strict.ok ? strict.value.type : null;

    let reason: string | null = null;
    if (response.text === null && response.timeout) reason = `timeout after ${String(response.latencyMs)}ms (client deadline; usage unknown)`;
    else if (response.status !== 200) reason = `http ${String(response.status ?? 'null')}`;
    else if (parsedBody === null) reason = 'response is not JSON';
    else if (!strict.ok) reason = `unparsable action: ${strict.error}`;

    const record: AttemptRecord = {
      schema: ATTEMPT_SCHEMA,
      attemptId: reserved.attemptId,
      index: item.index,
      pairId: item.pairId,
      inputId: item.inputId,
      arm: item.arm,
      rep: item.rep,
      at,
      requestBody: body,
      requestSha256: sha256(JSON.stringify(body)),
      status: response.status,
      responseBody: response.text,
      finishReason: typeof parsedBody?.choices?.[0]?.finish_reason === 'string' ? parsedBody.choices[0].finish_reason : null,
      latencyMs: response.latencyMs,
      timeout: 'timeout' in response ? response.timeout : false,
      usage,
      parse: { ok: strict.ok, action, error: strict.ok ? null : strict.error },
      stopReason: reason,
    };
    writeFileSync(join(attemptsDir, `${reserved.attemptId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    finishCampaignChat(campaignDir, reserved.attemptId, {
      outcome: reason === null ? 'success' : response.status === null ? 'provider_error' : 'http_error',
      totalTokens: usage.total,
    });
    results.push({ index: item.index, pairId: item.pairId, arm: item.arm, attemptId: reserved.attemptId, status: reason === null ? 'done' : 'failed', reason });
    if (reason !== null) stopReason = `${reserved.attemptId}: ${reason}`;
  }

  emit({
    mode: 'run',
    classification: stopReason === null ? 'complete' : 'stopped',
    sent,
    stopReason,
    campaign: loadCampaign(campaignDir).spent,
    results,
  });
  return stopReason === null ? 0 : 1;
}

function cmdSummarize(args: Map<string, string>): number {
  const dir = dirOf(args);
  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) fail(`no plan at ${planPath}`);
  const plan = readJson(planPath) as unknown as LatencyPlan;
  const attemptsDir = join(dir, 'attempts');
  const attempts: AttemptRecord[] = existsSync(attemptsDir)
    ? readdirSync(attemptsDir).filter(name => name.endsWith('.json')).sort()
      .map(name => readJson(join(attemptsDir, name)) as unknown as AttemptRecord)
    : [];

  const ran = new Map(attempts.map(attempt => [`${attempt.inputId}#${attempt.rep}#${attempt.arm}`, attempt]));
  const rows = plan.matrix.map(item => {
    const attempt = ran.get(`${item.inputId}#${item.rep}#${item.arm}`);
    return {
      index: item.index,
      pairId: item.pairId,
      arm: item.arm,
      attemptId: attempt?.attemptId ?? null,
      status: attempt === undefined ? 'not_run' : attempt.parse.ok ? 'ok' : attempt.timeout ? 'timeout' : 'failed',
      action: attempt?.parse.action ?? null,
      latencyMs: attempt?.latencyMs ?? null,
      timeout: attempt?.timeout ?? null,
      finishReason: attempt?.finishReason ?? null,
      prompt: attempt?.usage.prompt ?? null,
      completion: attempt?.usage.completion ?? null,
      reasoning: attempt?.usage.reasoning ?? null,
      total: attempt?.usage.total ?? null,
      stopReason: attempt?.stopReason ?? null,
    };
  });

  // Only pairs whose BOTH members completed and parsed contribute a delta.
  const pairs: Record<string, unknown>[] = [];
  for (const pairId of [...new Set(plan.matrix.map(item => item.pairId))]) {
    const off = rows.find(row => row.pairId === pairId && row.arm === 'off' && row.status === 'ok');
    const on = rows.find(row => row.pairId === pairId && row.arm === 'on' && row.status === 'ok');
    if (off === undefined || on === undefined) {
      pairs.push({ pairId, usable: false, why: 'one arm did not complete and parse' });
      continue;
    }
    pairs.push({
      pairId,
      usable: true,
      action: { off: off.action, on: on.action, same: off.action === on.action },
      latencyMs: { off: off.latencyMs, on: on.latencyMs, delta: (on.latencyMs ?? 0) - (off.latencyMs ?? 0) },
      completion: { off: off.completion, on: on.completion },
      reasoning: { off: off.reasoning, on: on.reasoning },
    });
  }

  const completed = attempts.filter(attempt => attempt.parse.ok);
  const timeouts = attempts.filter(attempt => attempt.timeout);
  const unknown = attempts.filter(attempt => attempt.usage.total === null).map(attempt => attempt.attemptId);
  const knownTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage.total ?? 0), 0);
  // Keep the known subtotal even when another charged attempt has unknown usage.
  const knownComplete = attempts.length > 0 && unknown.length === 0;
  const summary = {
    schema: SUMMARY_SCHEMA,
    dir,
    planned: plan.proposedCalls,
    authorizedCalls: plan.authorizedCalls,
    sent: attempts.length,
    rows,
    pairs,
    counts: {
      ok: completed.length,
      failed: attempts.filter(attempt => !attempt.parse.ok && !attempt.timeout).length,
      timeout: timeouts.length,
      notRun: rows.filter(row => row.status === 'not_run').length,
      usablePairs: pairs.filter(pair => pair.usable === true).length,
    },
    // A timeout is a RIGHT-CENSORED observation: it is a lower-bound event, not
    // a completed 120s sample, so it never enters the latency mean.
    tokens: {
      known: knownTokens,
      unknown,
      total: knownComplete ? knownTokens : null,
    },
    caveats: [
      'a timeout is recorded as a client deadline hit, not as a completed sample',
      'only pairs with both arms complete and parsed contribute a delta',
      'two repetitions per cell: no p95 or variance claim is made',
      'a legal single-step action is not whole-episode success; wait is not the only correct answer',
    ],
  };
  const outPath = args.get('--out') ?? join(dir, 'summary.json');
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), `${JSON.stringify(summary, null, 2)}\n`);
  emit(summary);
  return 0;
}

function usage(): never {
  console.error('usage: g11-latency-probe <plan|run|summarize> --dir DIR [--inputs DIR] [--http URL] [--fixture FILE] [--authorized] [--test-loopback] [--out FILE]');
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  const mode = argv[0] ?? '';
  const args = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--authorized') { args.set(flag, 'true'); continue; }
    const value = argv[index + 1] ?? '';
    args.set(flag, value);
    index += 1;
  }
  if (mode === 'plan') return cmdPlan(args);
  if (mode === 'summarize') return cmdSummarize(args);
  if (mode === 'run') return cmdRun(args);
  return usage();
}

// Only the CLI entry runs the tool: importing the module (a test needs the pure
// helpers) must never parse argv or exit.
if (require.main === module) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
