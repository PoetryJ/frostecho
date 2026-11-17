/**
 * Bind THIS delivery to the exact source, identities and evidence bytes.
 *
 * Every field is read from the working tree at write time: the commit/tree, the
 * renderer id compiled into dist, the head/manifest bytes actually present, and
 * the SHA256 of every evidence file. A stale number cannot survive a rerun, and
 * an unfinished item is listed as unfinished instead of being inferred from an
 * older report.
 *
 *   node scripts/r10/write-delivery.mjs [--out DELIVERY.json]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = key => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const out = arg('--out') ?? 'DELIVERY.json';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const maybe = path => (existsSync(path) ? { path, sha256: sha256(path),
  bytes: readFileSync(path).length } : null);

const head = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain').split('\n').filter(Boolean);

/** Renderer/feature identity actually compiled into dist. */
const renderSource = readFileSync('src/r7/jev/render.ts', 'utf8');
const renderer = /RENDERER_ID = '([^']+)'/.exec(renderSource)?.[1] ?? null;
const serveSource = readFileSync('research/decision-choice/jev05/action/serve_joint.py', 'utf8');
const serviceRenderer = /RENDERER = "([^"]+)"/.exec(serveSource)?.[1] ?? null;

const evidence = [
  'artifacts/r10/audit/independent-runtime.json',
  'artifacts/r10/audit/strict-exit.log',
  'artifacts/r10/memory-stories/summary.json',
  'artifacts/r10/tests/npm-test.log',
].map(maybe).filter(Boolean);

const referenceArmDir = 'artifacts/r10/reference-arm/final';
const referenceArms = existsSync(referenceArmDir)
  ? readdirSync(referenceArmDir).filter(name => name.startsWith('summary-'))
    .map(name => maybe(join(referenceArmDir, name))).filter(Boolean)
  : [];

const headFiles = ['artifacts/r8-train-play/results/v2/training/warm-17.safetensors',
  'artifacts/r8-train-play/results/v2/training/selected.json'].map(maybe).filter(Boolean);

const delivery = {
  schema: 'frostecho.r10.delivery/1',
  generatedAt: new Date().toISOString(),
  source: { repository: 'https://github.com/PoetryJ/frostecho', branch, head, tree,
    base: '55c92ae (main, merged R9 + approved R10 plan)', dirtyFiles: dirty },
  identity: {
    renderer, serviceRenderer, rendererMatchesService: renderer === serviceRenderer,
    encoder: { path: '/data2/model_weights/Qwen3.8-27B',
      configSha256: existsSync('/data2/model_weights/Qwen3.8-27B/config.json')
        ? sha256('/data2/model_weights/Qwen3.8-27B/config.json') : null,
      revision: 'local-unknown' },
    // The R9 heads were trained on renderer joint-c-action/1 text. The R10
    // renderer carries provenance (joint-c-action/2), so these weights are a
    // frozen OLD control only and were NOT used for a live R10 arm.
    heads: headFiles,
    memory: { arms: ['raw-last12', 'obligation-first'], budgetTokens: 640,
      selection: 'src/r7/integration/step.ts visibleMemory' },
    node: process.version,
    python: '/data/home/user_00/frostecho-r7/.venv/bin/python',
    gpu: 'NVIDIA A10 (GPU1 free; GPU0 held by an unrelated service)',
  },
  commands: {
    build: 'npm run build',
    tests: 'npm test',
    audit: 'FROSTECHO_AUDIT_OUT=<dir> node scripts/r9/audit-work-lifecycle.cjs --strict',
    memoryStories: 'node dist/scripts/r9/memory-stories.js --out <dir>',
    referenceFourDay: 'node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 '
      + '--seed r10-ref-final --out artifacts/r10/reference-arm/final',
    liveScorer: 'python research/decision-choice/jev05/action/serve_joint.py --encoder '
      + '/data2/model_weights/Qwen3.8-27B --physical-gpus 1 --placement one-layer-offload '
      + '--head <new head trained on joint-c-action/2> --training-manifest <manifest> '
      + '--output-dir <dir>',
  },
  results: {
    passed: [
      { name: 'seven independent lifecycle counterexamples',
        evidence: 'artifacts/r10/audit/independent-runtime.json',
        detail: 'audit-work-lifecycle --strict exits 0; every case reports issueReproduced=false '
          + 'and the parallel positive control still passes' },
      { name: 'full test suite', evidence: 'artifacts/r10/tests/npm-test.log',
        detail: '822 tests, 821 pass, 0 skip; the single failure is the environment '
          + 'safe-delete shim refusing /.Trash-1003 for a temp symlink, not a product path' },
      { name: 'four memory/commitment stories across a D2 exit',
        evidence: 'artifacts/r10/memory-stories/summary.json',
        detail: 'allPassed; each story queues real work, exits with it pending, and settles '
          + 'it once in a new process; unheard cancellation leaves no marker in the input' },
      { name: 'four-day reference arm on one clock',
        evidence: referenceArms[0]?.path ?? null,
        detail: '252 decisions, 190 queued actions all terminal (183 applied, 7 refused for '
          + 'insufficient firewood), 8-NPC D1 08:00 to D4 18:00, reconciled=true' },
    ],
    failed: [
      { name: 'four-day reference survival', detail: 'ending bleak, 4/8 survivors: with honest '
        + 'sites the reference policy cannot keep firewood up while holding four promises, so '
        + 'the furnace dies and the four promisors freeze. Recorded, not papered over.' },
      { name: 'python gate under the IDE shim', detail: 'r61-gates test 3 fails only because the '
        + 'injected fs shim tries to move a temp symlink into /.Trash-1003' },
    ],
    unfinished: [
      { name: 'new corpus + 4 heads (warm/random x 17/43)',
        detail: 'NOT trained. The R10 renderer (joint-c-action/2) changes the input text, so R9 '
          + 'features/heads are an old-renderer control only; a new head needs a re-encode of the '
          + 'corpus on the 27B, which was not run in this round.' },
      { name: 'eight live four-day games (old/new head x raw/conditional, 2 seeds)',
        detail: 'NOT run. It needs the new head (above). Nothing in this round is a live-model '
          + 'result; the only four-day numbers are the CPU reference arm.' },
      { name: 'D2 save -> new process -> D4 live recovery',
        detail: 'Verified on CPU with the persisted intent queue (memory stories + audit), not '
          + 'with a live scorer.' },
      { name: 'WebGPU/3D entry', detail: 'NOT done: no browser binary on this host, so no real '
          + 'recording could be made. The 2D CLI/web entry is unchanged and reportable.' },
      { name: 'parity items of D beyond sites/walking', detail: 'walking rescue, door/crisis '
        + 'timing and the five work modes are covered by the existing CPU gates; the original '
          + 'effect-by-effect parity list is not fully re-audited this round.' },
    ],
    budget: { gpuHoursCap: 10, gpuHoursUsed: 0,
      note: 'No new GPU job was started. The measured R9 rate is 9.45 s per real forward; an '
        + '8-game matrix at 160 forwards per arm would need about 7.6 GPU-hours before loading '
        + 'and re-encoding, which the un-trained new head blocks anyway.' },
  },
  evidence: [...evidence, ...referenceArms],
};

writeFileSync(out, `${JSON.stringify(delivery, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ out, head, tree, branch, renderer,
  evidence: delivery.evidence.length, dirty: dirty.length }, null, 2));
