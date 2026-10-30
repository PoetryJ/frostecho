/**
 * H01 — deterministic per-game evidence verifier. Re-derives everything the
 * harness saved: sidecar files, engine replay, replayMatches, goal, scenario
 * judgement, the step/command ledger, and the parser result. Never throws.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOAL_HUNGER_AT_LEAST } from '../agent/contracts';
import { parseAction } from '../agent/parser';
import { Engine, replay } from '../engine';
import type { GameRecord } from '../play/game';
import { judgeScenario } from '../play/scenarios';
import type { ScenarioId } from '../play/scenarios';
import type { WorldState } from '../types';
import { canonical } from '../util';

export interface GameEvidenceVerification {
  ok: boolean;
  issues: string[];
  game: GameRecord | null;
}

const REQUIRED_FILES = [
  'game.json', 'commands.json', 'events.json', 'steps.json',
  'initial-state.json', 'final-state.json', 'replay.json', 'meta.json',
] as const;

const META_FIELDS = [
  'batchId', 'scenarioId', 'mode', 'thinking', 'scenarioPass',
  'goalReached', 'outcome', 'providerCalls', 'replayMatches',
] as const;

function readJsonFile(path: string, name: string, issues: string[]): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    issues.push(`${name} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifyGameEvidence(gameDir: string): GameEvidenceVerification {
  const issues: string[] = [];
  // 1. required files
  const present = new Map<string, boolean>();
  for (const name of REQUIRED_FILES) {
    const ok = existsSync(join(gameDir, name));
    present.set(name, ok);
    if (!ok) issues.push(`${name} missing`);
  }
  const gameRaw = present.get('game.json')
    ? readJsonFile(join(gameDir, 'game.json'), 'game.json', issues)
    : undefined;
  if (gameRaw === undefined || gameRaw === null || typeof gameRaw !== 'object' || Array.isArray(gameRaw)) {
    return { ok: false, issues, game: null };
  }
  const game = gameRaw as GameRecord;
  const meta = present.get('meta.json')
    ? readJsonFile(join(gameDir, 'meta.json'), 'meta.json', issues) as Record<string, unknown> | undefined
    : undefined;
  const replayFile = present.get('replay.json')
    ? readJsonFile(join(gameDir, 'replay.json'), 'replay.json', issues) as { matches?: unknown } | undefined
    : undefined;

  // 2. sidecar files must canonically equal the matching game.json content
  const sides: readonly (readonly [string, unknown])[] = [
    ['commands.json', game.commands],
    ['events.json', game.events],
    ['steps.json', game.steps],
    ['initial-state.json', game.initialState],
    ['final-state.json', game.finalState],
  ];
  for (const [name, expected] of sides) {
    if (!present.get(name)) continue;
    const value = readJsonFile(join(gameDir, name), name, issues);
    if (value !== undefined && canonical(value) !== canonical(expected)) {
      issues.push(`${name} does not match game.json`);
    }
  }
  if (replayFile !== undefined && replayFile.matches !== game.replayMatches) {
    issues.push('replay.json matches does not match game.json');
  }
  if (meta !== undefined) {
    for (const field of META_FIELDS) {
      if (meta[field] !== (game as unknown as Record<string, unknown>)[field]) {
        issues.push(`meta.json ${field} does not match game.json`);
      }
    }
  }

  // 3. re-execute every command through a fresh Engine
  let engine: Engine | null = null;
  try {
    engine = new Engine(game.initialState);
  } catch (err) {
    issues.push(`engine rejected initialState: ${msg(err)}`);
  }
  if (engine !== null) {
    const entries = Array.isArray(game.commands) ? game.commands : [];
    for (const entry of entries) {
      const id = (entry as { command?: { commandId?: string } })?.command?.commandId ?? '(no id)';
      try {
        const reexec = engine.submit(entry?.command);
        if (canonical(reexec) !== canonical(entry?.exec)) {
          issues.push(`command ${id}: engine replay exec mismatch (commandId/seq/status/reason/eventIds)`);
        }
      } catch (err) {
        issues.push(`command ${id}: engine submit threw: ${msg(err)}`);
        break;
      }
    }
    // 4. events  5. final state
    try {
      if (canonical(engine.getEvents()) !== canonical(game.events)) {
        issues.push('engine replay events do not match game.json');
      }
      if (canonical(engine.getState()) !== canonical(game.finalState)) {
        issues.push('engine replay state does not match game.json finalState');
      }
    } catch (err) {
      issues.push(`engine replay threw: ${msg(err)}`);
    }
  }

  // 6. recompute replayMatches from initialState+events vs finalState
  let recomputedReplay: boolean | null = null;
  try {
    const replayed: WorldState = replay(game.initialState, Array.isArray(game.events) ? game.events : []);
    recomputedReplay = canonical(replayed) === canonical(game.finalState);
  } catch (err) {
    issues.push(`replay threw: ${msg(err)}`);
  }
  if (recomputedReplay !== null) {
    if (recomputedReplay !== game.replayMatches) issues.push('game.replayMatches contradicts recomputation');
    if (replayFile !== undefined && replayFile.matches !== recomputedReplay) {
      issues.push('replay.json matches contradicts recomputation');
    }
    if (meta !== undefined && meta.replayMatches !== recomputedReplay) {
      issues.push('meta.json replayMatches contradicts recomputation');
    }
  }

  // 7. recompute goalReached from finalState
  const hunger = (game.finalState as { npcs?: { npc_a?: { hunger?: unknown } } } | undefined)?.npcs?.npc_a?.hunger;
  if (typeof hunger === 'number') {
    const recomputedGoal = hunger >= GOAL_HUNGER_AT_LEAST;
    if (recomputedGoal !== game.goalReached) issues.push('game.goalReached contradicts finalState');
    if (meta !== undefined && meta.goalReached !== recomputedGoal) {
      issues.push('meta.json goalReached contradicts finalState');
    }
  } else {
    issues.push('finalState.npcs.npc_a.hunger is not a number');
  }

  // 8. re-judge the scenario when a scenario is pinned and a verdict is stored
  const pinned = game.scenarioId === 's1' || game.scenarioId === 's2' || game.scenarioId === 's3';
  if (pinned && game.scenarioPass !== null && game.scenarioPass !== undefined) {
    try {
      const verifiedGame: GameRecord = { ...game, replayMatches: recomputedReplay ?? game.replayMatches };
      const judged = judgeScenario(game.scenarioId as ScenarioId, verifiedGame);
      if (judged.pass !== game.scenarioPass) {
        issues.push(`scenarioPass contradicts re-judgement (recomputed=${judged.pass}, saved=${String(game.scenarioPass)})`);
      }
    } catch (err) {
      issues.push(`judgeScenario threw: ${msg(err)}`);
    }
  }

  // 9. step ledger: every step command+exec must exist in game.commands
  const ledger = new Map<string, unknown>();
  for (const entry of Array.isArray(game.commands) ? game.commands : []) {
    const id = (entry as { command?: { commandId?: string } })?.command?.commandId;
    if (typeof id === 'string') ledger.set(id, entry);
  }
  const steps = Array.isArray(game.steps) ? game.steps : [];
  for (const step of steps) {
    const s = step as { round?: number; command?: unknown; exec?: unknown };
    if (s?.command === undefined || s?.exec === undefined) continue;
    const id = (s.command as { commandId?: string })?.commandId ?? '(no id)';
    const found = ledger.get(id);
    if (found === undefined) {
      issues.push(`step ${String(s.round)}: command ${id} missing from game.commands`);
    } else if (canonical((found as { command: unknown }).command) !== canonical(s.command)
      || canonical((found as { exec: unknown }).exec) !== canonical(s.exec)) {
      issues.push(`step ${String(s.round)}: command ${id} differs from game.commands`);
    }
  }

  // 10. re-parse raw output and compare the final action with the recorded command
  for (const step of steps) {
    const s = step as { round?: number; raw?: unknown; parse?: { ok?: boolean }; command?: { type?: string; payload?: unknown } };
    if (s?.parse?.ok !== true || typeof s.raw !== 'string' || s.raw.length === 0) continue;
    const reparsed = parseAction(s.raw);
    if (!reparsed.ok) {
      issues.push(`step ${String(s.round)}: saved raw output no longer parses`);
      continue;
    }
    const action = reparsed.action;
    if (action.type === 'stop') {
      if (s.command !== undefined) issues.push(`step ${String(s.round)}: stop step carries a command`);
    } else if (s.command === undefined) {
      issues.push(`step ${String(s.round)}: parsed ${action.type} but no command recorded`);
    } else {
      const expected = action.type === 'move' ? { type: 'move', payload: { to: action.to } } : { type: 'eat', payload: {} };
      if (canonical({ type: s.command.type, payload: s.command.payload }) !== canonical(expected)) {
        issues.push(`step ${String(s.round)}: parsed action differs from recorded command`);
      }
    }
  }

  return { ok: issues.length === 0, issues, game };
}
