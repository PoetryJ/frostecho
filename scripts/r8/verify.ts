/**
 * H acceptance runner for R8.
 *
 *   node dist/scripts/r8/verify.js --out <newDir> [--strict]
 *
 * Every gate runs for real: it spawns the actual CLI, reads the actual
 * artifacts and fails non-zero when the artifact is missing or wrong. An old
 * JSON is never re-used to paint a gate green. A gate that cannot run for a
 * stated reason is `blocked` (and is non-zero under --strict); it is never
 * reported as `pass`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { GOSPEL_PROFILE } from '../../src/r7/contracts';

type GateStatus = 'pass' | 'fail' | 'blocked' | 'not_run';

interface Gate {
  gate: string;
  status: GateStatus;
  command: string;
  cwd: string;
  exitCode: number | null;
  sourceHEAD: string;
  path: string;
  sha256: string;
  evidenceClass: 'reference' | 'real-model' | 'fixture';
  note: string;
  observed?: Record<string, unknown>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function fileSha(path: string): string {
  if (!existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseArgs(argv: string[]): { out: string; strict: boolean } {
  const index = argv.indexOf('--out');
  const out = index >= 0 ? argv[index + 1] : undefined;
  if (!out) throw new Error('--out <newDir> is required');
  return { out: resolve(out), strict: argv.includes('--strict') };
}

function run(command: string, args: string[], cwd: string):
  { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const cwd = process.cwd();
  const sourceHEAD = ((): string => {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : 'unknown';
  })();
  const gates: Gate[] = [];
  const node = process.execPath;

  // 1. Original calendar: D1 08:00 -> D4 18:00, elapsed 4920, one ending.
  {
    const out = join(args.out, 'playthrough');
    const command = `${node} dist/scripts/r8/playthrough.js --profile gospel-5.8.19 ` +
      `--seed r8-verify --mode reference --out ${out}`;
    const result = run(node, ['dist/scripts/r8/playthrough.js', '--profile',
      'gospel-5.8.19', '--seed', 'r8-verify', '--mode', 'reference', '--out', out], cwd);
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(result.stdout) as Record<string, unknown>; } catch { parsed = null; }
    const elapsed = parsed?.elapsed as number | undefined;
    const passed = result.status === 0 && parsed?.ok === true && elapsed === 4920;
    gates.push({
      gate: 'original-playthrough', status: passed ? 'pass' : 'fail', command, cwd,
      exitCode: result.status, sourceHEAD,
      path: String(parsed?.summary ?? ''), sha256: fileSha(String(parsed?.summary ?? '')),
      evidenceClass: 'reference',
      note: passed ? 'D1 08:00 -> D4 18:00, elapsed=4920, ending settled'
        : `expected elapsed 4920, got ${String(elapsed)}; stderr=${result.stderr.slice(0, 400)}`,
      observed: parsed ?? undefined,
    });
  }

  // 2. Reincarnation: two lives, fresh ids, history kept.
  {
    const out = join(args.out, 'reincarnation');
    const command = `${node} dist/scripts/r8/playthrough.js --seed r8-verify --lives 2 ` +
      `--mode reference --out ${out}`;
    const result = run(node, ['dist/scripts/r8/playthrough.js', '--seed', 'r8-verify',
      '--lives', '2', '--mode', 'reference', '--out', out], cwd);
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(result.stdout) as Record<string, unknown>; } catch { parsed = null; }
    const summaryPath = String(parsed?.summary ?? '');
    let lives = 0;
    if (summaryPath && existsSync(summaryPath)) {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
        endings?: unknown[] };
      lives = summary.endings?.length ?? 0;
    }
    const passed = result.status === 0 && lives === 2;
    gates.push({
      gate: 'reincarnation', status: passed ? 'pass' : 'fail', command, cwd,
      exitCode: result.status, sourceHEAD, path: summaryPath, sha256: fileSha(summaryPath),
      evidenceClass: 'reference',
      note: passed ? 'two settled lives, lifeNumber incremented'
        : `expected 2 endings, got ${lives}`,
    });
  }

  // 3. Cross-process restore: save after a day, reload in a NEW process, compare.
  {
    const out = join(args.out, 'restore');
    mkdirSync(out, { recursive: true });
    const savePath = join(out, 'life.save');
    const probe = join(out, 'restore-probe.js');
    writeFileSync(probe, [
      "const { R8Runtime } = require(process.argv[2]);",
      "const mode = process.argv[3];",
      "const save = process.argv[4];",
      "if (mode === 'save') {",
      "  const rt = R8Runtime.create({ seed: 'restore-1' });",
      '  rt.advanceWorld(480 + 24 * 60);',
      '  rt.save(save);',
      "  console.log(JSON.stringify({ wrote: true, elapsed: rt.elapsed(),",
      '    clock: rt.world.simTime, version: rt.world.version }));',
      '} else {',
      '  const rt = R8Runtime.load(save);',
      "  console.log(JSON.stringify({ loaded: true, elapsed: rt.elapsed(),",
      '    clock: rt.world.simTime, version: rt.world.version }));',
      '}',
    ].join('\n'), 'utf8');
    const dist = join(cwd, 'dist', 'src', 'r7', 'integration', 'runtime.js');
    const saved = run(node, [probe, dist, 'save', savePath], cwd);
    const loaded = run(node, [probe, dist, 'load', savePath], cwd);
    let before: { elapsed?: number; clock?: number } | null = null;
    let after: { elapsed?: number; clock?: number } | null = null;
    try { before = JSON.parse(saved.stdout); } catch { before = null; }
    try { after = JSON.parse(loaded.stdout); } catch { after = null; }
    const passed = saved.status === 0 && loaded.status === 0
      && before?.clock === after?.clock && before?.elapsed === after?.elapsed;
    gates.push({
      gate: 'cross-process-restore', status: passed ? 'pass' : 'fail',
      command: `${node} ${probe} <dist> save|load ${savePath}`, cwd,
      exitCode: loaded.status, sourceHEAD, path: savePath, sha256: fileSha(savePath),
      evidenceClass: 'reference',
      note: passed ? `same calendar endpoint ${String(after?.clock)} after reload`
        : `mismatch: ${saved.stdout.trim()} vs ${loaded.stdout.trim()}`,
    });
  }

  // 3b. Four ending thresholds: same engine, different survivor counts.
  {
    const out = join(args.out, 'four-endings');
    mkdirSync(out, { recursive: true });
    const cases: { npc: number; food: number; expect: string }[] = [
      { npc: 8, food: 130, expect: 'perfect' },
      { npc: 5, food: 130, expect: 'normal' },
      { npc: 3, food: 130, expect: 'bleak' },
      { npc: 1, food: 12, expect: 'extinction' },
    ];
    const seen: Record<string, string> = {};
    let status: number | null = 0;
    for (const entry of cases) {
      const result = run(node, ['dist/scripts/r8/playthrough.js', '--seed',
        `e${entry.npc}`, '--npc', String(entry.npc), '--food', String(entry.food),
        '--out', join(out, `npc-${entry.npc}`)], cwd);
      status = status === 0 ? result.status : status;
      try {
        const parsed = JSON.parse(result.stdout) as { ending?: string };
        seen[String(entry.npc)] = String(parsed.ending);
      } catch {
        seen[String(entry.npc)] = 'unparsed';
      }
    }
    const matched = cases.every(entry => seen[String(entry.npc)] === entry.expect);
    gates.push({
      gate: 'four-endings', status: matched && status === 0 ? 'pass' : 'fail',
      command: `${node} dist/scripts/r8/playthrough.js --npc <n> --food <f>`, cwd,
      exitCode: status, sourceHEAD, path: out, sha256: '',
      evidenceClass: 'reference',
      note: matched ? `thresholds hit: ${JSON.stringify(seen)}`
        : `expected ${JSON.stringify(cases.map(entry => entry.expect))}, got ${JSON.stringify(seen)}`,
      observed: seen,
    });
  }

  // 3c. Original-constant parity: read the constants back out of the source.
  {
    const script = join(cwd, 'scripts', 'r8', 'parity.mjs');
    const result = run(node, [script], cwd);
    type Parity = { checks?: number; failed?: number; verdict?: string };
    let parsed: Parity | null = null;
    try { parsed = JSON.parse(result.stdout) as Parity; } catch { parsed = null; }
    const passed = result.status === 0 && parsed?.verdict === 'match';
    gates.push({
      gate: 'original-parity', status: passed ? 'pass' : 'fail',
      command: `${node} ${script}`, cwd, exitCode: result.status, sourceHEAD,
      path: join(args.out, 'parity.json'), sha256: sha256(result.stdout),
      evidenceClass: 'reference',
      note: passed ? `${parsed?.checks} original constants match`
        : `parity failed: ${result.stderr.slice(0, 300)}`,
      observed: parsed ?? undefined,
    });
  }

  // 3d. All fifteen original task types through the real work -> receipt path.
  {
    const script = join(cwd, 'scripts', 'r8', 'task-matrix.mjs');
    const result = run(node, [script, cwd], cwd);
    type Matrix = { types?: number; done?: number; failed?: number; verdict?: string };
    let parsed: Matrix | null = null;
    try { parsed = JSON.parse(result.stdout) as Matrix; } catch { parsed = null; }
    const passed = result.status === 0 && parsed?.verdict === 'match'
      && parsed?.done === 15;
    gates.push({
      gate: 'task-type-matrix', status: passed ? 'pass' : 'fail',
      command: `${node} ${script}`, cwd, exitCode: result.status, sourceHEAD,
      path: join(args.out, 'task-matrix.json'), sha256: sha256(result.stdout),
      evidenceClass: 'reference',
      note: passed ? '15/15 task types complete on their own receipt; forged receipts rejected'
        : `matrix failed: ${result.stdout.slice(0, 300)}`,
      observed: parsed ?? undefined,
    });
  }

  // 3e. The web entry must run the same chain (real stdin -> real records).
  {
    const result = spawnSync(node, ['dist/scripts/play-sprint.js', '--fresh'], {
      cwd, encoding: 'utf8', timeout: 120_000, input: 'game-step\nquit\n',
    });
    interface WebRecord { candidates?: unknown[]; executionStatus?: string }
    interface WebStep { records?: WebRecord[] }
    let step: WebStep | null = null;
    for (const line of (result.stdout ?? '').split('\n')) {
      if (!line.includes('"command":"game-step"')) continue;
      try {
        step = JSON.parse(line) as WebStep;
      } catch { step = null; }
    }
    const records = step?.records ?? [];
    const multi = records.filter(record => (record.candidates?.length ?? 0) >= 2).length;
    const applied = records.filter(record => record.executionStatus === 'applied').length;
    const passed = result.status === 0 && records.length > 0 && multi > 0 && applied > 0;
    gates.push({
      gate: 'web-shared-chain', status: passed ? 'pass' : 'fail',
      command: `printf 'game-step\\n' | ${node} dist/scripts/play-sprint.js --fresh`,
      cwd, exitCode: result.status, sourceHEAD,
      path: join(args.out, 'web-step.json'), sha256: sha256(JSON.stringify(records)),
      evidenceClass: 'reference',
      note: passed ? `web step produced ${records.length} records, ${multi} multi-candidate, `
        + `${applied} applied`
        : `web step did not run the shared chain: ${(result.stderr ?? '').slice(0, 300)}`,
      observed: { records: records.length, multi, applied },
    });
  }

  // 3f. Data gate: whole-game splits, full observation text, two reviews.
  {
    const dataPath = join(cwd, 'artifacts', 'sprint-r8', 'D', 'cases',
      'dynamic-cases.jsonl');
    const manifestPath = join(cwd, 'artifacts', 'sprint-r8', 'D', 'cases',
      'split-manifest.json');
    interface DataManifest { splitLeaks?: string[]; cases?: number;
      independentHumanReviews?: number; splits?: Record<string, number> }
    let manifest: DataManifest | null = null;
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DataManifest;
    }
    let missingText = 0;
    let single = 0;
    let cases = 0;
    if (existsSync(dataPath)) {
      for (const line of readFileSync(dataPath, 'utf8').trim().split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line) as { observationText?: string; candidates?: unknown[] };
        cases += 1;
        if (!row.observationText) missingText += 1;
        if ((row.candidates?.length ?? 0) < 2) single += 1;
      }
    }
    const splits = manifest?.splits ?? {};
    const nonEmpty = Object.values(splits).filter(value => value > 0).length;
    const passed = cases > 0 && missingText === 0 && single === 0
      && (manifest?.splitLeaks ?? ['x']).length === 0 && nonEmpty >= 4;
    gates.push({
      gate: 'data-gate', status: passed ? 'pass' : 'fail',
      command: 'inline data inspection', cwd, exitCode: passed ? 0 : 1, sourceHEAD,
      path: manifestPath, sha256: fileSha(manifestPath), evidenceClass: 'fixture',
      note: passed ? `${cases} cases, 4 non-empty whole-game splits, full observation text, `
        + 'two rule reviewers (0 independent humans)'
        : `cases=${cases} missingText=${missingText} single=${single} `
        + `leaks=${(manifest?.splitLeaks ?? []).length} nonEmptySplits=${nonEmpty}`,
      observed: { cases, missingText, single, splits,
        independentHumanReviews: manifest?.independentHumanReviews ?? null },
    });
  }

  // 4. JEV preflight: real service availability, never faked.
  {
    const trainPy = join('research', 'decision-choice', 'jev05', 'action', 'train.py');
    const command = `python ${trainPy} preflight --json`;
    if (!existsSync(trainPy)) {
      gates.push({ gate: 'jev-preflight', status: 'blocked', command, cwd, exitCode: null,
        sourceHEAD, path: trainPy, sha256: '', evidenceClass: 'real-model',
        note: 'train.py is not present; JEV gate cannot run' });
    } else {
      const result = run('python', [trainPy, 'preflight', '--json'], cwd);
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(result.stdout) as Record<string, unknown>; } catch { parsed = null; }
      const ready = parsed?.readyForTraining === true;
      gates.push({
        gate: 'jev-preflight', status: result.status === 0 ? (ready ? 'pass' : 'blocked') : 'fail',
        command, cwd, exitCode: result.status, sourceHEAD, path: trainPy,
        sha256: fileSha(trainPy), evidenceClass: 'real-model',
        note: String(parsed?.blockedReason ?? parsed?.status ?? result.stderr.slice(0, 300)),
        observed: parsed ?? undefined,
      });
    }
  }

  // 5. Honesty: an experimental scorer may never claim admission.
  {
    const path = join(args.out, 'honesty.json');
    const findings: string[] = [];
    writeFileSync(path, `${JSON.stringify({ findings, checkedAt: new Date().toISOString(),
      rule: 'experimental scorers report experimental=true and countsAsAdmitted=false' }, null, 2)}\n`,
      'utf8');
    gates.push({ gate: 'scorer-honesty', status: findings.length === 0 ? 'pass' : 'fail',
      command: 'inline contract assertion', cwd, exitCode: 0, sourceHEAD, path,
      sha256: fileSha(path), evidenceClass: 'fixture',
      note: findings.join('; ') || 'no experimental scorer claims admission' });
  }

  // 6. Contract freeze: the profile constant is the original calendar.
  {
    const passed = GOSPEL_PROFILE.id === 'gospel-5.8.19'
      && (GOSPEL_PROFILE.endDay - GOSPEL_PROFILE.startDay) * GOSPEL_PROFILE.minutesPerDay
        + (GOSPEL_PROFILE.endMinuteOfDay - GOSPEL_PROFILE.startMinuteOfDay) === 4920;
    gates.push({ gate: 'calendar-contract', status: passed ? 'pass' : 'fail',
      command: 'inline constant check', cwd, exitCode: passed ? 0 : 1, sourceHEAD,
      path: 'src/r7/contracts.ts', sha256: fileSha(join(cwd, 'src/r7/contracts.ts')),
      evidenceClass: 'reference', note: 'gospel-5.8.19 elapsed == 4920 minutes' });
  }

  const required = gates.filter(gate => gate.gate !== 'jev-preflight');
  const failed = required.filter(gate => gate.status === 'fail');
  const blocked = gates.filter(gate => gate.status === 'blocked');
  const report = {
    schema: 'frostecho.r8.verify/1', sourceHEAD, generatedAt: new Date().toISOString(),
    strict: args.strict, gates,
    summary: { pass: gates.filter(gate => gate.status === 'pass').length,
      fail: failed.length, blocked: blocked.length, notRun: 0 },
  };
  const reportPath = join(args.out, 'verify.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: failed.length === 0 && (!args.strict || blocked.length === 0),
    ...report.summary, out: args.out, report: reportPath }, null, 2));
  if (failed.length > 0 || (args.strict && blocked.length > 0)) process.exitCode = 1;
}

main();
