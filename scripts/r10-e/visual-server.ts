/**
 * E: one process, one authority. Starts the existing game server on loopback and
 * puts the WebGPU display adapter in front of it, so the page and the 2D entry
 * share the same CLI session, clock, receipts and save file.
 *
 *   node dist/scripts/r10-e/visual-server.js [--port 18766] [--open-hint]
 *
 * It deliberately does not start a second CLI: `createPlayWebServer` owns the
 * only bridge, and this process only adds a read-only snapshot + a verbatim
 * command hop.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPlayWebServer } from '../../src/r7/ui/server';
import { createVisualAdapter } from '../../src/r7/visual/adapter';

const root = resolve(__dirname, '../../..');
const arg = process.argv.indexOf('--port');
const port = Number(arg >= 0 ? process.argv[arg + 1] : process.env.FROSTECHO_VISUAL_PORT ?? 18766);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');

const profile = (process.env.FROSTECHO_PROFILE as 'legacy' | 'gospel-5.8.19' | undefined)
  ?? 'gospel-5.8.19';
const mode = (process.env.FROSTECHO_MODE as 'reference' | 'jev-experimental' | undefined)
  ?? 'reference';

const game = createPlayWebServer(root, undefined, { profile, mode });
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
    console.log(`FrostEcho visual adapter: http://127.0.0.1:${actual}/`);
    console.log(`  display  : FrostEcho-WebGPU @ ${pinned.commit} (${pinned.mode ?? 'vendored'})`);
    console.log(`  authority: existing CLI via http://127.0.0.1:${internal} (profile=${profile}, mode=${mode})`);
    console.log('  2D entry : /api/state on the same process is the comparison baseline.');
    console.log('  browser  : none on this host; visual acceptance is NOT run here.');
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
