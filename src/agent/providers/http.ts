import { RULES } from '../../types';
import { DecideInput, Provider, TransportRecord, UsageStats } from '../contracts';

export const HTTP_ENV = {
  url: 'FROSTECHO_LLM_URL',
  model: 'FROSTECHO_LLM_MODEL',
  apiKey: 'FROSTECHO_LLM_API_KEY',
} as const;

/** `true` / `false`. Unset or blank keeps the production default, which is thinking on. */
export const THINKING_ENV = 'FROSTECHO_LLM_THINKING';

/**
 * Sampling the live server was validated with.
 * enable_thinking may make the server also return a reasoning field.
 * That field is not an action; only message.content is parsed.
 */
export const HTTP_SAMPLING = {
  temperature: 0,
  max_tokens: 1024,
  stream: false,
  chat_template_kwargs: { enable_thinking: true },
} as const;

export interface HttpProviderConfig {
  /** Full chat-completions URL. The adapter does not append a path. */
  url: string;
  /** Model name the server expects. */
  model: string;
  /** Optional. Callers should take this from the environment, never from the prompt. */
  apiKey?: string;
  /**
   * chat_template_kwargs.enable_thinking. Default true, matching HTTP_SAMPLING.
   * false is the comparison arm; it does not change the production default.
   */
  enableThinking?: boolean;
  fetchImpl?: typeof fetch;
}

/** Missing or unrecognized values stay on the production default (thinking enabled). */
export function enableThinkingFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[THINKING_ENV]?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return HTTP_SAMPLING.chat_template_kwargs.enable_thinking;
}

export class ProviderTransportError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderTransportError';
    this.status = status;
  }
}

const MOVE_TARGETS = RULES.LOCATIONS.map(place => `"${place}"`).join('|');

/**
 * Public rules plus DecideInput. No world dump, other NPC, global log, or credential.
 * Numeric eat rules come from RULES, not from a second copy of the balance.
 */
export function renderDecidePrompt(input: DecideInput): string {
  return [
    'Reply with one JSON object and no other text.',
    `Allowed: {"type":"move","to":${MOVE_TARGETS}}, {"type":"eat"}, {"type":"stop"}.`,
    'Do not set actorId or commandId. World changes happen only through Engine.submit.',
    'hunger is satiety: higher means fuller.',
    `Eat only in the kitchen. Each eat consumes ${RULES.EAT_FOOD_COST} food and restores ${RULES.EAT_HUNGER_RESTORE} hunger, clamped to ${RULES.HUNGER_MIN}..${RULES.HUNGER_MAX}.`,
    'Observation includes only this actor, food at the current location, and reachable places. Distant food, other NPCs, and the global log are omitted.',
    `goal: hunger >= ${input.goal.hungerAtLeast}`,
    `observation: ${JSON.stringify(input.observation)}`,
    `feedback: ${JSON.stringify(input.feedback)}`,
  ].join('\n');
}

/** Missing URL or model → null. A blank API key is treated as omitted. */
export function loadHttpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpProviderConfig | null {
  const url = env[HTTP_ENV.url]?.trim();
  const model = env[HTTP_ENV.model]?.trim();
  if (!url || !model) return null;
  const apiKey = env[HTTP_ENV.apiKey]?.trim();
  return apiKey ? { url, model, apiKey } : { url, model };
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

const REASONING_PARTS = new Set(['reasoning', 'thinking', 'reasoning_text', 'redacted_reasoning']);

/** Text parts of message.content. Reasoning parts are dropped, never used as a fallback. */
function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const type = (part as { type?: unknown }).type;
    if (typeof type === 'string' && REASONING_PARTS.has(type)) return '';
    const textPart = (part as { text?: unknown }).text;
    return typeof textPart === 'string' ? textPart : '';
  }).join('');
  return text ? text : undefined;
}

/**
 * Action text is choices[0].message.content only.
 * reasoning, reasoning_content, and thinking are not actions, even when content is empty.
 */
function messageContent(body: unknown): string {
  if (!body || typeof body !== 'object') throw new ProviderTransportError('missing message content');
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new ProviderTransportError('missing message content');
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== 'object') throw new ProviderTransportError('missing message content');
  if (!Object.hasOwn(message, 'content')) throw new ProviderTransportError('missing message content');
  const text = textFromContent((message as { content?: unknown }).content);
  if (text === undefined) throw new ProviderTransportError('missing message content');
  return text;
}

function scrub(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    return secrets.reduce((out, secret) => (secret ? out.split(secret).join('[redacted]') : out), value);
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = scrub((value as Record<string, unknown>)[key], secrets);
    return out;
  }
  return value;
}

function readUsage(body: unknown): UsageStats | null {
  if (!body || typeof body !== 'object') return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const num = (key: string): number | null => (
    typeof record[key] === 'number' && Number.isFinite(record[key] as number) ? record[key] as number : null
  );
  const stats: UsageStats = {
    prompt_tokens: num('prompt_tokens'),
    completion_tokens: num('completion_tokens'),
    total_tokens: num('total_tokens'),
  };
  if (stats.prompt_tokens === null && stats.completion_tokens === null && stats.total_tokens === null) return null;
  return stats;
}

function chatRequestBody(config: HttpProviderConfig, input: DecideInput, enableThinking: boolean): Record<string, unknown> {
  return {
    model: config.model,
    temperature: HTTP_SAMPLING.temperature,
    max_tokens: HTTP_SAMPLING.max_tokens,
    stream: HTTP_SAMPLING.stream,
    chat_template_kwargs: { enable_thinking: enableThinking },
    messages: [{ role: 'user', content: renderDecidePrompt(input) }],
  };
}

export function createHttpProvider(config: HttpProviderConfig): Provider {
  const fetchImpl = config.fetchImpl ?? fetch;
  const secret = config.apiKey;
  const enableThinking = config.enableThinking ?? true;
  const secrets = [secret ?? '', config.url].filter(value => value.length > 0);
  let slot: TransportRecord | null = null;
  return {
    async decide(input, signal) {
      if (signal.aborted) throw abortError();
      const started = Date.now();
      const body = chatRequestBody(config, input, enableThinking);
      const record: TransportRecord = {
        requestBody: scrub(body, secrets) as Record<string, unknown>,
        responseContent: null,
        status: null,
        usage: null,
        latencyMs: 0,
        error: null,
      };
      slot = record;
      const touch = () => { record.latencyMs = Math.max(0, Date.now() - started); };
      const markTimeout = () => {
        if (!record.error) record.error = 'timeout';
        touch();
      };
      signal.addEventListener('abort', markTimeout, { once: true });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret) headers.authorization = `Bearer ${secret}`;
      try {
        let res: Response;
        try {
          res = await fetchImpl(config.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            markTimeout();
            throw abortError();
          }
          record.error = 'network error';
          throw new ProviderTransportError('network error');
        }
        // Abort wins over a body that arrives later. That body is not the action.
        if (signal.aborted) {
          markTimeout();
          throw abortError();
        }
        record.status = res.status;
        let rawText = '';
        try {
          rawText = await res.text();
        } catch {
          rawText = '';
        }
        if (signal.aborted) {
          markTimeout();
          throw abortError();
        }
        let parsed: unknown;
        if (!res.ok) {
          let content: unknown = rawText;
          if (rawText) {
            try { content = JSON.parse(rawText); } catch { content = rawText; }
          } else content = null;
          record.responseContent = scrub(content, secrets);
          record.usage = readUsage(content);
          record.error = `http ${res.status}`;
          throw new ProviderTransportError(`http ${res.status}`, res.status);
        }
        try {
          parsed = rawText ? JSON.parse(rawText) : null;
        } catch {
          record.responseContent = scrub(rawText, secrets);
          record.error = 'invalid response json';
          throw new ProviderTransportError('invalid response json');
        }
        record.responseContent = scrub(parsed, secrets);
        record.usage = readUsage(parsed);
        try {
          return messageContent(parsed);
        } catch (err) {
          record.error = err instanceof Error ? err.message : 'missing message content';
          throw err;
        }
      } finally {
        touch();
        signal.removeEventListener('abort', markTimeout);
      }
    },
    consumeTransport() {
      const current = slot;
      slot = null;
      return current;
    },
  };
}
