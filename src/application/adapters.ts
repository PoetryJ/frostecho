/**
 * G10-R1 — provider, save, failure, budget-binding and run-record adapters.
 *
 * Owned by the main agent (single wiring point). A live slot is bound to its
 * exact ledger BEFORE any provider is constructed; the run record is built
 * from the authoritative game snapshot/checkpoint, never from the view.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { messageFail, messageOk, type MessageResult } from '../communication/contracts';
import { G09_TIMEOUT_MS } from '../negotiation/contracts';
import type { GoalProtocolOptions } from '../agent/contracts';
import type { GoalRequestStore } from '../negotiation/requests';
import {
  loadG09Checkpoint, restoreG09Game, saveG09CheckpointDetailed, type G09Checkpoint,
} from '../negotiation/checkpoint';
import { createHttpProvider } from '../agent/providers/http';
import type { Provider, TransportRecord } from '../agent/contracts';
import type { G08EffectiveConfig } from '../temporal/contracts';
import { createNeedsGame, buildNeedsWorld, type NeedsGame } from '../needs/game';
import { createWireCollector, wireUsage, type G09WireCapture } from '../agent/providers/wire';
import { thinkingForPhase } from './thinking';
import {
  campaignCounts, finishCampaignChat, loadCampaign, openCampaign, reserveCampaignChat,
  type CampaignState,
} from '../eval/campaign-budget';
import type { Location } from '../types';
import {
  campaignJsonPath, campaignSummary, canonicalLedgerLocator, createCampaignBinding, validateCampaignBinding,
} from './budget-binding';
import { saveOutcomeFromMessage, writeAuthoritativeRunRecord } from './persistence';
import {
  fixtureNeedsNegotiation, isFixtureId,
  G10_APP_SCHEMA_V2, G10_FAILURE_SCHEMA,
  type ApplicationPorts, type AppMeta, type AppView, type CampaignBinding, type FailureEvidence,
  type FixtureId, type GoalArm, type ProviderKind, type RunRecordLineage, type RunRecordWriteResult,
  type SaveOutcome, type SatietyLevel, type WireRecordEntry,
} from './contracts';

/** G11 demo fixtures run the recurring/timed_wait configuration. */
function isG11Demo(fixture: FixtureId | null): boolean {
  return fixture === 'w0' || fixture === 'w1' || fixture === 'w2';
}

export interface G10RuntimeOptions {
  root: string;
  slot: string;
  goals: 'legacy' | 'negotiated';
  candidates: GoalArm;
  satiety: SatietyLevel;
  /** G11 demo input: explicit starting hunger for npc_a (0..100). */
  startHunger?: number;
  fixture: FixtureId | null;
  live: boolean;
  http: string;
  model: string | null;
  /** Explicit authorized campaign directory; required for --live, unused offline. */
  campaign: string | null;
  campaignLimit: number | null;
  /** Opt-in action-phase thinking; absent inherits `thinking` (true). */
  actionThinking?: boolean;
  now?: () => number;
}

export type G10WireRecord = WireRecordEntry;

export interface G10Runtime {
  game: NeedsGame;
  store: GoalRequestStore;
  config: G08EffectiveConfig;
  meta: AppMeta;
  root: string;
  slot: string;
  ports: ApplicationPorts;
  wire(): WireRecordEntry[];
  /** The immutable binding written with the last save (null offline). */
  campaignBinding(): CampaignBinding | null;
  writeRunRecord(view: AppView, failures?: FailureEvidence[]): RunRecordWriteResult;
  loadInfo: { path: string; calls: 0; parentSlot: string } | null;
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

/**
 * The scripted demos are TEST providers; never production policy.
 *
 * G11 fixtures are purely INPUT-DRIVEN (no hidden call cursor), so a restored
 * session reproduces the same answers:
 *  - w0: the first call of a cycle (empty feedback) waits, then the ordinary
 *    reference eat. No goal phase ever runs.
 *  - w1/w2: the goal phase yields; while the active goal is the yield promise
 *    the action is wait; once ordinary needs are back the reference eat runs.
 *    The player's input (eat or not) decides fulfilled vs expired — the
 *    fixture itself is identical, so each trajectory stays honest.
 */
export function fixtureProvider(fixture: FixtureId): Provider {
  return {
    async decide(input: { goalChoice?: unknown; feedback?: unknown; activeGoal?: { kind?: string } }) {
      const goal = input.goalChoice !== undefined;
      switch (fixture) {
        case 'cooperate': return goal ? '{"goal":"yield_once"}' : '{"type":"wait"}';
        case 'decline': return goal ? '{"goal":"feed_self"}' : '{"type":"eat"}';
        case 'violate': return goal ? '{"goal":"yield_once"}' : '{"type":"eat"}';
        case 'w0': return input.feedback === null || input.feedback === undefined ? '{"type":"wait"}' : '{"type":"eat"}';
        case 'w1':
        case 'w2': {
          if (goal) return '{"goal":"yield_once"}';
          return input.activeGoal?.kind === 'yield_once' ? '{"type":"wait"}' : '{"type":"eat"}';
        }
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

function invalidRoot(root: string): string | null {
  try {
    const stat = statSync(resolve(root));
    return stat.isDirectory() ? null : `--root ${JSON.stringify(resolve(root))} exists and is not a directory`;
  } catch {
    return null; // absent is fine: it will be created on the first write
  }
}

function lineageOf(parentSlot: string | null, wire: WireRecordEntry[]): RunRecordLineage {
  return {
    baseCommit: process.env.FROSTECHO_COMMIT ?? null,
    parentSlot,
    attemptRange: {
      first: wire.length === 0 ? null : wire[0]!.attemptId,
      last: wire.length === 0 ? null : wire[wire.length - 1]!.attemptId,
      count: wire.length,
    },
  };
}

/**
 * Build one runtime around the real createNeedsGame controller. Offline never
 * reads env: only an explicit `--live --http URL --model M --campaign DIR`
 * creates the HTTP path, and this task authorizes no real remote budget.
 */
export function createG10Runtime(options: G10RuntimeOptions): MessageResult<G10Runtime> {
  const now = options.now ?? Date.now;
  const rootProblem = invalidRoot(options.root);
  if (rootProblem !== null) return messageFail('INVALID_COMMAND', rootProblem);
  const providerKind: ProviderKind = options.live ? 'live' : options.fixture !== null ? 'fixture' : 'reference';
  const scripted = providerKind !== 'live';
  const config: G08EffectiveConfig = {
    mode: options.live ? 'live' : 'reference',
    requestModel: options.live ? options.model : null,
    thinking: true,
    // Only an explicit experiment override is serialized; absent keeps the
    // slot/record key set exactly as before.
    ...(options.actionThinking !== undefined ? { actionThinking: options.actionThinking } : {}),
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
  if (options.fixture !== null && options.live) {
    return messageFail('INVALID_COMMAND', '--fixture cannot be combined with --live');
  }
  if (options.fixture !== null && fixtureNeedsNegotiation(options.fixture) && options.goals !== 'negotiated') {
    return messageFail('INVALID_COMMAND', `--fixture ${options.fixture} requires --goals negotiated`);
  }

  const meta: AppMeta = {
    schema: G10_APP_SCHEMA_V2,
    episodeId: options.slot,
    providerKind,
    fixtureId: options.fixture,
    goalMode: options.goals,
    candidateSet: options.candidates,
    satiety: options.satiety,
    ...(options.startHunger !== undefined && options.startHunger !== options.satiety ? { startHunger: options.startHunger } : {}),
    scripted,
    campaign: null,
  };

  const wire: WireRecordEntry[] = [];
  let providerFor = (): Provider => (options.fixture !== null ? fixtureProvider(options.fixture) : referenceProvider());
  let ledger: CampaignState | null = null;
  let campaignJson: string | null = null;
  let savedBinding: CampaignBinding | null = null;
  /** G11-live: continuation budget gate (live only); injected, never serialized. */
  let externalBudget: ((actorId: string) => boolean) | undefined;

  if (options.live) {
    const campaignDir = resolve(options.campaign!);
    try {
      const opened = loadCampaign(campaignDir);
      const limit = options.campaignLimit ?? opened.limit;
      if (!Number.isInteger(limit) || limit < 0) return messageFail('INVALID_COMMAND', 'campaign limit must be a non-negative integer');
      ledger = options.campaignLimit === null ? opened : openCampaign(campaignDir, limit, opened.campaignId);
    } catch {
      if (options.campaignLimit === null) return messageFail('INVALID_COMMAND', 'the campaign ledger does not exist; pass --campaign-limit to create it');
      ledger = openCampaign(campaignDir, options.campaignLimit, options.slot);
    }
    campaignJson = campaignJsonPath(campaignDir);
    // G11-live: consult the AUTHORITATIVE persistent ledger before a
    // continuation cycle opens; the reserve above stays the hard limit.
    externalBudget = makeCampaignBudgetGate(campaignDir);
    const collector = createWireCollector(fetch);
    // One HTTP provider per distinct thinking value; both share the SAME wire
    // collector, budget reserve and ledger, so a phase still costs exactly one
    // call and the evidence is unchanged by the extra provider object.
    const providers = new Map<boolean, Provider>();
    const providerForThinking = (enableThinking: boolean): Provider => {
      const existing = providers.get(enableThinking);
      if (existing !== undefined) return existing;
      const created = createHttpProvider({
        url: options.http,
        model: String(options.model),
        enableThinking,
        fetchImpl: collector.fetchImpl,
      });
      providers.set(enableThinking, created);
      return created;
    };
    providerFor = () => ({
      async decide(input, signal) {
        const phase: 'goal' | 'action' = (input as { goalChoice?: unknown }).goalChoice !== undefined ? 'goal' : 'action';
        const reservation = reserveCampaignChat(campaignDir, { batch: options.slot, episodeId: meta.episodeId, phase });
        if (!reservation.ok) throw new Error(`campaign budget: ${reservation.reason}`);
        ledger = reservation.state;
        const inner = providerForThinking(thinkingForPhase(input, config));
        try {
          const answer = await inner.decide(input, signal);
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, options.model, capture, usage, null));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: 'success', totalTokens: usage?.total_tokens ?? null });
          ledger = loadCampaign(campaignDir);
          return answer;
        } catch (error) {
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          const message = error instanceof Error ? error.message : String(error);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, options.model, capture, usage, message));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: message.includes('timeout') ? 'timeout' : 'provider_error', totalTokens: usage?.total_tokens ?? null });
          ledger = loadCampaign(campaignDir);
          throw error;
        }
      },
    });
  }

  const initialState = buildNeedsWorld({
    actorIds: [...ACTOR_IDS],
    kitchenFood: 1,
    hunger: { npc_a: options.startHunger ?? options.satiety, npc_b: 40, npc_c: 70 },
  });
  const game = createNeedsGame({
    episodeId: options.slot,
    initialState,
    actorIds: [...ACTOR_IDS],
    providerFor: () => providerFor(),
    mode: config.mode,
    thinking: config.thinking,
    ...(config.actionThinking !== undefined ? { actionThinking: config.actionThinking } : {}),
    // G11 demos run the recurring/timed_wait configuration even without a
    // negotiated request (W0 is an ordinary wait), exactly as the contract
    // freezes it; the G09/G10 matrix semantics are untouched.
    needPolicy: options.goals === 'negotiated' || isG11Demo(options.fixture) ? 'recurring' : 'one-shot',
    requestModel: config.requestModel ?? undefined,
    timeoutMs: config.timeoutMs,
    actionSet: options.goals === 'negotiated' || isG11Demo(options.fixture) ? 'timed_wait' : 'legacy',
    goalMode: options.goals,
    candidateSet: options.candidates,
    playerId: 'npc_b',
    now,
    ...(externalBudget !== undefined ? { externalBudget } : {}),
  });

  const runtimeRoot = resolve(options.root);
  return messageOk({
    game,
    store: game.goalRequests(),
    config,
    meta,
    root: runtimeRoot,
    slot: options.slot,
    ports: createPorts({
      game, config, meta, root: runtimeRoot, slot: options.slot,
      ledger: () => ledger,
      campaignJson: () => campaignJson,
      onBinding: binding => { savedBinding = binding; },
      binding: () => savedBinding,
      wire,
      now,
      parentSlot: null,
    }),
    wire: () => [...wire],
    campaignBinding: () => savedBinding,
    writeRunRecord: (view: AppView, failures?: FailureEvidence[]) => writeRunRecord({
      game, store: game.goalRequests(), root: runtimeRoot, slot: options.slot, view, meta, config,
      wire, parentSlot: null, ledger: ledger === null ? null : summaryOf(ledger), binding: savedBinding, now, failures,
    }),
    loadInfo: null,
  });
}

function summaryOf(ledger: CampaignState): { limit: number; spent: number; known: number | null } {
  return campaignSummary(ledger);
}

/**
 * G11-live: the external campaign budget gate consulted BEFORE a continuation
 * cycle opens (the per-call reserve stays the hard limit). Reads the
 * AUTHORITATIVE persistent ledger fresh on every call — never a stale memory
 * copy — and a read failure fails CLOSED: no continuation, no provider call.
 */
function makeCampaignBudgetGate(campaignDir: string): (actorId: string) => boolean {
  return _actorId => {
    try {
      const current = loadCampaign(campaignDir);
      return current.spent < current.limit;
    } catch {
      return false;
    }
  };
}

function wireRecord(
  attemptId: string, phase: 'goal' | 'action', url: string, model: string | null,
  capture: G09WireCapture | null,
  usage: WireRecordEntry['usage'],
  error: string | null,
): WireRecordEntry {
  return {
    attemptId,
    phase,
    endpointClass: endpointClassOf(url),
    providerSource: 'http',
    model,
    requestBody: capture?.requestBody ?? null,
    requestBodyText: capture?.requestBodyText ?? '',
    status: capture?.status ?? null,
    responseBody: capture?.responseBody ?? null,
    usage,
    error,
  };
}

function createPorts(input: {
  game: NeedsGame;
  config: G08EffectiveConfig;
  meta: AppMeta;
  root: string;
  slot: string;
  ledger: () => CampaignState | null;
  campaignJson: () => string | null;
  onBinding(binding: CampaignBinding | null): void;
  binding: () => CampaignBinding | null;
  wire: WireRecordEntry[];
  now: () => number;
  parentSlot: string | null;
}): ApplicationPorts {
  const { game, config, meta, root, slot, wire, now } = input;
  return {
    save(target: string): SaveOutcome {
      // A live save is bound to the ledger's CURRENT immutable identity and
      // spent history; the binding is written inside the same exclusive slot.
      let metaToSave: AppMeta = { ...meta, schema: G10_APP_SCHEMA_V2, campaign: null };
      if (meta.providerKind === 'live') {
        const ledger = input.ledger();
        const json = input.campaignJson();
        if (ledger === null || json === null) {
          return { ok: false, path: null, code: 'INTERNAL', fatal: true, issues: ['the live run has no campaign ledger'], cause: 'live run without a ledger' };
        }
        const bound = createCampaignBinding(ledger, json, now);
        if (!bound.ok) {
          return { ok: false, path: null, code: 'INVALID_SNAPSHOT', fatal: false, issues: bound.issues, cause: bound.issues.join('; ') };
        }
        metaToSave = { ...metaToSave, campaign: bound.binding };
        input.onBinding(bound.binding);
      }
      const session = game.sessionsOf().find(entry => entry.actorId === 'npc_a')?.session ?? null;
      const saved = saveG09CheckpointDetailed(root, target, game, {
        arm: meta.candidateSet,
        satiety: meta.satiety,
        requests: game.goalRequests(),
        binding: session?.goalBinding ?? null,
        goalMode: meta.goalMode,
        app: { ...metaToSave } as Record<string, unknown>,
      }, config);
      const outcome = saveOutcomeFromMessage(saved);
      if (!outcome.ok && metaToSave.campaign !== null) input.onBinding(null);
      return outcome;
    },
    failure(error: unknown): string | null {
      try {
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
      } catch {
        // A bad root cannot hold evidence; the caller reports the original
        // cause on stderr and the finalization stays nonzero. Never throw here.
        return null;
      }
    },
    budget: () => (input.ledger() === null ? null : summaryOf(input.ledger()!)),
    writeRunRecord(view: AppView, failures?: FailureEvidence[]): RunRecordWriteResult {
      return writeRunRecord({
        game, store: game.goalRequests(), root, slot, view, meta, config, wire,
        parentSlot: input.parentSlot,
        ledger: input.ledger() === null ? null : summaryOf(input.ledger()!),
        binding: input.binding(),
        now,
        failures,
      });
    },
    now,
  };
}

function writeRunRecord(input: {
  game: NeedsGame;
  store: GoalRequestStore;
  root: string;
  slot: string;
  view: AppView;
  meta: AppMeta;
  config: G08EffectiveConfig;
  wire: WireRecordEntry[];
  parentSlot: string | null;
  ledger: { limit: number; spent: number; known: number | null } | null;
  binding: CampaignBinding | null;
  now: () => number;
  failures?: FailureEvidence[];
}): RunRecordWriteResult {
  return writeAuthoritativeRunRecord({
    root: input.root,
    slot: input.slot,
    game: input.game,
    store: input.store,
    meta: input.meta,
    config: input.config,
    beforeCloseView: input.view,
    wire: input.wire,
    lineage: lineageOf(input.parentSlot, input.wire),
    campaign: input.ledger === null ? null : {
      binding: input.binding,
      limit: input.ledger.limit,
      spent: input.ledger.spent,
      known: input.ledger.known,
    },
    now: input.now,
    failures: input.failures,
  });
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
  /** G11 demo input; only an explicitly passed value is compared. */
  startHunger?: number;
  /** Only when the user EXPLICITLY passed the flag; a conflict is refused. */
  actionThinking?: boolean;
  now?: () => number;
}

/**
 * Rebuild a saved run from the envelope. A live slot is validated against its
 * SAVED ledger binding BEFORE any provider is constructed; a mismatch is a
 * named refusal with zero POST and zero Engine.submit.
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
  // An explicit action-thinking flag must agree with the EFFECTIVE value the
  // slot was saved with; absent means "adopt the slot". Refuse before any
  // provider exists: zero POST, zero writes to the original slot.
  if (options.actionThinking !== undefined) {
    const savedActionThinking = envelope.effectiveConfig.actionThinking ?? envelope.effectiveConfig.thinking;
    if (options.actionThinking !== savedActionThinking) {
      return messageFail('INVALID_COMMAND',
        `action-thinking conflict: the slot was saved with ${String(savedActionThinking)}, not ${String(options.actionThinking)}`);
    }
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
  if (options.startHunger !== undefined && options.startHunger !== (savedMeta.startHunger ?? envelope.satiety)) {
    return messageFail('INVALID_COMMAND', `start-hunger conflict: the slot was saved with ${savedMeta.startHunger ?? envelope.satiety}`);
  }

  const wire: WireRecordEntry[] = [];
  let ledger: CampaignState | null = null;
  let campaignJson: string | null = null;
  let savedBinding: CampaignBinding | null = savedMeta.campaign ?? null;
  let providerFor = (): Provider => (savedMeta.fixtureId !== null ? fixtureProvider(savedMeta.fixtureId) : referenceProvider());
  /** G11-live: continuation budget gate (live only); injected, never serialized. */
  let externalBudget: ((actorId: string) => boolean) | undefined;

  if (savedMeta.providerKind === 'live') {
    if (options.campaign === null) return messageFail('INVALID_COMMAND', 'CAMPAIGN_BINDING_MISSING: a live slot needs its authorized campaign directory');
    if (!isLoopback(options.http)) return messageFail('INVALID_COMMAND', 'this task authorizes loopback only; a remote endpoint needs a separately authorized budget');
    if (savedBinding === null) {
      return messageFail('INVALID_COMMAND', 'CAMPAIGN_BINDING_MISSING: this live slot was saved without a campaign binding; it cannot be attached to a ledger automatically');
    }
    if (options.campaignLimit !== null && options.campaignLimit !== savedBinding.limit) {
      return messageFail('INVALID_COMMAND', `LEDGER_LIMIT_MISMATCH: the slot authorizes ${savedBinding.limit}, not ${options.campaignLimit}`);
    }
    const campaignDir = resolve(options.campaign);
    campaignJson = campaignJsonPath(campaignDir);
    try {
      ledger = loadCampaign(campaignDir);
    } catch (error) {
      return messageFail('INVALID_COMMAND', `LEDGER_MISSING: ${error instanceof Error ? error.message : String(error)}`);
    }
    const check = validateCampaignBinding(savedBinding, ledger, campaignJson);
    if (!check.ok) {
      return messageFail('INVALID_COMMAND', `${check.code}: ${check.issues.join('; ')}`);
    }
    // G11-live: the restored game consults the SAME authoritative ledger before
    // a continuation cycle opens — same identity/path/limit as the slot binding.
    externalBudget = makeCampaignBudgetGate(campaignDir);
    const collector = createWireCollector(fetch);
    // The restored runtime picks its provider from the SLOT's effective
    // configuration, so a saved actionThinking=false survives the process
    // boundary and never falls back to the goal value.
    const savedConfig = envelope.effectiveConfig;
    const providers = new Map<boolean, Provider>();
    const providerForThinking = (enableThinking: boolean): Provider => {
      const existing = providers.get(enableThinking);
      if (existing !== undefined) return existing;
      const created = createHttpProvider({
        url: options.http, model: String(savedConfig.requestModel),
        enableThinking, fetchImpl: collector.fetchImpl,
      });
      providers.set(enableThinking, created);
      return created;
    };
    providerFor = () => ({
      async decide(input, signal) {
        const phase: 'goal' | 'action' = (input as { goalChoice?: unknown }).goalChoice !== undefined ? 'goal' : 'action';
        const reservation = reserveCampaignChat(campaignDir, { batch: savedMeta.episodeId, episodeId: savedMeta.episodeId, phase });
        if (!reservation.ok) throw new Error(`campaign budget: ${reservation.reason}`);
        ledger = reservation.state;
        const inner = providerForThinking(thinkingForPhase(input, savedConfig));
        try {
          const answer = await inner.decide(input, signal);
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, envelope.effectiveConfig.requestModel, capture, usage, null));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: 'success', totalTokens: usage?.total_tokens ?? null });
          ledger = loadCampaign(campaignDir);
          return answer;
        } catch (error) {
          const capture = collector.take();
          const usage = capture === null || capture.responseBody === null ? null : wireUsage(capture.responseBody);
          const message = error instanceof Error ? error.message : String(error);
          wire.push(wireRecord(reservation.attemptId, phase, options.http, envelope.effectiveConfig.requestModel, capture, usage, message));
          finishCampaignChat(campaignDir, reservation.attemptId, { outcome: message.includes('timeout') ? 'timeout' : 'provider_error', totalTokens: usage?.total_tokens ?? null });
          ledger = loadCampaign(campaignDir);
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
    // G11-live: same authoritative campaign gate as the fresh path.
    ...(externalBudget !== undefined ? { externalBudget } : {}),
  });
  if (!restored.ok) return messageFail(restored.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(restored.issues ?? []));
  const game = restored.value.game as NeedsGame;
  const root = dirname(resolve(path));
  const slot = basename(resolve(path)).replace(/\.g09\.json$/, '');
  const parentSlot = resolve(path);
  return messageOk({
    game,
    store: restored.value.store,
    config: envelope.effectiveConfig,
    meta: savedMeta,
    root,
    slot,
    ports: createPorts({
      game, config: envelope.effectiveConfig, meta: savedMeta, root, slot,
      ledger: () => ledger,
      campaignJson: () => campaignJson,
      onBinding: binding => { savedBinding = binding; },
      binding: () => savedBinding,
      wire,
      now: options.now ?? Date.now,
      parentSlot,
    }),
    wire: () => [...wire],
    campaignBinding: () => savedBinding,
    writeRunRecord: (view: AppView, failures?: FailureEvidence[]) => writeRunRecord({
      game, store: restored.value.store, root, slot, view, meta: savedMeta,
      config: envelope.effectiveConfig, wire, parentSlot,
      ledger: ledger === null ? null : summaryOf(ledger),
      binding: savedBinding, now: options.now ?? Date.now, failures,
    }),
    loadInfo: { path: parentSlot, calls: 0, parentSlot },
  });
}

function appMetaOf(envelope: G09Checkpoint): AppMeta {
  const raw = envelope.app as Partial<AppMeta> | undefined;
  const fallback: AppMeta = {
    schema: G10_APP_SCHEMA_V2,
    episodeId: typeof (envelope.app as { episodeId?: unknown } | undefined)?.episodeId === 'string'
      ? String((envelope.app as { episodeId: string }).episodeId)
      : 'slot',
    providerKind: envelope.effectiveConfig.mode === 'live' ? 'live' : 'reference',
    fixtureId: null,
    goalMode: envelope.goalMode ?? 'negotiated',
    candidateSet: envelope.arm,
    satiety: envelope.satiety,
    scripted: envelope.effectiveConfig.mode !== 'live',
    campaign: null,
  };
  // /1 slots have no campaign binding; live ones are refused on load.
  if (raw === undefined || (raw.schema !== G10_APP_SCHEMA_V2 && raw.schema !== 'frostecho.g10.app/1')) return fallback;
  const fixture = raw.fixtureId;
  return {
    schema: G10_APP_SCHEMA_V2,
    episodeId: typeof raw.episodeId === 'string' ? raw.episodeId : fallback.episodeId,
    providerKind: raw.providerKind === 'live' || raw.providerKind === 'fixture' ? raw.providerKind : 'reference',
    fixtureId: typeof fixture === 'string' && isFixtureId(fixture) ? fixture : null,
    goalMode: raw.goalMode === 'legacy' ? 'legacy' : 'negotiated',
    candidateSet: raw.candidateSet === 'self_only' ? 'self_only' : 'choice',
    satiety: raw.satiety === 60 ? 60 : 40,
    scripted: raw.providerKind !== 'live',
    campaign: raw.schema === G10_APP_SCHEMA_V2 ? (raw.campaign ?? null) : null,
  };
}

/** Exported for tests: the canonical ledger locator used by the binding. */
export { canonicalLedgerLocator };

/** Exported for the terminal: the scripted demo label (never "model behaviour"). */
export function demoLabel(meta: AppMeta): string | null {
  if (meta.fixtureId === null) return null;
  const names: Record<FixtureId, string> = {
    cooperate: '合作（脚本演示：选择 yield_once 并 wait）',
    decline: '拒绝（脚本演示：选择 feed_self 并 eat）',
    violate: '违约（脚本演示：选择 yield_once 却 eat）',
    w0: 'W0 普通等待（脚本演示：先 wait，到期后同 cycle 继续吃）',
    w1: 'W1 让食履约后（脚本演示：yield+wait，玩家吃到后恢复自己的饱食需求）',
    w2: 'W2 让食到期后（脚本演示：yield+wait，玩家没吃，到期后恢复自己的饱食需求）',
  };
  return names[meta.fixtureId];
}

/** Re-exported for callers that only need the frozen two-phase prompt text. */
export type { GoalProtocolOptions, Location };
