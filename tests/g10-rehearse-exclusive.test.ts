/**
 * G10 closeout worker B — the rehearsal output directory is EXCLUSIVELY
 * created. Pre-fix behaviour (rmSync + recursive mkdir) destroyed whatever the
 * target path held; these black-box process tests lock the fix: an existing
 * directory — sentinel-filled or empty — is refused with exit 2 and untouched
 * bytes, a fresh directory runs the full 8-episode/16-loopback-POST rehearsal
 * once, and the same path can never be reused. No real network, no 18872.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/g10-live-rehearse.mjs');

interface RunResult { code: number | null; stdout: string; stderr: string }

function runRehearse(outDir: string): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, outDir], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** SHA-256 of every regular file under dir, keyed by relative path. */
function treeHashes(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (statSync(path).isDirectory()) walk(path, rel);
      else hashes.set(rel, createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(dir, '');
  return hashes;
}

test('existing directory with sentinel evidence is refused with exit 2 and unchanged bytes', async () => {
  const base = mkdtempSync(join(tmpdir(), 'frostecho-rehearse-exclusive-'));
  const target = join(base, 'occupied');
  mkdirSync(target);
  writeFileSync(join(target, 'sentinel.json'), 'sentinel-old-evidence\n');
  mkdirSync(join(target, 'nested'));
  writeFileSync(join(target, 'nested/deep.txt'), 'nested-old-evidence\n');
  const before = treeHashes(target);
  const run = await runRehearse(target);
  assert.equal(run.code, 2, `expected exit 2, stderr: ${run.stderr}`);
  assert.match(run.stderr, /refusing to overwrite/i);
  assert.deepEqual(treeHashes(target), before, 'no byte may change and no file may be added');
});

test('an existing EMPTY directory is refused the same way', async () => {
  const base = mkdtempSync(join(tmpdir(), 'frostecho-rehearse-exclusive-'));
  const target = join(base, 'empty-but-taken');
  mkdirSync(target);
  const run = await runRehearse(target);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /refusing to overwrite/i);
  assert.deepEqual(readdirSync(target), [], 'the empty directory must stay empty');
});

test('a fresh directory runs the full rehearsal: 8 episodes, 16 loopback POSTs, verify ok', async () => {
  const base = mkdtempSync(join(tmpdir(), 'frostecho-rehearse-exclusive-'));
  const target = join(base, 'fresh-run');
  const run = await runRehearse(target);
  assert.equal(run.code, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  const report = JSON.parse(readFileSync(join(target, 'report.json'), 'utf8'));
  assert.equal(report.loopbackPosts, 16);
  assert.equal(report.episodes, 8);
  assert.equal(report.verifyOk, true);
  assert.equal(report.allEqual, true);
  assert.equal(report.realModelCalls, 0);
  assert.equal(report.providerSource.includes('test-owned'), true, 'the rehearsal names its fake provider');

  const reportBytes = readFileSync(join(target, 'report.json'));
  const second = await runRehearse(target);
  assert.equal(second.code, 2, 'the same path must be refused on a second run');
  assert.match(second.stderr, /refusing to overwrite/i);
  assert.deepEqual(readFileSync(join(target, 'report.json')), reportBytes, 'bytes must be unchanged');
});
