import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  RISK_ALPHA, TAU_GRID, assessEvidence, cpUpper, fitTemperature, softmax,
  type EvidencePayload, type EvidenceRecord,
} from '../src/decision/jev-evidence';

const IDENTITY = {
  model: 'fixture/r61', head: 'shared-scalar/1', adapter: 'jev-choice/1',
  tokenizer: 'fixture-tok/1', renderer: 'jev04-render/3', task: 'choose_action', k: 2,
  policy_version: 'softmax-accept/1', memory_policy_version: 'memory-policy/1',
};

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort()
      .map(key => [key, sortValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function stamp(name: 'calT' | 'select' | 'cert', records: EvidenceRecord[],
  extra: Partial<EvidencePayload>): EvidencePayload {
  return {
    partition: name,
    evidenceClass: 'fixture',
    calibration_id: 'near-tau',
    policy: { ...IDENTITY },
    sampleIds: records.map(record => record.sampleId),
    records,
    data_sha256: createHash('sha256').update(JSON.stringify(sortValue(records)), 'utf8').digest('hex'),
    ...extra,
  };
}

function peaked(prefix: string, group: string, count: number): EvidenceRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    sampleId: `${prefix}-${index}`,
    sourceGroup: group,
    candidateIds: ['a', 'b'],
    logits: [5, 0],
    label: 0,
    evidenceClass: 'fixture',
  }));
}

function row(id: string, group: string, delta: number, label: number): EvidenceRecord {
  return {
    sampleId: id, sourceGroup: group, candidateIds: ['a', 'b'],
    logits: [delta, 0], label, evidenceClass: 'fixture',
  };
}

function frozenTau(records: EvidenceRecord[], temperature: number): { tau: number; accepted: number } {
  const scored = records.map(record => {
    const scaled = softmax(record.logits, temperature);
    return { pmax: scaled[0] >= scaled[1] ? scaled[0] : scaled[1], correct: (scaled[0] >= scaled[1] ? 0 : 1) === record.label };
  });
  let best: { tau: number; accepted: number } | null = null;
  for (const tau of TAU_GRID) {
    const accepted = scored.filter(item => item.pmax >= tau);
    if (accepted.length < 100) continue;
    const errors = accepted.filter(item => !item.correct).length;
    if (errors / accepted.length > 0.05) continue;
    if (!best || accepted.length > best.accepted) best = { tau, accepted: accepted.length };
  }
  if (!best) throw new Error('select did not freeze');
  return best;
}

test('a non-flat margin still passes when the temperature band keeps the accept set', () => {
  const cal = peaked('cal', 'cal', 40);
  const fitted = fitTemperature(cal.map(record => record.logits), cal.map(record => record.label));
  const stable = Math.log(0.55 / 0.45) * fitted;
  const select = [
    ...peaked('sel', 'select', 100),
    ...Array.from({ length: 6 }, (_, index) => row(`bad-${index}`, 'select', stable, 1)),
  ];
  const chosen = frozenTau(select, fitted);
  assert.equal(chosen.tau, 0.6);
  const selectCoverage = Number((chosen.accepted / select.length).toFixed(4));
  const cert = peaked('cert', 'cert', 120);
  const upper = cpUpper(0, cert.length, RISK_ALPHA);
  const assessed = assessEvidence({
    calT: stamp('calT', cal, { temperature: fitted }),
    select: stamp('select', select, {
      temperature: fitted, tau: chosen.tau, accepted: chosen.accepted,
      coverage: selectCoverage,
    }),
    cert: stamp('cert', cert, {
      tau: chosen.tau, n: cert.length, errors: 0, upper: upper ?? undefined,
      coverage: 1, alpha: RISK_ALPHA,
    }),
  }, IDENTITY);
  assert.equal(assessed.ok, true, assessed.reason);
  assert.equal(assessed.tau, 0.6);
});

test('a near-tau sample inside the 2e-3 band is rejected when the accept set would change', () => {
  const cal = peaked('cal', 'cal', 40);
  const fitted = fitTemperature(cal.map(record => record.logits), cal.map(record => record.label));
  const declared = Number((fitted + 0.0015).toFixed(6));
  assert.ok(Math.abs(declared - fitted) <= 2e-3);
  assert.notEqual(declared, fitted);
  const mid = (fitted + declared) / 2;
  const boundary = Math.log(1.5) * mid;
  const atFit = softmax([boundary, 0], fitted)[0];
  const atDeclared = softmax([boundary, 0], declared)[0];
  assert.ok((atFit >= 0.6 && atDeclared < 0.6) || (atDeclared >= 0.6 && atFit < 0.6));
  const stable = Math.log(0.55 / 0.45) * Math.max(fitted, declared);
  const stableAtFit = softmax([stable, 0], fitted)[0];
  const stableAtDeclared = softmax([stable, 0], declared)[0];
  assert.ok(stableAtFit > 0.5 && stableAtFit < 0.6 && stableAtDeclared > 0.5 && stableAtDeclared < 0.6);
  const select = [
    ...peaked('sel', 'select', 100),
    ...Array.from({ length: 6 }, (_, index) => row(`bad-${index}`, 'select', stable, 1)),
    row('edge', 'select', boundary, 0),
  ];
  const chosen = frozenTau(select, declared);
  const selectCoverage = Number((chosen.accepted / select.length).toFixed(4));
  const cert = peaked('cert', 'cert', 120);
  const upper = cpUpper(0, cert.length, RISK_ALPHA);
  const assessed = assessEvidence({
    calT: stamp('calT', cal, { temperature: declared }),
    select: stamp('select', select, {
      tau: chosen.tau, accepted: chosen.accepted, coverage: selectCoverage,
    }),
    cert: stamp('cert', cert, {
      tau: chosen.tau, n: cert.length, errors: 0, upper: upper ?? undefined,
      coverage: 1, alpha: RISK_ALPHA,
    }),
  }, IDENTITY);
  assert.equal(assessed.ok, false);
  assert.match(assessed.reason, /accept set/);
});
