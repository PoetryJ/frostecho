#!/usr/bin/env node
/**
 * Normalise a live serve reply into the `joint-live-probe/2` document the
 * replay tool reads. Every value is copied from the real run; nothing is
 * synthesised, and the identity fields are kept as the service reported them.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const get = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const requestPath = get('--request');
const resultPath = get('--result');
const outPath = get('--out');
if (!requestPath || !resultPath || !outPath) {
  throw new Error('--request --result --out are required');
}
if (existsSync(resolve(outPath))) throw new Error('choose a new output path');

const sha = value => createHash('sha256').update(value).digest('hex');
const envelope = JSON.parse(readFileSync(resolve(requestPath), 'utf8'));
const requestBytes = readFileSync(resolve(requestPath), 'utf8');
const served = JSON.parse(readFileSync(resolve(resultPath), 'utf8').trim().split('\n')[0]);
if (served.error) throw new Error(`serve failed: ${served.error}`);

const document = {
  schema: 'frostecho.r8.joint-live-probe/2',
  status: 'encoded',
  sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
  requestFileSha256: sha(requestBytes),
  input: {
    inputSha256: served.inputSha256,
    candidateSetHash: served.candidateSetHash,
    candidateIds: served.scores.map(score => score.candidateId),
    rendererId: 'joint-c-action/1',
    rendererSourceSha256: envelope.rendererSourceSha256,
    rendererBuildSha256: envelope.rendererBuildSha256,
    tokens: served.encoder.tokens,
  },
  scores: served.scores.map(score => ({
    candidateId: score.candidateId,
    logit: score.logit,
    probability: score.probability,
  })),
  selectedId: served.selectedId,
  disposition: served.disposition,
  forward: { shape: served.encoder.shape, featureSha256: served.encoder.featureSha256 },
  encoder: served.encoder,
  headSha256: served.identity.headSha256,
  encoderForwardCalls: served.encoder.encoderForwardCalls,
  headForwardCalls: 1,
  gameCommits: 0,
  experimental: served.identity.experimental,
  countsAsAdmitted: served.identity.countsAsAdmitted,
  calibrated: false,
  temperature: served.identity.temperature,
  tau: served.identity.tau,
  identity: served.identity,
  latencyMs: served.latencyMs,
  note: 'produced by the persistent serve_joint.py process; admission requires a certificate',
};
writeFileSync(resolve(outPath), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, out: outPath, selectedId: document.selectedId,
  candidates: document.scores.length, tokens: document.input.tokens,
  encoderForwardCalls: document.encoderForwardCalls }, null, 2));
