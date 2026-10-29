import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Engine, initialWorld } from '../src';
import {
  HTTP_ENV, LIVE_DECISION_TIMEOUT_MS, LIVE_RUN_COUNT, RunResult, allocateLiveBatchDir, createHttpProvider,
  enableThinkingFromEnv, liveArtifactDir, liveExitCode, liveTimeoutMs, loadHttpConfigFromEnv, replayMatches,
  runAgent, summarizeLiveDir, writeLiveRun,
} from '../src/agent';

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolveArtifactRoot(env: NodeJS.ProcessEnv): string {
  const resolved = resolve(liveArtifactDir(env));
  const cwd = resolve(process.cwd());
  if (!strictlyInside(cwd, resolved) && !strictlyInside(resolve(tmpdir()), resolved)) {
    throw new Error('live artifact dir must be inside the workspace or the temp directory');
  }
  return resolved;
}

function say(line: string) {
  console.log(line);
}

/**
 * Live G01 entry. HTTP only. Does not fall back to the reference policy.
 * Exit 2: FROSTECHO_LLM_URL or FROSTECHO_LLM_MODEL missing.
 * Exit 0: LIVE_RUN_COUNT runs each reach hunger >= 70 and replay.
 * Exit 1: any run failed, the goal was missed, replay diverged, or saved metadata disagrees with the records.
 * Each invocation writes a new batch directory and does not delete older batches.
 */
async function main() {
  const config = loadHttpConfigFromEnv(process.env);
  if (!config) {
    const missing = [HTTP_ENV.url, HTTP_ENV.model].filter(name => !process.env[name]?.trim());
    console.error(`missing required live config: ${missing.join(', ')}`);
    process.exit(2);
  }

  const root = resolveArtifactRoot(process.env);
  mkdirSync(root, { recursive: true });
  // Each invocation gets its own directory. Prior batches and any other files under root stay put.
  const batch = allocateLiveBatchDir(root);
  const timeoutMs = liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);
  const enableThinking = enableThinkingFromEnv(process.env);
  const secrets = [config.apiKey ?? '', config.url].filter(secret => secret.length > 0);
  const meta = { model: config.model, apiKeyPresent: Boolean(config.apiKey), timeoutMs, secrets, enableThinking };
  const provider = createHttpProvider({ ...config, enableThinking });
  say(`live model=${config.model} apiKey=${config.apiKey ? 'present' : 'absent'} thinking=${enableThinking} timeoutMs=${timeoutMs} runs=${LIVE_RUN_COUNT} batch=${batch}`);

  for (let i = 1; i <= LIVE_RUN_COUNT; i++) {
    const runId = `g01-live-${i}`;
    const world = new Engine(initialWorld());
    try {
      const result = await runAgent({
        world,
        provider,
        actorId: 'npc_a',
        runId,
        timeoutMs,
      });
      writeLiveRun(batch, i, result, meta);
      say(`run ${i} outcome=${result.outcome} goalReached=${result.goalReached} replay=${replayMatches(result)} providerCalls=${result.providerCalls}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'provider error';
      const failed: RunResult = {
        runId,
        actorId: 'npc_a',
        outcome: 'provider_error',
        goalReached: false,
        providerCalls: 0,
        steps: [],
        initialState: world.getInitialState(),
        events: world.getEvents(),
        finalState: world.getState(),
        timing: { totalMs: 0, calls: [] },
        error: message,
      };
      writeLiveRun(batch, i, failed, meta);
      say(`run ${i} outcome=provider_error goalReached=false replay=${replayMatches(failed)} providerCalls=0`);
    }
  }

  const summary = summarizeLiveDir(batch);
  const code = liveExitCode(summary);
  say(`live runs=${summary.runs.length} success=${summary.successCount} requests=${summary.requestCount} exit=${code}`);
  process.exit(code);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
