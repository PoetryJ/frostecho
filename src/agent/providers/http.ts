import { DecideInput, Provider } from '../contracts';

export const HTTP_ENV = {
  url: 'FROSTECHO_LLM_URL',
  model: 'FROSTECHO_LLM_MODEL',
  apiKey: 'FROSTECHO_LLM_API_KEY',
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

/** Prompt is built only from DecideInput. No world dump, log, or credential. */
export function renderDecidePrompt(input: DecideInput): string {
  return [
    'Reply with one JSON object and no other text.',
    'Allowed: {"type":"move","to":"<place>"} using a reachable place, {"type":"eat"}, {"type":"stop"}.',
    'hunger is satiety: higher means fuller.',
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

function messageContent(body: unknown): string {
  if (!body || typeof body !== 'object') throw new ProviderTransportError('missing message content');
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new ProviderTransportError('missing message content');
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== 'object') throw new ProviderTransportError('missing message content');
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    }).join('');
    if (text) return text;
  }
  throw new ProviderTransportError('missing message content');
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
            temperature: 0,
            stream: false,
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
