/**
 * Workstream C — batch store and versioning.
 * Interface (locked): createBatchStore(root, name) -> BatchStore (exclusive), collectVersion(repoRoot) -> VersionInfo.
 * Evidence is write-once: every file is created with flag 'wx'. A second start with the same name throws before any request.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { renderDecidePrompt } from '../agent';

export const BATCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class BatchStoreError extends Error {
  readonly code: 'bad_name' | 'out_of_bounds' | 'exists' | 'evidence_exists';
  constructor(code: BatchStoreError['code'], message: string) {
    super(message);
    this.name = 'BatchStoreError';
    this.code = code;
  }
}

export function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface BatchStore {
  readonly root: string;
  readonly name: string;
  readonly dir: string;
  /** Write-once JSON. Throws if the file exists or the path leaves the batch dir. */
  writeJson(relPath: string, value: unknown): string;
  /** Fresh subdirectory that must not exist yet. */
  freshDir(relPath: string): string;
  path(relPath: string): string;
}

export function validateBatchName(root: string, name: string): string {
  if (!BATCH_NAME_RE.test(name) || name.includes('..')) {
    throw new BatchStoreError('bad_name', `batch name must match ${BATCH_NAME_RE} and not contain '..': ${JSON.stringify(name)}`);
  }
  const dir = resolve(root, name);
  if (!strictlyInside(root, dir)) throw new BatchStoreError('out_of_bounds', 'batch dir escapes the artifact root');
  return dir;
}

/** Exclusive create. Never reuses or overwrites an existing batch. */
export function createBatchStore(root: string, name: string): BatchStore {
  const absRoot = resolve(root);
  const dir = validateBatchName(absRoot, name);
  mkdirSync(absRoot, { recursive: true });
  try {
    mkdirSync(dir); // non-recursive: EEXIST if a batch with this name already exists
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new BatchStoreError('exists', `batch ${name} already exists; evidence is never overwritten`);
    }
    throw err;
  }
  const inside = (relPath: string) => {
    const target = resolve(dir, relPath);
    if (!strictlyInside(dir, target)) throw new BatchStoreError('out_of_bounds', `path escapes batch: ${relPath}`);
    return target;
  };
  return {
    root: absRoot,
    name,
    dir,
    path: inside,
    writeJson(relPath, value) {
      const target = inside(relPath);
      mkdirSync(resolve(target, '..'), { recursive: true });
      try {
        writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new BatchStoreError('evidence_exists', `refusing to overwrite ${relPath}`);
        throw err;
      }
      return target;
    },
    freshDir(relPath) {
      const target = inside(relPath);
      if (existsSync(target)) throw new BatchStoreError('evidence_exists', `refusing to reuse ${relPath}`);
      mkdirSync(target, { recursive: true });
      return target;
    },
  };
}

export interface VersionInfo {
  commit: string | null;
  dirty: boolean | null;
  dirtyFiles: string[];
  sourceFingerprint: string;
  promptFingerprint: string;
  node: string;
  platform: string;
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function filesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** sha256 over src/**\/*.ts and scripts/*.ts, path + LF-normalised content, so CRLF checkouts match. */
export function sourceFingerprint(repoRoot: string): string {
  const hash = createHash('sha256');
  for (const file of [...filesUnder(join(repoRoot, 'src')), ...filesUnder(join(repoRoot, 'scripts'))]) {
    hash.update(relative(repoRoot, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** sha256 of the prompt rendered for a fixed probe input. Changes whenever the prompt text changes. */
export function promptFingerprint(): string {
  const prompt = renderDecidePrompt({
    observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [] } as never,
    goal: { hungerAtLeast: 70 },
    feedback: null,
  });
  return createHash('sha256').update(prompt).digest('hex');
}

export function collectVersion(repoRoot: string = process.cwd()): VersionInfo {
  const commit = git(repoRoot, ['rev-parse', 'HEAD']);
  const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  const dirtyFiles = status ? status.split(/\r?\n/).filter(Boolean).map(line => line.slice(3)) : [];
  return {
    commit,
    dirty: status === null ? null : dirtyFiles.length > 0,
    dirtyFiles,
    sourceFingerprint: sourceFingerprint(repoRoot),
    promptFingerprint: promptFingerprint(),
    node: process.version,
    platform: process.platform,
  };
}
