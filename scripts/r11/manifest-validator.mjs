#!/usr/bin/env node
/**
 * R11 C line: the shared manifest validator H/CLI/web can call without Python.
 *
 *   node scripts/r11/manifest-validator.mjs --manifest <m> --head <h> \
 *     [--renderer-source src/r7/jev/render.ts] \
 *     [--encoder-source research/decision-choice/jev05/action/joint_encoder.py] \
 *     [--features-dir <enc>] [--corpus <corpus.jsonl>] \
 *     [--memory-policy conditional-experience --memory-selection obligation-first \
 *      --memory-token-budget 640] [--json-out <file>]
 *
 * It is the same contract as `research/decision-choice/r11/manifest_contract.py`:
 * version 1 is `frostecho.action-weak-experiment/1` and reference-imitation only;
 * version 2 is `frostecho.training-manifest/r11` (alias
 * `frostecho.action-training-manifest/2`) and allows reference-imitation and
 * same-snapshot-branch-rollout.  Missing or tampered documents exit 2 with a
 * stable code, before any model is loaded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA_V1 = 'frostecho.action-weak-experiment/1';
export const SCHEMA_V2 = 'frostecho.action-training-manifest/2';
export const SCHEMA_R11 = 'frostecho.training-manifest/r11';
export const SCHEMA_V2_ALIASES = [SCHEMA_V2, SCHEMA_R11];
export const LABEL_REFERENCE = 'reference-imitation';
export const LABEL_BRANCH = 'same-snapshot-branch-rollout';
export const HIDDEN = 5120;
export const PAD_MULTIPLE = 8;

export class Refusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

export const fileSha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const shaBytes = value => createHash('sha256').update(value).digest('hex');

const sortDeep = value => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
};
export const canonical = value => JSON.stringify(sortDeep(value));
export const stableSha = value => shaBytes(canonical(value));

const requireThat = (condition, code, detail) => {
  if (!condition) throw new Refusal(code, detail);
};
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nonempty = (value, field) => {
  requireThat(typeof value === 'string' && value.trim() !== '', 'manifest-field',
    `${field} must be a nonempty string`);
  return value;
};

function readHead(path, expectedSha) {
  requireThat(existsSync(path), 'head-missing', `head ${path} does not exist`);
  requireThat(typeof expectedSha === 'string' && expectedSha.length === 64, 'head-sha',
    'a head sha is required with the head path');
  requireThat(fileSha(path) === expectedSha, 'head-sha',
    'selectedCheckpointSha256 differs from the supplied head');
  const bytes = readFileSync(path);
  requireThat(bytes.length > 8, 'head-tensor', 'head is too small for a safetensors file');
  const headerLength = Number(bytes.readBigUInt64LE(0));
  requireThat(headerLength > 0 && 8 + headerLength <= bytes.length, 'head-tensor',
    'invalid safetensors header length');
  let header;
  try {
    header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString('utf8'));
  } catch (error) {
    throw new Refusal('head-tensor', `safetensors header is not JSON: ${error.message}`);
  }
  const tensor = header['score.weight'];
  requireThat(tensor && tensor.dtype === 'F32', 'head-tensor',
    'head must contain exactly one F32 score.weight');
  requireThat(tensor.shape?.length === 2 && tensor.shape[0] === 1
    && tensor.shape[1] === HIDDEN, 'head-tensor',
    `score.weight must be [1,${HIDDEN}], got ${JSON.stringify(tensor.shape)}`);
  const [begin, end] = tensor.data_offsets ?? [];
  requireThat(Number.isInteger(begin) && Number.isInteger(end)
    && end - begin === 4 * HIDDEN && 8 + headerLength + end <= bytes.length,
  'head-tensor', 'score.weight data offsets are inconsistent with the file');
  const data = bytes.subarray(8 + headerLength + begin, 8 + headerLength + end);
  for (let offset = 0; offset < data.length; offset += 4) {
    if (!Number.isFinite(data.readFloatLE(offset))) {
      throw new Refusal('head-tensor', 'head contains nonfinite values');
    }
  }
  return { path, sha256: expectedSha };
}

function checkFeatureIdentity(document, options, requireFull) {
  const identity = document.featureIdentity;
  requireThat(identity && typeof identity === 'object', 'feature-identity',
    'featureIdentity must be an object');
  requireThat(stableSha(identity) === document.featureIdentityHash,
    'feature-identity-hash', 'featureIdentityHash does not hash featureIdentity');
  if (!requireFull) return identity;
  requireThat(identity.dimension === HIDDEN, 'feature-identity-dimension',
    `dimension must be ${HIDDEN}`);
  requireThat(identity.padMultiple === PAD_MULTIPLE, 'feature-identity-padding',
    `padMultiple must be ${PAD_MULTIPLE}`);
  if (options.rendererSource) {
    requireThat(identity.rendererSourceSha256 === fileSha(options.rendererSource),
      'feature-identity-renderer',
      'cache renderer differs from the live renderer; re-encode, do not relabel');
  }
  if (options.encoderSource && identity.encoderSourceSha256 !== undefined) {
    requireThat(identity.encoderSourceSha256 === fileSha(options.encoderSource),
      'feature-identity-encoder', 'cache encoder source differs from the live encoder');
  }
  for (const key of ['modelPath', 'precision', 'readout', 'padding']) {
    nonempty(identity[key], `featureIdentity.${key}`);
  }
  requireThat(identity.precision === 'bfloat16', 'feature-identity-precision',
    'served features are bfloat16');
  return identity;
}

function checkExecution(document) {
  const execution = document.encodingExecution;
  requireThat(execution && typeof execution === 'object', 'encoding-execution',
    'encodingExecution is required');
  requireThat(execution.batchSize === 1, 'encoding-execution',
    'online service requires batchSize 1');
  requireThat(execution.padMultiple === PAD_MULTIPLE, 'encoding-execution',
    `online service requires padMultiple ${PAD_MULTIPLE}`);
  requireThat(Number.isInteger(execution.maxTokens) && execution.maxTokens > 0,
    'encoding-execution', 'maxTokens must be a positive integer');
  requireThat(['auto', 'one-layer-offload'].includes(execution.placement),
    'encoding-execution', 'placement must be auto or one-layer-offload');
  return execution;
}

function checkQualification(document, featuresDir) {
  const entry = document.encodingQualification;
  requireThat(entry && typeof entry === 'object', 'encoding-qualification',
    'encodingQualification is required');
  nonempty(entry.path, 'encodingQualification.path');
  requireThat(isDigest(entry.sha256), 'encoding-qualification',
    'encodingQualification.sha256 must be a sha256');
  requireThat(isDigest(entry.featuresSha256), 'encoding-qualification',
    'encodingQualification.featuresSha256 must be a sha256');
  requireThat(entry.ok !== false, 'encoding-qualification', 'qualification did not pass');
  requireThat(entry.featureIdentityHash === undefined
    || entry.featureIdentityHash === document.featureIdentityHash,
  'encoding-qualification', 'qualification identity differs from the manifest');
  if (featuresDir) {
    const qualification = resolve(featuresDir, entry.path);
    const qualificationFeatures = resolve(featuresDir, 'qualification-features.npz');
    requireThat(existsSync(qualification) && fileSha(qualification) === entry.sha256,
      'encoding-qualification-bytes', `${qualification} is missing or changed`);
    requireThat(existsSync(qualificationFeatures)
      && fileSha(qualificationFeatures) === entry.featuresSha256,
    'encoding-qualification-bytes', 'qualification-features.npz is missing or changed');
    const sealed = JSON.parse(readFileSync(qualification, 'utf8'));
    requireThat(sealed.ok === true, 'encoding-qualification', 'qualification.json did not pass');
    requireThat(sealed.featureIdentityHash === document.featureIdentityHash,
      'encoding-qualification', 'qualification.json was produced under another identity');
    for (const [name, key] of [['features.npz', 'cacheSha256'],
      ['records.jsonl', 'recordsSha256']]) {
      const path = resolve(featuresDir, name);
      requireThat(existsSync(path) && isDigest(document[key]), 'cache-sha',
        `${name} or its digest is missing`);
      requireThat(fileSha(path) === document[key], 'cache-sha',
        `${name} differs from ${key}`);
    }
  }
  return entry;
}

function checkMemory(document, expected) {
  const memory = document.memory;
  requireThat(memory && typeof memory === 'object', 'memory-identity',
    'version 2 manifests must bind the memory policy');
  nonempty(memory.policy, 'memory.policy');
  nonempty(memory.selection, 'memory.selection');
  requireThat(Number.isInteger(memory.tokenBudget) && memory.tokenBudget > 0,
    'memory-identity', 'memory.tokenBudget must be a positive integer');
  if (expected) {
    for (const key of ['policy', 'selection', 'tokenBudget']) {
      if (expected[key] !== undefined) {
        requireThat(expected[key] === memory[key], 'memory-identity',
          `served ${key} ${expected[key]} differs from manifest ${memory[key]}`);
      }
    }
  }
  return memory;
}

function checkCorpus(document, corpus) {
  requireThat(isDigest(document.corpusSha256), 'corpus-sha',
    'corpusSha256 must be a sha256');
  if (corpus) {
    requireThat(fileSha(corpus) === document.corpusSha256, 'corpus-sha',
      'corpus file differs from corpusSha256');
  }
  const splits = document.corpusSplits;
  if (splits !== undefined && splits !== null) {
    requireThat(splits && Object.keys(splits).sort().join(',') === 'dev,test,train'
      && Object.values(splits).every(value => Number.isInteger(value) && value >= 0),
    'corpus-splits', 'corpusSplits must hold nonnegative train/dev/test counts');
  }
}

function checkDeadline(document) {
  const protocol = document.deadlineProtocol;
  requireThat(protocol && typeof protocol === 'object', 'deadline-protocol',
    'branch-rollout labels must bind the common-deadline protocol');
  nonempty(protocol.continuationPolicy, 'deadlineProtocol.continuationPolicy');
  requireThat(Number.isInteger(protocol.horizonMinutes) && protocol.horizonMinutes > 0,
    'deadline-protocol', 'horizonMinutes must be a positive integer');
  requireThat(protocol.absolute === true, 'deadline-protocol',
    'branches must run to one absolute deadline, not a per-branch horizon');
  requireThat(protocol.pendingIsNotFailure === true, 'deadline-protocol',
    'an unfinished slow action must be recorded as pending');
  return protocol;
}

/**
 * Validate one manifest against the bytes it claims. Throws Refusal.
 * `options`: { headPath, headSha, rendererSource, encoderSource, featuresDir,
 *              corpus, memory, allowLegacyV1 }
 */
export function validateManifest(document, options = {}) {
  requireThat(document && typeof document === 'object', 'manifest-json',
    'manifest root must be an object');
  const schema = document.schema;
  let version;
  if (SCHEMA_V2_ALIASES.includes(schema)) version = 2;
  else if (schema === SCHEMA_V1) version = 1;
  else throw new Refusal('manifest-schema', `unexpected schema ${JSON.stringify(schema)}`);
  if (version === 1 && options.allowLegacyV1 === false) {
    throw new Refusal('manifest-schema', 'legacy version 1 is not accepted here');
  }
  for (const [field, expected] of [['experimental', true], ['countsAsAdmitted', false],
    ['calibrated', false], ['researchTrainReady', false], ['mayTrainOnJev', false]]) {
    requireThat(document[field] === expected, 'manifest-admission-flags',
      `${field} must be ${expected}`);
  }
  const source = document.labelSource;
  requireThat([LABEL_REFERENCE, LABEL_BRANCH].includes(source), 'label-source',
    `labelSource ${JSON.stringify(source)} is not allowed`);
  if (version === 1) {
    requireThat(source === LABEL_REFERENCE, 'label-source',
      `version 1 is reference-imitation only; branch rollouts require ${SCHEMA_R11}`);
    requireThat(document.selectedCheckpointSha256 === options.headSha,
      'head-sha', 'selectedCheckpointSha256 differs from the supplied head');
    if (options.rendererSource) {
      const identity = document.featureIdentity ?? {};
      requireThat(stableSha(identity) === document.featureIdentityHash,
        'feature-identity-hash', 'featureIdentityHash does not hash featureIdentity');
    } else {
      requireThat(stableSha(document.featureIdentity) === document.featureIdentityHash,
        'feature-identity-hash', 'featureIdentityHash does not hash featureIdentity');
    }
    requireThat(document.encodingExecution?.batchSize === 1
      && document.encodingExecution?.padMultiple === PAD_MULTIPLE, 'encoding-execution',
    'online head requires the completed batch1 / pad8 encoding experiment');
    requireThat(document.encodingQualification?.path
      && isDigest(document.encodingQualification?.sha256)
      && isDigest(document.encodingQualification?.featuresSha256),
    'encoding-qualification',
    'training manifest lacks its encoding qualification binding');
    return { ok: true, contractVersion: 1, schema, schemaCanonical: SCHEMA_V1,
      sha256: options.manifestSha ?? null, labelSource: source,
      labelRule: document.labelRule ?? '',
      labelFamily: document.labelFamily ?? null,
      selectedCheckpointSha256: document.selectedCheckpointSha256,
      featureIdentityHash: document.featureIdentityHash,
      countsAsAdmitted: false, experimental: true };
  }

  const rule = nonempty(document.labelRule, 'labelRule');
  requireThat(Number.isInteger(document.independentReviews)
    && document.independentReviews >= 0, 'independent-reviews',
  'independentReviews must be a nonnegative integer');
  let head = null;
  if (options.headPath) {
    head = readHead(options.headPath, options.headSha);
    requireThat(document.selectedCheckpoint === undefined
      || document.selectedCheckpoint === options.headPath.split('/').at(-1),
    'head-name', 'selectedCheckpoint differs from the supplied head name');
  } else {
    requireThat(document.selectedCheckpointSha256 === options.headSha, 'head-sha',
      'selectedCheckpointSha256 differs from the supplied head');
  }
  const identity = checkFeatureIdentity(document, options, true);
  const execution = checkExecution(document);
  const qualification = checkQualification(document, options.featuresDir);
  const memory = checkMemory(document, options.memory);
  checkCorpus(document, options.corpus);
  const deadline = source === LABEL_BRANCH ? checkDeadline(document) : null;
  if (source === LABEL_BRANCH && document.splitUnit !== undefined) {
    requireThat(document.splitUnit === 'sourceEpisodeId', 'split-unit',
      'branch corpora must split by sourceEpisodeId');
  }
  requireThat(isDigest(document.trainingCodeSha256), 'manifest-field',
    'trainingCodeSha256 must be a sha256');
  requireThat(document.backboneGradients === 0, 'backbone',
    'this recipe trains small heads only (backboneGradients 0)');
  requireThat(document.backboneLoadedByTrainer === false, 'backbone',
    'the trainer must not load the backbone');
  return { ok: true, contractVersion: 2, schema, schemaCanonical: SCHEMA_R11,
    sha256: options.manifestSha ?? null, labelSource: source, labelRule: rule,
    labelFamily: document.labelFamily ?? null, independentReviews: document.independentReviews,
    selectedCheckpoint: document.selectedCheckpoint ?? null,
    selectedCheckpointSha256: document.selectedCheckpointSha256, head,
    featureIdentityHash: document.featureIdentityHash,
    rendererSourceSha256: identity.rendererSourceSha256,
    execution, qualification, memory,
    corpus: { sha256: document.corpusSha256, splits: document.corpusSplits ?? null },
    deadlineProtocol: deadline, experimental: true, countsAsAdmitted: false };
}

/** File-oriented helper: parse, hash and validate in one call. */
export function validateManifestFile(path, options = {}) {
  requireThat(existsSync(path), 'manifest-missing', `no training manifest at ${path}`);
  const bytes = readFileSync(path);
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Refusal('manifest-json', `manifest is not JSON: ${error.message}`); }
  return validateManifest(document, {
    ...options, manifestSha: shaBytes(bytes),
    headSha: options.headSha ?? (options.headPath && existsSync(options.headPath)
      ? fileSha(options.headPath) : undefined),
  });
}

function parseArgs(argv) {
  const args = { values: {} };
  const names = new Set(['--manifest', '--head', '--renderer-source', '--encoder-source',
    '--features-dir', '--corpus', '--memory-policy', '--memory-selection',
    '--memory-token-budget', '--json-out']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!names.has(key)) throw new Refusal('cli', `unknown argument ${key}`);
    args.values[key] = argv[index + 1];
    index += 1;
  }
  return args.values;
}

export function main(argv = process.argv.slice(2)) {
  const values = parseArgs(argv);
  requireThat(values['--manifest'], 'cli', '--manifest is required');
  requireThat(values['--head'], 'cli', '--head is required');
  const memory = values['--memory-policy']
    ? { policy: values['--memory-policy'],
      selection: values['--memory-selection'],
      tokenBudget: values['--memory-token-budget']
        ? Number(values['--memory-token-budget']) : undefined }
    : undefined;
  const report = validateManifestFile(values['--manifest'], {
    headPath: values['--head'],
    rendererSource: values['--renderer-source'],
    encoderSource: values['--encoder-source'],
    featuresDir: values['--features-dir'],
    corpus: values['--corpus'],
    memory,
  });
  const text = `${JSON.stringify(report)}\n`;
  if (values['--json-out']) writeFileSync(values['--json-out'], text);
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    const refusal = error instanceof Refusal ? error
      : new Refusal('internal', error?.message ?? String(error));
    process.stderr.write(`${JSON.stringify({ ok: false, refused: true,
      code: refusal.code, detail: refusal.detail })}\n`);
    process.exitCode = 2;
  }
}
