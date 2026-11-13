/**
 * G07 — playable player-message CLI (worker C), default messages=off.
 *
 * Keeps every play:g06 command (step/run/status/world advance/world restart/
 * player move|eat/save/load/quit) and adds `player say npc_a|npc_c <text>`.
 * Messages are the only new channel: sending changes the mailbox ledger only
 * (no model call, no world change, no drive/wake, no budget refresh), and a
 * message reaches the model only inside the NPC's next natural decision.
 *
 * Live mode validates the saved mode/model before constructing a provider and
 * uses the saved thinking/timeout. Save/load use the G07 envelope (.g07.json);
 * a G06 file is refused explicitly.
 */
import { createInterface } from 'node:readline/promises';
import { LIVE_DECISION_TIMEOUT_MS, type Provider } from '../src/agent/contracts';
import { liveTimeoutMs } from '../src/agent/live-record';
import { createHttpProvider, loadHttpConfigFromEnv } from '../src/agent/providers/http';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { Location } from '../src/types';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { G04_THINKING, type NeedPolicy, type ReactiveGame } from '../src/reactive/contracts';
import { writeReactiveEpisode } from '../src/reactive/record';
import { exportGameCheckpoint, restoreNeedsGame } from '../src/reactive/checkpoint';
import { createMailbox } from '../src/communication/mailbox';
import { createMessageProvider } from '../src/communication/provider';
import { loadG07Checkpoint, saveG07Checkpoint } from '../src/communication/checkpoint';
import type { Mailbox, MessageMode } from '../src/communication/contracts';

interface CliOptions {
  live: boolean;
  messages: MessageMode | 'default';
  episode: string;
  out: string;
  timeoutMs?: number;
  order: 'ac' | 'ca';
  need: NeedPolicy;
  load?: string;
  slots: string;
}

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const options: CliOptions = {
    live: false,
    messages: 'default',
    episode: `play-g07-${stamp}`,
    out: 'artifacts/g07-play',
    order: 'ac',
    need: 'recurring',
    slots: 'artifacts/g07-play/slots',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--episode') options.episode = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--load') options.load = argv[++i] ?? '';
    else if (arg === '--slots') options.slots = argv[++i] ?? '';
    else if (arg === '--messages') {
      const value = argv[++i] ?? '';
      if (value !== 'on' && value !== 'off') usageError('--messages must be on or off');
      options.messages = value;
    } else if (arg === '--order') {
      const value = argv[++i] ?? '';
      if (value !== 'ac' && value !== 'ca') usageError('--order must be ac or ca');
      options.order = value;
    } else if (arg === '--need') {
      const value = argv[++i] ?? '';
      if (value !== 'one-shot' && value !== 'recurring') usageError('--need must be one-shot or recurring');
      options.need = value;
    } else usageError(`unknown argument ${arg}`);
  }
  if (!options.episode) usageError('--episode requires a value');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    usageError('--timeout must be a positive number');
  }
  return options;
}

const USAGE = 'commands: step | run | status | world advance <1-120> | world restock dorm|kitchen <1-10> | player say npc_a|npc_c <text> | player move dorm|kitchen | player eat | save <slot> | need one-shot|recurring | quit';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const mode: 'reference' | 'live' = options.live ? 'live' : 'reference';
  const cliThinking = G04_THINKING;
  const timeoutMs = options.timeoutMs ?? liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);
  let messageMode: MessageMode = options.messages === 'on' ? 'on' : 'off';
  let mailbox: Mailbox = createMailbox();
  let providerFor!: (actorId: string) => Provider;

  const wrap = (innerFor: (actorId: string) => Provider): void => {
    providerFor = (actorId: string) => createMessageProvider(innerFor(actorId), mailbox, { enabled: messageMode === 'on', actorId });
  };

  let game: ReactiveGame;
  if (options.load !== undefined) {
    const loaded = loadG07Checkpoint(options.load);
    if (!loaded.ok) {
      console.error(`[load rejected] ${loaded.code}: ${(loaded.issues ?? []).join('; ')}`);
      process.exitCode = 2;
      return;
    }
    const { envelope, mailbox: loadedMailbox } = loaded.value;
    if (envelope.game.mode !== mode) {
      console.error(`[load rejected] MODE_CONFLICT: checkpoint mode '${envelope.game.mode}' but the CLI is '${mode}'`);
      process.exitCode = 2;
      return;
    }
    if (options.messages !== 'default' && options.messages !== envelope.messageMode) {
      console.error(`[load rejected] MODE_CONFLICT: checkpoint message mode '${envelope.messageMode}' but --messages ${options.messages}`);
      process.exitCode = 2;
      return;
    }
    messageMode = envelope.messageMode;
    // Swap the validated mailbox BEFORE building providers/restoring, so the
    // restored game's providers decorate the resumed ledger.
    mailbox = loadedMailbox;
    if (envelope.game.mode === 'live') {
      const config = loadHttpConfigFromEnv();
      if (!config) {
        console.error('[load rejected] MODEL_CONFLICT: live checkpoint needs FROSTECHO_LLM_URL / FROSTECHO_LLM_MODEL');
        process.exitCode = 2;
        return;
      }
      if (envelope.game.requestModel === null || envelope.game.requestModel !== config.model) {
        console.error(`[load rejected] MODEL_CONFLICT: checkpoint model '${String(envelope.game.requestModel)}' != environment model '${config.model}' (no request was sent)`);
        process.exitCode = 2;
        return;
      }
      wrap(() => createHttpProvider({ ...config, enableThinking: envelope.game.thinking }));
    } else {
      wrap(() => createReferenceProvider());
    }
    const restored = restoreNeedsGame(envelope.game, { providerFor });
    if (!restored.ok) {
      console.error(`[load rejected] ${restored.code}: ${(restored.issues ?? []).join('; ')}`);
      process.exitCode = 2;
      return;
    }
    game = restored.value;
    console.log(`G07 resumed ${envelope.game.episodeId} from ${options.load} (mode=${envelope.game.mode}, messages=${messageMode}, pending=${Object.keys(mailbox.export().pending).length}, binds=${mailbox.status().bindSeq}) — no model call, no command replay`);
  } else {
    let requestModel: string | undefined;
    if (mode === 'live') {
      const config = loadHttpConfigFromEnv();
      if (!config) {
        console.error('live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL in the environment');
        process.exitCode = 2;
        return;
      }
      requestModel = config.model;
      wrap(() => createHttpProvider({ ...config, enableThinking: cliThinking }));
    } else {
      wrap(() => createReferenceProvider());
    }
    const actorIds = options.order === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
    game = createNeedsGame({
      episodeId: options.episode,
      initialState: buildNeedsWorld({ kitchenFood: 4 }),
      actorIds,
      providerFor,
      mode,
      thinking: cliThinking,
      needPolicy: options.need,
      timeoutMs,
      requestModel,
    });
    console.log(`G07 episode ${options.episode} (${mode}, messages=${messageMode}, need=${options.need}, order=${options.order})`);
  }
  console.log(USAGE);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let running = false;
  let finalized = false;
  let fatal = false;

  const report = (): void => {
    const status = game.status();
    for (const id of game.actorIds) {
      const actor = status.actors[id];
      console.log(`  ${id}: ${actor?.location ?? '?'} hunger=${actor?.hunger ?? '?'} state=${actor?.state ?? '?'} cycle=${actor?.cycle ?? 0} calls=${actor?.providerCalls ?? 0}`);
    }
    const box = mailbox.status();
    const pendingText = Object.entries(box.pending).map(([to, list]) => `${to}:${list.length}`).join(',') || 'none';
    const last = box.lastReceipt;
    console.log(`  simTime=${status.simTime} food.kitchen=${status.food.kitchen} food.dorm=${status.food.dorm} player=${status.player.location ?? '?'} hunger=${status.player.hunger ?? '?'} closed=${status.closed}`);
    console.log(`  messages=${messageMode} pending=${pendingText} binds=${box.bindSeq}${last === null ? '' : ` last=[${last.status} ${last.actorId}${last.text === null ? '' : ` "${last.text}"`}]`}`);
  };

  const finalize = async (reason: string): Promise<void> => {
    if (finalized) return;
    finalized = true;
    running = false;
    try {
      await game.close();
    } catch (err) {
      fatal = true;
      console.error(`[close] ${err instanceof Error ? err.message : String(err)}`);
    }
    const record = game.snapshot();
    try {
      const dir = writeReactiveEpisode(options.out, record.episodeId, record);
      console.log(`saved ${dir} (stopReason=${record.stopReason})`);
    } catch (err) {
      fatal = true;
      console.error(`[save] ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = record.stopReason === 'interrupted' || fatal ? 1 : 0;
    console.log(`[finalize ${reason}] exit=${String(process.exitCode)}`);
    rl.close();
    setImmediate(() => process.exit(process.exitCode ?? 0));
  };

  const drive = (): void => {
    if (running || finalized) return;
    running = true;
    void game.runUntilIdle().then(outcome => {
      running = false;
      console.log(`[run ${outcome.kind}]`);
      report();
      if (outcome.kind === 'interrupted') void finalize('interrupted');
    });
  };

  rl.on('line', (raw: string) => {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (line === '' || line === 'help') {
      console.log(USAGE);
      rl.prompt();
      return;
    }
    if (line === 'quit') {
      void finalize('quit');
      return;
    }
    if (line === 'status') {
      report();
      rl.prompt();
      return;
    }
    if (line === 'step') {
      void game.advance().then(outcome => {
        console.log(`[step ${outcome.kind}]`);
        report();
        if (outcome.kind === 'interrupted') void finalize('interrupted');
        else rl.prompt();
      });
      return;
    }
    if (line === 'run') {
      if (running) console.log('[run already active]');
      else drive();
      rl.prompt();
      return;
    }
    if (line.startsWith('player say')) {
      const match = /^player say (npc_[a-z]+) (.+)$/.exec(line);
      if (match === null) {
        console.log('[say rejected] usage: player say npc_a|npc_c <text>');
        rl.prompt();
        return;
      }
      const state = game.snapshot().finalState;
      const positions: Record<string, string> = {};
      for (const [id, npc] of Object.entries(state.npcs)) positions[id] = npc.location;
      const sent = mailbox.send({ commandId: `${game.snapshot().episodeId}:say:${mailbox.status().messageSeq + 1}`, to: match[1], text: match[2] }, positions);
      if (!sent.ok) {
        console.log(`[say rejected] ${sent.code}: ${(sent.issues ?? []).join('; ')}`);
      } else {
        console.log(`[say ${sent.value.outcome}] seq=${sent.value.seq} to=${sent.value.to} (no model call, no world change, no wake)`);
      }
      report();
      rl.prompt();
      return;
    }
    if (line.startsWith('player ')) {
      const result = game.playerLine(line);
      console.log(result.ok ? `[player accepted] ${result.detail}` : `[player rejected] ${result.detail}`);
      report();
      rl.prompt();
      return;
    }
    if (line.startsWith('save')) {
      const slot = line === 'save' ? '' : line.slice(5);
      const saved = saveG07Checkpoint(options.slots, slot, game, mailbox, messageMode);
      if (!saved.ok) {
        // An IO failure means nothing reached disk, so the run must exit non-zero.
        if (saved.code === 'IO_ERROR') fatal = true;
        console.log(`[save rejected] ${saved.code}: ${(saved.issues ?? []).join('; ')}`);
        rl.prompt();
        return;
      }
      const status = game.status();
      const box = mailbox.status();
      console.log(`[save ok] ${saved.value.path} simTime=${status.simTime} messages=${messageMode} pending=${Object.keys(box.pending).length} binds=${box.bindSeq}`);
      for (const id of game.actorIds) {
        const actor = status.actors[id];
        console.log(`  ${id}: state=${actor?.state ?? '?'} cycle=${actor?.cycle ?? 0} calls=${actor?.providerCalls ?? 0} hunger=${actor?.hunger ?? '?'}`);
      }
      rl.prompt();
      return;
    }
    if (line.startsWith('world advance')) {
      const match = /^world advance ([0-9]+)$/.exec(line);
      if (match === null) {
        console.log('[advance rejected] usage: world advance <1-120>');
        rl.prompt();
        return;
      }
      const result = game.worldAdvanceTime(Number(match[1]));
      console.log(result.ok ? `[advance accepted] simTime ${result.before} -> ${result.after}` : `[advance rejected] ${result.error}`);
      report();
      rl.prompt();
      return;
    }
    if (line.startsWith('world restock ')) {
      const match = /^world restock (dorm|kitchen) ([0-9]+)$/.exec(line);
      if (match === null) {
        console.log('[world rejected] usage: world restock dorm|kitchen <1-10>');
        rl.prompt();
        return;
      }
      const result = game.worldRestock(match[1] as Location, Number(match[2]));
      console.log(result.ok ? `[world accepted] ${result.command.commandId}` : `[world rejected] ${result.error ?? 'rejected'}`);
      report();
      if (result.ok) drive();
      rl.prompt();
      return;
    }
    if (line === 'need' || line.startsWith('need ')) {
      const arg = line === 'need' ? '' : line.slice(5);
      if (arg === '') console.log(`need policy = ${game.getNeedPolicy()}`);
      else if (arg === 'one-shot' || arg === 'recurring') {
        game.setNeedPolicy(arg);
        console.log(`need policy -> ${game.getNeedPolicy()}`);
      } else console.log('[need rejected] usage: need one-shot|recurring');
      rl.prompt();
      return;
    }
    console.log(`unknown command ${JSON.stringify(line)}`);
    rl.prompt();
  });
  rl.on('close', () => { void finalize('eof'); });
  rl.setPrompt('> ');
  rl.prompt();
}

void main();
