/**
 * R11 (H) determinism control: ids minted by the game must depend on the
 * experiment, not on the process. `randomUUID()` is therefore replaced by a
 * hash of (seed, call context, occurrence). The call context is set by the
 * runner at every decision/settlement boundary, so a segmented run (D2 exit,
 * new pid) and a continuous replay of the same state produce the SAME ids.
 *
 * This is a harness control, not a game rule: it is declared in
 * H/SCENARIO-FREEZE.json (`idFactory`) and every save/compare records
 * `deterministicIds: true`. Without it, `commitmentId`/`changeId` are random
 * per process and a byte-level full-state comparison would be impossible.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let seed = 'unset';
let context = 'boot';
const counters = new Map();
let installed = false;

function uuidFrom(text) {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Install once, before any compiled game module is required. */
export function installDeterministicIds(idSeed) {
  seed = String(idSeed);
  if (installed) return;
  const crypto = require('node:crypto');
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => {
      const n = counters.get(context) ?? 0;
      counters.set(context, n + 1);
      return uuidFrom(`${seed}|${context}|${n}`);
    },
  });
  installed = true;
}

export function setUuidContext(next) {
  context = String(next);
}

export function uuidContext() {
  return context;
}

/** Exposed for the comparator: the exact id the next call would mint. */
export function peekUuid(offset = 0) {
  const n = (counters.get(context) ?? 0) + offset;
  return uuidFrom(`${seed}|${context}|${n}`);
}
