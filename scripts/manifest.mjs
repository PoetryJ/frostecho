// Manifest of the tracked tree only. Walking the filesystem used to pull in
// untracked scratch files, so `sha256sum -c` failed in a fresh clone; evidence
// hashes are only meaningful for files that actually ship in the bundle.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const listed = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter(file => file !== 'MANIFEST.sha256')
  .sort();

const lines = listed.map(file => {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `${hash}  ${file}`;
});
writeFileSync('MANIFEST.sha256', lines.join('\n') + '\n');
console.log(lines.join('\n'));
