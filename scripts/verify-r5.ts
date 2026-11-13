/**
 * R5 recovery entry (H): one command that checks HEAD, dependencies, the G11
 * evidence archive and one real CLI slice, then reports the current feature
 * statuses and the next unpassed item. It is a sprint verifier, not a second
 * agent platform.
 *
 * Run: node dist/scripts/verify-r5.js [--out DIR]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT_INDEX = process.argv.indexOf('--out');
const OUT = OUT_INDEX !== -1 && process.argv[OUT_INDEX + 1]
  ? resolve(process.argv[OUT_INDEX + 1])
  : join(process.cwd(), 'artifacts/sprint-r5/verify');
mkdirSync(OUT, { recursive: true });

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
check('head', head.status === 0 && head.stdout.trim().length === 40,
  head.stdout.trim() || head.stderr);

check('node', Number(process.versions.node.split('.')[0]) >= 20,
  `node ${process.versions.node}`);
check('typescript', existsSync(join(process.cwd(), 'node_modules/typescript/package.json')),
  'node_modules/typescript present');

const g11 = join(process.cwd(),
  'artifacts/g11-live/g11-live-20261105-r1/w1/w1-wait-run.run.json');
check('g11-evidence', existsSync(g11), g11);

const state = join(OUT, 'smoke-session.json');
const smoke = spawnSync(process.execPath,
  [join('dist', 'scripts', 'play-sprint.js'), '--state', state, '--fresh', '--npc', '3'],
  { input: 'council-open\ncouncil-resolve\ncouncil-status\nsave\nquit\n',
    encoding: 'utf8', cwd: process.cwd(), timeout: 60_000 });
let smokeRows: Array<Record<string, any>> = [];
try {
  smokeRows = smoke.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
} catch {
  smokeRows = [];
}
const resolved = smokeRows.find(row => row.command === 'council-resolve');
const reopened = smokeRows.find(row => row.command === 'council-status');
check('real-cli-council', smoke.status === 0 && Boolean(resolved?.resolution)
  && Boolean(reopened?.council?.[0]?.resolution?.resolutionId),
  `exit=${smoke.status} resolution=${resolved?.resolution?.resolutionId ?? 'missing'}`);

const featuresPath = join(process.cwd(), 'artifacts/sprint-r5/features.json');
let features: Array<Record<string, any>> = [];
if (existsSync(featuresPath)) {
  features = JSON.parse(readFileSync(featuresPath, 'utf8')).features ?? [];
}
const unpassed = features.filter(feature => feature.status !== 'pass');
const summary = {
  schema: 'frostecho.r5-verify/1',
  at: new Date().toISOString(),
  head: head.stdout.trim(),
  results,
  features: features.length,
  passed: features.filter(feature => feature.status === 'pass').length,
  unpassed: unpassed.map(feature => ({ featureId: feature.featureId,
    status: feature.status, next: feature.next ?? null })),
  next: unpassed[0]?.next ?? (unpassed.length === 0 ? 'bundle + independent clone' : null),
};
mkdirSync(OUT, { recursive: true });
const path = join(OUT, 'verify-r5.json');
writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ path, passed: summary.passed, features: summary.features,
  unpassed: summary.unpassed.length, next: summary.next }, null, 2));
process.exit(results.every(result => result.ok) ? 0 : 1);
