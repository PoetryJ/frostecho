import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type CliRecord = Record<string, any>;
type Pending = { resolve: (record: CliRecord) => void; reject: (error: Error) => void;
  timer: NodeJS.Timeout };

export interface BridgeOptions {
  profile?: 'legacy' | 'gospel-5.8.19';
  mode?: 'reference' | 'jev-experimental';
  scorerCommand?: string[];
  scorerTimeoutMs?: number;
}

/** Transport only: the existing CLI owns every job, rule, clock and save. */
export class CliBridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private scheduler?: NodeJS.Timeout;
  private starting = false;
  private refreshing?: Promise<void>;
  private closed = false;
  private sessionId: string | null = null;
  private recordPath: string | null = null;
  private speed = 1;
  private running = false;
  private observation: CliRecord | null = null;
  private status: CliRecord | null = null;
  private positions: Record<string, CliRecord> = {};
  private records: CliRecord[] = [];
  private savedAt: string | null = null;
  private lastError: string | null = null;
  private profile: 'legacy' | 'gospel-5.8.19';
  private readonly mode: 'reference' | 'jev-experimental';
  private readonly scorerTimeoutMs: number;

  constructor(readonly root: string, readonly saveRoot = join(root, 'saves', 'r7'),
    readonly options: BridgeOptions = {}) {
    super();
    this.profile = options.profile ?? (process.env.FROSTECHO_PROFILE as BridgeOptions['profile']) ?? 'gospel-5.8.19';
    this.mode = options.mode ?? (process.env.FROSTECHO_MODE as BridgeOptions['mode']) ?? 'reference';
    this.scorerTimeoutMs = options.scorerTimeoutMs ?? Number(process.env.FROSTECHO_SCORER_TIMEOUT_MS ?? 300000);
    mkdirSync(saveRoot, { recursive: true });
  }

  snapshot(): CliRecord {
    return { active: Boolean(this.child), sessionId: this.sessionId,
      profile: this.profile, mode: this.mode,
      running: this.running, speed: this.speed, observation: this.observation,
      status: this.status, positions: this.positions, records: this.records.slice(-80),
      savedAt: this.savedAt, lastError: this.lastError,
      canContinue: existsSync(join(this.saveRoot, 'last-session.json')) };
  }

  private broadcast(): void { this.emit('state', this.snapshot()); }

  private record(record: CliRecord): void {
    this.records.push(record);
    if (this.records.length > 160) this.records.shift();
    if (this.recordPath) appendFileSync(this.recordPath,
      JSON.stringify({ receivedAt: new Date().toISOString(), ...record }) + '\n', 'utf8');
    if (record.command === 'observe' && !record.error) this.observation = record;
    if (record.command === 'task-status' && record.status) this.status = record.status;
    if (record.command === 'where' && record.npcId) this.positions[record.npcId] = record;
    if (record.command === 'save' && record.saved) this.savedAt = new Date().toISOString();
    if (record.error) this.lastError = String(record.error);
    this.emit('record', record);
    const waiting = this.pending.get(record.jobId);
    if (waiting && (record.command || record.event === 'job_terminal')) {
      clearTimeout(waiting.timer);
      this.pending.delete(record.jobId);
      waiting.resolve(record);
    }
  }

  async start(fresh: boolean): Promise<CliRecord> {
    if (this.starting) throw new Error('A session is already starting.');
    if (this.closed) throw new Error('The server is closing.');
    this.starting = true;
    try {
      if (this.child) await this.stop(true);
      if (fresh) {
        this.profile = this.options.profile ?? (process.env.FROSTECHO_PROFILE as BridgeOptions['profile']) ?? 'gospel-5.8.19';
        this.sessionId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      }
      else {
        const pointer = join(this.saveRoot, 'last-session.json');
        if (!existsSync(pointer)) throw new Error('还没有可继续的存档。请先开始新游戏。');
        const saved = JSON.parse(readFileSync(pointer, 'utf8'));
        if (typeof saved.sessionId !== 'string' || !/^\d+-[a-f0-9-]+$/.test(saved.sessionId)) {
          throw new Error('Invalid saved session identity.');
        }
        this.sessionId = saved.sessionId;
        // Old pointers predate Gospel and must keep their legacy clock/ledger.
        this.profile = saved.profile ?? 'legacy';
      }
      const directory = join(this.saveRoot, this.sessionId!);
      mkdirSync(directory, { recursive: true });
      const statePath = join(directory, 'session.json');
      if (!fresh && !existsSync(statePath)) throw new Error('存档文件不存在。');
      const entry = join(this.root, 'dist', 'scripts', 'play-sprint.js');
      if (!existsSync(entry)) throw new Error('请先运行 npm run build。');
      this.sequence = 0;
      this.records = [];
      this.positions = {};
      this.observation = null;
      this.status = null;
      this.lastError = null;
      this.recordPath = join(directory, 'web-cli.jsonl');
      const args = [entry, '--state', statePath, '--npc', '8', '--days', '4',
        '--food', this.profile === 'gospel-5.8.19' ? '130' : '120', '--seed', 'r7-player', '--profile', this.profile,
        '--mode', this.mode, '--scorer-timeout-ms', String(this.scorerTimeoutMs)];
      if (this.options.scorerCommand) args.push('--scorer-command-json', JSON.stringify(this.options.scorerCommand));
      if (fresh) args.push('--fresh');
      const child = spawn(process.execPath, args, { cwd: this.root,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      const reader = createInterface({ input: child.stdout });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('CLI startup timed out.')); }, 10_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer);
          reject(new Error(`CLI exited during startup (${code}).`)); });
        reader.on('line', line => {
          try {
            const row = JSON.parse(line) as CliRecord;
            this.record(row);
            if (row.event === 'ready') { clearTimeout(timer); resolve(); }
          } catch { this.record({ event: 'stdout', text: line }); }
        });
      });
      child.stderr.on('data', chunk => this.record({ event: 'stderr', text: String(chunk) }));
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.pause();
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`CLI exited (${code ?? signal}).`));
        }
        this.pending.clear();
        this.record({ event: 'process_exit', code, signal });
        this.broadcast();
      });
      await ready;
      await this.command('save');
      writeFileSync(join(this.saveRoot, 'last-session.json'),
        JSON.stringify({ sessionId: this.sessionId, profile: this.profile, mode: this.mode }, null, 2) + '\n', 'utf8');
      await this.refresh();
      this.broadcast();
      return this.snapshot();
    } catch (error) {
      if (this.child) this.child.kill();
      throw error;
    } finally { this.starting = false; }
  }

  /** No transport queue: cancellation can enter stdin while a scorer is waiting. */
  command(line: string): Promise<CliRecord> {
    if (!this.child || this.child.stdin.destroyed) return Promise.reject(new Error('请先开始或继续游戏。'));
    if (!line.trim() || /[\r\n\0]/.test(line) || line.length > 2048) {
      return Promise.reject(new Error('每次请输入一条有效命令（最多 2048 字符）。'));
    }
    const jobId = `job-${String(++this.sequence).padStart(4, '0')}`;
    const promise = new Promise<CliRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        // Timeout is transport uncertainty, never evidence that the command was cancelled.
        reject(new Error(`等待 ${jobId} 超时；结果仍可能到达，请勿盲目重试。`));
      // A batch scores up to eight residents. Control and save stay bounded by
      // the CLI's independent barrier; a legitimate encoder call may be slow.
      }, /^(game-step|r8-step)\b/.test(line) ? this.scorerTimeoutMs * 8 + 10_000 : 35_000);
      this.pending.set(jobId, { resolve, reject, timer });
      this.child!.stdin.write(line.trim() + '\n', error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(jobId);
        reject(error);
      });
    });
    if (this.recordPath) appendFileSync(this.recordPath,
      JSON.stringify({ submittedAt: new Date().toISOString(), event: 'web_input', jobId, line }) + '\n', 'utf8');
    return promise;
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!this.child) return;
      await this.command('observe');
      await this.command('task-status');
      const ids = (this.observation?.npcs ?? []).map((npc: CliRecord) => npc.id);
      await Promise.all(ids.map((id: string) => this.command(`where ${id}`)));
      this.broadcast();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  pause(): void {
    this.running = false;
    if (this.scheduler) clearTimeout(this.scheduler);
    this.scheduler = undefined;
    this.broadcast();
  }

  setSpeed(value: number): void {
    if (![1, 4, 12].includes(value)) throw new Error('Unsupported speed.');
    this.speed = value;
    this.broadcast();
  }

  run(): void {
    if (!this.child) throw new Error('请先开始或继续游戏。');
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running || !this.child) return;
      try {
        const before = Number(this.observation?.simTime ?? 0);
        const decision = await this.command('game-step');
        if (decision.error) throw new Error(String(decision.error));
        await this.refresh();
        // Some choices (eating, gathering, waiting) do not advance the clock.
        // Use the existing authoritative time command only when no action did.
        if (this.running && Number(this.observation?.simTime ?? 0) === before
          && (!this.status?.ending || this.status.ending === 'none')) {
          await this.command('advance 15');
          await this.refresh();
        }
        if (this.status?.ending && this.status.ending !== 'none') this.pause();
      } catch (error) { this.lastError = (error as Error).message; this.pause(); }
      if (this.running) this.scheduler = setTimeout(tick, Math.max(120, 1600 / this.speed));
    };
    this.broadcast();
    void tick();
  }

  async stop(save: boolean): Promise<void> {
    this.pause();
    const child = this.child;
    if (!child) return;
    if (save) await this.command('save');
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    await this.command('quit');
    await exited;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop(true);
  }
}
