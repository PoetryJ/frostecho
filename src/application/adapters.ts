/**
 * G10 worker C — provider, save, failure and budget adapters.
 *
 * Reuses the G09 checkpoint/atomic slot, the campaign ledger and the real
 * wire collector. It never creates a second domain state: the app metadata is
 * stored beside the authoritative envelope and restore rebuilds the game from
 * the envelope only. Offline is the default; `--live` must be explicit and is
 * only meant for a loopback fake in this task (no real budget is authorized).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { writeExclusiveSlot } from '../persistence/atomic-slot';
import { messageFail, messageOk, type MessageResult } from '../communication/contracts';
import { G09_TIMEOUT_MS, type GoalChoiceId } from '../negotiation/contracts';
import type { GoalProtocolOptions } from '../agent/contracts';
import type { GoalRequestStore } from '../negotiation/requests';
import {
  loadG09Checkpoint, restoreG09Game, saveG09Checkpoint, type G09Checkpoint,
} from '../negotiation/checkpoint';
import { createHttpProvider } from '../agent/providers/http';
import type { Provider, TransportRecord } from '../agent/contracts';
import type { G08EffectiveConfig } from '../temporal/contracts';
import { createNeedsGame, buildNeedsWorld, type NeedsGame } from '../needs/game';
import { createWireCollector, wireUsage, type G09WireCapture } from '../agent/providers/wire';
import {
  campaignCounts, finishCampaignChat, loadCampaign, openCampaign, reserveCampaignChat,
} from '../eval/campaign-budget';
import type { Location } from '../types';
import {
  G10_APP_SCHEMA, G10_FAILURE_SCHEMA, G10_RUN_SCHEMA,
  type ApplicationPorts, type AppMeta, type AppView, type FixtureId, type GoalArm,
  type ProviderKind, type SaveOutcome, type SatietyLevel,
} from './contracts';

export interface G10RuntimeOptions {
  root: string;
  slot: string;
  goals: 'legacy' | 'negotiated';
  candidates: GoalArm;
  satiety: SatietyLevel;
  fixture: FixtureId | null;
  live: boolean;
  http: string;
  model: string | null;
  /** Explicit authorized campaign directory; required for --live, unused offline. */
  campaign: string | null;
  campaignLimit: number | null;
  now?: () => number;
}

export interface G10WireRecord {
  attemptId: string;
  phase: 'goal' | 'action';
  endpointClass: 'loopback' | 'remote';
  requestBody: unknown;
  requestBodyText: string;
  status: number | null;
  responseBody: string | null;
  usage: { total_tokens: number | null; prompt_tokens: number | null; completion_tokens: number | null } | null;
  error: string | null;
}

export interface G10Runtime {
  game: NeedsGame;
  store: GoalRequestStore;
  config: G08EffectiveConfig;
  meta: AppMeta;
  root: string;
  slot: string;
  ports: ApplicationPorts;
  wire(): G10WireRecord[];
  writeRunRecord(view: AppView): string;
  loadInfo: { path: string; calls: 0 } | null;
}

const ACTOR_IDS = ['npc_a', 'npc_c'] as const;

function endpointClassOf(url: string): 'loopback' | 'remote' {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' ? 'loopback' : 'remote';
  } catch {
    return 'remote';
  }
}

/** The three scripted demos are TEST providers; never production policy. */
export function fixtureProvider(fixture: FixtureId): Provider {
  return {
    async decide(input: { goalChoice?: unknown }) {
      const goal = input.goalChoice !== undefined;
      switch (fixture) {
        case 'cooperate': return goal ? '{"goal":"yield_once"}' : '{"type":"wait"}';
        case 'decline': return goal ? '{"goal":"feed_self"}' : '{"type":"eat"}';
        case 'violate': return goal ? '{"goal":"yield_once"}' : '{"type":"eat"}';
      }
    },
  };
}

/** The offline reference provider (legacy: feed_self then eat). */
export function referenceProvider(): Provider {
  return {
    async decide(input: { goalChoice?: unknown }) {
      return input.goalChoice !== undefined ? '{"goal":"feed_self"}' : '{"type":"eat"}';
    },
  };
}

function isLoopback(url: string): boolean {
  return endpointClassOf(url) === 'loopback';
}

/**
 * Build one runtime around the real createNeedsGame controller. Offline never
 * reads env: only an explicit `--live --http URL --model M --campaign DIR`
 * creates the HTTP path, and this task authorizes no real remote budget.
 */
export function createG10Runtime(options: G10RuntimeOptions): MessageResult<G10Runtime> {
  const now = options.now ?? Date.now;
  const providerKind: ProviderKind = options.live ? 'live' : options.fixture !== null ? 'fixture' : 'reference';
  const scripted = providerKind !== 'live';
  const config: G08EffectiveConfig = {
    mode: options.live ? 'live' : 'reference',
    requestModel: options.live ? options.model : null,
    thinking: true,
    timeoutMs: G09_TIMEOUT_MS,
  };
  if (options.live && (options.model === null || options.model.length === 0)) {
    return messageFail('INVALID_COMMAND', '--live requires --model');
  }
  if (options.live && options.campaign === null) {
    return messageFail('INVALID_COMMAND', '--live requires an explicit authorized --campaign DIR (no new budget is created here)');
  }
  if (options.live && !isLoopback(options.http)) {
    return messageFail('INVALID_COMMAND', 'this task authorizes loopback only; a remote endpoint needs a separately authorized budget');
  }
  if (options.fixture !== null && (options.goals !== 'negotiated' || options.live)) {
    return messageFail('INVALID_COMMAND', '--fixture requires --goals negotiated and cannot be combined with --live');
  }

  const meta: AppMeta = {
    schema: G10_APP_SCHEMA,
    episodeId: options.slot,
    providerKind,
    fixtureId: options.fixture,
    goalMode: options.goals,
    candidateSet: options.candidates,
    satiety: options.satiety,
    scripted,
  };

  const wire: G10WireRecord[] = [];
  let providerFor = (): Provider => (options.fixture !== null ? fixtureProvider(options.fixture) : referenceProvider());
  let campaign: { limit: number; spent: number } | null = null;

  if (options.live) {
    const campaignDir = resolve(options.campaign!);
    try {
      const opened = loadCampaign(campaignDir);
      const limit = options.campaignLimit ?? opened.limit;
      if (!Number.isInteger(limit) || limit < 0) return messageFail('INVALID_COMMAND', 'campaign limit must be a non-negative integer');
      const state = options.campaignLimit === null ? opened : openCampaign(campaignDir, limit, opened.campaignId);
      campaign = { limit: campaignCounts(state).limit, spent: campaignCounts(state).spent };
    } catch {
      if (options.campaignLimit === null) return messageFail('INVALID_COMMAND', 'the campaign ledger does not exist; pass --campaign-limit to create it');
      const state = openCampaign(campaignDir, options.campaignLimit, options.slot);
      campaign = { limit: campaignCounts(state).limit, spent: campaignCounts(state).spent };
    }
    const collector = createWireCollector(fetch);
    const inner = createHttpProvider({
      url: options.http,
      model: String(options.model),
      enableThinking: config.thinking,
      fetchImpl: collector.fetchImpl,
    });
    providerFor = () => ({
      async decide(input, signal) {
        const phase: 'goal' | 'action' = (input as { goalChoice?: unknown }).goalChoice !== undefined ? 'goal' : 'action';
        const reservation = reserveCampaignChat(campaignDir, { batch: options.slot, episodeId: meta.episodeId, phase });
        if (!reservation.ok) throw new Error(`campaign budget: ${reservation.reason}`);
        campaign = campaignCounts(reservation.state);
        try {
          const answer = await inner.decide(input, signal);
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, capture, usage, null));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: 'success', totalTokens: usage?.total_tokens ?? null });
          campaign = campaignCounts(loadCampaign(campaignDir));
          return answer;
        } catch (error) {
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          const message = error instanceof Error ? error.message : String(error);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, capture, usage, message));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: message.includes('timeout') ? 'timeout' : 'provider_error', totalTokens: usage?.total_tokens ?? null });
          campaign = campaignCounts(loadCampaign(campaignDir));
          throw error;
        }
      },
    });
  }

  const initialState = buildNeedsWorld({
    actorIds: [...ACTOR_IDS],
    kitchenFood: 1,
    hunger: { npc_a: options.satiety, npc_b: 40, npc_c: 70 },
  });
  const game = createNeedsGame({
    episodeId: options.slot,
    initialState,
    actorIds: [...ACTOR_IDS],
    providerFor: () => providerFor(),
    mode: config.mode,
    thinking: config.thinking,
    needPolicy: options.goals === 'negotiated' ? 'recurring' : 'one-shot',
    requestModel: config.requestModel ?? undefined,
    timeoutMs: config.timeoutMs,
    actionSet: options.goals === 'negotiated' ? 'timed_wait' : 'legacy',
    goalMode: options.goals,
    candidateSet: options.candidates,
    playerId: 'npc_b',
    now,
  });

  return messageOk({
    game,
    store: game.goalRequests(),
    config,
    meta,
    root: resolve(options.root),
    slot: options.slot,
    ports: createPorts(game, config, meta, resolve(options.root), options.slot, () => campaign, wire, now),
    wire: () => [...wire],
    writeRunRecord: (view: AppView) => writeRunRecord({
      root: resolve(options.root), slot: options.slot, view, meta, config, campaign, wire,
    }),
    loadInfo: null,
  });
}

function wireRecord(
  attemptId: string, phase: 'goal' | 'action', url: string,
  capture: G09WireCapture | null,
  usage: G10WireRecord['usage'],
  error: string | null,
): G10WireRecord {
  return {
    attemptId,
    phase,
    endpointClass: endpointClassOf(url),
    requestBody: capture?.requestBody ?? null,
    requestBodyText: capture?.requestBodyText ?? '',
    status: capture?.status ?? null,
    responseBody: capture?.responseBody ?? null,
    usage,
    error,
  };
}

function createPorts(
  game: NeedsGame,
  config: G08EffectiveConfig,
  meta: AppMeta,
  root: string,
  slot: string,
  campaign: () => { limit: number; spent: number } | null,
  wire: G10WireRecord[],
  now: () => number,
): ApplicationPorts {
  return {
    save(target: string): SaveOutcome {
      const session = game.sessionsOf().find(entry => entry.actorId === 'npc_a')?.session ?? null;
      const saved = saveG09Checkpoint(root, target, game, {
        arm: meta.candidateSet,
        satiety: meta.satiety,
        requests: game.goalRequests(),
        binding: session?.goalBinding ?? null,
        goalMode: meta.goalMode,
        app: { ...meta },
      }, config);
      if (saved.ok) return { ok: true, path: saved.value.path, code: 'OK', issues: [] };
      const busy = saved.code === 'QUEUE_FULL';
      return { ok: false, path: null, code: busy ? 'SAVE_BUSY' : 'SAVE_FAILED', issues: saved.issues ?? [] };
    },
    failure(error: unknown): string | null {
      const session = game.sessionsOf().find(entry => entry.actorId === 'npc_a')?.session ?? null;
      const lastStep = session === null ? undefined : session.steps[session.steps.length - 1];
      const transport: TransportRecord | undefined = lastStep?.transport;
      const path = `${resolve(root, slot)}.failure.json`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({
        schema: G10_FAILURE_SCHEMA,
        at: new Date(now()).toISOString(),
        reason: error instanceof Error ? error.message : String(error),
        meta,
        config,
        phase: session?.phase ?? null,
        sessionStatus: session?.status ?? null,
        requests: game.goalRequests(),
        transport: transport === undefined ? null : {
          requestBody: transport.requestBody,
          status: transport.status,
          usage: transport.usage,
          error: transport.error,
        },
        wire: [...wire],
      }, null, 2)}\n`);
      return path;
    },
    budget: campaign,
    now,
  };
}

export interface LoadG10Options {
  live: boolean;
  model: string | null;
  fixture: FixtureId | null;
  http: string;
  campaign: string | null;
  campaignLimit: number | null;
  /** Only when the user EXPLICITLY passed the flag; a mismatch is refused. */
  goals?: 'legacy' | 'negotiated';
  candidates?: GoalArm;
  satiety?: SatietyLevel;
  now?: () => number;
}

/**
 * Rebuild a saved run from the envelope. A saved slot uses its SAVED mode,
 * model, provider kind and fixture; a conflicting flag is refused before any
 * provider call. Restore is pure data: zero calls, zero submit, no re-choice.
 */
export function loadG10Runtime(path: string, options: LoadG10Options): MessageResult<G10Runtime> {
  const loaded = loadG09Checkpoint(path);
  if (!loaded.ok) return messageFail(loaded.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(loaded.issues ?? []));
  const envelope: G09Checkpoint = loaded.value.envelope;
  const savedMeta = appMetaOf(envelope);
  if (savedMeta.providerKind === 'live' && !options.live) return messageFail('INVALID_COMMAND', 'mode conflict: the slot is a live slot, pass --live');
  if (savedMeta.providerKind !== 'live' && options.live) return messageFail('INVALID_COMMAND', 'mode conflict: the slot is an offline slot');
  if (options.live && envelope.effectiveConfig.requestModel !== options.model) {
    return messageFail('INVALID_COMMAND', `model conflict: the slot was saved with ${JSON.stringify(envelope.effectiveConfig.requestModel)}`);
  }
  if (options.fixture !== null && options.fixture !== savedMeta.fixtureId) {
    return messageFail('INVALID_COMMAND', `fixture conflict: the slot was saved with ${JSON.stringify(savedMeta.fixtureId)}`);
  }
  if (options.goals !== undefined && options.goals !== savedMeta.goalMode) {
    return messageFail('INVALID_COMMAND', `goal-mode conflict: the slot was saved with ${savedMeta.goalMode}`);
  }
  if (options.candidates !== undefined && options.candidates !== envelope.arm) {
    return messageFail('INVALID_COMMAND', `candidate conflict: the slot was saved with ${envelope.arm}`);
  }
  if (options.satiety !== undefined && options.satiety !== envelope.satiety) {
    return messageFail('INVALID_COMMAND', `satiety conflict: the slot was saved with ${envelope.satiety}`);
  }
  if (savedMeta.providerKind === 'live' && (options.campaign === null || !isLoopback(options.http))) {
    return messageFail('INVALID_COMMAND', 'a live slot needs its authorized campaign and a loopback endpoint in this task');
  }

  const wire: G10WireRecord[] = [];
  let campaign: { limit: number; spent: number } | null = null;
  let providerFor = (): Provider => (savedMeta.fixtureId !== null ? fixtureProvider(savedMeta.fixtureId) : referenceProvider());
  if (savedMeta.providerKind === 'live') {
    const campaignDir = resolve(options.campaign!);
    try { campaign = campaignCounts(loadCampaign(campaignDir)); }
    catch { return messageFail('INVALID_SNAPSHOT', 'the saved live run has no campaign ledger to resume'); }
    const collector = createWireCollector(fetch);
    const inner = createHttpProvider({
      url: options.http, model: String(envelope.effectiveConfig.requestModel),
      enableThinking: envelope.effectiveConfig.thinking, fetchImpl: collector.fetchImpl,
    });
    providerFor = () => ({
      async decide(input, signal) {
        const phase: 'goal' | 'action' = (input as { goalChoice?: unknown }).goalChoice !== undefined ? 'goal' : 'action';
        const reservation = reserveCampaignChat(campaignDir, { batch: savedMeta.episodeId, episodeId: savedMeta.episodeId, phase });
        if (!reservation.ok) throw new Error(`campaign budget: ${reservation.reason}`);
        campaign = campaignCounts(reservation.state);
        try {
          const answer = await inner.decide(input, signal);
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, capture, usage, null));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: 'success', totalTokens: usage?.total_tokens ?? null });
          campaign = campaignCounts(loadCampaign(campaignDir));
          return answer;
        } catch (error) {
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          const message = error instanceof Error ? error.message : String(error);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, capture, usage, message));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: message.includes('timeout') ? 'timeout' : 'provider_error', totalTokens: usage?.total_tokens ?? null });
          campaign = campaignCounts(loadCampaign(campaignDir));
          throw error;
        }
      },
    });
  }

  let providerCalls = 0;
  const restored = restoreG09Game(loaded.value, {
    providerFor: () => {
      const provider = providerFor();
      return {
        async decide(input, signal) {
          providerCalls += 1;
          return provider.decide(input, signal);
        },
      };
    },
    now: options.now ?? Date.now,
    playerId: 'npc_b',
  });
  if (!restored.ok) return messageFail(restored.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(restored.issues ?? []));
  const game = restored.value.game as NeedsGame;
  const root = dirname(resolve(path));
  const slot = basename(resolve(path)).replace(/\.g09\.json$/, '');
  return messageOk({
    game,
    store: restored.value.store,
    config: envelope.effectiveConfig,
    meta: savedMeta,
    root,
    slot,
    ports: createPorts(game, envelope.effectiveConfig, savedMeta, root, slot, () => campaign, wire, options.now ?? Date.now),
    wire: () => [...wire],
    writeRunRecord: (view: AppView) => writeRunRecord({
      root, slot, view, meta: savedMeta, config: envelope.effectiveConfig, campaign, wire,
    }),
    loadInfo: { path: resolve(path), calls: 0 },
  });
}

function appMetaOf(envelope: G09Checkpoint): AppMeta {
  const raw = envelope.app as Partial<AppMeta> | undefined;
  const fallback: AppMeta = {
    schema: G10_APP_SCHEMA,
    episodeId: typeof (envelope.app as { episodeId?: unknown } | undefined)?.episodeId === 'string'
      ? String((envelope.app as { episodeId: string }).episodeId)
      : 'slot',
    providerKind: envelope.effectiveConfig.mode === 'live' ? 'live' : 'reference',
    fixtureId: null,
    goalMode: envelope.goalMode ?? 'negotiated',
    candidateSet: envelope.arm,
    satiety: envelope.satiety,
    scripted: envelope.effectiveConfig.mode !== 'live',
  };
  if (raw === undefined || raw.schema !== G10_APP_SCHEMA) return fallback;
  const fixture = raw.fixtureId;
  return {
    schema: G10_APP_SCHEMA,
    episodeId: typeof raw.episodeId === 'string' ? raw.episodeId : fallback.episodeId,
    providerKind: raw.providerKind === 'live' || raw.providerKind === 'fixture' ? raw.providerKind : 'reference',
    fixtureId: fixture === 'cooperate' || fixture === 'decline' || fixture === 'violate' ? fixture : null,
    goalMode: raw.goalMode === 'legacy' ? 'legacy' : 'negotiated',
    candidateSet: raw.candidateSet === 'self_only' ? 'self_only' : 'choice',
    satiety: raw.satiety === 60 ? 60 : 40,
    scripted: raw.providerKind !== 'live',
  };
}

/** Quit writes ONE new run record; an existing run record is never overwritten. */
export function writeRunRecord(input: {
  root: string;
  slot: string;
  view: AppView;
  meta: AppMeta;
  config: G08EffectiveConfig;
  campaign: { limit: number; spent: number } | null;
  wire: G10WireRecord[];
}): string {
  const payload = {
    schema: G10_RUN_SCHEMA,
    at: new Date().toISOString(),
    meta: input.meta,
    config: input.config,
    view: input.view,
    campaign: input.campaign,
    wire: input.wire,
  };
  for (let index = 1; index < 100; index += 1) {
    const slot = index === 1 ? `${input.slot}-run` : `${input.slot}-run-${index}`;
    const written = writeExclusiveSlot(input.root, slot, '.run.json', G10_RUN_SCHEMA, payload);
    if (written.ok) return written.value.path;
    if (written.code !== 'EXISTS') throw new Error(`cannot write the run record: ${written.code} ${(written.issues ?? []).join('; ')}`);
  }
  throw new Error('cannot allocate a run-record slot');
}

/** Exported for the terminal: the scripted demo label (never "model behaviour"). */
export function demoLabel(meta: AppMeta): string | null {
  if (meta.fixtureId === null) return null;
  const names: Record<FixtureId, string> = {
    cooperate: '合作（脚本演示：选择 yield_once 并 wait）',
    decline: '拒绝（脚本演示：选择 feed_self 并 eat）',
    violate: '违约（脚本演示：选择 yield_once 却 eat）',
  };
  return names[meta.fixtureId];
}

/** Re-exported for callers that only need the frozen two-phase prompt text. */
export type { GoalChoiceId, GoalProtocolOptions, Location };
