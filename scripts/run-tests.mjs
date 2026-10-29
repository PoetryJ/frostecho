import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
