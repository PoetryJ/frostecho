/**
 * Generate artifacts/sprint-r5/features.json from ACTUAL result files.
 * It does not run tests itself: eval-full's fixed TAP, the pytest log and the
 * comparison JSON are the inputs, so a failed/skipped test cannot be hand-waved
 * into a pass.
 *
 * Run: node dist/scripts/r5-features.js
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'artifacts/sprint-r5');
mkdirSync(OUT, { recursive: true });

function head(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.stdout.trim();
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const tapPath = join(OUT, 'eval-full/full-suite.tap');
const tap = read(tapPath);
function tapResult(fragment: string): 'pass' | 'fail' | 'missing' {
  const line = tap.split('\n').find(entry => entry.includes(fragment)
    && /^(ok|not ok) /.test(entry));
  if (!line) return 'missing';
  return line.startsWith('ok ') ? 'pass' : 'fail';
}

const pytestPath = join(OUT, 'jev/pytest.log');
const pytest = read(pytestPath);
function pytestResult(fragment: string): 'pass' | 'fail' | 'missing' {
  if (!pytest) return 'missing';
  const lines = pytest.split('\n');
  const line = lines.find(entry => entry.includes(fragment));
  if (!line) return 'missing';
  if (/\bPASSED\b/.test(line)) return 'pass';
  if (/\bFAILED\b|\bERROR\b/.test(line)) return 'fail';
  return 'missing';
}

const comparisonPath = join(OUT, 'comparison/comparison.json');
let comparison: any = null;
try {
  comparison = JSON.parse(read(comparisonPath));
} catch {
  comparison = null;
}
const comparisonOk = Boolean(comparison)
  && comparison.schema === 'frostecho.r5.comparison/1'
  && Array.isArray(comparison.arms)
  && comparison.arms.includes('raw')
  && comparison.arms.includes('experience')
  && !comparison.arms.includes('summary')
  && Array.isArray(comparison.scenarios)
  && comparison.scenarios.every((scenario: any) =>
    ['raw', 'experience'].every(arm => scenario.metrics?.[arm]
      && typeof scenario.metrics[arm].commandCount === 'number'
      && 'negotiationActionMismatch' in scenario.metrics[arm]));

interface Feature {
  featureId: string;
  entry: string;
  command: string;
  invariant: string;
  status: 'pass' | 'fail' | 'missing';
  evidence: string[];
  next?: string;
}

function gate(parts: Array<'pass' | 'fail' | 'missing'>): 'pass' | 'fail' | 'missing' {
  if (parts.includes('fail')) return 'fail';
  if (parts.includes('missing')) return 'missing';
  return 'pass';
}

const features: Feature[] = [
  { featureId: 'commitment-terminal', entry: 'dist/scripts/play-sprint.js',
    command: 'node --test dist/tests/acceptance-v5/gate-r5.test.js',
    invariant: 'terminal commitments absorb old changes; counter-accept binds one task; wait gate is real',
    status: gate([tapResult('R5-G1'), tapResult('R5-G2'), tapResult('R5-G3'),
      tapResult('R5-T1'), tapResult('R5-T2'), tapResult('R5-T3'), tapResult('R5-T4'),
      tapResult('R5-T5')]),
    evidence: [tapPath] },
  { featureId: 'barrier-captured', entry: 'dist/scripts/play-sprint.js',
    command: 'node --test --test-name-pattern=R5-G4 dist/tests/acceptance-v5/gate-r5.test.js',
    invariant: 'a save barrier revokes only its captured set; queued work has 0 effects; later work runs',
    status: tapResult('R5-G4'), evidence: [tapPath],
    next: 'rerun R5-G4 with a fresh state directory' },
  { featureId: 'intent-idempotent', entry: 'dist/scripts/play-sprint.js',
    command: 'node --test --test-name-pattern=R5-G5 dist/tests/acceptance-v5/gate-r5.test.js',
    invariant: 'same travel intent replays the first receipt; same id/different target conflicts with 0 effects',
    status: tapResult('R5-G5'), evidence: [tapPath],
    next: 'rerun R5-G5 on a clean state directory' },
  { featureId: 'training-entry-refusal', entry: 'research/decision-choice/jev04/models/encoder_train.py',
    command: 'python3 -m pytest research/decision-choice/jev04/tests/test_r5_gates.py -v',
    invariant: 'a closed v4 gate exits non-zero before any torch/transformers import',
    status: gate([pytestResult('test_refusal_happens_before_any_model_import'),
      pytestResult('test_gate_status_does_not_trust_gate_v4_json')]),
    evidence: [pytestPath],
    next: 'if the gate is reopened, re-run the stub audit before training' },
  { featureId: 'data-qualification', entry: 'research/decision-choice/jev04/data/v4/validate_v4.py',
    command: 'python3 -m pytest research/decision-choice/jev04/tests/test_r5_gates.py -v',
    invariant: 'text/params/label/duplicate/group tampering is rejected; unique counts gate training',
    status: gate(['test_current_v4_is_structurally_valid_but_not_ready',
      'test_candidate_text_and_params_change_is_rejected',
      'test_illegal_training_label_is_rejected',
      'test_duplicate_rows_cannot_inflate_512_128',
      'test_group_overlap_is_rejected'].map(pytestResult)),
    evidence: [pytestPath, join(ROOT, 'research/decision-choice/jev04/data/v4/gate-v4.json')],
    next: 'adjudicate 39 cases and expand by source/family before 512/128' },
  { featureId: 'port-shadow', entry: 'research/decision-choice/jev04/scorers/port_v3.py',
    command: 'python3 -m pytest research/decision-choice/jev04/tests/test_r5_gates.py -v; '
      + 'node --test dist/tests/r5-jev-evidence.test.js',
    invariant: 'empty/reused/mis-protocol evidence is not real; fixture never counts; TS selectedId stays null',
    status: gate(['test_empty_certificate_never_counts_as_real',
      'test_fixture_artifact_with_real_registration_never_counts',
      'test_duplicate_partition_is_refused',
      'test_protocol_mismatch_is_refused',
      'test_valid_distinct_evidence_binds_the_identity'].map(pytestResult)
      .concat([tapResult('R5-J1'), tapResult('R5-J2'), tapResult('R5-J3'),
        tapResult('R5-J4'), tapResult('R5-J5')])),
    evidence: [pytestPath, tapPath] },
  { featureId: 'download-path', entry: 'research/decision-choice/jev04/models/prepare_t27.py',
    command: 'python3 -m pytest research/decision-choice/jev04/tests/test_r5_gates.py -v',
    invariant: 'first real request keeps Qwen/Qwen3.5-27B + exact revision; snapshot args and resume agree',
    status: pytestResult('test_first_request_and_snapshot_args'),
    evidence: [pytestPath], next: 'network is still unresolved; keep the exact resume command' },
  { featureId: 'council-resolution', entry: 'dist/scripts/play-sprint.js',
    command: 'node --test --test-name-pattern=R5-G6 dist/tests/acceptance-v5/gate-r5.test.js',
    invariant: 'one council -> two plans -> resolution -> two residents -> real receipts',
    status: tapResult('R5-G6'), evidence: [tapPath] },
  { featureId: 'council-save-reassign', entry: 'dist/scripts/play-sprint.js',
    command: 'node --test --test-name-pattern="R5-G7|R5-G8" dist/tests/acceptance-v5/gate-r5.test.js',
    invariant: 'exit stops old task; substitute gets a new revision; replay creates no duplicate dispatch',
    status: gate([tapResult('R5-G7'), tapResult('R5-G8')]), evidence: [tapPath] },
  { featureId: 'four-day-96h', entry: 'dist/scripts/play-sprint.js',
    command: 'node --test --test-name-pattern=R5-G9 dist/tests/acceptance-v5/gate-r5.test.js',
    invariant: '8 NPCs, spatial from day 1, one success, one out_of_stock, split saves == continuous',
    status: tapResult('R5-G9'), evidence: [tapPath] },
  { featureId: 'raw-experience-comparison', entry: 'dist/scripts/r4-compare.js',
    command: 'node dist/scripts/r4-compare.js --out artifacts/sprint-r5/comparison',
    invariant: 'raw and experience are different implementations; summary is not claimed; waits excluded; N/A not 0',
    status: comparisonOk ? 'pass' : comparison ? 'fail' : 'missing',
    evidence: [comparisonPath] },
];

const payload = {
  schema: 'frostecho.r5.features/1',
  head: head(),
  at: new Date().toISOString(),
  note: 'statuses are derived from the fixed TAP / pytest log / comparison JSON; '
    + 'a missing result is not a pass',
  features,
};
writeFileSync(join(OUT, 'features.json'),
  `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ path: join(OUT, 'features.json'),
  passed: features.filter(feature => feature.status === 'pass').length,
  failed: features.filter(feature => feature.status === 'fail').length,
  missing: features.filter(feature => feature.status === 'missing').length }, null, 2));
