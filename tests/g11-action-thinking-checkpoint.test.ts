/**
 * B: the optional actionThinking must survive the .g09 slot, and nothing else
 * may change. Offline (fixture provider, zero HTTP, zero POST).
 *
 * Pinned here:
 *   - an explicit false is written to BOTH the envelope and the embedded game,
 *     restored into the runtime and handed to the provider layer;
 *   - a slot without the flag keeps its original key set byte-for-byte;
 *   - envelope/game disagreement, a non-boolean value or a tampered checksum
 *     are refused BEFORE any provider call or command;
 *   - restoring itself performs 0 calls, 0 commands and rewrites no byte.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createG10Runtime, loadG10Runtime } from '../src/application/adapters';
import { createApplicationController } from '../src/application/session';
import { parseInput } from '../src/application/commands';
import type { ApplicationController } from '../src/application/contracts';
import { loadG09Checkpoint } from '../src/negotiation/checkpoint';
import { slotChecksum } from '../src/persistence/atomic-slot';

const OFFLINE_LOAD = { live: false, model: null, fixture: 'w1' as const, http: '', campaign: null, campaignLimit: null };

interface Saved { path: string; controller: ApplicationController; callsBefore: number }

async function saveW1(actionThinking?: boolean): Promise<Saved> {
  const base = mkdtempSync(join(tmpdir(), 'fe-action-slot-'));
  const built = createG10Runtime({
    root: base, slot: 'b-off', goals: 'negotiated', candidates: 'choice', satiety: 40,
    fixture: 'w1', live: false, http: '', model: null, campaign: null, campaignLimit: null,
    ...(actionThinking !== undefined ? { actionThinking } : {}),
  });
  assert.equal(built.ok, true, built.ok ? '' : (built.issues ?? []).join('; '));
  const runtime = built.value;
  const controller = createApplicationController({
    game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot, meta: runtime.meta, ports: runtime.ports,
  });
  for (const line of ['request npc_a yield_once', 'run 1', 'run 1']) {
    const parsed = parseInput(line);
    assert.equal(parsed.ok, true);
    const result = await controller.execute(parsed.command);
    assert.equal(result.ok, true, `${line}: ${result.code} ${result.detail ?? ''}`);
  }
  const parsedSave = parseInput('save b-off');
  assert.equal(parsedSave.ok, true);
  const saved = await controller.execute(parsedSave.command);
  assert.equal(saved.ok, true, `${saved.code} ${saved.detail ?? ''}`);
  const slotPath = controller.view().savedPath;
  assert.notEqual(slotPath, null);
  return { path: slotPath!, controller, callsBefore: runtime.wire().length };
}

const payloadOf = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

function resign(path: string, edit: (payload: Record<string, any>) => void): void {
  const file = payloadOf(path);
  edit(file.payload as Record<string, any>);
  file.sha256 = slotChecksum(file.payload);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

test('explicit action off is written, restored and handed to the provider layer', async () => {
  const saved = await saveW1(false);
  const before = readFileSync(saved.path);
  const loadedSlot = loadG09Checkpoint(saved.path);
  assert.equal(loadedSlot.ok, true, loadedSlot.ok ? '' : (loadedSlot.issues ?? []).join('; '));
  const envelope = loadedSlot.value.envelope;
  assert.equal(envelope.effectiveConfig.actionThinking, false);
  assert.equal((envelope.game as unknown as { actionThinking?: boolean }).actionThinking, false, 'the game record carries the same value');

  const loaded = loadG10Runtime(saved.path, OFFLINE_LOAD);
  assert.equal(loaded.ok, true, loaded.ok ? '' : (loaded.issues ?? []).join('; '));
  assert.equal(loaded.value.config.actionThinking, false, 'restore does not fall back to the goal value');
  assert.equal((loaded.value.game as unknown as { actionThinking?: boolean }).actionThinking, false);
  assert.equal(loaded.value.loadInfo?.calls, 0, 'restore makes no provider call');
  assert.equal(loaded.value.wire().length, 0, 'restore sends nothing');
  assert.equal(readFileSync(saved.path).equals(before), true, 'load never rewrites the original slot');
});

test('a slot saved without the flag keeps its original key set and meaning', async () => {
  const saved = await saveW1();
  const text = readFileSync(saved.path, 'utf8');
  assert.equal(text.includes('actionThinking'), false, 'no new key on an old-shaped slot');
  const loaded = loadG10Runtime(saved.path, OFFLINE_LOAD);
  assert.equal(loaded.ok, true, loaded.ok ? '' : (loaded.issues ?? []).join('; '));
  assert.equal('actionThinking' in loaded.value.config, false);
  assert.equal((loaded.value.game as unknown as { actionThinking?: boolean }).actionThinking, undefined);
});

test('an envelope/game disagreement is refused before anything runs', async () => {
  const saved = await saveW1();
  resign(saved.path, payload => { (payload.effectiveConfig as Record<string, any>).actionThinking = true; });
  const loaded = loadG10Runtime(saved.path, OFFLINE_LOAD);
  assert.equal(loaded.ok, false);
  assert.match((loaded.ok ? [] : loaded.issues ?? []).join('; '), /disagrees|effectiveConfig/);
});

test('a non-boolean actionThinking is refused by slot validation', async () => {
  const saved = await saveW1();
  resign(saved.path, payload => {
    (payload.effectiveConfig as Record<string, any>).actionThinking = 'false';
    (payload.game as Record<string, any>).actionThinking = 'false';
  });
  const loaded = loadG10Runtime(saved.path, OFFLINE_LOAD);
  assert.equal(loaded.ok, false);
  assert.match((loaded.ok ? [] : loaded.issues ?? []).join('; '), /actionThinking must be a boolean/);
});

test('a tampered checksum is still rejected (the new field adds no bypass)', async () => {
  const saved = await saveW1(false);
  const file = payloadOf(saved.path);
  (file.payload as Record<string, any>).effectiveConfig.actionThinking = true;
  writeFileSync(saved.path, `${JSON.stringify(file, null, 2)}\n`);
  const loaded = loadG10Runtime(saved.path, OFFLINE_LOAD);
  assert.equal(loaded.ok, false);
  assert.match((loaded.ok ? [] : loaded.issues ?? []).join('; '), /sha256|checksum/i);
});
