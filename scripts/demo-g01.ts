import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine, initialWorld, replay } from '../src';
import { createReferenceProvider, deterministicRecord, runAgent, RunResult } from '../src/agent';

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
  return same;
}

/**
 * Offline G01 demo. Reference policy only.
 * FROSTECHO_LLM_* is ignored. This process does not open a socket.
 */
async function main() {
  const lines: string[] = [];
  const offline = await runAgent({
    world: new Engine(initialWorld()),
    provider: createReferenceProvider(),
    actorId: 'npc_a',
    runId: 'g01-offline-reference',
  });
  const same = printRun('offline reference policy', offline, lines);
  mkdirSync('artifacts/g01', { recursive: true });
  writeFileSync('artifacts/g01/offline-trace.json', JSON.stringify(deterministicRecord(offline), null, 2) + '\n');
  writeFileSync('artifacts/g01/offline-timing.json', JSON.stringify(offline.timing, null, 2) + '\n');
  writeFileSync('artifacts/g01/demo-output.txt', lines.join('\n') + '\n');
  if (!offline.goalReached || !same) {
    console.error('offline reference policy did not reach hunger >= 70 with a matching replay');
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
