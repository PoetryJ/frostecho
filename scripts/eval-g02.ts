import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { HTTP_ENV, loadHttpConfigFromEnv } from '../src/agent';
import { runG02Eval } from '../src/play';

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

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
 * G02 eval: 3 scenarios × 3 reps × thinking on/off = 18 games.
 * `--fixture` uses the reference policy and does not claim a real model.
 * Without `--fixture`, FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL are required.
 * Requests are serial, capped at 90, and are not retried. The production thinking default stays true.
 */
async function main() {
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
  });
  const summary = out.summary;
  console.log(`eval mode=${summary.mode} realModel=${summary.realModel} batch=${out.batchDir ?? 'none'} games=${summary.gamesRun}/${summary.gamesPlanned} requests=${summary.requestCount} exit=${out.exitCode}`);
  for (const id of ['s1', 's2', 's3'] as const) {
    const row = summary.byScenario[id];
    console.log(`scenario ${id} pass=${row.scenarioPass}/${row.games} goalReached=${row.goalReached}`);
  }
  console.log(`thinking on pass=${summary.byThinking.true.scenarioPass}/${summary.byThinking.true.games} requests=${summary.byThinking.true.requestCount} latencyMs=${summary.byThinking.true.latencyMs} tokens=${summary.byThinking.true.totalTokens}`);
  console.log(`thinking off pass=${summary.byThinking.false.scenarioPass}/${summary.byThinking.false.games} requests=${summary.byThinking.false.requestCount} latencyMs=${summary.byThinking.false.latencyMs} tokens=${summary.byThinking.false.totalTokens}`);
  console.log(`errors transport=${summary.errors.transport} parse=${summary.errors.parse} decide=${summary.errors.decide} execute=${summary.errors.execute}`);
  process.exit(out.exitCode);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});