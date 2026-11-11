/**
 * Real player entry (G). Reads commands from stdin, not a scripted fixture.
 *
 *   node dist/scripts/play-sprint.js --state artifacts/sprint-r1/play/session.json
 *
 * Commands:
 *   observe                     show day/time/resources/NPCs
 *   promise <npcId>             ask that NPC to leave food (others present hear)
 *   cancel <npcId>              cancel face to face with that NPC only
 *   tell <npcId> <promisorId>   tell another NPC the player already cancelled
 *   step                        run one decision for every alive NPC
 *   advance <minutes>           authoritative time advance
 *   knowledge                   each NPC's own promise knowledge
 *   save                        persist the whole session
 *   quit                        exit (use save first)
 */
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { PlaySession, defaultStatePath } from '../src/application-v2/session';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const statePath = argValue('--state') ?? defaultStatePath();
const npcCount = Number(argValue('--npc') ?? 8);
const days = Number(argValue('--days') ?? 4);
const food = argValue('--food') === undefined ? undefined : Number(argValue('--food'));

const session = existsSync(statePath) && !process.argv.includes('--fresh')
  ? PlaySession.load(statePath)
  : PlaySession.create(npcCount, { days, food, seed: argValue('--seed') ?? `play-${npcCount}` });

const emit = (value: unknown) => console.log(JSON.stringify(value));
emit({ schema: 'frostecho.play/1', event: 'ready', statePath,
  restored: existsSync(statePath) && !process.argv.includes('--fresh'),
  day: session.world.day, simTime: session.world.simTime, npcs: session.npcIds });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  const [command, ...rest] = line.trim().split(/\s+/).filter(Boolean);
  try {
    switch (command) {
      case 'observe':
        emit({ command, ...session.observe() });
        break;
      case 'promise':
        emit({ command, ...session.playerPromise(rest[0]) });
        break;
      case 'cancel':
        emit({ command, ...session.playerCancel(rest[0]) });
        break;
      case 'tell':
        emit({ command, ...session.playerTell(rest[0], rest[1]) });
        break;
      case 'advance':
        emit({ command, ...session.advance(Number(rest[0] ?? 60)) });
        break;
      case 'step': {
        const decisions = rest.length > 0
          ? [await session.stepActor(rest[0])]
          : await session.stepAll();
        emit({ command, decisions });
        break;
      }
      case 'knowledge':
        emit({ command, knowledge: session.knowledge(), plans: session.plans });
        break;
      case 'save':
        session.save(statePath);
        emit({ command, saved: statePath, version: session.world.version });
        break;
      case 'quit':
        emit({ command, bye: true });
        rl.close();
        break;
      case '':
        break;
      default:
        emit({ command, error: `unknown command ${command}` });
    }
  } catch (error) {
    emit({ command, error: (error as Error).message });
  }
});

rl.on('close', () => process.exit(0));
