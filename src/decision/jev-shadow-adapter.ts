/**
 * R3 (M): trusted policy gate for the jev choice head, on the TS side.
 *
 * A real model artifact and its request BOTH self-report an identity
 * (model/head/adapter/tokenizer/renderer/task/K/policy/memoryPolicy).
 * Self-report agreement proves nothing, so the adapter resolves identity
 * against a trusted manifest that the operator registered out of band
 * (file or object). Behaviour:
 *
 *  - identity not registered            -> unavailable (fail closed);
 *  - task/K/memoryPolicy drift          -> unavailable;
 *  - NaN/Inf logits, non-finite probs   -> unavailable;
 *  - a policy claiming real executable
 *    acceptance without sealed calT/
 *    select/cert evidence               -> shadow-only, reason recorded;
 *  - every successful path returns a
 *    shadow result (selectedId null)    -> world execution stays 0.
 *
 * The logits source is explicit: either a `predict` function wired to the
 * real model process, or `recorded-logits` replay (labelled as fake encoder
 * wiring; never a real-model claim). Without a real model attached, the
 * adapter reports `no_real_model_attached`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import type { ChoiceRequest, ChoiceResult } from './contracts';
import type { ScorerPort } from '../planning/candidates';
import { makeChoiceResult } from './contracts';

export interface JevRegistration {
  model: string;
  head: string;
  adapter: string;
  tokenizer: string;
  renderer: string;
  task: string;
  K: number;
  policy: string;
  memoryPolicy: string;
  weightsSha256?: string;
  evidence?: {
    calT?: { path: string; sha256: string };
    select?: { path: string; sha256: string };
    cert?: { path: string; sha256: string };
    protocolVersion?: string;
    sealed?: boolean;
  };
}

export interface JevPolicyManifest {
  schema: 'frostecho.jev04.policy-manifest/1';
  registrations: JevRegistration[];
}

export interface ArtifactIdentity {
  kind: 'real-model' | 'fixture' | 'recorded-logits';
  model: string;
  head: string;
  adapter: string;
  tokenizer: string;
  renderer: string;
  weightsSha256?: string;
}

export interface JevPredictFn {
  (request: ChoiceRequest): Promise<Array<{ candidateId: string; logit: number;
    probability?: number }>> | Array<{ candidateId: string; logit: number;
    probability?: number }>;
}

export interface JevShadowOptions {
  id?: string;
  manifest: JevPolicyManifest | string;
  identity: ArtifactIdentity;
  predict?: JevPredictFn;
  logitsFile?: string;
}

function unavailable(request: ChoiceRequest, scorerId: string, reason: string): ChoiceResult {
  return makeChoiceResult({ request, scorerId, scores: [], selectedId: null,
    disposition: 'unavailable', reason });
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const RISK_PROTOCOL_VERSION = 'jev04-risk/1';
const POLICY_FIELDS = ['model', 'head', 'tokenizer', 'renderer', 'task'] as const;

/**
 * R5: sealed means three DISTINCT, non-empty, valid partitions bound to the
 * same policy identity and the exact risk protocol. A reused `{}` file, a
 * duplicate partition, or an identity/risk mismatch leaves the policy shadow
 * only.
 */
function evidenceSealed(registration: JevRegistration): boolean {
  const evidence = registration.evidence;
  if (!evidence || evidence.sealed !== true) return false;
  if (evidence.protocolVersion !== RISK_PROTOCOL_VERSION) return false;
  const paths: string[] = [];
  const partitions: string[] = [];
  const sampleSets: Set<string>[] = [];
  for (const key of ['calT', 'select', 'cert'] as const) {
    const ref = evidence[key];
    if (!ref || !existsSync(ref.path)) return false;
    if (sha256File(ref.path) !== ref.sha256) return false;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(readFileSync(ref.path, 'utf8')) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
      return false;
    }
    if (payload.partition !== key) return false;
    if (payload.protocol_version !== RISK_PROTOCOL_VERSION) return false;
    if (payload.valid !== true) return false;
    const samples = payload.sampleIds;
    if (!Array.isArray(samples) || samples.length === 0
      || samples.some(value => typeof value !== 'string' || value.length === 0)) {
      return false;
    }
    sampleSets.push(new Set(samples as string[]));
    const policy = payload.policy as Record<string, unknown> | undefined;
    if (!policy) return false;
    if (POLICY_FIELDS.some(field => policy[field] !== registration[field])) return false;
    if (policy.k !== registration.K) return false;
    if (policy.memory_policy_version !== registration.memoryPolicy) return false;
    if (key === 'cert') {
      const upper = Number(payload.upper);
      const n = Number(payload.n);
      if (!Number.isFinite(upper) || upper > 0.05 || !Number.isFinite(n) || n <= 0) {
        return false;
      }
    }
    if (key === 'calT') {
      const temperature = Number(payload.temperature);
      const tau = Number(payload.tau);
      if (!Number.isFinite(temperature) || temperature <= 0
        || !Number.isFinite(tau) || tau < 0 || tau > 1) return false;
    }
    if (key === 'select') {
      const tau = Number(payload.tau);
      const accepted = Number(payload.accepted);
      if (!Number.isFinite(tau) || tau < 0 || tau > 1
        || !Number.isFinite(accepted) || accepted < 100) return false;
    }
    paths.push(resolvePath(ref.path));
    partitions.push(String(payload.partition));
  }
  if (new Set(paths).size !== 3 || new Set(partitions).size !== 3) return false;
  const [calT, select, cert] = sampleSets;
  for (const value of calT) {
    if (select.has(value) || cert.has(value)) return false;
  }
  for (const value of select) {
    if (cert.has(value)) return false;
  }
  return true;
}

export function loadJevPolicyManifest(source: JevPolicyManifest | string): JevPolicyManifest {
  const manifest = typeof source === 'string'
    ? JSON.parse(readFileSync(source, 'utf8')) as JevPolicyManifest
    : source;
  if (manifest.schema !== 'frostecho.jev04.policy-manifest/1') {
    throw new Error(`jev-shadow: unsupported manifest schema ${manifest.schema}`);
  }
  return manifest;
}

/** Resolves a registration for the artifact identity, or null. */
export function matchRegistration(manifest: JevPolicyManifest, identity: ArtifactIdentity,
  request: ChoiceRequest): { registration: JevRegistration; problems: string[] } | null {
  const problems: string[] = [];
  for (const registration of manifest.registrations) {
    if (registration.model !== identity.model) continue;
    if (registration.head !== identity.head) continue;
    if (registration.adapter !== identity.adapter) continue;
    if (registration.tokenizer !== identity.tokenizer) continue;
    if (registration.renderer !== identity.renderer) continue;
    problems.length = 0;
    if (registration.task !== request.task) {
      problems.push(`task drift: manifest=${registration.task} request=${request.task}`);
    }
    if (registration.K !== request.candidates.length) {
      problems.push(`K drift: manifest=${registration.K} request=${request.candidates.length}`);
    }
    if (registration.memoryPolicy !== (request.memoryPolicyVersion ?? '')) {
      problems.push(`memoryPolicy drift: manifest=${registration.memoryPolicy} `
        + `request=${request.memoryPolicyVersion ?? ''}`);
    }
    if (registration.weightsSha256 && identity.weightsSha256
      && registration.weightsSha256 !== identity.weightsSha256) {
      problems.push('weights identity drift');
    }
    return { registration, problems };
  }
  return null;
}

export function createJevShadowAdapter(options: JevShadowOptions): ScorerPort {
  const manifest = loadJevPolicyManifest(options.manifest);
  const scorerId = options.id ?? `jev-shadow:${options.identity.model}`;
  let recorded: Array<{ candidateId: string; logit: number; probability?: number }> | null = null;
  if (options.logitsFile) {
    const parsed = JSON.parse(readFileSync(options.logitsFile, 'utf8')) as {
      note?: string; logits: Array<{ candidateId: string; logit: number; probability?: number }>;
    };
    if (parsed.note !== 'recorded logits; fake encoder wiring; no real model') {
      throw new Error('jev-shadow: logits file must label itself as recorded fake wiring');
    }
    recorded = parsed.logits;
  }

  return {
    id: scorerId,
    mode: 'jev',
    async score(request) {
      const matched = matchRegistration(manifest, options.identity, request);
      if (!matched) {
        return unavailable(request, scorerId,
          `policy_not_registered: no manifest entry for `
          + `${options.identity.model}/${options.identity.head}/${options.identity.renderer}`);
      }
      const { registration, problems } = matched;
      if (options.identity.kind === 'fixture') {
        return unavailable(request, scorerId,
          'fixture_artifact_may_not_pose_as_real: fixture identity is refused on the '
          + 'model line');
      }
      if (problems.length > 0) {
        return unavailable(request, scorerId, `identity_drift: ${problems.join('; ')}`);
      }
      const logits = await (async () => {
        if (options.predict) return await options.predict(request);
        if (recorded) return recorded;
        return null;
      })();
      if (!logits) {
        return unavailable(request, scorerId,
          'no_real_model_attached: recorded logits only, fake encoder wiring');
      }
      const known = new Set(request.candidates.map(candidate => candidate.id));
      for (const entry of logits) {
        if (!known.has(entry.candidateId)) {
          return unavailable(request, scorerId,
            `unbound_candidate: ${entry.candidateId}`);
        }
        if (!Number.isFinite(entry.logit)) {
          return unavailable(request, scorerId,
            `nonfinite_logit: ${entry.candidateId}`);
        }
        if (entry.probability !== undefined && !Number.isFinite(entry.probability)) {
          return unavailable(request, scorerId,
            `nonfinite_probability: ${entry.candidateId}`);
        }
      }
      const ranked = [...logits].sort((left, right) =>
        (right.probability ?? 0) - (left.probability ?? 0));
      const shadowReason = options.predict
        ? (evidenceSealed(registration)
          ? `shadow_only: real policy evidence sealed; would pick ${ranked[0]?.candidateId ?? 'n/a'}`
          : `shadow_only_no_sealed_evidence: real policy cannot execute; would pick `
            + `${ranked[0]?.candidateId ?? 'n/a'}`)
        : `shadow_only_recorded_logits: would pick ${ranked[0]?.candidateId ?? 'n/a'} `
          + '(fake encoder wiring, no real model)';
      return makeChoiceResult({ request, scorerId,
        scores: logits.map(score => ({ candidateId: score.candidateId, logit: score.logit })),
        selectedId: null, disposition: 'abstain', reason: shadowReason });
    },
  };
}
