/**
 * E (R11): one process, one authority.
 *
 * Starts the existing game server (`createPlayWebServer` → `dist/scripts/play-sprint.js`)
 * on loopback and puts the WebGPU display adapter in front of it. The page, the
 * 2D page and the CLI therefore share one session, one clock, one save file and
 * one receipt log.
 *
 *   node dist/scripts/r11-e/visual-server.js [--port 18766] [--saves DIR]
 *        [--profile gospel-5.8.19] [--mode reference] [--browser-tag NAME]
 *
 * It deliberately starts no second CLI: the bridge owns the only child process,
 * the adapter only derives a read-only snapshot and forwards one command line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPlayWebServer } from '../../src/r7/ui/server';
import { createVisualAdapter } from '../../src/r7/visual/adapter';
import { VISUAL_RUNNER } from '../../src/r7/visual/snapshot';

const root = resolve(__dirname, '../../..');
const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const port = Number(argValue('--port') ?? process.env.FROSTECHO_VISUAL_PORT ?? 18766);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');

const profile = (argValue('--profile') ?? process.env.FROSTECHO_PROFILE
  ?? 'gospel-5.8.19') as 'legacy' | 'gospel-5.8.19';
const mode = (argValue('--mode') ?? process.env.FROSTECHO_MODE
  ?? 'reference') as 'reference' | 'jev-experimental';
const saves = resolve(argValue('--saves') ?? process.env.FROSTECHO_VISUAL_SAVES
  ?? resolve(root, 'saves', 'r11-e'));
const browserTag = argValue('--browser-tag') ?? process.env.FROSTECHO_VISUAL_BROWSER ?? null;
if (browserTag) process.env.FROSTECHO_VISUAL_BROWSER = browserTag;

const game = createPlayWebServer(root, saves, { profile, mode });
game.server.listen(0, '127.0.0.1', () => {
  const address = game.server.address();
  const internal = typeof address === 'object' && address ? address.port : 0;
  const adapter = createVisualAdapter({
    gameBaseUrl: `http://127.0.0.1:${internal}`,
    publicRoot: resolve(root, 'public', 'r7', 'visual'),
  });
  adapter.server.listen(port, '127.0.0.1', () => {
    const bound = adapter.server.address();
    const actual = typeof bound === 'object' && bound ? bound.port : port;
    const vendored = resolve(root, 'public', 'r7', 'visual', 'VENDORED.json');
    const pinned = existsSync(vendored)
      ? JSON.parse(readFileSync(vendored, 'utf8'))
      : { commit: 'missing', source: 'missing' };
    const url = `http://127.0.0.1:${actual}/`;
    console.log(`FrostEcho visual adapter: ${url}`);
    console.log(`  display  : FrostEcho-WebGPU @ ${pinned.commit} (${pinned.mode ?? 'vendored'})`);
    console.log(`  authority: existing CLI via http://127.0.0.1:${internal} (profile=${profile}, mode=${mode})`);
    console.log(`  runner   : ${VISUAL_RUNNER} · saves ${saves}`);
    console.log(`  pid      : ${process.pid}`);
    console.log(`FROSTECHO_VISUAL_READY ${JSON.stringify({ url, port: actual, pid: process.pid,
      profile, mode, runner: VISUAL_RUNNER, saves, browserTag })}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void adapter.close()
      .then(() => game.close())
      .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
