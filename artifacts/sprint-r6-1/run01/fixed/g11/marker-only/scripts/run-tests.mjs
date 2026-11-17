import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

/**
 * npm test runs the G11 latency checks, which read the packaged historical
 * batch. Those run files are not tracked (only plan.json and offline-ready.json
 * are). Restore missing files from evidence/g11-original-evidence.tar.gz and
 * never replace a file that is already present.
 */
function restorePackagedG11() {
  const pkg = join('evidence', 'g11-original-evidence.tar.gz');
  const sums = join('evidence', 'g11-original-evidence.sha256');
  if (!existsSync(pkg) || !existsSync(sums)) {
    console.error('missing packaged G11 evidence; g11-live run files cannot be restored');
    process.exit(1);
  }
  const expected = readFileSync(sums, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash('sha256').update(readFileSync(pkg)).digest('hex');
  if (actual !== expected) {
    console.error('packaged G11 evidence hash does not match g11-original-evidence.sha256');
    process.exit(1);
  }
  const staging = mkdtempSync(join(tmpdir(), 'g11-evidence-'));
  const root = resolve('.');
  const allowed = resolve(root, 'artifacts', 'g11-live');
  try {
    const extracted = spawnSync('tar', ['-xzf', resolve(pkg), '-C', staging], { stdio: 'inherit' });
    if (extracted.status !== 0) process.exit(extracted.status === null ? 1 : extracted.status);
    let copied = 0;
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        const relativePath = relative(staging, path);
        const target = resolve(root, relativePath);
        if (target !== allowed && !target.startsWith(allowed + sep)) {
          console.error(`refusing unexpected G11 archive path: ${relativePath}`);
          process.exit(1);
        }
        if (!existsSync(target)) {
          mkdirSync(join(target, '..'), { recursive: true });
          copyFileSync(path, target);
          copied += 1;
        }
      }
    };
    walk(staging);
    console.error(`restored ${copied} packaged G11 evidence files`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

restorePackagedG11();
if (process.argv.includes('--restore-only')) process.exit(0);

/** Node treats `node --test <directory>` as a module. Pass every compiled test file. */
function testsIn(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testsIn(path, out);
    else if (name.endsWith('.test.js')) out.push(path);
  }
  return out;
}

const files = testsIn('dist/tests');
if (files.length === 0) {
  console.error('no compiled tests under dist/tests');
  process.exit(1);
}
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
