#!/usr/bin/env node
/**
 * R10 (A) verifier: the D2 exit -> new process -> D4 run must keep the promises
 * and settle each one exactly once.
 *
 * It reads only raw artifacts:
 *   <d2>/state.json.{commitments.json,r8.json,runner.json}   what was saved
 *   <d4>/summary-*.json                                      what the new process saw
 *   <d4>/settlement-audit-*.json                             re-derived ledgers
 *
 * Run: node scripts/r10/verify-d2-restore.mjs \
 *   --d2 artifacts/r10/a-d2-restore/d2/state.json --d4 artifacts/r10/a-d2-restore/d4
 * Exit 0 only when every check passes.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const d2 = resolve(arg('--d2', 'artifacts/r10/a-d2-restore/d2/state.json'));
const d4 = resolve(arg('--d4', 'artifacts/r10/a-d2-restore/d4'));
const out = resolve(arg('--out', 'artifacts/r10/a-d2-restore'));

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const newest = (dir, prefix) => {
  const names = readdirSync(dir).filter(name => name.startsWith(prefix)).sort();
  if (names.length === 0) throw new Error(`no ${prefix}* in ${dir}`);
  return join(dir, names.at(-1));
};

const d2Commitments = readJson(`${d2}.commitments.json`).commitments ?? [];
const d2Runtime = readJson(`${d2}.r8.json`);
const d2Runner = readJson(`${d2}.runner.json`);
const summaryPath = newest(d4, 'summary-');
const auditPath = newest(d4, 'settlement-audit-');
const summary = readJson(summaryPath);
const audit = readJson(auditPath);

const checks = [];
const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });

const d2Working = (d2Runtime.intents ?? []).filter(intent => intent.status === 'working');
const d2Active = d2Commitments.filter(row => row.status === 'active');

check('the D2 save carries open promises', d2Commitments.length > 0 && d2Active.length > 0,
  { commitments: d2Commitments.length, active: d2Active.length });
check('the D2 save carries real queued work', d2Working.length > 0,
  { pending: d2Working.length, dueAt: [...new Set(d2Working.map(row => row.dueAt))] });
check('the D2 save used the CLI sidecar set', d2Runner.pledged === true
  && d2Runner.savedAt !== null, { savedAt: d2Runner.savedAt, pledged: d2Runner.pledged });

check('the D4 process restored that exact state', summary.restore?.from === d2,
  { restoredFrom: summary.restore?.from ?? null, clock: summary.restore?.clock ?? null });
check('the restored board count matches the save',
  summary.restore?.commitments === d2Commitments.length
  && summary.restore?.pendingIntents === d2Working.length,
  { saved: { commitments: d2Commitments.length, pending: d2Working.length },
    restored: summary.restore ?? null });
check('the RESUMED process applied the D2 interference',
  summary.environment?.interference?.at === summary.restore?.clock
  && summary.environment?.interference2?.at === summary.restore?.clock,
  { interference: summary.environment?.interference ?? null,
    interference2: summary.environment?.interference2 ?? null });

check('every promise settled at most once', audit.commitments.every(row => row.settledOnce),
  audit.commitments.filter(row => !row.settledOnce).map(row => row.commitmentId));
check('every promise has at most one applied projection',
  audit.commitments.every(row => row.appliedProjections <= 1),
  audit.commitments.map(row => [row.commitmentId, row.appliedProjections]));
check('every promise carries at most one evidence id per settlement',
  audit.commitments.every(row => row.uniqueEvidence
    && Math.max(0, ...Object.values(row.fulfilRecordsByObserver)) <= 1
    && Math.max(0, ...Object.values(row.promiseKeptByObserver)) <= 1),
  audit.commitments.map(row => [row.commitmentId, row.evidenceEventIds.length,
    row.fulfilRecordsByObserver, row.promiseKeptByObserver]));
check('every intent projected at most once',
  audit.intents.every(row => row.projectionOnce && row.settleLogEntries <= 1),
  audit.intents.filter(row => !row.projectionOnce || row.settleLogEntries > 1));
check('no duplicate settlement / projection anywhere',
  audit.duplicates.settledTwice.length === 0 && audit.duplicates.projectedTwice.length === 0
  && audit.duplicates.duplicateFulfilments.length === 0, audit.duplicates);
check('the final queue is reconciled', audit.pendingIntents === 0 && audit.ok === true,
  { pendingIntents: audit.pendingIntents, ok: audit.ok, clock: audit.clock });

// The cross-boundary proof: a promise that was ACTIVE in the save reached a
// terminal state at a receipt time AFTER the saved clock — in the new process.
const settledAfter = audit.commitments.filter(row => d2Active
  .some(saved => saved.commitmentId === row.commitmentId)
  && row.status === 'fulfilled' && row.updatedAt > (summary.restore?.clock ?? Infinity));
check('a promise active at the boundary was settled afterwards, exactly once',
  settledAfter.length > 0 && settledAfter.every(row => row.appliedProjections === 1),
  settledAfter.map(row => ({ commitmentId: row.commitmentId, status: row.status,
    updatedAt: row.updatedAt, savedClock: summary.restore?.clock,
    evidence: row.evidenceEventIds })));

// A promise that was active in the save must never be missing from the final
// board: this is the exact R9 defect ("promises vanish after restore").
const finalIds = new Set(audit.commitments.map(row => row.commitmentId));
check('no promise disappeared across the process boundary',
  d2Commitments.every(row => finalIds.has(row.commitmentId)),
  d2Commitments.filter(row => !finalIds.has(row.commitmentId)).map(row => row.commitmentId));

const report = {
  schema: 'frostecho.r10.d2-restore-verify/1',
  generatedAt: new Date().toISOString(),
  sourceHead: process.env.FROSTECHO_SOURCE_HEAD ?? null,
  inputs: { d2, d2Runtime: `${d2}.r8.json`, runner: `${d2}.runner.json`,
    summary: summaryPath, audit: auditPath },
  checks,
  ok: checks.every(row => row.passed),
};
writeFileSync(join(out, 'verify-d2-restore.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: report.ok,
  failed: checks.filter(row => !row.passed).map(row => row.name),
  evidence: join(out, 'verify-d2-restore.json') }, null, 2));
process.exitCode = report.ok ? 0 : 1;
