#!/usr/bin/env node
/**
 * G11 — one-start playable demo of the three frozen trajectories.
 *
 * Everything here is OFFLINE: the CLI runs the scripted `w0/w1/w2` fixtures
 * (explicitly labelled as scripts in every status line). No model service is
 * contacted, no campaign ledger is created, no real quota is consumed.
 *
 * Reproduce:  node scripts/g11-demo.mjs [--keep]
 *
 * W0  ordinary wait: wait -> idle (0 calls) -> world time 1 -> same cycle eat   (2 calls)
 * W1  yield fulfilled: goal+wait (2) -> player eats -> time 1 -> restock -> 2 ordinary eats (4)
 * W2  yield expired:   goal+wait (2) -> nobody eats -> time 1 -> restock -> 2 ordinary eats (4)
 *
 * Each trajectory is also run through a cross-process save/load at a frozen cut
 * point and compared with the continuous run (world, cycles, calls, request).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/scripts/play-g10.js');
const keep = process.argv.includes('--keep');

function runCli(args, lines) {
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: process.cwd() });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.stderr.on('data', chunk => { err += String(chunk); });
    child.on('close', code => done({ code, out, err }));
    child.stdin.end(lines.join('\n') + '\n');
  });
}

const last = (text, re) => {
  let value = null;
  for (const match of text.matchAll(re)) value = match;
  return value;
};

function facts(out) {
  const calls = last(out, /本局 (\d+)\/(\d+)/g);
  const cycle = last(out, /npc_a: cycle=(\d+)[^\n]*调用=(\d+)\/(\d+)/g);
  const world = last(out, /厨房食物=(\d+) 宿舍食物=(\d+) \| 玩家 npc_b@\w+ 饱食=(\d+)/g);
  const request = last(out, /请求 ([\w-]+): (\w+)\/(\w+)/g);
  // npc_a's own block only: slice from its status line to the next actor line.
  const start = out.lastIndexOf('npc_a:');
  const segment = start < 0 ? '' : out.slice(start, out.indexOf('npc_c:', start) < 0 ? out.length : out.indexOf('npc_c:', start));
  const hungerA = last(segment, /饱食目标=(已满足|未满足)/g);
  return {
    calls: calls === null ? null : Number(calls[1]),
    cycles: cycle === null ? null : Number(cycle[1]),
    cycleCalls: cycle === null ? null : Number(cycle[2]),
    food: world === null ? null : Number(world[1]),
    player: world === null ? null : Number(world[3]),
    request: request === null ? null : `${request[2]}/${request[3]}`,
    hungerSatisfied: hungerA === null ? null : hungerA[1] === '已满足',
  };
}

const W0 = ['run 1', 'run 1', 'world time 1', 'run 1', 'status', 'quit'];
const W1 = ['request npc_a yield_once', 'run 1', 'run 1', 'run 1', 'player eat', 'world time 1', 'world restock kitchen 2', 'run 2', 'status', 'quit'];
const W2 = ['request npc_a yield_once', 'run 1', 'run 1', 'run 1', 'world time 1', 'world restock kitchen 1', 'run 2', 'status', 'quit'];

async function trajectory(name, fixture, hunger, lines, expect) {
  const dir = mkdtempSync(join(tmpdir(), `g11-${name}-`));
  const args = ['--fixture', fixture, '--hunger', String(hunger), '--root', join(dir, 'root'), '--slot', name];
  if (fixture !== 'w0') args.push('--goals', 'negotiated');
  const { code, out, err } = await runCli(args, lines);
  const got = facts(out);
  const problems = [];
  if (code !== 0) problems.push(`exit ${code}: ${err.trim()}`);
  for (const [key, want] of Object.entries(expect)) {
    if (got[key] !== want) problems.push(`${key}: got ${JSON.stringify(got[key])}, want ${JSON.stringify(want)}`);
  }
  return { name, got, problems, dir, out };
}

/** Save mid-trajectory, then continue in a SECOND process and compare. */
async function restored(name, fixture, hunger, linesBeforeSave, linesAfterLoad, expect) {
  const dir = mkdtempSync(join(tmpdir(), `g11-${name}-restore-`));
  const args = ['--fixture', fixture, '--hunger', String(hunger), '--root', join(dir, 'root'), '--slot', `${name}-r`, '--goals', 'negotiated'];
  const first = await runCli(args, [...linesBeforeSave, 'save cut', 'quit']);
  if (first.code !== 0) return { name: `${name} restore`, got: null, problems: [`save exit ${first.code}: ${first.err.trim()}`] };
  const second = await runCli([...args, '--load', join(dir, 'root', 'cut.g09.json'), '--slot', `${name}-r`], [...linesAfterLoad, 'status', 'quit']);
  const got = facts(second.out);
  const problems = [];
  if (second.code !== 0) problems.push(`load exit ${second.code}: ${second.err.trim()}`);
  for (const [key, want] of Object.entries(expect)) {
    if (got[key] !== want) problems.push(`${key}: got ${JSON.stringify(got[key])}, want ${JSON.stringify(want)}`);
  }
  return { name: `${name} restore`, got, problems };
}

const rows = [];
const results = [];
results.push(await trajectory('w0', 'w0', 50, W0, { calls: 2, cycles: 1, food: 0, player: 30, hungerSatisfied: true }));
const w1 = await trajectory('w1', 'w1', 40, W1, { calls: 4, cycles: 2, food: 0, player: 60, request: 'accepted/fulfilled', hungerSatisfied: true });
results.push(w1);
results.push(await trajectory('w2', 'w2', 40, W2, { calls: 4, cycles: 2, food: 0, player: 30, request: 'accepted/expired', hungerSatisfied: true }));
// Frozen cut points: after the wait (before the player eats) and after settlement.
results.push(await restored('w1-wait', 'w1', 40, ['request npc_a yield_once', 'run 1', 'run 1'],
  ['run 1', 'player eat', 'world time 1', 'world restock kitchen 2', 'run 2'],
  { calls: 4, cycles: 2, food: 0, player: 60, request: 'accepted/fulfilled', hungerSatisfied: true }));
results.push(await restored('w2-settled', 'w2', 40, ['request npc_a yield_once', 'run 1', 'run 1', 'run 1', 'world time 1'],
  ['world restock kitchen 1', 'run 2'],
  { calls: 4, cycles: 2, food: 0, player: 30, request: 'accepted/expired', hungerSatisfied: true }));

for (const r of results) rows.push({ name: r.name, ...r.got, problems: r.problems.join('; ') || 'ok' });
console.table(rows);

const failures = results.filter(r => r.problems.length > 0);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure.name}: ${failure.problems.join('; ')}`);
  process.exit(1);
}
console.log(`\nall trajectories OK — scripted fixtures only, zero model calls, zero campaign quota${keep ? '' : ' (temp dirs left in the system temp)'}`);
