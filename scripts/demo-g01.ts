import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine, initialWorld, replay } from '../src';
import {
  createHttpProvider, createReferenceProvider, deterministicRecord, loadHttpConfigFromEnv, runAgent, RunResult,
} from '../src/agent';

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function printRun(title: string, result: RunResult, lines: string[]) {
  const say = (line: string) => { lines.push(line); console.log(line); };
  say(`== ${title} ==`);
  say(`runId=${result.runId} outcome=${result.outcome} goalReached=${result.goalReached} providerCalls=${result.providerCalls}`);
  for (const step of result.steps) {
    const exec = step.exec ? ` ${step.exec.status}${step.exec.reason ? ' ' + step.exec.reason : ''}` : '';
    say(`  #${step.round} ${step.observation.id}@${step.observation.location} hunger=${step.observation.hunger} foodHere=${step.observation.foodHere} raw=${JSON.stringify(step.raw)}${exec}${step.error ? ' error=' + step.error : ''}`);
  }
  const finalNpc = result.finalState.npcs.npc_a;
  say(`final: ${finalNpc.id}@${finalNpc.location} hunger=${finalNpc.hunger} kitchen.food=${result.finalState.food.kitchen}`);
  const same = JSON.stringify(replay(result.initialState, result.events)) === JSON.stringify(result.finalState);
  say(`replay matches final state: ${same}`);
}

async function main() {
  const lines: string[] = [];
  const say = (line: string) => { lines.push(line); console.log(line); };
  const eng = new Engine(initialWorld());
  const offline = await runAgent({
    world: eng,
    provider: createReferenceProvider(),
    actorId: 'npc_a',
    runId: 'g01-offline-reference',
  });
  printRun('offline reference policy', offline, lines);
  if (!offline.goalReached) {
    say('offline reference policy did not reach hunger >= 70');
    mkdirSync('artifacts/g01', { recursive: true });
    writeFileSync('artifacts/g01/demo-output.txt', lines.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  const config = loadHttpConfigFromEnv(process.env);
  mkdirSync('artifacts/g01', { recursive: true });
  if (!config) {
    const missing = ['FROSTECHO_LLM_URL', 'FROSTECHO_LLM_MODEL'].filter(name => !process.env[name]?.trim());
    const note = [
      'REAL MODEL UNVERIFIED',
      `missing: ${missing.join(', ')}`,
      'The offline reference-policy run was not used as a substitute for the real-model check.',
    ].join('\n');
    say(note);
    writeFileSync('artifacts/g01/real-model.txt', note + '\n');
  } else {
    const secrets = [config.apiKey ?? '', config.url].filter(Boolean);
    say(`real model configured: model=${config.model} apiKey=${config.apiKey ? 'present' : 'absent'}`);
    const runs: { outcome: string; goalReached: boolean; providerCalls: number; latencyMs: number; error?: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      try {
        const result = await runAgent({
          world: new Engine(initialWorld()),
          provider: createHttpProvider(config),
          actorId: 'npc_a',
          runId: `g01-real-${i + 1}`,
          timeoutMs: 20_000,
        });
        runs.push({
          outcome: result.outcome,
          goalReached: result.goalReached,
          providerCalls: result.providerCalls,
          latencyMs: Date.now() - started,
          error: result.error ? redact(result.error, secrets) : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'provider error';
        runs.push({ outcome: 'provider_error', goalReached: false, providerCalls: 0, latencyMs: Date.now() - started, error: redact(message, secrets) });
      }
    }
    const success = runs.filter(run => run.goalReached).length;
    const requests = runs.reduce((sum, run) => sum + run.providerCalls, 0);
    const failures = runs.filter(run => !run.goalReached).map(run => run.error ?? run.outcome);
    say(`real model runs: 3 success: ${success} requests: ${requests} latencyMs: ${runs.map(run => run.latencyMs).join(',')}`);
    say(`failure reasons: ${failures.length ? failures.join(' | ') : 'none'}`);
    const report = { model: config.model, apiKey: config.apiKey ? 'present' : 'absent', success, requests, runs };
    writeFileSync('artifacts/g01/real-model.json', JSON.stringify(report, null, 2) + '\n');
    writeFileSync('artifacts/g01/real-model.txt', [
      `model=${config.model}`,
      `apiKey=${config.apiKey ? 'present' : 'absent'}`,
      `success=${success}/3`,
      `requests=${requests}`,
      `latencyMs=${runs.map(run => run.latencyMs).join(',')}`,
      `failures=${failures.length ? failures.join(' | ') : 'none'}`,
    ].join('\n') + '\n');
  }

  writeFileSync('artifacts/g01/offline-trace.json', JSON.stringify(deterministicRecord(offline), null, 2) + '\n');
  writeFileSync('artifacts/g01/offline-timing.json', JSON.stringify(offline.timing, null, 2) + '\n');
  writeFileSync('artifacts/g01/demo-output.txt', lines.join('\n') + '\n');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
