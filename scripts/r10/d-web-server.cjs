/**
 * The real `public/r7` server with an explicit save root, used by the D web
 * evidence script. It is the same `createPlayWebServer` the game ships, so the
 * save/restore evidence is about the product, not a harness copy.
 *
 *   node scripts/r10/d-web-server.cjs --port 18755 --saves <dir>
 */
const { resolve } = require('node:path');
const { createPlayWebServer } = require('../../dist/src/r7/ui/server.js');

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = Number(arg('--port', 18755));
const saves = resolve(arg('--saves', 'saves/r10-d'));
const root = resolve(__dirname, '..', '..');
const app = createPlayWebServer(root, saves);
app.server.listen(port, '127.0.0.1', () => {
  const address = app.server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${actual}`, saves }));
});
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
process.on('SIGINT', () => { void app.close().then(() => process.exit(0)); });
