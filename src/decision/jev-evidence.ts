/**
 * R6: recompute sealed calT/select/cert claims from per-sample records.
 * The arithmetic is the same bisection / golden-section as calibration.py.
 * A summary without records is not evidence. This module loads no model.
 */
import { createHash } from 'node:crypto';
export const RISK_ALPHA = 0.05;
export const RISK_MAX = 0.05;
export const RISK_MIN_ACCEPTED = 100;
export const RISK_MIN_COVERAGE = 0.3;
export const TAU_GRID = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975, 0.99];
const TOLERANCE = 1e-9;

export interface EvidenceRecord {
  sampleId: string;
  sourceGroup: string;
  candidateIds: string[];
  logits: number[];
  label: number;
  evidenceClass?: string;
  accepted?: boolean;
  error?: boolean;
}

export interface EvidencePayload {
  partition?: string;
  evidenceClass?: string;
  calibration_id?: string;
  protocol_version?: string;
  policy?: Record<string, unknown>;
  sampleIds?: string[];
  records?: EvidenceRecord[];
  data_sha256?: string;
  temperature?: number;
  tau?: number;
  accepted?: number;
  n?: number;
  errors?: number;
  upper?: number;
  coverage?: number;
  alpha?: number;
  valid?: boolean;
}

export interface EvidenceAssessment {
  ok: boolean;
  reason: string;
  temperature: number | null;
  tau: number | null;
  calibrationId: string | null;
  evidenceClass: string | null;
  upper: number | null;
}

export function softmax(logits: number[], temperature: number): number[] {
  if (logits.length === 0) throw new Error('softmax over an empty candidate set is undefined');
  if (temperature <= 0) throw new Error('temperature must be positive');
  const scaled = logits.map(value => value / temperature);
  const top = Math.max(...scaled);
  const exps = scaled.map(value => Math.exp(value - top));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map(value => value / total);
}

export function fitTemperature(rows: number[][], labels: number[]): number {
  if (rows.length !== labels.length || rows.length === 0) {
    throw new Error('rows and labels must be non-empty and aligned');
  }
  const objective = (logT: number) => {
    const temperature = Math.exp(logT);
    let total = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const probabilities = softmax(rows[index], temperature);
      total += -Math.log(Math.max(probabilities[labels[index]], 1e-12));
    }
    return total / rows.length;
  };
  let low = Math.log(0.05);
  let high = Math.log(20);
  const ratio = (Math.sqrt(5) - 1) / 2;
  let left = high - ratio * (high - low);
  let right = low + ratio * (high - low);
  let fLeft = objective(left);
  let fRight = objective(right);
  for (let step = 0; step < 200 && high - low >= 1e-9; step += 1) {
    if (fLeft < fRight) {
      high = right;
      right = left;
      fRight = fLeft;
      left = high - ratio * (high - low);
      fLeft = objective(left);
    } else {
      low = left;
      left = right;
      fLeft = fRight;
      right = low + ratio * (high - low);
      fRight = objective(right);
    }
  }
  return Number(Math.exp((low + high) / 2).toFixed(6));
}

function binomCdf(k: number, n: number, p: number): number {
  let total = 0;
  for (let index = 0; index <= k; index += 1) {
    total += Number(comb(n, index)) * (p ** index) * ((1 - p) ** (n - index));
  }
  return total;
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= k; index += 1) {
    result = result * (n - k + index) / index;
  }
  return result;
}

export function cpUpper(errors: number, n: number, alpha = RISK_ALPHA): number | null {
  if (n < 0 || errors < 0 || errors > n) throw new Error('errors must satisfy 0 <= errors <= n');
  if (n === 0) return null;
  if (errors === n) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 200; step += 1) {
    const mid = (low + high) / 2;
    if (binomCdf(errors, n, mid) > alpha) low = mid;
    else high = mid;
  }
  return high;
}

function close(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= TOLERANCE;
}

function exactInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a real non-negative integer`);
  }
  return value;
}

function argmax(values: number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[best]) best = index;
  }
  return best;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort()
      .map(key => [key, sortValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function assessEvidence(payloads: Record<'calT' | 'select' | 'cert', EvidencePayload>,
  identity: Record<string, unknown>): EvidenceAssessment {
  try {
    return assess(payloads, identity);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error),
      temperature: null, tau: null, calibrationId: null, evidenceClass: null, upper: null };
  }
}

function assess(payloads: Record<'calT' | 'select' | 'cert', EvidencePayload>,
  identity: Record<string, unknown>): EvidenceAssessment {
  const names = ['calT', 'select', 'cert'] as const;
  for (const name of names) {
    const records = payloads[name].records;
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(`${name}: missing per-sample records; summary n/errors/upper is not evidence`);
    }
  }
  const classes = new Set(names.map(name => String(payloads[name].evidenceClass)));
  if (classes.size !== 1) throw new Error('evidenceClass drifted across partitions');
  const evidenceClass = [...classes][0];
  if (evidenceClass !== 'fixture' && evidenceClass !== 'cpu-mechanism') {
    throw new Error(`evidenceClass ${evidenceClass} is not a known sealed class`);
  }
  const calibrationIds = new Set(names.map(name => payloads[name].calibration_id));
  if (calibrationIds.size !== 1 || ![...calibrationIds][0]) {
    throw new Error('calibration_id missing or drifted');
  }
  const calibrationId = [...calibrationIds][0] as string;
  let protocol: string[] | null = null;
  const groups: Record<string, Set<string>> = {};
  for (const name of names) {
    const payload = payloads[name];
    const records = payload.records as EvidenceRecord[];
    const sampleIds = payload.sampleIds ?? [];
    if (sampleIds.length !== records.length) throw new Error(`${name}: sampleIds must list every record`);
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (record.sampleId !== sampleIds[index] || seen.has(record.sampleId)) {
        throw new Error(`${name}: sampleId mismatch or duplicate at ${index}`);
      }
      seen.add(record.sampleId);
      if (!record.sourceGroup) throw new Error(`${name}: missing sourceGroup`);
      const recordClass = (record as { evidenceClass?: string }).evidenceClass;
      if (recordClass && recordClass !== String(payload.evidenceClass)) {
        throw new Error(`${name}: record evidenceClass ${recordClass} != partition evidenceClass ${payload.evidenceClass}`);
      }
    });
    if (payload.data_sha256 !== sha256(canonical(records))) {
      throw new Error(`${name}: data_sha256 does not match the per-sample records`);
    }
    protocol = protocol ?? [...records[0].candidateIds];
    if (JSON.stringify(records[0].candidateIds) !== JSON.stringify(protocol)) {
      throw new Error(`${name}: candidate protocol drift`);
    }
    for (const record of records) {
      if (JSON.stringify(record.candidateIds) !== JSON.stringify(protocol)) {
        throw new Error(`${name}: candidate protocol drift at ${record.sampleId}`);
      }
      if (!Array.isArray(record.logits) || record.logits.length !== protocol.length
        || record.logits.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`${name}: logits are not finite at ${record.sampleId}`);
      }
      if (!Number.isInteger(record.label) || record.label < 0 || record.label >= protocol.length) {
        throw new Error(`${name}: label is not a candidate index at ${record.sampleId}`);
      }
    }
    const policy = payload.policy ?? {};
    if (policy.k !== protocol.length || identity.k !== protocol.length) {
      throw new Error(`${name}: k drifted from the candidate protocol`);
    }
    for (const field of ['model', 'head', 'adapter', 'tokenizer', 'renderer', 'task',
      'policy_version', 'memory_policy_version']) {
      if (field in identity && policy[field] !== identity[field]) {
        throw new Error(`${name}: policy ${field} does not match the identity`);
      }
    }
    groups[name] = new Set(records.map(record => record.sourceGroup));
  }
  if (!protocol) throw new Error('missing candidate protocol');
  if ([...groups.calT].some(group => groups.select.has(group) || groups.cert.has(group))
    || [...groups.select].some(group => groups.cert.has(group))) {
    throw new Error('sourceGroup crosses calT/select/cert');
  }
  const fitted = fitTemperature(
    (payloads.calT.records as EvidenceRecord[]).map(record => record.logits),
    (payloads.calT.records as EvidenceRecord[]).map(record => record.label));
  // Peaked logits make NLL ~0 across a small temperature band, so the JS and
  // Python golden searches can stop 0.002 apart. A real mismatch (0.01 vs
  // 1.2, or a tampered 1.7) is still rejected. The frozen value we report is
  // the declared temperature once it sits in that band.
  if (typeof payloads.calT.temperature !== 'number'
    || Math.abs(payloads.calT.temperature - fitted) > 2e-3) {
    throw new Error(`calT temperature ${payloads.calT.temperature} != fitted ${fitted}`);
  }
  const temperature = payloads.calT.temperature;
  const mask = (records: EvidenceRecord[], used: number, tau: number) => records.map(record => {
    const scaled = softmax(record.logits, used);
    return scaled[argmax(scaled)] >= tau ? '1' : '0';
  }).join('');
  const selectRows = (payloads.select.records as EvidenceRecord[]).map(record => {
    const scaled = softmax(record.logits, temperature);
    const chosen = argmax(scaled);
    return { pmax: scaled[chosen], correct: chosen === record.label };
  });
  let best: { tau: number; accepted: number; coverage: number } | null = null;
  for (const tau of TAU_GRID) {
    const accepted = selectRows.filter(row => row.pmax >= tau);
    if (accepted.length < RISK_MIN_ACCEPTED) continue;
    const errors = accepted.filter(row => !row.correct).length;
    const risk = errors / accepted.length;
    if (risk > RISK_MAX) continue;
    if (!best || accepted.length > best.accepted) {
      best = { tau, accepted: accepted.length,
        coverage: Number((accepted.length / selectRows.length).toFixed(4)) };
    }
  }
  if (!best) throw new Error('select did not freeze a tau');
  if (typeof payloads.select.tau !== 'number' || !close(payloads.select.tau, best.tau)) {
    throw new Error(`select tau ${payloads.select.tau} != frozen ${best.tau}`);
  }
  if (exactInt(payloads.select.accepted, 'select.accepted') !== best.accepted) {
    throw new Error('select accepted does not match the recomputed count');
  }
  if (typeof payloads.select.coverage !== 'number' || !close(payloads.select.coverage, best.coverage)) {
    throw new Error('select coverage does not match the recomputed value');
  }
  for (const name of ['select', 'cert'] as const) {
    const records = payloads[name].records as EvidenceRecord[];
    if (mask(records, temperature, best.tau) !== mask(records, fitted, best.tau)) {
      throw new Error(`temperature tolerance would change the ${name} accept set`);
    }
  }
  const certRows = (payloads.cert.records as EvidenceRecord[]).map(record => {
    const scaled = softmax(record.logits, temperature);
    const chosen = argmax(scaled);
    return { pmax: scaled[chosen], correct: chosen === record.label };
  });
  const accepted = certRows.filter(row => row.pmax >= best.tau);
  const n = accepted.length;
  const errors = accepted.filter(row => !row.correct).length;
  if (payloads.cert.alpha !== RISK_ALPHA) throw new Error(`cert alpha != ${RISK_ALPHA}`);
  const upper = cpUpper(errors, n, RISK_ALPHA);
  if (upper === null) throw new Error('cert n=0 is refused');
  const coverage = n / certRows.length;
  if (exactInt(payloads.cert.n, 'cert.n') !== n
    || exactInt(payloads.cert.errors, 'cert.errors') !== errors) {
    throw new Error('cert counts do not match the recomputed records');
  }
  if (typeof payloads.cert.upper !== 'number' || !close(payloads.cert.upper, upper)) {
    throw new Error(`cert upper ${payloads.cert.upper} != cp_upper ${upper}`);
  }
  if (typeof payloads.cert.coverage !== 'number' || !close(payloads.cert.coverage, coverage)) {
    throw new Error('cert coverage does not match n/all-records');
  }
  if (payloads.cert.tau !== undefined && typeof payloads.cert.tau === 'number'
    && !close(payloads.cert.tau, best.tau)) {
    throw new Error('cert tau is not the frozen select tau');
  }
  if (coverage < RISK_MIN_COVERAGE) throw new Error('cert coverage is below 0.30');
  if (upper > RISK_MAX) throw new Error('cert upper is above max risk');
  return { ok: true, reason: 'recomputed evidence matches the frozen policy',
    temperature, tau: best.tau, calibrationId, evidenceClass, upper };
}
