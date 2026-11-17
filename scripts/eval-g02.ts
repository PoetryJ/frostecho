import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HTTP_ENV, loadHttpConfigFromEnv } from '../src/agent';
import { strictlyInside } from '../src/eval';
import { runG02Eval, verifyG02Batch } from '../src/play';

function artifactRoot(): string {
  const custom = process.env.FROSTECHO_G02_ARTIFACT_DIR?.trim();
  const resolved = resolve(custom && custom.length > 0 ? custom : 'artifacts/g02');
  const cwd = resolve(process.cwd());
  if (!strictlyInside(cwd, resolved) && !strictlyInside(resolve(tmpdir()), resolved)) {
    throw new Error('g02 artifact dir must be inside the workspace or the temp directory');
  }
  return resolved;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

/**
 * G02 eval: gate (rep 1 × 3 scenarios × thinking on/off = 6) then up to 18 games, paired and serial.
 * `--fixture` uses the reference policy and does not claim a real model.
 * Without `--fixture`, FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL are required and /models must serve the model.
 * `--verify <batchDir>` rebuilds a batch summary from disk and checks it. Exit 0 only on full success.
 */
async function main() {
  const verify = option('--verify');
  if (verify) {
    const result = verifyG02Batch(resolve(verify));
    console.log(`verify ok=${result.ok} provesCurrentSource=${result.provesCurrentSource}`);
    for (const issue of result.issues) console.log(`issue ${issue}`);
    process.exit(result.ok ? 0 : 1);
  }
  const fixture = process.argv.includes('--fixture');
  if (!fixture) {
    const config = loadHttpConfigFromEnv(process.env);
    if (!config) {
      const missing = [HTTP_ENV.url, HTTP_ENV.model].filter(name => !process.env[name]?.trim());
      console.error(`missing required live config: ${missing.join(', ')}`);
      console.error('Real eval: source the connect script so FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL are set, then npm run eval:g02');
      console.error('Harness only: npm run eval:g02 -- --fixture');
      process.exit(2);
    }
  }

  const out = await runG02Eval({
    mode: fixture ? 'fixture' : 'live',
    root: artifactRoot(),
    batchId: option('--batch'),
    env: process.env,
    gate: !process.argv.includes('--no-gate'),
  });
  const summary = out.summary;
  for (const note of summary.notes.filter(n => n.startsWith('batch store refused') || n.startsWith('missing'))) console.error(note);
  if (summary.health) console.log(`health ok=${summary.health.ok} status=${summary.health.status} model=${summary.health.expectedModel} served=${summary.health.models.join(',')} error=${summary.health.error ?? 'none'}`);
  console.log(`eval mode=${summary.mode} realModel=${summary.realModel} batch=${out.batchDir ?? 'none'} games=${summary.gamesRun}/${summary.gamesPlanned} requests=${summary.requestCount} http=${summary.httpRequests} decisions=${summary.decisionCalls} intercepts=${summary.budgetIntercepts} stop=${summary.stopReason} gate=${summary.gate.passed} exit=${out.exitCode}`);
  for (const id of ['s1', 's2', 's3'] as const) {
    const row = summary.byScenario[id];
    console.log(`scenario ${id} pass=${row.scenarioPass}/${row.games} goalReached=${row.goalReached}`);
  }
  for (const row of summary.rebuilt.combinations) {
    console.log(`combo ${row.scenarioId}/thinking-${row.thinking ? 'on' : 'off'} planned=${row.planned} valid=${row.valid} pass=${row.pass} behaviorFail=${row.behaviorFail} interrupted=${row.interrupted} notRun=${row.notRun} http=${row.counters.httpRequests} latencyMs=${row.counters.latencyMs} tokens=${row.counters.usage.totalTokens} usageUnknown=${row.counters.usage.unknownRequests} s3NoFood=${row.counters.errors.s3ExpectedNoFood}`);
  }
  for (const key of ['true', 'false'] as const) {
    const g = summary.byThinking[key];
    console.log(`thinking ${key === 'true' ? 'on' : 'off'} pass=${g.scenarioPass}/${g.games} requests=${g.requestCount} latencyMs=${g.latencyMs} tokens=${g.totalTokens} usageUnknown=${g.usageUnknownRequests}`);
  }
  console.log(`errors transport=${summary.errors.transport} parse=${summary.errors.parse} decide=${summary.errors.decide} execute=${summary.errors.execute} s3ExpectedNoFood=${summary.errors.s3ExpectedNoFood}`);
  for (const item of summary.rebuilt.interrupted) console.log(`interrupted ${item.taskId} kind=${item.kind} error=${item.error}`);
  if (summary.rebuilt.notRun.length) console.log(`not_run ${summary.rebuilt.notRun.join(',')}`);
  for (const issue of summary.rebuilt.issues) console.log(`issue ${issue}`);
  process.exit(out.exitCode);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
