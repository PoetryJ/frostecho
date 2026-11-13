/**
 * R6 integration entry. Real CLI processes only: morning council across four
 * days, and the CPU evidence bundle judged by the production Python port and
 * the TS sealed check. No model, no GPU, no server.
 *
 *   node dist/scripts/verify-r6.js --out artifacts/sprint-r6/<run-id>/integration
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assessEvidence, type EvidencePayload } from '../src/decision/jev-evidence';

const CLI = join('dist', 'scripts', 'play-sprint.js');

interface Row { [key: string]: any }

export interface StoryResult {
  simMinutes: number;
  deliveredMeals: number;
  warehouseFood: number;
  publicFood: number;
  supplyFulfilled: number;
  mealFulfilled: number;
  withdrawnSupply: number;
  substituteDone: boolean;
  shortageSeen: boolean;
  replayDuplicate: boolean;
  lateIgnored: boolean;
  activeWithOpenPromise: number;
  ledger: LedgerRow[];
}

export interface LedgerRow {
  requestId: string;
  source: string | null;
  councilId: string;
  resolutionId: string;
  revision: number;
  actor: string;
  goal: string;
  commitmentId: string | null;
  commitmentStatus: string | null;
  taskId: string | null;
  taskStatus: string | null;
  terminalReason: string;
  receiptEventIds: string[];
  unfinishedReason: string | null;
  unfinishedEvidence: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

class Driver {
  private out = '';
  private err = '';
  readonly stdin: string[] = [];
  constructor(private readonly child: ReturnType<typeof spawn>, readonly state: string) {
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', chunk => { this.out += chunk; });
    child.stderr!.on('data', chunk => { this.err += chunk; });
  }

  rows(): Row[] {
    return this.out.trim() ? this.out.trim().split('\n').map(line => JSON.parse(line)) : [];
  }

  private async wait(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (this.child.exitCode !== null) {
        throw new Error(`cli exited ${this.child.exitCode}\n${this.err}\n${this.out.slice(-2000)}`);
      }
      if (Date.now() > deadline) throw new Error(`timeout\n${this.err}\n${this.out.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 8));
    }
  }

  async ready(): Promise<void> {
    await this.wait(() => this.rows().some(row => row.event === 'ready'));
  }

  async send(line: string): Promise<Row> {
    this.stdin.push(line);
    const before = this.rows().length;
    this.child.stdin!.write(`${line}\n`);
    await this.wait(() => this.rows().length > before);
    return this.rows()[this.rows().length - 1];
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) {
      this.child.stdin!.end();
      await new Promise(resolve => this.child.on('close', resolve));
    }
  }

  dump(dir: string, name: string): void {
    writeFileSync(join(dir, `${name}.stdout.jsonl`), this.out);
    writeFileSync(join(dir, `${name}.stderr.txt`), this.err);
    writeFileSync(join(dir, `${name}.stdin.txt`), `${this.stdin.join('\n')}\n`);
  }
}

function openDriver(state: string, fresh: boolean): Driver {
  const args = [CLI, '--state', state, '--npc', '8', '--food', '120', '--seed', 'play-r6', '--days', '4'];
  if (fresh) args.push('--fresh');
  const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  return new Driver(child, state);
}

function readSidecars(state: string): Record<string, unknown> {
  const load = (suffix: string) => existsSync(state + suffix)
    ? JSON.parse(readFileSync(state + suffix, 'utf8')) : null;
  return {
    session: JSON.parse(readFileSync(state, 'utf8')),
    tasks: load('.tasks.json'),
    commitments: load('.commitments.json'),
    council: load('.council.json'),
    experience: load('.experience.json'),
  };
}

function snapshot(dir: string, state: string, label: string): void {
  const files = ['', '.tasks.json', '.commitments.json', '.council.json', '.experience.json'];
  for (const suffix of files) {
    if (!existsSync(state + suffix)) continue;
    writeFileSync(join(dir, `${label}${suffix || '.session.json'}`), readFileSync(state + suffix));
  }
}

async function pace(send: (line: string) => Promise<Row>, until: number): Promise<Row> {
  for (let guard = 0; guard < 90; guard += 1) {
    const status = await send('task-status');
    if (status.status.simTime >= until) return status;
    await send('advance 120');
    await send('game-step');
  }
  throw new Error(`did not reach simTime ${until}`);
}

function freeNpc(busy: Set<string>): string {
  for (let index = 1; index <= 8; index += 1) {
    const id = `npc_${String(index).padStart(2, '0')}`;
    if (!busy.has(id)) return id;
  }
  throw new Error('no free npc');
}

export async function runArm(dir: string, segmented: boolean): Promise<StoryResult> {
  mkdirSync(dir, { recursive: true });
  const state = join(dir, 'session.json');
  const transcript: Row[] = [];
  let driver = openDriver(state, true);
  await driver.ready();
  const send = async (line: string): Promise<Row> => {
    const row = await driver.send(line);
    transcript.push({ line, row });
    return row;
  };
  const checkpoint = async (label: string) => {
    await send('save');
    snapshot(dir, state, label);
    if (!segmented) return;
    await send('quit');
    driver.dump(dir, label);
    await driver.close();
    driver = openDriver(state, false);
    await driver.ready();
  };

  await send('council-open');
  const day1 = await send('council-resolve');
  const day1Supply = day1.requests.find((request: Row) => request.role === 'supply');
  for (const request of day1.requests) await send(`council-respond ${request.requestId} accept`);
  for (let step = 0; step < 4; step += 1) await send('game-step');
  await checkpoint('day1-done');
  await pace(send, 1440);

  await send('council-open');
  const day2 = await send('council-resolve');
  const supply = day2.requests.find((request: Row) => request.role === 'supply');
  const deliver = day2.requests.find((request: Row) => request.role === 'deliver');
  const accepted = await send(`council-respond ${supply.requestId} accept`);
  const withdrawn = await send(`relinquish ${accepted.commitment.commitmentId}`);
  if (withdrawn.commitment?.status !== 'withdrawn') {
    throw new Error(`day2 exit did not withdraw: ${JSON.stringify(withdrawn).slice(0, 400)}`);
  }
  const busy = new Set<string>(day2.requests.map((request: Row) => request.actorId));
  const substitute = freeNpc(busy);
  const moved = await send(`council-reassign ${supply.requestId} ${substitute}`);
  if (moved.request.revision !== 2) throw new Error(`expected revision 2, got ${moved.request.revision}`);
  await send(`council-respond ${moved.request.requestId} accept`);
  const late = await send(`council-respond ${supply.requestId} accept`);
  if (late.ignored !== true) throw new Error('old supply response was not ignored');
  if (deliver) await send(`council-respond ${deliver.requestId} accept`);
  for (let step = 0; step < 6; step += 1) await send('game-step');
  await checkpoint('day2-done');
  await pace(send, 2880);

  await send('council-open');
  const day3 = await send('council-resolve');
  const d3deliver = day3.requests.find((request: Row) => request.role === 'deliver');
  for (const request of day3.requests) {
    if (request.role !== 'deliver') await send(`council-respond ${request.requestId} decline`);
  }
  const drainer = freeNpc(new Set(day3.requests.map((request: Row) => request.actorId)));
  await send(`travel ${drainer} warehouse`);
  const before = await send('task-status');
  const deposited = await send(`deposit ${drainer} ${before.status.resources.food}`);
  if (deposited.status !== 'applied') throw new Error(`deposit failed ${deposited.status} ${deposited.reason ?? ''}`);
  const pulled = await send(`withdraw ${drainer} ${deposited.warehouseFood}`);
  if (pulled.warehouseFood !== 0) throw new Error('warehouse was not emptied by the pre-registered drain');
  const acceptedDeliver = await send(`council-respond ${d3deliver.requestId} accept`);
  const commitmentId = acceptedDeliver.commitment.commitmentId as string;
  await send(`travel ${d3deliver.actorId} warehouse`);
  const shortage = await send(`withdraw ${d3deliver.actorId} 1`);
  const shortageTypes = (shortage.events ?? []).map((event: Row) => event.type);
  if (!shortageTypes.includes('out_of_stock')) throw new Error(`shortage was not observed: ${shortageTypes}`);
  await checkpoint('day3-shortage');

  let delivered = false;
  for (let step = 0; step < 12 && !delivered; step += 1) {
    await send('game-step');
    const board = await send('commitment-status');
    const row = board.commitments.find((item: Row) => item.commitmentId === commitmentId);
    const open = (row?.changes ?? []).filter((change: Row) => change.status === 'open');
    if (open.length > 0) {
      const verdict = open.some((change: Row) => change.kind === 'suspend') ? 'reject' : 'accept';
      await send(`respond-change ${commitmentId} ${verdict}`);
    }
    delivered = row?.status === 'fulfilled';
  }
  if (!delivered) throw new Error('day3 delivery did not settle from gather→deposit→withdraw→deliver');
  await checkpoint('day3-recovered');
  await pace(send, 4320);

  const opened = await send('council-open');
  const resolved = await send('council-resolve');
  const replay = await send('council-resolve');
  const old = await send(`council-respond ${day1Supply.requestId} accept`);
  if (replay.duplicate !== true) throw new Error('replayed resolution dispatched again');
  if (old.ignored !== true) throw new Error('replayed day1 response was not ignored');
  for (const request of resolved.requests ?? []) {
    if (request.status === 'pending') await send(`council-respond ${request.requestId} decline`);
  }
  await send('save');
  snapshot(dir, state, 'day4-final');
  await send('quit');
  driver.dump(dir, 'final');
  await driver.close();
  writeJson(join(dir, 'transcript.json'), transcript);

  const final = readSidecars(state);
  const ledger = buildLedger(final);
  writeJson(join(dir, 'obligation-ledger.json'), ledger);
  const session = final.session as any;
  const tasks = (final.tasks as any[]) ?? [];
  const commitments = ((final.commitments as any).commitments as any[]) ?? [];
  return {
    simMinutes: session.world.simTime,
    deliveredMeals: session.world.spatial?.deliveredMeals ?? 0,
    warehouseFood: session.world.spatial?.stocks?.warehouse?.food ?? 0,
    publicFood: session.world.resources.food,
    supplyFulfilled: commitments.filter(row => row.goal === 'supply-warehouse' && row.status === 'fulfilled').length,
    mealFulfilled: commitments.filter(row => row.goal === 'deliver-meal' && row.status === 'fulfilled').length,
    withdrawnSupply: commitments.filter(row => row.goal === 'supply-warehouse' && row.status === 'withdrawn').length,
    substituteDone: tasks.some(task => task.actorId !== supply.actorId && task.kind === 'supply-warehouse' && task.status === 'done'),
    shortageSeen: true,
    replayDuplicate: true,
    lateIgnored: true,
    activeWithOpenPromise: tasks.filter(task => task.status === 'done' && commitments.some(row =>
      row.commitmentId === task.commitmentId && row.status === 'active')).length,
    ledger,
  };
}

function buildLedger(final: Record<string, unknown>): LedgerRow[] {
  const council = ((final.council as any).councils as any[]) ?? [];
  const commitments = ((final.commitments as any).commitments as any[]) ?? [];
  const tasks = (final.tasks as any[]) ?? [];
  const memories = ((final.session as any).memories ?? {}) as Record<string, any>;
  const rows: LedgerRow[] = [];
  for (const record of council) {
    for (const request of record.requests ?? []) {
      const commitment = commitments.find(item => item.commitmentId === request.commitmentId) ?? null;
      const task = tasks.find(item => item.commitmentId && item.commitmentId === request.commitmentId) ?? null;
      const memory = memories[request.actorId];
      const shortage = (memory?.records ?? []).filter((item: any) => item.kind === 'out_of_stock')
        .map((item: any) => item.eventId);
      const fulfilled = commitment?.status === 'fulfilled';
      const terminalReason = fulfilled ? 'fulfilled'
        : commitment?.status ?? request.status;
      let unfinishedReason: string | null = null;
      let unfinishedEvidence = 'unknown';
      if (!fulfilled) {
        if (request.status === 'declined') {
          unfinishedReason = 'resident declined the request';
          unfinishedEvidence = request.requestId;
        } else if (request.status === 'superseded' || commitment?.status === 'withdrawn') {
          unfinishedReason = 'promisor exited; commitment withdrawn and task cancelled';
          unfinishedEvidence = commitment?.commitmentId ?? request.requestId;
        } else if (shortage.length > 0 && commitment?.status !== 'fulfilled') {
          unfinishedReason = 'actor observed out_of_stock';
          unfinishedEvidence = shortage[0];
        } else if (request.status === 'pending') {
          unfinishedReason = 'request stayed pending';
          unfinishedEvidence = request.requestId;
        } else {
          unfinishedReason = terminalReason;
          unfinishedEvidence = commitment?.commitmentId ?? request.requestId;
        }
      }
      rows.push({
        requestId: request.requestId,
        source: request.source ?? record.resolution?.source ?? null,
        councilId: request.councilId,
        resolutionId: request.resolutionId,
        revision: request.revision,
        actor: request.actorId,
        goal: request.goal,
        commitmentId: commitment?.commitmentId ?? null,
        commitmentStatus: commitment?.status ?? null,
        taskId: task?.taskId ?? null,
        taskStatus: task?.status ?? null,
        terminalReason,
        receiptEventIds: commitment?.evidenceEventIds ?? [],
        unfinishedReason,
        unfinishedEvidence,
      });
    }
  }
  return rows;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort()
      .map(key => [key, sortValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function normalizeLinkedState(value: any): any {
  const aliases: Record<string, string> = {};
  const apply = (text: string) => {
    let out = text;
    for (const [oldId, mapped] of Object.entries(aliases).sort((left, right) => right[0].length - left[0].length)) {
      out = out.split(oldId).join(mapped);
    }
    return out;
  };
  for (const council of value.council?.councils ?? []) {
    for (const request of council.requests ?? []) {
      if (request.commitmentId) aliases[request.commitmentId] = `CM_FOR:${request.requestId}`;
    }
  }
  for (const commitment of value.commitments?.commitments ?? []) {
    if (!aliases[commitment.commitmentId]) {
      throw new Error(`unmapped commitment: ${commitment.commitmentId}`);
    }
    (commitment.changes ?? []).forEach((change: any, index: number) => {
      if (change.changeId) {
        aliases[change.changeId] = `CHANGE_FOR:${aliases[commitment.commitmentId]}:${index}`;
      }
    });
  }
  for (const [actor, memory] of Object.entries(value.session?.memories ?? {}) as [string, any][]) {
    for (const record of memory?.records ?? []) {
      if (record?.recordId) {
        aliases[record.recordId] = `MEM:${actor}:${apply(String(record.eventId ?? ''))}:${record.revision}`;
      }
    }
  }
  for (const [oldId, note] of Object.entries(value.experience ?? {}) as [string, any][]) {
    const conditions = createHash('sha256')
      .update(JSON.stringify(sortValue(note.conditions)))
      .digest('hex');
    aliases[oldId] = `EXP:${note.ownerActorId}:${note.lesson}:${conditions}`;
  }
  if (new Set(Object.values(aliases)).size !== Object.keys(aliases).length) {
    throw new Error('normalization is not a bijection');
  }
  return sortValue(JSON.parse(apply(JSON.stringify(sortValue(value)))));
}

function project(final: Record<string, unknown>): unknown {
  const session = final.session as any;
  const world = session.world;
  const tasks = ((final.tasks as any[]) ?? []).map(task => ({
    taskId: task.taskId, actorId: task.actorId, kind: task.kind, status: task.status,
    assignedAt: task.assignedAt,
  }));
  const commitments = (((final.commitments as any).commitments as any[]) ?? [])
    .map(row => ({
      promisorId: row.promisorId, beneficiaryId: row.beneficiaryId, goal: row.goal,
      status: row.status, revision: row.revision, createdAt: row.createdAt,
      evidenceEventIds: row.evidenceEventIds, source: row.source ?? null,
    }))
    .sort((left, right) => left.createdAt - right.createdAt
      || left.promisorId.localeCompare(right.promisorId)
      || left.goal.localeCompare(right.goal));
  const councils = (((final.council as any).councils as any[]) ?? []).map(record => ({
    councilId: record.councilId, day: record.day, status: record.status, revision: record.revision,
    resolutionId: record.resolution?.resolutionId ?? null,
    requests: (record.requests ?? []).map((request: any) => ({
      requestId: request.requestId, role: request.role, actorId: request.actorId,
      status: request.status, revision: request.revision, goal: request.goal,
    })),
  }));
  return {
    simTime: world.simTime, day: world.day, version: world.version,
    resources: world.resources,
    npcs: Object.fromEntries(Object.entries(world.npcs).map(([id, npc]: any) => [id, {
      hunger: npc.hunger, stamina: npc.stamina, health: npc.health, san: npc.san,
      alive: npc.alive, location: npc.location,
    }])),
    spatial: world.spatial ? {
      warehouseFood: world.spatial.stocks.warehouse.food,
      deliveredMeals: world.spatial.deliveredMeals,
      carry: world.spatial.carry,
      closedCells: world.spatial.closedCells,
    } : null,
    tasks, commitments, councils,
  };
}

function stableLedger(rows: LedgerRow[]): unknown[] {
  return rows.map(row => ({
    councilId: row.councilId, resolutionId: row.resolutionId, revision: row.revision,
    actor: row.actor, goal: row.goal, commitmentStatus: row.commitmentStatus,
    taskStatus: row.taskStatus, terminalReason: row.terminalReason,
    receiptEventIds: row.receiptEventIds, unfinishedReason: row.unfinishedReason,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export async function runStory(root: string): Promise<{ pass: boolean; reason: string;
  continuous: StoryResult; segmented: StoryResult }> {
  const continuous = await runArm(join(root, 'continuous'), false);
  const segmented = await runArm(join(root, 'segmented'), true);
  const leftRaw = readSidecars(join(root, 'continuous', 'session.json'));
  const rightRaw = readSidecars(join(root, 'segmented', 'session.json'));
  const left = normalizeLinkedState(leftRaw);
  const right = normalizeLinkedState(rightRaw);
  writeJson(join(root, 'normalize.json'), {
    rule: 'Map commitment ids by requestId, change ids by parent commitment and ordinal. Keep task.commitmentId, request.commitmentId, revision and receipt ids. A scrambled task.commitmentId must not compare equal.',
  });
  const sameWorld = JSON.stringify(sortValue((leftRaw.session as any).world))
    === JSON.stringify(sortValue((rightRaw.session as any).world));
  const same = sameWorld && JSON.stringify(left) === JSON.stringify(right);
  writeJson(join(root, 'authority-diff.json'), same ? { equal: true }
    : { equal: false, continuous: left, segmented: right });
  writeJson(join(root, 'ledger-diff.json'), {
    equal: JSON.stringify(stableLedger(continuous.ledger)) === JSON.stringify(stableLedger(segmented.ledger)),
  });
  const problems: string[] = [];
  if (!same) problems.push('continuous and segmented authority projections differ');
  for (const [name, result] of [['continuous', continuous], ['segmented', segmented]] as const) {
    if (result.supplyFulfilled < 1) problems.push(`${name} missing a fulfilled supply`);
    if (result.mealFulfilled < 1) problems.push(`${name} missing a fulfilled meal`);
    if (result.withdrawnSupply < 1) problems.push(`${name} missing a withdrawn supply`);
    if (!result.substituteDone) problems.push(`${name} substitute supply did not finish`);
    if (result.activeWithOpenPromise !== 0) problems.push(`${name} has done tasks with active commitments`);
    if (!(result.simMinutes > 4320)) problems.push(`${name} simTime ${result.simMinutes} did not cross four mornings`);
  }
  writeJson(join(root, 'minutes.json'), {
    continuous: continuous.simMinutes, segmented: segmented.simMinutes,
    note: 'Actual simulated minutes from the world clock. Not a hardcoded 96h claim.',
  });
  return { pass: problems.length === 0, reason: problems.join('; ') || 'two arms agree',
    continuous, segmented };
}

function runJev(dir: string): { pass: boolean; reason: string } {
  mkdirSync(dir, { recursive: true });
  const script = `
import json, hashlib, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'research/decision-choice/jev04/scorers'))})
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'research/decision-choice/jev04/calibration'))})
import port_v3 as port
from sealed import build_cpu_bundle
from calibration import ALPHA, cp_upper
ident = dict(model='fixture/r6', head='shared-scalar/1', adapter='jev-choice/1',
    tokenizer='fixture-tok/1', renderer='jev04-render/3', task='choose_action', k=4,
    policy_version='softmax-accept/1', memory_policy_version='memory-policy/1')
bundle = build_cpu_bundle(ident, calibration_id='fixture-r6-cpu', evidence_class='fixture', seeds=(17, 43))
out = Path(${JSON.stringify(dir)})
refs = {}
for name, payload in bundle.items():
    path = out / f'{name}.json'
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\\n', encoding='utf-8')
    refs[name] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
identity = port.ScorerIdentity(**ident)
manifest = {'schema': port.MANIFEST_SCHEMA, 'registrations': [{'identity': identity.as_dict(),
    'mode': 'real', 'utility_source': None, 'evidence': {**refs, 'protocol_version': port.RISK_PROTOCOL_VERSION}}]}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\\n', encoding='utf-8')
loaded = port.load_trusted_manifest(str(out / 'manifest.json'))
inspection = port.resolve_registration(loaded, identity).inspect()
art = port.ScorerArtifact(port.ARTIFACT_SCHEMA, identity, 'fixture', inspection.temperature,
    inspection.tau, inspection.coverage or 0, inspection.upper, calibration_id=inspection.calibration_id)
high = port.decide(art, port.ScorerRequest('high', identity, ['c0','c1','c2','c3'], [6,0,0,0]), loaded)
low = port.decide(art, port.ScorerRequest('low', identity, ['c0','c1','c2','c3'], [0,0,0,0]), loaded)
real = port.ScorerArtifact(port.ARTIFACT_SCHEMA, identity, 'real', inspection.temperature,
    inspection.tau, inspection.coverage or 0, inspection.upper, calibration_id=inspection.calibration_id)
as_real = port.decide(real, port.ScorerRequest('real', identity, ['c0','c1','c2','c3'], [6,0,0,0]), loaded)
# one-field tamper: temperature, everything else legal
bad = port.ScorerArtifact(port.ARTIFACT_SCHEMA, identity, 'real', 0.01, inspection.tau,
    inspection.coverage or 0, inspection.upper, calibration_id=inspection.calibration_id)
mismatch = port.decide(bad, port.ScorerRequest('tamper-T', identity, ['c0','c1','c2','c3'], [6,0,0,0]), loaded)
upper0 = cp_upper(0, 120, ALPHA)
report = {
  'inspection': inspection.__dict__,
  'high': high.__dict__, 'low': low.__dict__, 'asReal': as_real.__dict__,
  'temperatureTamper': mismatch.__dict__,
  'cpUpper0of120': upper0,
  'reference': '1-alpha**(1/120)',
  'referenceValue': 1 - ALPHA ** (1 / 120),
}
(out / 'decisions.json').write_text(json.dumps(report, indent=2) + '\\n', encoding='utf-8')
`;
  const python = resolvePython();
  const proc = spawnSync(python, ['-c', script], { encoding: 'utf8', timeout: 120_000 });
  writeFileSync(join(dir, 'python.stdout'), proc.stdout ?? '');
  writeFileSync(join(dir, 'python.stderr'), proc.stderr ?? '');
  if (proc.status !== 0) return { pass: false, reason: `python bundle failed: ${proc.stderr}` };
  const decisions = JSON.parse(readFileSync(join(dir, 'decisions.json'), 'utf8'));
  const payloads = {
    calT: JSON.parse(readFileSync(join(dir, 'calT.json'), 'utf8')) as EvidencePayload,
    select: JSON.parse(readFileSync(join(dir, 'select.json'), 'utf8')) as EvidencePayload,
    cert: JSON.parse(readFileSync(join(dir, 'cert.json'), 'utf8')) as EvidencePayload,
  };
  const identity = {
    model: 'fixture/r6', head: 'shared-scalar/1', adapter: 'jev-choice/1',
    tokenizer: 'fixture-tok/1', renderer: 'jev04-render/3', task: 'choose_action', k: 4,
    policy_version: 'softmax-accept/1', memory_policy_version: 'memory-policy/1',
  };
  const ts = assessEvidence(payloads, identity);
  writeJson(join(dir, 'ts-assessment.json'), ts);
  const problems: string[] = [];
  if (!decisions.inspection.ok) problems.push(`python inspection: ${decisions.inspection.reason}`);
  if (decisions.high.disposition !== 'accept' || decisions.high.counts_as_real !== false) {
    problems.push('high pmax fixture did not accept with counts_as_real false');
  }
  if (decisions.low.disposition !== 'abstain' || decisions.low.counts_as_real !== false) {
    problems.push('low pmax fixture did not abstain with counts_as_real false');
  }
  if (decisions.high.utility !== null) problems.push('utility was not null');
  if (decisions.asReal.counts_as_real !== false) problems.push('fixture class counted as real');
  if (decisions.temperatureTamper.counts_as_real !== false
    || !String(decisions.temperatureTamper.reason).includes('temperature')) {
    problems.push(`T tamper reason missing: ${decisions.temperatureTamper.reason}`);
  }
  if (!ts.ok) problems.push(`ts assessment: ${ts.reason}`);
  if (ts.ok && decisions.inspection.temperature !== ts.temperature) {
    problems.push(`T python ${decisions.inspection.temperature} != ts ${ts.temperature}`);
  }
  if (ts.ok && decisions.inspection.tau !== ts.tau) problems.push('tau python/ts differ');
  const gap = Math.abs(decisions.cpUpper0of120 - decisions.referenceValue);
  if (gap > 1e-9) problems.push(`cp upper 0/120 gap ${gap}`);
  const capability = {
    numericEvidenceValid: ts.ok && decisions.inspection.ok,
    fixtureDecisionWorks: decisions.high.disposition === 'accept' && decisions.low.disposition === 'abstain',
    researchTrainReady: false,
    realModelLoaded: false,
    realExecutionEnabled: false,
    countsAsReal: false,
    note: 'CPU fixture only. 39 cases remain 0 eligible. No weights were loaded.',
  };
  writeJson(join(dir, 'capability.json'), capability);
  const encoder = spawnSync(python, [
    join('research', 'decision-choice', 'jev04', 'models', 'encoder_train.py'),
    '--data-dir', join('research', 'decision-choice', 'jev04', 'data', 'v4'),
  ], { encoding: 'utf8', timeout: 60_000 });
  const gateText = `${encoder.stdout ?? ''}\n${encoder.stderr ?? ''}`;
  writeFileSync(join(dir, 'encoder-gate.txt'), `exit=${encoder.status}\n${gateText}`);
  capability.researchTrainReady = /"mayTrainOnJev":\s*true/.test(gateText);
  capability.realModelLoaded = /loaded weights|model loaded/i.test(gateText) && !/refused/i.test(gateText);
  capability.realExecutionEnabled = capability.realModelLoaded && capability.researchTrainReady;
  return { pass: problems.length === 0 && capability.researchTrainReady === false
      && capability.realModelLoaded === false, reason: problems.join('; ') || 'cpu fixture accepted and abstained' };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function resolvePython(argv = process.argv, env = process.env): string {
  const index = argv.indexOf('--python');
  const chosen = (index >= 0 ? argv[index + 1] : undefined) || env.FROSTECHO_PYTHON;
  if (chosen) return chosen;
  for (const name of ['python3', 'python']) {
    const found = spawnSync(name, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('no python interpreter');
}

export type GateStatus = 'pass' | 'fail' | 'blocked';

export function judgeGate(entry: { status?: string; head?: string } | undefined,
  expectedHead: string): GateStatus {
  if (!entry || typeof entry.status !== 'string') return 'blocked';
  if (entry.head && entry.head !== expectedHead) return 'fail';
  if (entry.status === 'pass') return 'pass';
  if (entry.status === 'blocked') return 'blocked';
  return 'fail';
}

export function integrationExit(statuses: GateStatus[]): number {
  return statuses.every(status => status === 'pass') ? 0 : 1;
}

export async function runIntegration(out: string): Promise<number> {
  mkdirSync(out, { recursive: true });
  const summary: Record<string, unknown> = {
    schema: 'frostecho.r6.integration/1',
    sourceHead: git(['rev-parse', 'HEAD']),
    workerCount: 1,
    P: { status: 'blocked', evidence: '' },
    R: { status: 'blocked', evidence: '' },
    D: { status: 'blocked', evidence: '' },
    M: { status: 'pending' },
    play: { status: 'pending' },
    jevCpu: { status: 'pending' },
    frozenEvidence: { status: 'pending' },
  };
  try {
    const python = resolvePython();
    const head = String(summary.sourceHead);
    const runProbe = (args: string[], dir: string) => spawnSync(python, args, {
      encoding: 'utf8', timeout: 180_000,
    });
    const r6Dir = join(out, 'r6-fixed');
    runProbe(['handoff/20261113-sprint-r6/tools/repro.py', '--repo', process.cwd(),
      '--out', r6Dir, '--expect', 'fixed'], r6Dir);
    const r61Dir = join(out, 'r61-fixed');
    runProbe(['handoff/20261113-sprint-r6-1/check.py', '--repo', process.cwd(),
      '--out', r61Dir, '--expect', 'fixed'], r61Dir);
    const readSummary = (dir: string) => existsSync(join(dir, 'summary.json'))
      ? JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as any : undefined;
    const r6 = readSummary(r6Dir);
    const r61 = readSummary(r61Dir);
    const gate = (ok: boolean, evidence: string, seenHead?: string) => ({
      status: judgeGate({ status: ok ? 'pass' : 'fail', head: seenHead }, head),
      evidence, head: seenHead ?? null,
    });
    summary.P = r6 ? gate(r6.checks?.product?.fixed === true && r6.verified === true, r6Dir, r6.head)
      : { status: 'blocked', evidence: r6Dir };
    summary.R = r61 ? gate(r61.checks?.R?.fixed === true, r61Dir, r61.head)
      : { status: 'blocked', evidence: r61Dir };
    summary.D = r61 ? gate(r61.checks?.D?.fixed === true, r61Dir, r61.head)
      : { status: 'blocked', evidence: r61Dir };
    summary.M = r61 ? gate(r61.checks?.M?.fixed === true && r61.checks?.fixture_control?.pass === true,
      r61Dir, r61.head) : { status: 'blocked', evidence: r61Dir };
    const story = await runStory(join(out, 'play'));
    summary.play = { status: story.pass ? 'pass' : 'fail', reason: story.reason,
      simMinutes: story.continuous.simMinutes,
      evidence: join(out, 'play') };
    const jev = runJev(join(out, 'jev'));
    summary.jevCpu = { status: jev.pass ? 'pass' : 'fail', reason: jev.reason, evidence: join(out, 'jev') };
    const pre = spawnSync(python, ['handoff/20261113-sprint-r6/tools/preflight.py',
      '--repo', process.cwd(), '--out', join(out, 'preflight')], { encoding: 'utf8' });
    writeFileSync(join(out, 'preflight.stdout'), pre.stdout ?? '');
    summary.frozenEvidence = { status: pre.status === 0 ? 'pass' : 'fail', exit: pre.status };
  } catch (error) {
    summary.play = { status: 'fail', reason: error instanceof Error ? error.message : String(error) };
  }
  const statuses = ['P', 'R', 'D', 'M', 'play', 'jevCpu', 'frozenEvidence']
    .map(key => (summary[key] as { status?: string }).status);
  const failed = statuses.some(status => status === 'fail' || status === 'blocked' || status === 'pending');
  writeJson(join(out, 'integration-summary.json'), summary);
  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  const index = process.argv.indexOf('--out');
  const out = index >= 0 ? resolve(process.argv[index + 1]) : '';
  if (!out) throw new Error('--out <fresh directory> is required');
  if (existsSync(out)) throw new Error(`refusing existing output directory: ${out}`);
  const code = await runIntegration(out);
  const summary = JSON.parse(readFileSync(join(out, 'integration-summary.json'), 'utf8'));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(code);
}

if (process.argv[1] && process.argv[1].includes('verify-r6')) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
