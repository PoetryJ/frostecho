/**
 * Workstream A — health and transport.
 * Interface (locked): checkLlmHealth(config, deps) -> HealthResult; classifyTransport(error) -> TransportKind | null.
 * No implicit retries. Fetch is injectable so fixtures never touch the network.
 */

export type TransportKind =
  | 'connect'        // DNS / refused / reset before any HTTP status
  | 'timeout'        // decision or health deadline hit
  | 'http_4xx'
  | 'http_5xx'
  | 'invalid_json'
  | 'missing_content'
  | 'budget';        // local call-cap intercept, never reached the network

/** Every kind except budget is an infrastructure interrupt that ends the batch. */
export function isInfrastructure(kind: TransportKind | null): boolean {
  return kind !== null && kind !== 'budget';
}

export function classifyTransport(error: string | null | undefined): TransportKind | null {
  if (!error) return null;
  if (error === 'provider call cap') return 'budget';
  if (error === 'timeout' || error === 'aborted') return 'timeout';
  if (error.startsWith('network error')) return 'connect';
  const http = /^http (\d{3})$/.exec(error);
  if (http) return Number(http[1]) >= 500 ? 'http_5xx' : 'http_4xx';
  if (error === 'invalid response json') return 'invalid_json';
  if (error === 'missing message content') return 'missing_content';
  return null;
}

export interface HealthConfig {
  /** Full chat-completions URL; the models URL is derived from it. */
  url: string;
  model: string;
  apiKey?: string;
}

export interface HealthResult {
  ok: boolean;
  checkedAt: string;
  modelsUrlPath: string;
  status: number | null;
  /** Model ids the server reported. */
  models: string[];
  expectedModel: string;
  modelMatch: boolean;
  kind: TransportKind | 'model_mismatch' | 'bad_models_body' | null;
  error: string | null;
  latencyMs: number;
}

export interface HealthDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export type HealthCheck = (config: HealthConfig, deps?: HealthDeps) => Promise<HealthResult>;

export const HEALTH_TIMEOUT_MS = 5000;

export function modelsUrl(chatUrl: string): string {
  const u = new URL(chatUrl);
  u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') + '/models';
  return u.toString();
}

/** One GET to /models. Confirms the service answers and serves the expected model. Never retried. */
export const checkLlmHealth: HealthCheck = async (config, deps = {}) => {
  const started = Date.now();
  const result = await probe(config, deps);
  return { ...result, latencyMs: Math.max(0, Date.now() - started) };
};

async function probe(config: HealthConfig, deps: HealthDeps): Promise<HealthResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const target = modelsUrl(config.url);
  const base: HealthResult = {
    ok: false,
    checkedAt: new Date(now()).toISOString(),
    modelsUrlPath: new URL(target).pathname,
    status: null,
    models: [],
    expectedModel: config.model,
    modelMatch: false,
    kind: null,
    error: null,
    latencyMs: 0,
  };
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? HEALTH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(target, { method: 'GET', headers, signal: controller.signal });
    } catch (err) {
      const aborted = controller.signal.aborted;
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      return { ...base, kind: aborted ? 'timeout' : 'connect', error: aborted ? 'timeout' : `network error${code ? `: ${code}` : ''}` };
    }
    base.status = res.status;
    if (!res.ok) {
      return { ...base, kind: res.status >= 500 ? 'http_5xx' : 'http_4xx', error: `http ${res.status}` };
    }
    let body: unknown;
    try { body = JSON.parse(await res.text()); } catch {
      return { ...base, kind: 'invalid_json', error: 'invalid models json' };
    }
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) return { ...base, kind: 'bad_models_body', error: 'models body has no data[]' };
    const models = data.map(item => (item as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
    const modelMatch = models.includes(config.model);
    return {
      ...base,
      models,
      modelMatch,
      ok: modelMatch,
      kind: modelMatch ? null : 'model_mismatch',
      error: modelMatch ? null : `model ${config.model} not served (got ${models.join(',') || 'none'})`,
    };
  } finally {
    clearTimeout(timer);
  }
}
