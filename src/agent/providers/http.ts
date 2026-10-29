import { RULES } from '../../types';
import { DecideInput, Provider } from '../contracts';

export const HTTP_ENV = {
  url: 'FROSTECHO_LLM_URL',
  model: 'FROSTECHO_LLM_MODEL',
  apiKey: 'FROSTECHO_LLM_API_KEY',
} as const;

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
  fetchImpl?: typeof fetch;
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

export function createHttpProvider(config: HttpProviderConfig): Provider {
  const fetchImpl = config.fetchImpl ?? fetch;
  const secret = config.apiKey;
  return {
    async decide(input, signal) {
      if (signal.aborted) throw abortError();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret) headers.authorization = `Bearer ${secret}`;
      let res: Response;
      try {
        res = await fetchImpl(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            temperature: HTTP_SAMPLING.temperature,
            max_tokens: HTTP_SAMPLING.max_tokens,
            stream: HTTP_SAMPLING.stream,
            chat_template_kwargs: HTTP_SAMPLING.chat_template_kwargs,
            messages: [{ role: 'user', content: renderDecidePrompt(input) }],
          }),
          signal,
        });
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw abortError();
        throw new ProviderTransportError('network error');
      }
      if (signal.aborted) throw abortError();
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderTransportError(`http ${res.status}`, res.status);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        if (signal.aborted) throw abortError();
        throw new ProviderTransportError('invalid response json');
      }
      if (signal.aborted) throw abortError();
      return messageContent(parsed);
    },
  };
}
