#!/usr/bin/env node
/**
 * G10-R1 worker D — the 8-episode/16-POST rehearsal of the EXISTING eval.
 *
 * This is a harness, not a second runner: it starts a TEST-OWNED HTTP server on
 * 127.0.0.1:0, runs dist/scripts/eval-g09.js through its real --live code path
 * against a fresh local campaign, then re-verifies read-only and compares the
 * captured wire with the records and the frozen config. No 18872, no real
 * model, no new campaign with real quota outside the rehearsal directory.
 *
 * The output directory is created EXCLUSIVELY (non-recursive mkdir): an
 * existing directory — including the default path — is refused with exit 2,
 * never deleted, never overwritten. Every rehearsal uses a NEW directory.
 *
 * Usage: node scripts/g10-live-rehearse.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repo = resolve('.');
const out = resolve(process.argv[2] ?? 'artifacts/g10-r1/rehearsal');
// Parents may be created recursively, but the output itself must be an
// ATOMIC exclusive create. EEXIST means old evidence lives there: refuse
// BEFORE the server or any campaign directory is created.
mkdirSync(dirname(out), { recursive: true });
try {
  mkdirSync(out);
} catch (error) {
  if (error instanceof Error && error.code === 'EEXIST') {
    console.error(`refusing to overwrite the existing rehearsal output directory: ${out}`);
    console.error('previous rehearsal evidence is immutable; pass a NEW directory path');
    process.exit(2);
  }
  console.error(`cannot create the rehearsal output directory ${out}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const wire = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += String(chunk); });
  req.on('end', () => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'loopback-model' }] }) : '{}');
      return;
    }
    const body = JSON.parse(raw);
    const prompt = String(body.messages?.[0]?.content ?? '');
    const isGoal = prompt.includes('candidateGoals:');
    const goal = prompt.includes('candidateGoals: ["feed_self"]') ? 'feed_self' : 'yield_once';
    const content = isGoal ? JSON.stringify({ goal }) : '{"type":"wait"}';
    const response = JSON.stringify({
      id: `rehearsal-${wire.length + 1}`,
      object: 'chat.completion',
      model: 'loopback-model',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      rehearsalMarker: 'test-owned-server',
    });
    wire.push({ requestBody: body, requestBodyText: raw, responseBody: response, status: 200 });
    res.setHeader('content-type', 'application/json');
    res.end(response);
  });
});

function runChild(args) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, args, { cwd: repo });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const artifacts = join(out, 'artifacts');
  const campaign = join(out, 'campaign');
  const evalRun = await runChild([
    join(repo, 'dist/scripts/eval-g09.js'),
    '--out', artifacts, '--batch', 'loopback-live', '--campaign', campaign,
    '--campaign-limit', '16', '--live', '--http', url, '--model', 'loopback-model',
  ]);
  const verify = await runChild([
    join(repo, 'dist/scripts/eval-g09.js'),
    '--verify', '--out', artifacts, '--batch', 'loopback-live', '--campaign', campaign,
  ]);
  const episodesDir = join(artifacts, 'loopback-live/episodes');
  const episodes = existsSync(episodesDir)
    ? readdirSync(episodesDir).sort().map(name => readJson(join(episodesDir, name)))
    : [];
  const exchanges = episodes.flatMap(episode => episode.http ?? []).sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  const plan = readJson(join(artifacts, 'loopback-live/plan.json'));
  const summary = readJson(join(artifacts, 'loopback-live/summary.json'));
  const ledger = readJson(join(campaign, 'campaign.json'));
  const exact = exchanges.map((exchange, index) => ({
    attemptId: exchange.attemptId,
    requestEqual: wire[index] !== undefined && JSON.stringify(exchange.requestBody) === JSON.stringify(wire[index].requestBody),
    responseEqual: wire[index] !== undefined && exchange.response.body === wire[index].responseBody,
    requestBodyTextEqual: wire[index] !== undefined && exchange.requestBody.messages[0].content === wire[index].requestBody.messages[0].content,
  }));
  const report = {
    schema: 'frostecho.g10.rehearsal/1',
    createdAt: new Date().toISOString(),
    providerSource: 'test-owned loopback HTTP server created by scripts/g10-live-rehearse.mjs',
    endpoint: { class: 'loopback', port, path: '/v1/chat/completions' },
    realModelCalls: 0,
    loopbackPosts: wire.length,
    model: { name: 'loopback-model', thinking: plan.thinking, temperature: plan.mode === 'live' ? 0 : null, timeoutMs: plan.timeoutMs },
    frozen: {
      batch: plan.batch,
      hardChatLimit: plan.hardChatLimit,
      matrix: plan.frozen.matrix,
      runtime: plan.runtime,
      cells: plan.cells,
    },
    exit: evalRun.code,
    verifyExit: verify.code,
    verifyOk: /ok=true/.test(verify.stdout),
    episodes: episodes.length,
    exchanges: exchanges.length,
    allEqual: exact.length === 16 && exact.every(item => item.requestEqual && item.responseEqual),
    exact,
    ledger: { limit: ledger.limit, spent: ledger.spent, attempts: ledger.attempts.length, ledgerId: ledger.ledgerId ?? null },
    summary: { protocol: summary.protocol, costs: summary.costs },
    stdout: evalRun.stdout,
    stderr: evalRun.stderr,
    verifyStdout: verify.stdout,
  };
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`rehearsal -> ${join(out, 'report.json')}`);
  console.log(`posts=${report.loopbackPosts} episodes=${report.episodes} verifyOk=${report.verifyOk} allEqual=${report.allEqual} ledger=${ledger.spent}/${ledger.limit}`);
  await new Promise(resolvePromise => { server.closeAllConnections(); server.close(resolvePromise); });
  const ok = report.loopbackPosts === 16 && report.episodes === 8 && report.verifyOk && report.allEqual && evalRun.code === 0;
  process.exitCode = ok ? 0 : 1;
}

main().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
