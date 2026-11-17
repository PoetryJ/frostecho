#!/usr/bin/env node
/**
 * G10-R1 worker D — the frozen live plan. It PROPOSES 16 chats and AUTHORIZES
 * 0: no ledger with real quota is created here, no endpoint is contacted.
 *
 * Usage: node scripts/g10-live-plan.mjs [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  G09_ALLOWED_GOALS, G09_HARD_CHAT_LIMIT, G09_REQUEST_TEXT, G09_TIMEOUT_MS, G09_GOAL_MODE,
} from '../dist/src/negotiation/contracts.js';
import { g09Plan, g09RuntimeConfig, G09_CELLS } from '../dist/scripts/g09-eval-lib.js';

const out = resolve(process.argv[2] ?? 'artifacts/g10-r1');
mkdirSync(out, { recursive: true });

const plan = g09Plan('live-plan');
const matrix = plan.plan.map(entry => [entry.rep, entry.satiety, entry.arm]);

const livePlan = {
  schema: 'frostecho.g10.live-plan/1',
  createdAt: new Date().toISOString(),
  status: 'awaiting_owner_authorization',
  proposedChatLimit: G09_HARD_CHAT_LIMIT,
  authorizedChatLimit: 0,
  automaticRetries: 0,
  extraWaitContinuationCalls: 0,
  episodes: matrix.length,
  callsPerEpisode: 2,
  matrix,
  request: {
    text: G09_REQUEST_TEXT,
    arms: {
      self_only: G09_ALLOWED_GOALS.self_only,
      choice: G09_ALLOWED_GOALS.choice,
    },
    bothArmsSameS1: true,
    createdAtSimTime: 0,
    expiresAtSimTime: 1,
  },
  world: {
    npcA: { satietyLevels: [40, 60], playerId: 'npc_b', companionId: 'npc_c' },
    playerHunger: 40,
    companionHunger: 70,
    kitchenFood: 1,
    needPolicy: g09RuntimeConfig().needPolicy,
    wakePolicy: g09RuntimeConfig().policy,
    actionSet: g09RuntimeConfig().actionSet,
    actors: g09RuntimeConfig().actorIds,
    goalMode: G09_GOAL_MODE,
    repetition2Reversed: true,
  },
  model: {
    name: 'qwen3.8-27b',
    thinking: true,
    temperature: 0,
    maxTokens: 1024,
    stream: false,
    timeoutMs: G09_TIMEOUT_MS,
    endpointKind: 'full /v1/chat/completions',
    modelListValidation: 'GET /v1/models must list the model before any authorized call',
  },
  providerSource: 'test-owned loopback HTTP server (rehearsal only)',
  endpointClassNote: '127.0.0.1 is an address class, not proof that the peer is a fake model; the rehearsal report names the test-owned server and captured wire.',
  structureGate: 'the first pair (4 POST) must pass verify before the rest may run',
  successDefinition: 'complete legal protocol + evidence chain; model cooperation is NOT required',
  perEpisodeReport: ['goal', 'request accepted/declined', 'action', 'fulfilment', 'both actors state', 'two-phase tokens', 'latency', 'unknown usage'],
  controlRestricted: 'a feed_self choice is reported as a control choice, never as an autonomous refusal',
  history: {
    label: 'out_of_contract',
    oldChatRequests: 17,
    knownTokens: 9970,
    totalTokens: 'unknown',
    note: 'not comparable to a new controlled batch; kept separate',
  },
  commands: {
    rehearsal: 'node scripts/g10-live-rehearse.mjs artifacts/g10-r1/rehearsal',
    verify: 'node dist/scripts/eval-g09.js --verify --out artifacts/g10-r1/rehearsal/artifacts --batch loopback-live --campaign artifacts/g10-r1/rehearsal/campaign',
    futureAuthorizedRun: 'node dist/scripts/eval-g09.js --out DIR --batch NAME --campaign DIR --campaign-limit 16 --live --http URL --model qwen3.8-27b',
    futureVerify: 'node dist/scripts/eval-g09.js --verify --out DIR --batch NAME --campaign DIR',
  },
  costReportTemplate: {
    chatRequests: 0,
    spentOfAuthorized: '0/0',
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    unknownUsage: 0,
    goalTokens: 0,
    actionTokens: 0,
    totalTokens: null,
  },
  cells: G09_CELLS,
  authorized: false,
};

const path = join(out, 'live-plan.json');
writeFileSync(path, `${JSON.stringify(livePlan, null, 2)}\n`);
console.log(`live-plan -> ${path} (proposed ${livePlan.proposedChatLimit}, authorized ${livePlan.authorizedChatLimit}, ${livePlan.status})`);
