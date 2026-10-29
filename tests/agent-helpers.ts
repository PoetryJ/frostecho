import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../src';
import { DecideInput, RunResult, WorldPort, deterministicRecord } from '../src/agent';

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface CountingWorld extends WorldPort {
  submits: () => number;
  commands: () => unknown[];
}

/** Engine behind the runner port. Extra methods are for assertions, not for the runner. */
export function countingWorld(eng: Engine): CountingWorld {
  const commands: unknown[] = [];
  let submits = 0;
  return {
    submits: () => submits,
    commands: () => commands.map(c => structuredClone(c)),
    getState: () => eng.getState(),
    getEvents: () => eng.getEvents(),
    submit: (command: unknown) => {
      submits += 1;
      commands.push(structuredClone(command));
      return eng.submit(command);
    },
  };
}

export function writeTrace(name: string, result: RunResult): void {
  const dir = join(process.cwd(), 'artifacts', 'g01');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(deterministicRecord(result), null, 2) + '\n');
}

export function scripted(lines: string[], seen?: DecideInput[]) {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      async decide(input: DecideInput, signal: AbortSignal): Promise<string> {
        if (signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        seen?.push(structuredClone(input));
        const line = lines[calls];
        calls += 1;
        if (line === undefined) return '{"type":"stop"}';
        return line;
      },
    },
  };
}
