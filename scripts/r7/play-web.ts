import { resolve } from 'node:path';
import { createPlayWebServer } from '../../src/r7/ui/server';

const root = resolve(__dirname, '../../..');
const arg = process.argv.indexOf('--port');
const port = Number(arg >= 0 ? process.argv[arg + 1] : process.env.FROSTECHO_WEB_PORT ?? 18740);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
const app = createPlayWebServer(root);
app.server.listen(port, '127.0.0.1', () => {
  const address = app.server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(`FrostEcho: http://127.0.0.1:${actual}`);
  console.log('原作素材 + 单一权威 CLI。关闭时保存当前游戏；Ctrl+C 退出。');
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
