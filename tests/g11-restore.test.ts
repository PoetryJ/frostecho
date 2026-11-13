import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a corrupt G11 archive hash exits nonzero and writes no evidence files', () => {
  const root = mkdtempSync(join(tmpdir(), 'g11-bad-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'evidence'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'run-tests.mjs'),
      readFileSync(join(process.cwd(), 'scripts', 'run-tests.mjs')));
    writeFileSync(join(root, 'evidence', 'g11-original-evidence.tar.gz'),
      readFileSync(join(process.cwd(), 'evidence', 'g11-original-evidence.tar.gz')));
    writeFileSync(join(root, 'evidence', 'g11-original-evidence.sha256'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  g11-original-evidence.tar.gz\n');
    const run = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--restore-only'],
      { cwd: root, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.equal(existsSync(join(root, 'artifacts')), false);
    assert.equal(readFileSync(join(root, 'evidence', 'g11-original-evidence.tar.gz')).length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
