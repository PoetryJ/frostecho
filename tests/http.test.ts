import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Engine, initialWorld, RULES } from '../src';
import {
  DecideInput, HTTP_SAMPLING, ProviderTransportError, createHttpProvider, enableThinkingFromEnv, loadHttpConfigFromEnv,
  renderDecidePrompt, runAgent,
} from '../src/agent';
import { countingWorld, delay, writeTrace } from './agent-helpers';

function sample(): DecideInput {
  return {
    observation: { id: 'npc_a', location: 'dorm', hunger: 40, foodHere: 0, reachable: ['dorm', 'kitchen'] },
    goal: { hungerAtLeast: 70 },
    feedback: null,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('env config requires a full URL and model; the key is optional', () => {
  assert.equal(loadHttpConfigFromEnv({}), null);
  assert.equal(loadHttpConfigFromEnv({ FROSTECHO_LLM_MODEL: 'm' }), null);
  assert.equal(loadHttpConfigFromEnv({ FROSTECHO_LLM_URL: 'http://example.test/v1/chat/completions' }), null);
  assert.deepEqual(
    loadHttpConfigFromEnv({ FROSTECHO_LLM_URL: ' http://example.test/v1/chat/completions ', FROSTECHO_LLM_MODEL: ' demo-model ' }),
    { url: 'http://example.test/v1/chat/completions', model: 'demo-model' },
  );
  const withKey = loadHttpConfigFromEnv({
    FROSTECHO_LLM_URL: 'http://example.test/v1/chat/completions',
    FROSTECHO_LLM_MODEL: 'demo-model',
    FROSTECHO_LLM_API_KEY: ' sekret ',
  });
  assert.equal(withKey?.apiKey, 'sekret');
});

test('prompt is only the decide input', () => {
  const prompt = renderDecidePrompt(sample());
  assert.equal(prompt.includes('npc_b'), false);
  assert.equal(prompt.includes('sekret-xyz'), false);
  assert.match(prompt, /hunger >= 70/);
  assert.match(prompt, /"foodHere":0/);
  assert.match(prompt, /"id":"npc_a"/);
});

test('prompt states public eat rules and forbids actorId', () => {
  const prompt = renderDecidePrompt(sample());
  assert.match(prompt, /hunger is satiety/);
  assert.match(prompt, /Eat only in the kitchen/);
  assert.match(prompt, new RegExp(`consumes ${RULES.EAT_FOOD_COST} food`));
  assert.match(prompt, new RegExp(`restores ${RULES.EAT_HUNGER_RESTORE} hunger`));
  assert.match(prompt, new RegExp(`clamped to ${RULES.HUNGER_MIN}\\.\\.${RULES.HUNGER_MAX}`));
  assert.match(prompt, /Do not set actorId/);
  assert.match(prompt, /Engine\.submit/);
  assert.match(prompt, /Distant food, other NPCs, and the global log are omitted/);
  assert.match(prompt, /already in the kitchen, foodHere is 0, and hunger is below the goal/);
  assert.match(prompt, /reply \{"type":"stop"\}/);
  assert.match(prompt, /Do not move around looking for distant food/);
  assert.match(prompt, /distant food is not observable/);
  assert.equal(prompt.includes('npc_b'), false);
  assert.equal(prompt.includes('sekret-xyz'), false);
});

test('HTTP adapter posts chat completions to the full URL and reads message content', async () => {
  let seenUrl = '';
  let seenAuth: string | undefined;
  let body: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    seenUrl = String(url);
    const headers = new Headers(init?.headers);
    seenAuth = headers.get('authorization') ?? undefined;
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"stop"}' } }] }), { status: 200 });
  };
  const key = 'sekret-xyz';
  const provider = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    apiKey: key,
    fetchImpl,
  });
  const raw = await provider.decide(sample(), new AbortController().signal);
  assert.equal(raw, '{"type":"stop"}');
  assert.equal(seenUrl, 'http://example.test/v1/chat/completions');
  assert.equal(seenAuth, `Bearer ${key}`);
  assert.equal(body.model, 'server-model');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.stream, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  assert.deepEqual(body.chat_template_kwargs, HTTP_SAMPLING.chat_template_kwargs);
  assert.equal(body.temperature, HTTP_SAMPLING.temperature);
  assert.equal(body.max_tokens, HTTP_SAMPLING.max_tokens);
  assert.equal(body.stream, HTTP_SAMPLING.stream);
  const messages = body.messages as { role: string; content: string }[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content.includes('npc_b'), false);
  assert.equal(messages[0].content.includes(key), false);

  const noKey: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), null);
    return new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: 'text', text: '{"type":"eat"}' }] } }],
    }), { status: 200 });
  };
  const open = createHttpProvider({ url: 'http://example.test/v1/chat/completions', model: 'server-model', fetchImpl: noKey });
  assert.equal(await open.decide(sample(), new AbortController().signal), '{"type":"eat"}');
});

test('HTTP errors do not include the response body or the API key', async () => {
  const key = 'sekret-xyz';
  const provider = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    apiKey: key,
    fetchImpl: async () => new Response(`boom ${key}`, { status: 502 }),
  });
  await assert.rejects(() => provider.decide(sample(), new AbortController().signal), (err: Error) => {
    assert.equal(err.name, 'ProviderTransportError');
    assert.equal(err.message, 'http 502');
    assert.equal(err.message.includes(key), false);
    assert.ok(err instanceof ProviderTransportError);
    return true;
  });

  const broken = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    apiKey: key,
    fetchImpl: async () => { throw new Error(`connect ${key}`); },
  });
  await assert.rejects(() => broken.decide(sample(), new AbortController().signal), (err: Error) => {
    assert.equal(err.name, 'ProviderTransportError');
    assert.match(err.message, /^network error: connect \[redacted\]$/);
    assert.equal(err.message.includes(key), false);
    const recorded = broken.consumeTransport?.();
    assert.equal(recorded?.status, null);
    assert.equal(recorded?.responseContent, null);
    assert.equal(recorded?.error, err.message);
    assert.equal(JSON.stringify(recorded).includes(key), false);
    return true;
  });

  const refused = new Error('fetch failed');
  (refused as { cause?: unknown }).cause = Object.assign(new Error(`connect ECONNREFUSED ${key}`), { code: 'ECONNREFUSED' });
  const coded = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    apiKey: key,
    fetchImpl: async () => { throw refused; },
  });
  await assert.rejects(() => coded.decide(sample(), new AbortController().signal), (err: Error) => {
    assert.equal(err.name, 'ProviderTransportError');
    assert.match(err.message, /^network error: ECONNREFUSED: connect ECONNREFUSED \[redacted\]/);
    assert.equal(err.message.includes(key), false);
    assert.equal(coded.consumeTransport?.()?.error, err.message);
    return true;
  });
});

test('adapter drops a body that arrives after abort', async () => {
  const fetchImpl: typeof fetch = (_url, init) => new Promise(resolve => {
    init?.signal?.addEventListener('abort', () => {
      setTimeout(() => {
        resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"eat"}' } }] }), { status: 200 }));
      }, 30);
    });
  });
  const provider = createHttpProvider({ url: 'http://example.test/v1/chat/completions', model: 'm', fetchImpl });
  const ac = new AbortController();
  const pending = provider.decide(sample(), ac.signal).then(
    value => ({ ok: true as const, value }),
    (err: Error) => ({ ok: false as const, name: err.name }),
  );
  setTimeout(() => ac.abort(), 10);
  const out = await pending;
  await delay(50);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.name, 'AbortError');
});

test('fake chat completions server: move then eat, and a transport error submits nothing', async () => {
  const replies = ['{"type":"move","to":"kitchen"}', '{"type":"eat"}'];
  const bodies: string[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      bodies.push(raw);
      const parsed = JSON.parse(raw) as {
        model?: string;
        temperature?: number;
        max_tokens?: number;
        stream?: boolean;
        chat_template_kwargs?: { enable_thinking?: boolean };
        messages?: { content?: string }[];
      };
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer test-key');
      assert.equal(parsed.model, 'server-model');
      assert.equal(parsed.temperature, 0);
      assert.equal(parsed.max_tokens, 1024);
      assert.equal(parsed.stream, false);
      assert.deepEqual(parsed.chat_template_kwargs, { enable_thinking: true });
      const content = parsed.messages?.[0]?.content ?? '';
      assert.equal(content.includes('npc_b'), false);
      assert.equal(content.includes('test-key'), false);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: replies[n++] } }] }));
    });
  });
  const port = await listen(server);
  try {
    const provider = createHttpProvider({
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: 'server-model',
      apiKey: 'test-key',
    });
    const eng = new Engine(initialWorld());
    const result = await runAgent({ world: countingWorld(eng), provider, actorId: 'npc_a', runId: 'http-ok', timeoutMs: 2000, now: () => 0 });
    assert.equal(result.outcome, 'goal_reached');
    assert.equal(result.goalReached, true);
    assert.equal(result.finalState.food.kitchen, 0);
    assert.equal(result.finalState.npcs.npc_a.hunger, 70);
    assert.equal(bodies.length, 2);
    assert.equal(JSON.stringify(result).includes('test-key'), false);
    writeTrace('http-fake-server', result);
  } finally {
    await close(server);
  }

  const failing = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    apiKey: 'sekret-xyz',
    fetchImpl: async () => new Response('sekret-xyz', { status: 500 }),
  });
  const eng = new Engine(initialWorld());
  const before = eng.getState();
  const counted = countingWorld(eng);
  const failed = await runAgent({
    world: counted,
    provider: failing,
    actorId: 'npc_a',
    runId: 'http-500',
    now: () => 0,
  });
  assert.equal(failed.outcome, 'provider_error');
  assert.equal(failed.goalReached, false);
  assert.equal(failed.error, 'http 500');
  assert.equal(failed.providerCalls, 1);
  assert.equal(counted.submits(), 0);
  assert.deepEqual(eng.getState(), before);
  assert.equal(JSON.stringify(deterministicSafe(failed)).includes('sekret-xyz'), false);
  writeTrace('http-error', failed);
});

function deterministicSafe(result: { error?: string; steps: { raw: string; error?: string }[] }): string {
  return JSON.stringify({ error: result.error, steps: result.steps.map(step => ({ raw: step.raw, error: step.error })) });
}

test('HTTP timeout aborts the request and submits nothing', async () => {
  let aborted = false;
  const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const eng = new Engine(initialWorld());
  const counted = countingWorld(eng);
  const result = await runAgent({
    world: counted,
    actorId: 'npc_a',
    runId: 'http-timeout',
    timeoutMs: 30,
    now: () => 0,
    provider: createHttpProvider({
      url: 'http://127.0.0.1/v1/chat/completions',
      model: 'server-model',
      apiKey: 'sekret-xyz',
      fetchImpl,
    }),
  });
  assert.equal(aborted, true);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.goalReached, false);
  assert.equal(result.error, 'timeout');
  assert.equal(counted.submits(), 0);
  assert.equal(eng.getEvents().length, 0);
  assert.equal(JSON.stringify(result).includes('sekret-xyz'), false);
  writeTrace('http-timeout', result);
});

test('reasoning fields are not actions; only message content is returned', async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    apiKey: 'sekret-xyz',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '{"type":"stop"}',
            reasoning_content: '{"type":"move","to":"kitchen"}',
            reasoning: '{"type":"eat"}',
            thinking: '{"type":"eat"}',
          },
        }],
      }), { status: 200 });
    },
  });
  const eng = new Engine(initialWorld());
  const counted = countingWorld(eng);
  const result = await runAgent({
    world: counted,
    provider,
    actorId: 'npc_a',
    runId: 'ignore-reasoning',
    now: () => 0,
  });
  assert.equal(result.steps[0].raw, '{"type":"stop"}');
  assert.equal(result.outcome, 'stopped');
  assert.equal(counted.submits(), 0);
  assert.equal(eng.getState().npcs.npc_a.location, 'dorm');
  assert.equal(eng.getState().npcs.npc_a.hunger, 40);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].temperature, 0);
  assert.equal(bodies[0].max_tokens, 1024);
  assert.equal(bodies[0].stream, false);
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: true });

  const onlyReasoning = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { reasoning_content: '{"type":"eat"}', reasoning: '{"type":"move","to":"kitchen"}' } }],
    }), { status: 200 }),
  });
  await assert.rejects(() => onlyReasoning.decide(sample(), new AbortController().signal), (err: Error) => {
    assert.equal(err.name, 'ProviderTransportError');
    assert.equal(err.message, 'missing message content');
    return true;
  });

  const nullContent = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, reasoning_content: '{"type":"eat"}' } }],
    }), { status: 200 }),
  });
  await assert.rejects(() => nullContent.decide(sample(), new AbortController().signal), (err: Error) => {
    assert.equal(err.message, 'missing message content');
    return true;
  });

  const emptyContent = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '', reasoning_content: '{"type":"eat"}' } }],
    }), { status: 200 }),
  });
  assert.equal(await emptyContent.decide(sample(), new AbortController().signal), '');

  const mixedParts = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: [
            { type: 'reasoning', text: '{"type":"eat"}' },
            { type: 'thinking', text: '{"type":"move","to":"kitchen"}' },
            { type: 'text', text: '{"type":"stop"}' },
          ],
        },
      }],
    }), { status: 200 }),
  });
  assert.equal(await mixedParts.decide(sample(), new AbortController().signal), '{"type":"stop"}');

  assert.equal(HTTP_SAMPLING.chat_template_kwargs.enable_thinking, true);
  assert.equal(enableThinkingFromEnv({}), true);
  assert.equal(enableThinkingFromEnv({ FROSTECHO_LLM_THINKING: 'false' }), false);
  const key = 'sekret-xyz';
  let offBody: Record<string, unknown> = {};
  const off = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    apiKey: key,
    enableThinking: false,
    fetchImpl: async (_url, init) => {
      offBody = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), `Bearer ${key}`);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"type":"stop"}', reasoning_content: '{"type":"eat"}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        echo: key,
      }), { status: 200 });
    },
  });
  assert.equal(await off.decide(sample(), new AbortController().signal), '{"type":"stop"}');
  assert.deepEqual(offBody.chat_template_kwargs, { enable_thinking: false });
  assert.equal(offBody.temperature, HTTP_SAMPLING.temperature);
  const transport = off.consumeTransport?.();
  assert.ok(transport);
  assert.equal(transport?.status, 200);
  assert.equal(transport?.error, null);
  assert.deepEqual(transport?.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
  assert.equal(typeof transport?.latencyMs, 'number');
  assert.equal((transport?.requestBody.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking, false);
  const dumped = JSON.stringify(transport);
  assert.equal(dumped.includes(key), false);
  assert.equal(dumped.includes('http://example.test'), false);
  assert.match(dumped, /\[redacted\]/);
  assert.equal(off.consumeTransport?.(), null);
  assert.equal(HTTP_SAMPLING.chat_template_kwargs.enable_thinking, true);

  const reasoningOnlyParts = createHttpProvider({
    url: 'http://example.test/v1/chat/completions',
    model: 'server-model',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: 'reasoning', text: '{"type":"eat"}' }] } }],
    }), { status: 200 }),
  });
  await assert.rejects(() => reasoningOnlyParts.decide(sample(), new AbortController().signal), /missing message content/);
});
