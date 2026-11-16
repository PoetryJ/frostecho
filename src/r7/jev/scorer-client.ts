/**
 * M bridge: a persistent local JSONL scorer service behind the frozen
 * ChoiceRequest/ChoiceResult contract.
 *
 * The game never talks to a model directly. It writes one request line, waits
 * for one result line, and validates that the reply answers *this* request
 * (same requestId, same candidateSetHash, only ids from the request). A reply
 * that fails validation commits nothing.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  makeChoiceResult, validateChoiceRequest, ContractError,
  type ChoiceRequest, type ChoiceResult, type CandidateScore,
} from '../../decision/contracts';
import {
  assertScorerIdentity, type ScorePort, type ScorerIdentity,
} from '../contracts';

export interface ScorerServiceOptions {
  /** e.g. ['python', 'research/decision-choice/jev05/action/train.py', 'serve', '--model', '...'] */
  command: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ScorerServiceReply {
  requestId: string;
  candidateSetHash: string;
  scores: CandidateScore[];
  identity: ScorerIdentity;
  latencyMs: number;
  selectedId?: string | null;
  disposition?: 'accept' | 'abstain' | 'unavailable';
  reason?: string;
}

export class ScorerServiceClient implements ScorePort {
  identity: ScorerIdentity;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Pending | null = null;
  private readonly timeoutMs: number;
  private readonly lines: string[] = [];
  readonly transactions: { requestId: string; latencyMs: number; ok: boolean;
    reason?: string }[] = [];

  constructor(readonly options: ScorerServiceOptions, identity: ScorerIdentity) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.identity = identity;
    assertScorerIdentity(identity, {});
  }

  get id(): string {
    return this.identity.scorerId;
  }

  get mode(): string {
    return this.identity.mode;
  }

  start(): void {
    if (this.child) return;
    const [program, ...args] = this.options.command;
    this.child = spawn(program, args, {
      cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.options.env ?? {}) },
    });
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', line => {
      this.lines.push(line);
      const pending = this.pending;
      if (!pending) return;
      this.pending = null;
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        pending.reject(new Error(`scorer reply is not JSON: ${(error as Error).message}`));
      }
    });
    this.child.stderr.on('data', chunk => {
      this.lines.push(`stderr:${String(chunk).trimEnd()}`);
    });
    this.child.on('exit', code => {
      const pending = this.pending;
      this.pending = null;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`scorer exited with code ${code}`));
      }
      this.child = null;
    });
  }

  async score(request: ChoiceRequest): Promise<ChoiceResult> {
    this.start();
    const child = this.child;
    if (!child) throw new ContractError('scorer_unavailable', 'scorer service is not running');
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`scorer timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending = { resolve, reject, timer };
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
    const parsed = this.parse(reply);
    this.transactions.push({ requestId: request.requestId,
      latencyMs: Number(parsed.latencyMs ?? 0), ok: true });
    return this.toResult(request, parsed);
  }

  private parse(raw: Record<string, unknown>): ScorerServiceReply {
    if (raw.error) {
      throw new ContractError('scorer_error', String(raw.error));
    }
    const identity = raw.identity as ScorerIdentity | undefined;
    if (!identity) throw new ContractError('scorer_identity', 'reply has no identity');
    assertScorerIdentity(identity, {});
    if (typeof raw.requestId !== 'string' || typeof raw.candidateSetHash !== 'string') {
      throw new ContractError('scorer_reply', 'reply must echo requestId and candidateSetHash');
    }
    if (!Array.isArray(raw.scores)) {
      throw new ContractError('scorer_reply', 'reply.scores must be an array');
    }
    return {
      requestId: raw.requestId,
      candidateSetHash: raw.candidateSetHash,
      scores: raw.scores as CandidateScore[],
      identity,
      latencyMs: Number(raw.latencyMs ?? 0),
      selectedId: (raw.selectedId as string | null | undefined) ?? null,
      disposition: (raw.disposition as ScorerServiceReply['disposition']) ?? undefined,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    };
  }

  private toResult(request: ChoiceRequest, reply: ScorerServiceReply): ChoiceResult {
    if (reply.requestId !== request.requestId) {
      throw new ContractError('scorer_request_mismatch',
        `reply ${reply.requestId} != request ${request.requestId}`);
    }
    if (reply.candidateSetHash !== request.candidateSetHash) {
      throw new ContractError('scorer_set_mismatch',
        'reply was scored against a different candidate set');
    }
    const disposition = reply.disposition ?? 'abstain';
    const selectedId = disposition === 'accept'
      ? (reply.selectedId ?? highest(reply.scores)?.candidateId ?? null)
      : null;
    return makeChoiceResult({
      request,
      scorerId: reply.identity.scorerId,
      scores: reply.scores,
      selectedId,
      disposition,
      reason: reply.reason ?? 'scorer-service',
      ...(reply.identity.calibrationId ? { calibrationId: reply.identity.calibrationId } : {}),
    });
  }

  close(): void {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    this.child = null;
  }

  /** Raw stdout/stderr lines, kept for evidence. */
  transcript(): string[] {
    return [...this.lines];
  }
}

export function highest(scores: readonly CandidateScore[]): CandidateScore | null {
  let best: CandidateScore | null = null;
  for (const score of scores) {
    if (!best || score.logit > best.logit) best = score;
  }
  return best;
}

/** Validates a request coming from another process before it is scored. */
export function checkedRequest(value: unknown): ChoiceRequest {
  return validateChoiceRequest(value);
}
