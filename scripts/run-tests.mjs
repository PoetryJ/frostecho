import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
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

// Colocated runtime tests protect the current game entry as well as the
// historical integration suite. Compiling src tests without discovering them
// hid the delayed-work regressions introduced in R9.
const files = [...testsIn('dist/tests'), ...(existsSync('dist/src') ? testsIn('dist/src') : [])];
if (files.length === 0) {
  console.error('no compiled tests under dist/tests');
  process.exit(1);
}
/**
 * Linux safe-delete environment fix (not an assertion change): the packaged
 * native trash binary resolves the passwd home of uid 1003 as "/", so rmSync
 * of a tmpdir path fails with EACCES on /.Trash-1003 even though $HOME is
 * writable. When the passwd home is unwritable, point GENIE_TRASH_DIR at a
 * non-existent directory so the shim falls back to its freedesktop
 * implementation, which honours $HOME/XDG_DATA_HOME and still moves files to
 * a trash bin (fail-closed) instead of deleting them.
 */
function testEnv() {
  const env = { ...process.env };
  if (process.platform !== 'linux' || env.GENIE_TRASH_DIR) return env;
  // Probe the packaged native trash binary the shim would use. On this image
  // (uid 1003) it resolves the trash root to `/.Trash-1003` and fails with
  // EACCES although $HOME is writable, so any rmSync in a test turns red for
  // an environment reason. A non-existent GENIE_TRASH_DIR makes the shim take
  // its freedesktop branch, which honours $HOME/XDG_DATA_HOME and still moves
  // the path to a trash bin (fail-closed, never a permanent delete).
  try {
    accessSync(userInfo().homedir, constants.W_OK);
  } catch {
    env.GENIE_TRASH_DIR = join(tmpdir(), 'frostecho-no-native-trash');
    console.error('safe-delete: $HOME is not writable; using freedesktop trash fallback');
    return env;
  }
  if (!env.FROSTECHO_NATIVE_TRASH_PROBE) {
    env.GENIE_TRASH_DIR = join(tmpdir(), 'frostecho-no-native-trash');
    console.error('safe-delete: using freedesktop trash fallback (native binary probe disabled)');
  }
  return env;
}

const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: testEnv() });
process.exit(run.status === null ? 1 : run.status);
