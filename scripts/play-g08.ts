/**
 * G08 playable CLI — R1 revision.
 *
 * A command-style tool: each invocation loads (or creates) a .g08.json slot,
 * applies one world/game action, prints the resulting status, and optionally
 * saves. Debug play defaults to the script provider; --live switches to the
 * real HTTP provider from the environment (no credentials are ever saved).
 * The status print exposes the paused actors and their wake deadlines.
 *
 * G08-R1:
 *  - exactly ONE effectiveConfig per process (mode/requestModel/thinking/
 *    timeoutMs); it is built before anything runs, threaded into the provider
 *    and the save, and verified against the slot on load (a live slot will
 *    not load without --live and the very same FROSTECHO_LLM_MODEL; refusal
 *    is CONFIGURATION exit 2 before any HTTP request or world mutation)
 *  - step and run share one finalize: a transport failure exits 1 and writes
 *    a run-failure record under <root>/failures/<slot>/ (own directory, never
 *    overwriting the input slot or a --save target)
 *  - the printed status reads totalCalls from the authoritative game record
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createNeedsGame, buildNeedsWorld } from '../src/needs/game';
import { createHttpProvider, loadHttpConfigFromEnv } from '../src/agent/providers/http';
import { createMailbox, restoreMailbox } from '../src/communication/mailbox';
import type { Mailbox, MessageMode } from '../src/communication/contracts';
import { createMessageProvider } from '../src/communication/provider';
import type { Provider } from '../src/agent/contracts';
import type { ActionSet, G08EffectiveConfig } from '../src/temporal/contracts';
import { g08CheckpointPath, loadG08Checkpoint, restoreG08Game, saveG08Checkpoint } from '../src/temporal/checkpoint';

const USAGE = `usage: play-g08 --root DIR --slot NAME {--new|--load} [actions]
  --new                 create a new episode in the slot (fails if it exists)
  --load                restore the slot (fails if absent)
  --save                write the slot after the action
  --actions legacy|timed_wait   capability axis (default legacy)
  --messages off|on     player-message axis (default off)
  --script npc=a,b,c    script provider moves for an npc (repeatable; default demo)
  --live                real HTTP provider from the environment (debug default is the script provider)
  --step [N]            advance N times (default 1)
  --run                 run until idle
  --close               close the game
  --time N              advance the world clock by N logical steps
  --restock PLACE N     restock a place
  --move PLACE          move the player (dorm|kitchen)
  --say NPC=TEXT        the player says TEXT to a colocated NPC (mailbox)
  --status              print the status JSON only`;

const WIRED_TIMEOUT_MS = 120000;

/** Usage / data errors stop here (exit 1). */
function fail(message: string): never {
  console.error(String(message));
  process.exit(1);
}

/** CONFIGURATION conflicts stop here (exit 2) — before HTTP, before the world. */
function failConfig(message: string): never {
  console.error(String(message));
  process.exit(2);
}

/** Deterministic scripted provider for offline play: repeatable move lists per npc. */
function scriptedProvider(scripts: Record<string, string[]>, counters: Record<string, number>): (actorId: string) => Provider {
  return (actorId: string) => ({
    decide: async () => {
      const list = scripts[actorId] ?? ['{"type":"stop"}'];
      const index = counters[actorId] ?? 0;
      counters[actorId] = index + 1;
      return list[index % list.length];
    },
  });
}

function parseScriptArg(value: string): { actorId: string; moves: string[] } {
  const eq = value.indexOf('=');
  if (eq <= 0) fail(`--script expects npc=move1,move2 (got ${JSON.stringify(value)})`);
  const actorId = value.slice(0, eq);
  const moves = value.slice(eq + 1).split(',').map(m => m.trim()).filter(m => m.length > 0)
    .map(m => (m.startsWith('{') ? m : `{"type":"${m}"}`));
  if (moves.length === 0) fail(`--script ${JSON.stringify(value)} has no moves`);
  return { actorId, moves };
}

interface Args {
  root: string; slot: string; create: boolean; load: boolean; save: boolean;
  actionSet: ActionSet; messageMode: MessageMode; live: boolean;
  step: number | null; run: boolean; close: boolean;
  time: number | null; restock: [string, number] | null; move: string | null; say: [string, string] | null;
  statusOnly: boolean; scripts: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: 'artifacts/g08-play', slot: 'demo', create: false, load: false, save: false,
    actionSet: 'legacy', messageMode: 'off', live: false,
    step: null, run: false, close: false, time: null, restock: null, move: null, say: null,
    statusOnly: false, scripts: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--root': args.root = argv[++i]; break;
      case '--slot': args.slot = argv[++i]; break;
      case '--new': args.create = true; break;
      case '--load': args.load = true; break;
      case '--save': args.save = true; break;
      case '--live': args.live = true; break;
      case '--run': args.run = true; break;
      case '--close': args.close = true; break;
      case '--actions': {
        const v = argv[++i];
        if (v !== 'legacy' && v !== 'timed_wait') fail(`--actions must be legacy|timed_wait (got ${JSON.stringify(v)})`);
        args.actionSet = v;
        break;
      }
      case '--messages': {
        const v = argv[++i];
        if (v !== 'off' && v !== 'on') fail(`--messages must be off|on (got ${JSON.stringify(v)})`);
        args.messageMode = v;
        break;
      }
      case '--script': {
        const { actorId, moves } = parseScriptArg(argv[++i]);
        args.scripts[actorId] = moves;
        break;
      }
      case '--step': {
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) { args.step = Number(next); i += 1; } else { args.step = 1; }
        break;
      }
      case '--time': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) fail('--time expects a positive integer');
        args.time = v;
        break;
      }
      case '--restock': {
        const place = argv[++i];
        const count = Number(argv[++i]);
        if (place !== 'dorm' && place !== 'kitchen') fail('--restock place must be dorm|kitchen');
        if (!Number.isInteger(count) || count <= 0) fail('--restock count must be a positive integer');
        args.restock = [place, count];
        break;
      }
      case '--move': {
        const v = argv[++i];
        if (v !== 'dorm' && v !== 'kitchen') fail('--move must be dorm|kitchen');
        args.move = v;
        break;
      }
      case '--say': {
        const v = argv[++i] ?? fail('--say expects NPC=TEXT');
        const eq = v.indexOf('=');
        if (eq <= 0) fail('--say expects NPC=TEXT');
        args.say = [v.slice(0, eq), v.slice(eq + 1)];
        break;
      }
      case '--status': args.statusOnly = true; break;
      case '--help': case '-h': console.log(USAGE); process.exit(0); break;
      default: fail(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    }
  }
  return args;
}

interface Runtime {
  game: ReturnType<typeof createNeedsGame>;
  mailbox: Mailbox;
}

/**
 * The ONE effective configuration for this process. Built once, before any
 * provider, world or save exists. The timeout is the wired default; thinking
 * is on for live sessions.
 */
function buildEffectiveConfig(args: Args): G08EffectiveConfig {
  if (args.live) {
    const env = loadHttpConfigFromEnv();
    if (env === null) failConfig('--live requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL in the environment');
    return { mode: 'live', requestModel: env.model, thinking: true, timeoutMs: WIRED_TIMEOUT_MS };
  }
  return { mode: 'reference', requestModel: null, thinking: false, timeoutMs: WIRED_TIMEOUT_MS };
}

/**
 * A loaded slot refuses to run under a different runtime: a live slot needs
 * --live AND the very same FROSTECHO_LLM_MODEL; a script slot must not be
 * silently upgraded to live. Checked before any HTTP request or world
 * mutation, and always CONFIGURATION exit 2.
 */
function assertProviderMatchesSlot(config: G08EffectiveConfig, args: Args): void {
  if (config.mode === 'live') {
    if (!args.live) {
      failConfig('configuration conflict: this slot was created with --live; loading it requires --live and the same FROSTECHO_LLM_MODEL (a script substitution is not allowed)');
    }
    const env = loadHttpConfigFromEnv();
    if (env === null) failConfig('--live requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL in the environment');
    if (env.model !== config.requestModel) {
      failConfig(`configuration conflict: this slot was created with model ${JSON.stringify(config.requestModel)} but the environment provides ${JSON.stringify(env.model)}; refusing before any request`);
    }
    return;
  }
  if (args.live) {
    failConfig('configuration conflict: this slot was created with the script provider; --live cannot load it');
  }
}

function providerFactory(args: Args, mailbox: Mailbox, counters: Record<string, number>, config: G08EffectiveConfig): (actorId: string) => Provider {
  const scripted = scriptedProvider(
    Object.keys(args.scripts).length > 0 ? args.scripts : {
      npc_a: ['{"type":"wait"}', '{"type":"eat"}', '{"type":"stop"}'],
      npc_c: ['{"type":"eat"}', '{"type":"stop"}'],
    },
    counters,
  );
  const env = config.mode === 'live' ? loadHttpConfigFromEnv() : null;
  return (actorId: string) => {
    const inner = env !== null
      ? createHttpProvider({ url: env.url, model: config.requestModel!, apiKey: env.apiKey, enableThinking: true })
      : scripted(actorId);
    if (args.messageMode !== 'on') return inner;
    return createMessageProvider(inner, mailbox, { enabled: true, actorId });
  };
}

function printStatus(rt: Runtime, args: Args): void {
  const status = rt.game.status();
  const mailboxView = rt.mailbox.status();
  const paused = Object.entries(status.wakeAtSimTime ?? {})
    .filter(([, deadline]) => deadline !== null)
    .map(([actorId, deadline]) => `${actorId}->simTime ${deadline}`);
  console.log(JSON.stringify({
    actionSet: args.actionSet,
    messages: args.messageMode,
    closed: status.closed,
    interrupted: status.interrupted,
    simTime: status.simTime,
    actors: Object.fromEntries(Object.entries(status.actors).map(([id, a]) => [id, {
      state: a.state, cycle: a.cycle, providerCalls: a.providerCalls,
    }])),
    paused: paused.length > 0 ? paused.join(' ') : '(none)',
    player: status.player,
    food: status.food,
    mailbox: mailboxView,
    // Authoritative count straight from the game record (the same sum the
    // checkpoint verifier cross-checks against the sessions).
    totalCalls: Object.values(status.actors).reduce((sum, a) => sum + a.providerCalls, 0),
  }, null, 2));
}

/**
 * R1 finalize for transport failures: persistent evidence in an exclusive
 * directory (never the input slot, never a --save target), then exit 1.
 */
function writeRunFailure(args: Args, kind: string, detail: string): never {
  const dir = join(resolve(args.root), 'failures', args.slot);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${kind}-${stamp}.json`);
  try {
    writeFileSync(file, JSON.stringify({
      schema: 'frostecho.g08.run-failure/1',
      slot: args.slot,
      kind,
      detail,
      wroteAt: new Date().toISOString(),
    }, null, 2));
    console.error(`run failed: ${kind} — ${detail}`);
    console.error(`failure evidence: ${file}`);
  } catch (err) {
    console.error(`run failed: ${kind} — ${detail} (writing the failure record also failed: ${err instanceof Error ? err.message : String(err)})`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.create && !args.load) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.create && args.load) fail('use either --new or --load, not both');
  mkdirSync(resolve(args.root), { recursive: true });
  const path = g08CheckpointPath(resolve(args.root), args.slot);
  const counters: Record<string, number> = {};

  // The one effective configuration for this whole process.
  const effectiveConfig = buildEffectiveConfig(args);

  let game: ReturnType<typeof createNeedsGame>;
  let mailbox: Mailbox;

  if (args.create) {
    if (existsSync(path)) fail(`slot exists: ${path}`);
    mailbox = createMailbox();
    game = createNeedsGame({
      episodeId: `g08-${args.slot}-${Date.now()}`,
      initialState: buildNeedsWorld({ kitchenFood: 3, hunger: { npc_a: 40, npc_c: 40 } }),
      providerFor: providerFactory(args, mailbox, counters, effectiveConfig),
      mode: effectiveConfig.mode === 'live' ? 'live' : 'reference',
      thinking: effectiveConfig.thinking,
      // The game record carries the same runtime values the envelope saves.
      requestModel: effectiveConfig.requestModel ?? undefined,
      timeoutMs: effectiveConfig.timeoutMs,
      needPolicy: 'recurring',
      actionSet: args.actionSet,
    });
  } else {
    const loaded = loadG08Checkpoint(path);
    if (!loaded.ok) fail(`load failed: ${loaded.code} ${(loaded.issues ?? []).join('; ')}`);
    // Provider must match the saved runtime BEFORE any HTTP or world work.
    assertProviderMatchesSlot(loaded.value.envelope.effectiveConfig, args);
    const factory = providerFactory(args, loaded.value.mailbox, counters, effectiveConfig);
    const restored = restoreG08Game(loaded.value, {
      providerFor: (actorId: string) => factory(actorId),
      actionSet: args.actionSet,
      messageMode: args.messageMode,
    });
    if (!restored.ok) fail(`restore failed: ${restored.code} ${(restored.issues ?? []).join('; ')}`);
    game = restored.value as ReturnType<typeof createNeedsGame>;
    mailbox = loaded.value.mailbox;
  }

  const rt: Runtime = { game, mailbox };
  let acted = false;

  if (args.time !== null) {
    const res = rt.game.worldAdvanceTime(args.time);
    if (!res.ok) fail(`--time failed: ${res.error}`);
    acted = true;
  }
  if (args.restock !== null) {
    const res = rt.game.worldRestock(args.restock[0] as 'dorm' | 'kitchen', args.restock[1]);
    if (!res.ok) fail(`--restock failed: ${res.error ?? 'unknown'}`);
    acted = true;
  }
  if (args.move !== null) {
    const res = rt.game.playerLine(`player move ${args.move}`);
    if (!res.ok) fail(`--move failed: ${res.detail}`);
    acted = true;
  }
  if (args.say !== null) {
    const positions = Object.fromEntries(
      Object.entries(rt.game.world.getState().npcs).map(([id, npc]) => [id, npc.location]),
    );
    const commandId = `g08-play:say:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
    const sent = rt.mailbox.send({ commandId, to: args.say[0], text: args.say[1] }, positions);
    if (!sent.ok) fail(`--say failed: ${sent.code} ${(sent.issues ?? []).join('; ')}`);
    acted = true;
  }
  if (args.step !== null) {
    for (let i = 0; i < args.step; i += 1) {
      const res = await rt.game.advance();
      if (res.kind === 'closed') { console.log('game closed'); break; }
      if (res.kind === 'interrupted') {
        writeRunFailure(args, 'interrupted-step', `transport failure while stepping actor ${res.actorId}`);
      }
      // A transport failure fails the session and flags the game; the step
      // itself still "completes" from the rotation's point of view.
      if (rt.game.status().interrupted) {
        const failed = Object.entries(rt.game.status().actors).find(([, a]) => a.state === 'failed');
        writeRunFailure(args, 'interrupted-step', `transport failure while stepping ${failed?.[0] ?? 'an actor'}`);
      }
    }
    acted = true;
  }
  if (args.run) {
    const res = await rt.game.runUntilIdle();
    if (res.kind === 'interrupted') {
      writeRunFailure(args, 'interrupted-run', `transport failure while running actor ${res.actorId}`);
    }
    if (rt.game.status().interrupted) {
      const failed = Object.entries(rt.game.status().actors).find(([, a]) => a.state === 'failed');
      writeRunFailure(args, 'interrupted-run', `transport failure while running ${failed?.[0] ?? 'an actor'}`);
    }
    acted = true;
  }
  if (args.close) {
    await rt.game.close();
    acted = true;
  }
  if (args.statusOnly || acted) printStatus(rt, args);
  if (args.save) {
    const saved = saveG08Checkpoint(resolve(args.root), args.slot, rt.game, rt.mailbox, args.actionSet, args.messageMode, effectiveConfig);
    if (!saved.ok) fail(`save failed: ${saved.code} ${(saved.issues ?? []).join('; ')}`);
    console.log(`saved ${saved.value.path}`);
  }
}

void main().catch(err => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
