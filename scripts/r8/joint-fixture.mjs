/** Protocol fixture only. This does not load an encoder or prove model quality. */
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { referenceAgencyScorer } = require('../../dist/src/r7/agency/reference.js');
const scorer = referenceAgencyScorer();
const delay = Number(process.argv[2] ?? 0);
let calls = 0;
createInterface({ input: process.stdin }).on('line', async line => {
  const envelope = JSON.parse(line), { request } = envelope;
  assert.equal(envelope.schema, 'frostecho.joint-encoding-request/1');
  assert.equal(envelope.inputSha256, createHash('sha256').update(envelope.requestJson).digest('hex'));
  assert.deepEqual(JSON.parse(envelope.requestJson), request);
  assert.equal(envelope.rendered.spanUnit, 'utf16-code-unit');
  const result = await scorer.score(request);
  await new Promise(resolve => setTimeout(resolve, delay));
  console.log(JSON.stringify({ ...result, inputSha256: envelope.inputSha256,
    identity: { mode: 'jev-experimental', scorerId: 'joint-protocol-fixture/1',
      experimental: true, countsAsAdmitted: false, rendererId: 'joint-c-action/1',
      requestsReceived: ++calls, encoderForwardCalls: 0, scoresSucceeded: calls },
    encoder: { evidenceClass: 'fixture', realModel: false, encoderForwardCalls: 0 } }));
});
