/**
 * G10 worker A — the pure command parser.
 *
 * One line in, one command out. No game, no fs, no provider: invalid input
 * costs zero game calls. Aliases, if any, belong only here — never in the
 * controller or the game rules.
 */
import {
  RESTOCK_MAX, RESTOCK_MIN, RUN_MAX, RUN_MIN, TIME_MAX, TIME_MIN,
  type AppCommand, type ParseIssue, type ParseResult,
} from './contracts';
import { SLOT_PATTERN } from '../persistence/atomic-slot';

const LOCATIONS = ['kitchen', 'dorm'] as const;

function bad(issue: ParseIssue, message: string): ParseResult {
  return { ok: false, issue, message };
}

function integer(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function parseInput(line: string): ParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return bad('EMPTY', '空输入；输入 help 查看命令');
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0]!;
  const arity = (expected: number): ParseResult | null => (
    tokens.length === expected ? null : bad('ARITY', `${head} 需要 ${expected - 1} 个参数`)
  );

  switch (head) {
    case 'help': {
      const failure = arity(1);
      return failure ?? { ok: true, command: { kind: 'help' } };
    }
    case 'status': {
      const failure = arity(1);
      return failure ?? { ok: true, command: { kind: 'status' } };
    }
    case 'step': {
      const failure = arity(1);
      return failure ?? { ok: true, command: { kind: 'step' } };
    }
    case 'quit': {
      const failure = arity(1);
      return failure ?? { ok: true, command: { kind: 'quit' } };
    }

    case 'request': {
      const failure = arity(3);
      if (failure !== null) return failure;
      const actorId = tokens[1]!;
      const goal = tokens[2]!;
      if (actorId !== 'npc_a') return bad('VALUE', 'request 只发给 npc_a');
      if (goal !== 'yield_once') return bad('VALUE', 'request 的 S1 只表达 yield_once');
      return { ok: true, command: { kind: 'request', actorId, goal: 'yield_once' } };
    }

    case 'run': {
      const failure = arity(2);
      if (failure !== null) return failure;
      const steps = integer(tokens[1], RUN_MIN, RUN_MAX);
      if (steps === null) return bad('LIMIT', `run 需要 ${RUN_MIN}..${RUN_MAX} 的整数`);
      return { ok: true, command: { kind: 'run', steps } };
    }

    case 'player': {
      const sub = tokens[1];
      if (sub === 'eat') {
        const failure = arity(2);
        if (failure !== null) return failure;
        return { ok: true, command: { kind: 'player_eat' } };
      }
      if (sub === 'move') {
        const failure = arity(3);
        if (failure !== null) return failure;
        const to = tokens[2]!;
        if (!(LOCATIONS as readonly string[]).includes(to)) return bad('VALUE', 'player move 只接受 dorm|kitchen');
        return { ok: true, command: { kind: 'player_move', to: to as 'dorm' | 'kitchen' } };
      }
      return bad('UNKNOWN', `未知 player 子命令 ${JSON.stringify(sub ?? '')}；可用 move|eat`);
    }

    case 'world': {
      const sub = tokens[1];
      if (sub === 'time') {
        const failure = arity(3);
        if (failure !== null) return failure;
        const steps = integer(tokens[2], TIME_MIN, TIME_MAX);
        if (steps === null) return bad('LIMIT', `world time 需要 ${TIME_MIN}..${TIME_MAX} 的整数`);
        return { ok: true, command: { kind: 'world_time', steps } };
      }
      if (sub === 'restock') {
        const failure = arity(4);
        if (failure !== null) return failure;
        const location = tokens[2]!;
        if (!(LOCATIONS as readonly string[]).includes(location)) return bad('VALUE', 'world restock 位置只接受 kitchen|dorm');
        const amount = integer(tokens[3], RESTOCK_MIN, RESTOCK_MAX);
        if (amount === null) return bad('LIMIT', `world restock 数量需要 ${RESTOCK_MIN}..${RESTOCK_MAX} 的整数`);
        return { ok: true, command: { kind: 'world_restock', location: location as 'dorm' | 'kitchen', amount } };
      }
      return bad('UNKNOWN', `未知 world 子命令 ${JSON.stringify(sub ?? '')}；可用 time|restock`);
    }

    case 'save': {
      const failure = arity(2);
      if (failure !== null) return failure;
      const slot = tokens[1]!;
      if (!SLOT_PATTERN.test(slot)) return bad('VALUE', `槽名 ${JSON.stringify(slot)} 只允许小写字母/数字/连字符，且以字母或数字开头`);
      return { ok: true, command: { kind: 'save', slot } };
    }

    default:
      return bad('UNKNOWN', `未知命令 ${JSON.stringify(head)}；输入 help 查看命令`);
  }
}

/** Exported for the help/tests: the exact heads the parser accepts. */
export const COMMAND_HEADS: readonly string[] = ['help', 'status', 'request', 'step', 'run', 'player', 'world', 'save', 'quit'];

/** Internal: keep AppCommand imported for declaration consumers. */
export type { AppCommand };
