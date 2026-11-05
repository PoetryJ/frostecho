#!/usr/bin/env node
/**
 * G10 worker B — the continuous interactive kitchen.
 *
 *   npm run play:g10 -- --goals negotiated --fixture cooperate --root artifacts/g10-play --slot play
 *
 * One process reads commands until quit/EOF/SIGINT. The terminal only parses
 * startup flags, reads stdin and calls the application controller; it never
 * submits an Engine command or copies a game rule. Default is offline
 * reference (legacy); a demo must be explicit and is labelled scripted.
 */
import { createInterface } from 'node:readline';
import {
  createG10Runtime, demoLabel, loadG10Runtime, type G10Runtime,
} from '../src/application/adapters';
import { parseInput } from '../src/application/commands';
import { createApplicationController } from '../src/application/session';
import {
  renderExecute, renderHelp, renderStatus, renderWelcome,
} from '../src/application/presenter';
import type { ApplicationController, FixtureId, GoalArm, SatietyLevel } from '../src/application/contracts';

const USAGE = `Usage:
  npm run play:g10 -- [--goals legacy|negotiated] [--candidates self_only|choice]
                       [--satiety 40|60] [--fixture cooperate|decline|violate]
                       [--root DIR] [--slot NAME]
                       [--live --http URL --model M --campaign DIR [--campaign-limit N]]
  npm run play:g10 -- --load FILE [--live --http URL --model M --campaign DIR]

Default: offline reference, --goals legacy. --fixture requires --goals negotiated
and is a SCRIPTED mechanism demo, not real-model behaviour. No env var turns the
network on by itself; --live is loopback-only in this task and needs an existing
authorized campaign.`;

interface Args {
  root: string; slot: string; goals: 'legacy' | 'negotiated'; candidates: GoalArm;
  satiety: SatietyLevel; fixture: FixtureId | null; live: boolean;
  http: string; model: string | null; campaign: string | null; campaignLimit: number | null;
  loadPath: string | null; help: boolean;
  goalsSet: boolean; candidatesSet: boolean; satietySet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: 'artifacts/g10-play', slot: 'play', goals: 'legacy', candidates: 'choice',
    satiety: 40, fixture: null, live: false, http: '', model: null,
    campaign: null, campaignLimit: null, loadPath: null, help: false,
    goalsSet: false, candidatesSet: false, satietySet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--root': args.root = argv[++i] ?? args.root; break;
      case '--slot': args.slot = argv[++i] ?? args.slot; break;
      case '--goals': {
        const value = argv[++i];
        if (value !== 'legacy' && value !== 'negotiated') throw new Error('--goals must be legacy|negotiated');
        args.goals = value;
        args.goalsSet = true;
        break;
      }
      case '--candidates': {
        const value = argv[++i];
        if (value !== 'self_only' && value !== 'choice') throw new Error('--candidates must be self_only|choice');
        args.candidates = value;
        args.candidatesSet = true;
        break;
      }
      case '--satiety': {
        const value = Number(argv[++i]);
        if (value !== 40 && value !== 60) throw new Error('--satiety must be 40|60');
        args.satiety = value as SatietyLevel;
        args.satietySet = true;
        break;
      }
      case '--fixture': {
        const value = argv[++i];
        if (value !== 'cooperate' && value !== 'decline' && value !== 'violate') {
          throw new Error('--fixture must be cooperate|decline|violate');
        }
        args.fixture = value;
        break;
      }
      case '--live': args.live = true; break;
      case '--http': args.http = argv[++i] ?? ''; break;
      case '--model': args.model = argv[++i] ?? null; break;
      case '--campaign': args.campaign = argv[++i] ?? null; break;
      case '--campaign-limit': {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 0) throw new Error('--campaign-limit must be a non-negative integer');
        args.campaignLimit = value;
        break;
      }
      case '--load': args.loadPath = argv[++i] ?? null; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
  }
  return args;
}

function print(lines: readonly string[]): void {
  for (const line of lines) console.log(line);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.loadPath === null && args.fixture !== null && args.goals !== 'negotiated') {
    console.error('--fixture requires --goals negotiated (the demo runs the two-phase protocol)');
    return 2;
  }
  if (args.live && (args.http.length === 0 || args.model === null)) {
    console.error('--live requires --http URL and --model M (explicit only; env never enables it)');
    return 2;
  }

  const built = args.loadPath === null
    ? createG10Runtime({
      root: args.root, slot: args.slot, goals: args.goals, candidates: args.candidates,
      satiety: args.satiety, fixture: args.fixture, live: args.live, http: args.http,
      model: args.model, campaign: args.campaign, campaignLimit: args.campaignLimit,
    })
    : loadG10Runtime(args.loadPath, {
      live: args.live, model: args.model, fixture: args.fixture, http: args.http,
      campaign: args.campaign, campaignLimit: args.campaignLimit,
      goals: args.goalsSet ? args.goals : undefined,
      candidates: args.candidatesSet ? args.candidates : undefined,
      satiety: args.satietySet ? args.satiety : undefined,
    });
  if (!built.ok) {
    console.error(`cannot start: ${(built.issues ?? []).join('; ')}`);
    return 2;
  }
  const runtime: G10Runtime = built.value;
  const controller: ApplicationController = createApplicationController({
    game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot,
    meta: runtime.meta, ports: runtime.ports,
  });

  print(renderWelcome(controller.view()));
  const demo = demoLabel(runtime.meta);
  if (demo !== null) console.log(`本次为 ${demo}；结果只证明机制，不代表真实模型。`);
  if (runtime.loadInfo !== null) {
    console.log(`已从 ${runtime.loadInfo.path} 恢复：0 次调用、0 次提交、不重选目标。`);
  }
  print(renderStatus(controller.view()));

  // The ONE finalization lives in the controller: close, authoritative run
  // record, exit code. quit/EOF/SIGINT all share its single promise.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true, prompt: 'g10> ' });
  if (process.stdin.isTTY === true) rl.prompt();
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    rl.close();
  };
  rl.on('SIGINT', interrupt);
  // With piped stdin the signal reaches the process, not readline; both paths
  // finalize exactly once and never add a decision.
  process.on('SIGINT', interrupt);

  for await (const line of rl) {
    const parsed = parseInput(line);
    if (!parsed.ok) {
      print([`[输入错误] ${parsed.message}`]);
      if (process.stdin.isTTY === true) rl.prompt();
      continue;
    }
    if (parsed.command.kind === 'help') {
      print(renderHelp());
      if (process.stdin.isTTY === true) rl.prompt();
      continue;
    }
    if (parsed.command.kind === 'status') {
      print(renderStatus(controller.view()));
      if (process.stdin.isTTY === true) rl.prompt();
      continue;
    }
    const result = await controller.execute(parsed.command);
    print(renderExecute(result, controller.view()));
    if (parsed.command.kind === 'quit') break;
    print(renderStatus(controller.view()));
    if (process.stdin.isTTY === true) rl.prompt();
  }
  if (interrupted) console.log('收到 SIGINT：本次运行收束一次。');
  const final = await controller.finalize();
  // Every failure latched during the run reaches stderr at least once, with
  // its ORIGINAL cause — even when the final record write later succeeded
  // (e.g. a transient IO fault that recovered before EOF).
  for (const failure of final.failures) {
    console.error(`[run:${failure.code}] ${failure.message}${failure.evidencePath === null ? '（失败证据未落盘）' : `（证据：${failure.evidencePath}）`}`);
  }
  for (const error of final.errors) {
    // The record could not be written (or close failed): the original cause
    // is printed, the run is NOT reported as saved, and the exit stays 1.
    console.error(`[finalize:${error.code}] ${error.message}`);
  }
  if (final.recordPath !== null) console.log(`运行记录 -> ${final.recordPath}`);
  return final.exitCode;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
