/** Run live decisions, persist, then verify the complete runtime in a fresh process. */
import { resolve, join } from 'node:path';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openCli } from './cli-session.mjs';

const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const root = process.cwd(), out = resolve(arg('--out') ?? 'artifacts/r8-online');
mkdirSync(out, { recursive: true });
const state = resolve(arg('--state') ?? join(out, 'session.json'));
const mode = arg('--mode') ?? 'reference', steps = Number(arg('--steps') ?? 2);
if (!Number.isInteger(steps) || steps < 1) throw new Error('--steps must be a positive integer');
const actors = (arg('--actors') ?? 'npc_01,npc_02').split(',');
const command = arg('--scorer-command-json') ?? process.env.FROSTECHO_SCORER_COMMAND_JSON;
const base = ['--state', state, '--profile', 'gospel-5.8.19', '--mode', mode,
  '--seed', arg('--seed') ?? 'r8-online', '--scorer-transcript', join(out, 'scorer.jsonl')];
if (command) base.push('--scorer-command-json', command);
const timeoutMs = Number(arg('--timeout-ms') ?? 300000);
base.push('--scorer-timeout-ms', String(timeoutMs));
const log = record => appendFileSync(join(out, 'cli.jsonl'), JSON.stringify(record) + '\n');
const cli = openCli(root, [...base, ...(process.argv.includes('--fresh') ? ['--fresh'] : [])], { timeoutMs, onRecord: log });
let first, restored;
try {
  await cli.ready;
  if (process.argv.includes('--full-map')) await cli.send('r8-map-enable');
  const before = await cli.send('observe'), decisions = [];
  for (let i = 0; i < steps; i++) decisions.push(await cli.send(`r8-step ${actors[i % actors.length]}`));
  first = await cli.send('r8-status');
  const after = await cli.send('observe');
  await cli.send('save');
  // Compare all saved authority and ledgers, not merely their clocks.
  const suffixes = ['', '.r8.json', '.tasks.json', '.experience.json', '.commitments.json', '.council.json', '.decision-memory.json'];
  const documents = new Map();
  for (const suffix of suffixes) {
    try { documents.set(suffix, JSON.parse(readFileSync(state + suffix, 'utf8'))); }
    catch (error) { if (suffix === '' || suffix === '.r8.json' || error.code !== 'ENOENT') throw error; }
  }
  await cli.close();
  const second = openCli(root, base, { timeoutMs, onRecord: log });
  try {
    await second.ready; restored = await second.send('r8-status');
    assert.deepEqual(restored.runtime, first.runtime, 'fresh process changed runtime domains/receipt ledger');
    const restoredObservation = await second.send('observe');
    const strip = ({ jobId, ...rest }) => rest;
    assert.deepEqual(strip(restoredObservation), strip(after), 'fresh process changed observation');
    await second.send('save');
    for (const [suffix, expected] of documents)
      assert.deepEqual(JSON.parse(readFileSync(state + suffix, 'utf8')), expected, `changed saved document ${suffix || 'session'}`);
    await second.close();
  } finally { if (second.child.exitCode === null) await second.close().catch(() => second.kill()); }
  const report = { schema: 'frostecho.online-play/1', mode, steps,
    scored: decisions.flatMap(row => row.records ?? []).filter(row => row.candidates?.length >= 2).length,
    executed: decisions.reduce((sum, row) => sum + row.executed, 0),
    before, after, decisions, runtimeSha256: createHash('sha256').update(JSON.stringify(first.runtime)).digest('hex'),
    restoreEqual: true, documentsCompared: [...documents.keys()],
    evidenceClass: mode === 'reference' ? 'reference' : 'experimental', countsAsAdmitted: false };
  if (mode !== 'reference' && existsSync(join(out, 'scorer.jsonl'))) {
    const replies = readFileSync(join(out, 'scorer.jsonl'), 'utf8').trim().split('\n')
      .map(JSON.parse).filter(row => row.event === 'score_reply');
    report.scorerIdentity = replies.at(-1)?.reply.identity ?? null;
  }
  writeFileSync(join(out, 'online-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, mode, executed: report.executed, restoreEqual: true, out }));
} finally { if (cli.child.exitCode === null) await cli.close().catch(() => cli.kill()); }
