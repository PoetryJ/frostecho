/**
 * `joint-c-action/1` renderer.
 *
 * One ChoiceRequest becomes ONE text: the actor's visible observation, then a
 * numbered candidate block. The segments carry character spans so the encoder
 * side can map text back to a candidate without a second encoding pass.
 *
 * Ids are never rendered: they are mapping handles only (CONTRACT §3).
 */
import type { Candidate, ChoiceRequest } from '../../decision/contracts';

export const RENDERER_ID = 'joint-c-action/1';

export type SegmentKind = 'observation' | 'question' | 'memory' | 'goal' | 'candidate';

export interface RenderSegment {
  kind: SegmentKind;
  /** Candidate index for `candidate` segments, null otherwise. */
  index: number | null;
  text: string;
  start: number;
  end: number;
}

export interface RenderedRequest {
  rendererId: string;
  text: string;
  segments: RenderSegment[];
  candidateSpans: { index: number; start: number; end: number }[];
  textSha256Hint: number;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '?';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** What the actor can see, in a fixed order so the text is reproducible. */
export function renderObservationText(observation: unknown): string {
  const raw = (observation && typeof observation === 'object'
    ? observation : {}) as Record<string, unknown>;
  const lines: string[] = [];
  if ('day' in raw) lines.push(`第${scalar(raw.day)}天 第${scalar(raw.minuteOfDay)}分钟`);
  if ('weather' in raw) lines.push(`天气:${scalar(raw.weather)}`);
  const resources = raw.resources as Record<string, unknown> | undefined;
  if (resources) {
    lines.push(`公共资源 食物${scalar(resources.food)} 木柴${scalar(resources.firewood)}`
      + ` 电力${scalar(resources.power)} 药品${scalar(resources.medicine)}`);
  }
  const furnace = raw.furnace as Record<string, unknown> | undefined;
  if (furnace) {
    lines.push(`炉火:${furnace.lit ? '点着' : '熄灭'} 燃料${scalar(furnace.fuel)}`);
  }
  const self = raw.self as Record<string, unknown> | undefined;
  if (self) {
    lines.push(`自身:位置${scalar(self.location)} 饥饿${scalar(self.hunger)}`
      + ` 体力${scalar(self.stamina)} 健康${scalar(self.health)}`
      + ` 精神${scalar(self.san)} 体温${scalar(self.bodyTemp)}`);
  }
  const belief = raw.belief as Record<string, unknown> | undefined;
  if (belief) {
    const level = belief.level;
    lines.push(`仓库认知:${level === null || level === undefined
      ? '未核实' : `${scalar(level)}份`}${belief.rumor ? '(有补货传闻)' : ''}`);
  }
  return lines.join('\n');
}

/** One candidate as the model reads it. No id, no utility, no rank. */
export function renderCandidateText(candidate: Candidate): string {
  const parameters = Object.entries(candidate.parameters)
    .filter(([key]) => key !== 'featureKey')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${scalar(value)}`)
    .join(' ');
  const pre = candidate.preconditions.length > 0
    ? ` 前提:${candidate.preconditions.join('、')}` : '';
  return `${candidate.description} [${candidate.kind}]`
    + `${parameters ? ` {${parameters}}` : ''}${pre}`;
}

function push(parts: string[], segments: RenderSegment[], kind: SegmentKind,
  text: string, index: number | null): void {
  const start = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(text);
  segments.push({ kind, index, text, start, end: start + text.length });
}

export function renderRequest(request: ChoiceRequest): RenderedRequest {
  const parts: string[] = [];
  const segments: RenderSegment[] = [];
  push(parts, segments, 'observation', renderObservationText(request.observation), null);
  push(parts, segments, 'question', `\n问题:${request.question}`, null);
  if (request.memoryFacts.length > 0) {
    const memory = request.memoryFacts.slice(0, 12).map(fact =>
      `- ${fact.kind}@${fact.simTime} ${JSON.stringify(fact.payload)}`).join('\n');
    push(parts, segments, 'memory', `\n记忆:\n${memory}`, null);
  }
  const goals = Array.isArray(request.goals) ? request.goals as unknown[] : [];
  if (goals.length > 0) {
    push(parts, segments, 'goal', `\n目标:${goals.map(scalar).join(';')}`, null);
  }
  push(parts, segments, 'candidate', '\n可选行动:', null);
  const candidateSpans: { index: number; start: number; end: number }[] = [];
  request.candidates.forEach((candidate, index) => {
    const text = `\n${index + 1}. ${renderCandidateText(candidate)}`;
    push(parts, segments, 'candidate', text, index);
    const segment = segments[segments.length - 1];
    candidateSpans.push({ index, start: segment.start, end: segment.end });
  });
  const text = parts.join('');
  return {
    rendererId: RENDERER_ID,
    text,
    segments,
    candidateSpans,
    textSha256Hint: text.length,
  };
}

/** Candidate text keyed by candidate, for the data file. */
export function renderCandidates(request: ChoiceRequest): { id: string; text: string }[] {
  return request.candidates.map(candidate => ({
    id: candidate.id,
    text: renderCandidateText(candidate),
  }));
}
