#!/usr/bin/env node
/** Capture a real pre-action request. No model call and no world commit. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { R8Runtime } = require('../../dist/src/r7/integration/runtime.js');
const { runStep } = require('../../dist/src/r7/integration/step.js');
const { renderRequest } = require('../../dist/src/r7/jev/render.js');
const { validateChoiceRequest } = require('../../dist/src/decision/contracts.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
};
const out = option('--out');
if (!out) throw new Error('Usage: node scripts/r8/export-encoding-request.mjs --out <new.json> [--seed <seed>]');
const seed = option('--seed') ?? 'r8-joint-probe';
const runtime = R8Runtime.create({ seed, npcCount: 8 });
const initial = JSON.stringify({ world: runtime.world, states: runtime.states });
const captureComplete = new Error('capture-complete');
let captured;
const identity = { mode: 'reference', scorerId: 'encoding-request-capture/1',
  rendererId: 'joint-c-action/1', experimental: false, countsAsAdmitted: false };
const scorer = {
  identity,
  async score(request) {
    validateChoiceRequest(request);
    if (request.candidates.length < 2) return { requestId: request.requestId,
      candidateSetHash: request.candidateSetHash, scorerId: identity.scorerId,
      scores: [], selectedId: null, disposition: 'abstain', reason: 'capture skips single candidate' };
    if (request.candidates.length > 8) throw new Error('Capture requires K=2..8');
    const rendered = renderRequest(request);
    for (const span of rendered.candidateSpans) {
      const segment = rendered.segments.find(s => s.kind === 'candidate' && s.index === span.index);
      if (!segment || rendered.text.slice(span.start, span.end) !== segment.text)
        throw new Error('Renderer candidate span does not match its segment');
    }
    const requestJson = JSON.stringify(request);
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (commit.status !== 0) throw new Error('Cannot identify source commit');
    captured = { schema: 'frostecho.joint-encoding-request/1', sourceHEAD: commit.stdout.trim(),
      nodeVersion: process.version, seed, npcCount: 8, request, requestJson,
      inputSha256: sha(requestJson), rendered: { ...rendered, spanUnit: 'utf16-code-unit' },
      rendererSourceSha256: sha(readFileSync(resolve(root, 'src/r7/jev/render.ts'))),
      rendererBuildSha256: sha(readFileSync(resolve(root, 'dist/src/r7/jev/render.js'))),
      renderedTextSha256: sha(rendered.text), modelCalls: 0, worldCommits: 0 };
    throw captureComplete;
  },
};
try { await runStep(runtime, scorer, { mode: 'reference', memoryPolicy: 'conditional-experience' }); }
catch (error) { if (error !== captureComplete) throw error; }
if (!captured) throw new Error('No real K=2..8 request found');
if (initial !== JSON.stringify({ world: runtime.world, states: runtime.states }))
  throw new Error('Capture unexpectedly changed the authoritative state');
const target = resolve(out);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(captured, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ ok: true, output: target, candidates: captured.request.candidates.length,
  inputSha256: captured.inputSha256, spanUnit: captured.rendered.spanUnit,
  utf16Length: captured.rendered.text.length, codePoints: [...captured.rendered.text].length,
  modelCalls: 0, worldCommits: 0 }));
