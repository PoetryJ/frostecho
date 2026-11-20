/**
 * R11 C line: the JS validator and the Python contract must accept and refuse
 * the same bytes, including the shared feature-identity hash.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Refusal, stableSha, validateManifestFile } from '../../../../scripts/r11/manifest-validator.mjs';

const REPO = resolve(import.meta.dirname, '../../../..');
const PYTHON = process.env.FROSTECHO_PYTHON
  ?? '/data/home/user_00/frostecho-r7/.venv/bin/python';
const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = path => sha(readFileSync(path));
const write = (directory, name, value) => {
  const path = join(directory, name);
  writeFileSync(path, value);
  return path;
};

function writeHead(path) {
  const data = Buffer.alloc(4 * 5120);
  const header = Buffer.from(JSON.stringify({
    'score.weight': { dtype: 'F32', shape: [1, 5120], data_offsets: [0, data.length] },
  }));
  const padding = (8 - (header.length % 8)) % 8;
  const padded = Buffer.concat([header, Buffer.alloc(padding, 0x20)]);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(padded.length));
  writeFileSync(path, Buffer.concat([length, padded, data]));
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'r11-validator-'));
  const head = join(directory, 'warm-17.safetensors');
  writeHead(head);
  write(directory, 'qualification-features.npz', Buffer.from('fixture-qualification'));
  write(directory, 'features.npz', Buffer.from('fixture-cache'));
  write(directory, 'records.jsonl', Buffer.from('{"caseId":"x"}\n'));
  const qualification = {
    ok: true, relativeL2: 0, maxAbs: 0, duplicateMaxAbs: 0,
  };
  const qualificationHash = sha(Buffer.from(JSON.stringify(qualification)));
  const qualificationPath = write(directory, 'qualification.json', JSON.stringify(qualification));
  const corpus = write(directory, 'corpus.jsonl', '{"caseId":"x"}\n');
  const identity = {
    schema: 'frostecho.joint-c-feature-identity/1',
    modelPath: '/model', class: 'Qwen3_5ForCausalLM', torch: '2.6',
    transformers: '4.57', precision: 'bfloat16', quantization: 'none',
    attention: 'eager', deviceMap: { 'model.layers.0': '0' },
    actualParameterBytesByDevice: { 'cuda:0': 1 },
    rotaryBufferDevices: { inv_freq: 'cpu' }, physicalGpus: [1],
    metadataSha256: { 'config.json': 'a'.repeat(64) },
    encoderSourceSha256: fileSha(resolve(REPO,
      'research/decision-choice/jev05/action/joint_encoder.py')),
    weightIdentityScope: 'fixture', readout: 'joint-candidate-end-token',
    dimension: 5120, padding: 'right-masked-position-ids/1', padMultiple: 8,
    rendererSourceSha256: fileSha(resolve(REPO, 'src/r7/jev/render.ts')),
  };
  const identityHash = stableSha(identity);
  qualification.featureIdentityHash = identityHash;
  write(directory, 'qualification.json', JSON.stringify(qualification));
  const document = {
    schema: 'frostecho.training-manifest/r11', experimental: true,
    countsAsAdmitted: false, calibrated: false, researchTrainReady: false,
    mayTrainOnJev: false, labelSource: 'same-snapshot-branch-rollout',
    labelRule: 'fixture rule', labelFamily: 'fulfillment', independentReviews: 2,
    selectedCheckpoint: 'warm-17.safetensors', selectedCheckpointSha256: fileSha(head),
    featureIdentity: identity, featureIdentityHash: identityHash,
    encodingExecution: { batchSize: 1, padMultiple: 8, maxTokens: 2048, placement: 'auto' },
    encodingQualification: { path: 'qualification.json',
      sha256: fileSha(qualificationPath), featuresSha256: fileSha(join(directory,
        'qualification-features.npz')), ok: true, featureIdentityHash: identityHash },
    cacheSha256: fileSha(join(directory, 'features.npz')),
    recordsSha256: fileSha(join(directory, 'records.jsonl')),
    corpusSha256: fileSha(corpus), corpusSplits: { train: 1, dev: 1, test: 1 },
    memory: { policy: 'conditional-experience', selection: 'obligation-first',
      tokenBudget: 640, renderer: 'joint-c-action/2' },
    deadlineProtocol: { continuationPolicy: 'reference-rule/1', horizonMinutes: 240,
      absolute: true, pendingIsNotFailure: true },
    splitUnit: 'sourceEpisodeId', trainingCodeSha256: 'b'.repeat(64),
    backboneGradients: 0, backboneLoadedByTrainer: false,
  };
  const manifest = write(directory, 'training-manifest.json',
    `${JSON.stringify(document)}\n`);
  return { directory, manifest, head, identity, document, qualificationPath };
}

function pythonValidate(manifest, head, directory, extra = []) {
  const script = resolve(REPO, 'research/decision-choice/r11/manifest_contract.py');
  try {
    const output = execFileSync(PYTHON, [script, '--manifest', manifest, '--head', head,
      '--renderer-source', resolve(REPO, 'src/r7/jev/render.ts'),
      '--encoder-source', resolve(REPO, 'research/decision-choice/jev05/action/joint_encoder.py'),
      '--features-dir', directory, '--corpus', join(directory, 'corpus.jsonl'),
      '--memory-policy', 'conditional-experience',
      '--memory-selection', 'obligation-first', '--memory-token-budget', '640',
      ...extra], { encoding: 'utf8' });
    return { code: 0, output: JSON.parse(output) };
  } catch (error) {
    const stdout = error.stdout?.toString() ?? '';
    let output = null;
    try { output = JSON.parse(stdout); } catch { /* refusal may be plain */ }
    return { code: error.status, output, stdout,
      stderr: error.stderr?.toString() ?? '' };
  }
}

test('both validators accept the same v2 document and refuse the same tamper', () => {
  const { directory, manifest, head, document, identity } = fixture();
  const report = validateManifestFile(manifest, {
    headPath: head, rendererSource: resolve(REPO, 'src/r7/jev/render.ts'),
    encoderSource: resolve(REPO, 'research/decision-choice/jev05/action/joint_encoder.py'),
    featuresDir: directory, corpus: join(directory, 'corpus.jsonl'),
    memory: { policy: 'conditional-experience', selection: 'obligation-first',
      tokenBudget: 640 },
  });
  assert.equal(report.contractVersion, 2);
  assert.equal(report.schemaCanonical, 'frostecho.training-manifest/r11');
  assert.equal(report.labelSource, 'same-snapshot-branch-rollout');
  const python = pythonValidate(manifest, head, directory);
  assert.equal(python.code, 0, python.stderr);
  assert.equal(python.output.featureIdentityHash, report.featureIdentityHash);
  assert.equal(python.output.contractVersion, 2);

  const tampered = structuredClone(document);
  tampered.featureIdentity.rendererSourceSha256 = '0'.repeat(64);
  tampered.featureIdentityHash = stableSha(tampered.featureIdentity);
  const tamperedPath = write(directory, 'tampered.json', `${JSON.stringify(tampered)}\n`);
  assert.throws(() => validateManifestFile(tamperedPath, {
    headPath: head, rendererSource: resolve(REPO, 'src/r7/jev/render.ts'),
  }), error => error instanceof Refusal && error.code === 'feature-identity-renderer');
  const refused = pythonValidate(tamperedPath, head, directory);
  assert.equal(refused.code, 2);
  assert.equal(refused.output?.code, 'feature-identity-renderer', refused.stdout);
  void identity;
});

test('the shared hash is identical across languages', () => {
  const { identity } = fixture();
  const jsHash = stableSha(identity);
  const output = execFileSync(PYTHON, ['-c', [
    'import json,sys',
    'sys.path.insert(0, "research/decision-choice/r11")',
    'import manifest_contract as c',
    'print(c.stable_sha(json.loads(sys.stdin.read())))',
  ].join('\n')], { cwd: REPO, input: JSON.stringify(identity), encoding: 'utf8' }).trim();
  assert.equal(output, jsHash);
});

test('a head name or sha mismatch is refused before any model load', () => {
  const { manifest, head } = fixture();
  assert.throws(() => validateManifestFile(manifest, {
    headPath: head.replace('warm-17', 'other'),
  }), error => error instanceof Refusal && error.code === 'head-missing');
});
