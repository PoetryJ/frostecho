#!/usr/bin/env node
/**
 * Re-derive the acceptable set from ALREADY RECORDED branch rollouts.
 *
 *   node research/decision-choice/r10/relabel.mjs \
 *     --labels <labels/labels.jsonl> --rule base|discharge --out <newDir>
 *
 * The rollouts are not re-run: every branch record already carries its terminal
 * facts (first-action status, alive counts, task statuses, settled intents), so
 * a label family is a pure predicate over stored evidence. That is what makes
 * the choice of family auditable instead of a silent switch.
 *
 *   base      first-action-applied && actor-alive && no-population-loss
 *             && no-accepted-task-lost
 *   discharge base && every task accepted at the branch point is discharged
 *             (status done) at the horizon
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const labelsPath = option('--labels');
const out = option('--out');
const rule = option('--rule', 'base');
if (!labelsPath || !out) throw new Error('Usage: --labels <labels.jsonl> --out <newDir> --rule base|discharge');
if (!['base', 'discharge'].includes(rule)) throw new Error(`unknown rule ${rule}`);
const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });

const RULE_TEXT = {
  base: 'first-action-applied && actor-alive && no-population-loss && no-accepted-task-lost',
  discharge: 'first-action-applied && actor-alive && no-population-loss && no-accepted-task-lost '
    + '&& obligations-discharged',
}[rule];

const rows = readFileSync(labelsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const labels = [];
for (const row of rows) {
  const branches = row.branches.map(branch => {
    const reasons = [];
    if (branch.firstAction.status !== 'applied') reasons.push(`first_action:${branch.firstAction.status}`);
    if (!branch.terminal.actorAlive) reasons.push('actor_dead');
    if (branch.terminal.alive < branch.branchPoint.alive) reasons.push('population_loss');
    if (branch.acceptedTaskLost.length > 0) reasons.push('accepted_task_lost');
    if (rule === 'discharge' && branch.obligationsStillOwed.length > 0) {
      reasons.push(`obligation_pending:${branch.obligationsStillOwed.length}`);
    }
    return { ...branch, acceptable: reasons.length === 0, acceptReasons: reasons };
  });
  const acceptableIds = branches.filter(branch => branch.acceptable).map(branch => branch.candidateId);
  labels.push({
    caseId: row.caseId,
    sourceEpisodeId: row.sourceEpisodeId,
    actorId: row.actorId,
    captureKind: row.captureKind,
    candidates: row.candidates,
    acceptableIds,
    allAcceptable: acceptableIds.length === row.candidates,
    noneAcceptable: acceptableIds.length === 0,
    rulePick: row.rulePick,
    rulePickAcceptable: acceptableIds.includes(row.rulePick),
    randomExpectation: acceptableIds.length / row.candidates,
    labelRule: RULE_TEXT,
    horizonMinutes: row.horizonMinutes,
    sliceMinutes: row.sliceMinutes,
    labelSource: `same-snapshot-branch-rollout/${rule}`,
    derivedFrom: labelsPath,
    derivedFromSha256: sha(readFileSync(labelsPath)),
    branches,
  });
}
writeFileSync(`${outDir}/labels.jsonl`, `${labels.map(label => JSON.stringify(label)).join('\n')}\n`);

let seed = 20261118;
const draw = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
let hits = 0, total = 0;
for (const label of labels) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pick = Math.min(label.candidates - 1, Math.floor(draw() * label.candidates));
    hits += label.branches[pick].acceptable ? 1 : 0;
    total += 1;
  }
}
const summary = {
  schema: 'frostecho.r10c.labels/2',
  derivedFrom: labelsPath,
  derivedFromSha256: sha(readFileSync(labelsPath)),
  rule,
  labelRule: RULE_TEXT,
  cases: labels.length,
  totalBranches: labels.reduce((sum, label) => sum + label.candidates, 0),
  allAcceptableCases: labels.filter(label => label.allAcceptable).length,
  noneAcceptableCases: labels.filter(label => label.noneAcceptable).length,
  partialCases: labels.filter(label => !label.allAcceptable && !label.noneAcceptable).length,
  meanAcceptablePerCase: Number((labels.reduce((sum, label) => sum + label.acceptableIds.length, 0)
    / labels.length).toFixed(4)),
  randomBaseline: { expectedTop1GivenUniformPick: Number((labels.reduce((sum, label) =>
    sum + label.randomExpectation, 0) / labels.length).toFixed(4)),
    seededDrawTop1: Number((hits / total).toFixed(4)), draws: total },
  ruleBaseline: { top1InAcceptable: Number((labels.filter(label => label.rulePickAcceptable).length
    / labels.length).toFixed(4)), cases: labels.length },
  byCaptureKind: labels.reduce((acc, label) => {
    const entry = acc[label.captureKind] ?? { cases: 0, allAcceptable: 0, ruleOk: 0 };
    entry.cases += 1;
    entry.allAcceptable += label.allAcceptable ? 1 : 0;
    entry.ruleOk += label.rulePickAcceptable ? 1 : 0;
    acc[label.captureKind] = entry;
    return acc;
  }, {}),
  labelsSha256: sha(labels.map(label => JSON.stringify(label)).join('\n')),
  note: 'Derived from stored branch facts; no rollout was re-run and no non-wait rule was applied.',
};
writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
