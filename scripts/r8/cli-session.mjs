import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/** Keep stdin open while the encoder runs; EOF is an intentional cancel barrier. */
export function openCli(root, args, { timeoutMs = 300000, env = process.env, onRecord = () => {} } = {}) {
  const child = spawn(process.execPath, [join(root, 'dist/scripts/play-sprint.js'), ...args],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const records = [], pending = new Map();
  let sequence = 0, stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error('CLI ready timeout')), 10000);
  const exited = new Promise(resolve => child.once('exit', code => {
    clearTimeout(timer); readyReject(new Error(`CLI exited: ${code} ${stderr}`));
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(new Error(`CLI exited: ${code} ${stderr}`)); }
    pending.clear(); resolve(code);
  }));
  child.on('error', error => { clearTimeout(timer); readyReject(error); });
  child.stderr.on('data', data => { stderr += data; });
  createInterface({ input: child.stdout }).on('line', line => {
    let record;
    try { record = JSON.parse(line); }
    catch { readyReject(new Error(`Non-protocol CLI output: ${line}`)); return; }
    records.push(record); onRecord(record);
    if (record.event === 'ready') { clearTimeout(timer); readyResolve(record); }
    const row = pending.get(record.jobId);
    if (row && (record.command || record.event === 'job_terminal')) {
      pending.delete(record.jobId); clearTimeout(row.timer);
      if (record.error) row.reject(new Error(record.error)); else row.resolve(record);
    }
  });
  return { child, ready, records, exited,
    send(line) {
      const jobId = `job-${String(++sequence).padStart(4, '0')}`;
      return new Promise((resolve, reject) => {
        const jobTimer = setTimeout(() => { pending.delete(jobId); reject(new Error(`CLI timeout ${line}`)); }, timeoutMs);
        pending.set(jobId, { resolve, reject, timer: jobTimer });
        child.stdin.write(line + '\n', error => {
          if (error) { clearTimeout(jobTimer); pending.delete(jobId); reject(error); }
        });
      });
    },
    async close() { if (child.exitCode === null) { await this.send('quit'); await exited; } },
    kill() { child.kill(); },
  };
}
