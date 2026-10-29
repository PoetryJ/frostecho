import { mkdirSync } from 'node:fs';
import readline from 'node:readline';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  HTTP_ENV, LIVE_DECISION_TIMEOUT_MS, createHttpProvider, createReferenceProvider, enableThinkingFromEnv,
  liveTimeoutMs, loadHttpConfigFromEnv,
} from '../src/agent';
import { createPlayGame, parsePlayCommand, saveGameRecord } from '../src/play';

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function artifactRoot(): string {
  const custom = process.env.FROSTECHO_G02_ARTIFACT_DIR?.trim();
  const resolved = resolve(custom && custom.length > 0 ? custom : join('artifacts', 'g02'));
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

function batchId(): string {
  const requested = option('--batch');
  if (requested) return requested;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `play-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Interactive player (npc_b) plus one NPC step (npc_a).
 * Reference policy unless `--live` is present. Live config is not read in the default mode.
 * `quit` rejects further commands, waits for the current step under its existing timeout, then saves.
 */
async function main() {
  const live = process.argv.includes('--live');
  const thinkingText = option('--thinking');
  if (thinkingText !== undefined && thinkingText !== 'true' && thinkingText !== 'false') {
    console.error('invalid --thinking value, expected true or false');
    process.exit(2);
  }

  let provider;
  let thinking: boolean | null = null;
  let mode: 'reference' | 'live' = 'reference';
  if (live) {
    const config = loadHttpConfigFromEnv(process.env);
    if (!config) {
      const missing = [HTTP_ENV.url, HTTP_ENV.model].filter(name => !process.env[name]?.trim());
      console.error(`missing required live config: ${missing.join(', ')}`);
      process.exit(2);
    }
    thinking = thinkingText === undefined ? enableThinkingFromEnv(process.env) : thinkingText === 'true';
    provider = createHttpProvider({ ...config, enableThinking: thinking });
    mode = 'live';
  } else {
    provider = createReferenceProvider();
  }

  const id = batchId();
  const timeoutMs = liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);
  const game = createPlayGame({
    batchId: id,
    provider,
    mode,
    thinking,
    timeoutMs,
  });
  const root = artifactRoot();
  mkdirSync(root, { recursive: true });
  console.log(`play mode=${mode} thinking=${thinking === null ? 'n/a' : String(thinking)} batch=${id} timeoutMs=${timeoutMs}`);
  console.log('commands: player move dorm|kitchen | player eat | npc step | status | quit');

  const finish = async () => {
    const record = await game.quit();
    const dir = saveGameRecord(join(root, 'play'), record);
    console.log(`quit saved=${dir} outcome=${record.outcome} goalReached=${record.goalReached} calls=${record.providerCalls}`);
    return record;
  };

  let quitting: Promise<void> | null = null;
  const handle = (line: string) => {
    const parsed = parsePlayCommand(line);
    if (parsed.kind === 'blank') return;
    if (parsed.kind === 'quit') {
      if (!quitting) {
        quitting = finish().then(() => { process.exit(0); });
      }
      return;
    }
    if (game.closed) {
      console.log('rejected closed');
      return;
    }
    if (parsed.kind === 'invalid') {
      console.log(`invalid ${parsed.error}`);
      return;
    }
    if (parsed.kind === 'status') {
      console.log(game.statusText());
      return;
    }
    if (parsed.kind === 'npc-step') {
      void game.npcStep().then(result => {
        if (result.status === 'busy') {
          console.log('busy');
          return;
        }
        const action = result.step?.parse.ok ? result.step.parse.action.type : (result.step?.error ?? result.status);
        const exec = result.step?.exec
          ? `${result.step.exec.status}${result.step.exec.reason ? ' ' + result.step.exec.reason : ''}`
          : result.status;
        console.log(`npc step round=${result.step?.round ?? game.session.round} action=${action} exec=${exec} session=${game.session.status} calls=${game.session.providerCalls}`);
      });
      return;
    }
    const applied = game.playerLine(line.trim());
    if (!applied.ok) {
      console.log(`player rejected ${applied.error}${applied.command ? ' ' + applied.command.commandId : ''}`);
      return;
    }
    console.log(`player ${applied.command.type} accepted ${applied.command.commandId}`);
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', handle);
  rl.on('close', () => {
    if (!quitting) void finish().then(() => process.exit(0));
  });
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
