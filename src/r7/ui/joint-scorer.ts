import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeChoiceResult, validateChoiceRequest, type ChoiceRequest, type ChoiceResult,
  type CandidateScore } from '../../decision/contracts';
import { renderRequest } from '../jev/render';
import type { ScorePort, ScorerIdentity } from '../contracts';

export function parseScorerCommand(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0
    || parsed.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('scorer command must be a nonempty JSON string array');
  }
  return parsed as string[];
}

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** The same text and UTF-16 spans used by the actual Python joint encoder. */
export function encodingEnvelope(request: ChoiceRequest, root: string) {
  validateChoiceRequest(request);
  const rendered = renderRequest(request);
  const requestJson = JSON.stringify(request);
  return { schema: 'frostecho.joint-encoding-request/1', request, requestJson,
    inputSha256: sha(requestJson), rendered: { ...rendered, spanUnit: 'utf16-code-unit' },
    rendererSourceSha256: sha(readFileSync(join(root, 'src/r7/jev/render.ts'))),
    rendererBuildSha256: sha(readFileSync(join(root, 'dist/src/r7/jev/render.js'))),
    renderedTextSha256: sha(rendered.text), nodeVersion: process.version };
}

interface Pending {
  resolve: (reply: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams;
}

/** Persistent experimental real encoder. It never upgrades a reply to admitted. */
export class JointScorerClient implements ScorePort {
  identity: ScorerIdentity = { mode: 'jev-experimental', scorerId: 'jev-joint-c/1',
    rendererId: 'joint-c-action/1', experimental: true, countsAsAdmitted: false };
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private pinnedIdentity: string | null = null;
  constructor(readonly root: string, readonly command: string[], readonly timeoutMs = 300_000,
    readonly transcript?: string) {
    if (!command.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid scorer config');
    if (transcript) mkdirSync(dirname(transcript), { recursive: true });
  }
  private record(value: Record<string, unknown>): void {
    if (this.transcript) appendFileSync(this.transcript,
      JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', 'utf8');
  }
  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.command[0], this.command.slice(1), { cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const fail = (error: Error) => {
      for (const [id, row] of this.pending) {
        if (row.child !== child) continue;
        clearTimeout(row.timer); this.pending.delete(id); row.reject(error);
      }
    };
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const reply = JSON.parse(line) as Record<string, any>;
        this.record({ event: 'score_reply', reply });
        // Error responses from older serve versions may omit requestId. Never
        // assign a successful response to an unrelated outstanding request.
        const key = typeof reply.requestId === 'string' ? reply.requestId
          : reply.error && this.pending.size === 1 ? this.pending.keys().next().value : undefined;
        if (!key) return;
        const waiting = this.pending.get(key);
        if (!waiting) return;
        this.pending.delete(key); clearTimeout(waiting.timer); waiting.resolve(reply);
      } catch (error) { fail(new Error(`scorer protocol: ${(error as Error).message}`)); }
    });
    child.stderr.on('data', data => this.record({ event: 'scorer_stderr', text: String(data) }));
    child.on('error', error => { if (this.child === child) this.child = null; fail(error); });
    child.on('exit', code => {
      if (this.child === child) this.child = null;
      fail(new Error(`scorer process exited (${code})`));
    });
    return child;
  }
  async score(request: ChoiceRequest): Promise<ChoiceResult> {
    if (request.candidates.length === 1) return makeChoiceResult({ request,
      scorerId: 'single-candidate/1', scores: [{ candidateId: request.candidates[0].id, logit: 0 }],
      disposition: 'accept', selectedId: request.candidates[0].id, reason: 'deterministic sole candidate; no model call' });
    if (this.pending.has(request.requestId)) throw new Error('duplicate live requestId');
    const envelope = encodingEnvelope(request, this.root);
    const child = this.start();
    this.record({ event: 'score_request', envelope });
    const reply = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Never let a late reply from an abandoned process satisfy a later
        // request with the same world/actor identity.
        this.record({ event: 'score_timeout', requestId: request.requestId });
        if (this.child === child) this.child = null;
        for (const [id, row] of this.pending) {
          if (row.child !== child) continue;
          clearTimeout(row.timer); this.pending.delete(id); row.reject(new Error('joint scorer timeout'));
        }
        child.kill();
      }, this.timeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer, child });
      child.stdin.write(JSON.stringify(envelope) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(request.requestId); reject(error); }
      });
    });
    if (reply.error) throw new Error(String(reply.error));
    if (reply.requestId !== request.requestId || reply.candidateSetHash !== request.candidateSetHash
      || reply.inputSha256 !== envelope.inputSha256) throw new Error('scorer response does not bind the current request');
    const identity = reply.identity as ScorerIdentity | undefined;
    if (!identity || identity.mode !== 'jev-experimental' || identity.experimental !== true
      || identity.countsAsAdmitted !== false || identity.rendererId !== 'joint-c-action/1') {
      throw new Error('untrusted experimental scorer identity');
    }
    // The service attaches cumulative call counters to identity for audit. They
    // change after each call; encoder/head/renderer/policy identity must not.
    const counters = new Set(['requestsReceived', 'scoresSucceeded', 'requestsFailed',
      'encoderForwardCalls', 'encoderForwardAttempts']);
    const serializedIdentity = JSON.stringify(Object.entries(identity)
      .filter(([key]) => !counters.has(key)).sort(([a], [b]) => a.localeCompare(b)));
    if (this.pinnedIdentity !== null && this.pinnedIdentity !== serializedIdentity)
      throw new Error('scorer identity changed during this session');
    this.pinnedIdentity = serializedIdentity;
    this.identity = { ...identity };
    return makeChoiceResult({ request, scorerId: identity.scorerId,
      scores: reply.scores as CandidateScore[], selectedId: reply.selectedId ?? null,
      disposition: reply.disposition, reason: String(reply.reason ?? 'joint encoder score') });
  }
  close(): void {
    for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error('scorer closed')); }
    this.pending.clear();
    const child = this.child; this.child = null;
    if (child) { child.stdin.end(); child.kill(); }
  }
}
