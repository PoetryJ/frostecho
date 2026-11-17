#!/usr/bin/env node
/**
 * Blind review packets.
 *
 * Each reviewer gets ONLY what the actor could see before deciding:
 *   observation text, the question, the candidate texts, visible memory and the
 *   goals the actor already holds.
 * It never gets: the reference choice, the consequence, the acceptable set, the
 * scenario family (which would name the trap), the other reviewer's answer, or
 * the split label.
 *
 *   node scripts/r8/export-blind-review.mjs --corpus <cases.jsonl> --out <dir>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const corpusPath = option('--corpus');
const outDir = option('--out');
if (!corpusPath || !outDir) throw new Error('Usage: --corpus <cases.jsonl> --out <dir>');
const out = resolve(outDir);
mkdirSync(out, { recursive: true });

const rows = readFileSync(resolve(corpusPath), 'utf8').trim().split('\n')
  .map(line => JSON.parse(line))
  .filter(row => row.split === 'test');

const keymap = {};
const packets = rows.map(row => {
  const request = row.request;
  const memory = (request.memoryFacts ?? []).slice(-6).map(fact => ({
    kind: fact.kind,
    learnedAt: fact.simTime,
    source: fact.source,
    detail: fact.payload,
  }));
  // The real caseId names the scenario family, so the packet uses an opaque
  // public id and the mapping stays in keymap.json (never shipped).
  const publicId = `c-${sha(row.caseId).slice(0, 12)}`;
  keymap[publicId] = { realCaseId: row.caseId, inputSha256: row.inputSha256,
    scenario: row.scenario, split: row.split, acceptableIdsOriginal: row.acceptableIds };
  return {
    schema: 'frostecho.r9.blind-review-item/1',
    caseId: publicId,
    inputSha256: row.inputSha256,
    visible: {
      observationText: row.rendered.text.split('\n可选行动:')[0],
      question: request.question,
      candidates: request.candidates.map(candidate => ({
        id: candidate.id,
        text: candidate.description
          + (Object.keys(candidate.parameters).length
            ? ` {${Object.entries(candidate.parameters)
              .filter(([key]) => key !== 'featureKey')
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}}`
            : '')
          + ` [${candidate.kind}]`
          + (candidate.preconditions.length
            ? ` 前提:${candidate.preconditions.join('、')}` : ''),
      })),
      memory,
      goals: request.goals ?? [],
    },
    // Deliberately absent: acceptableIds, selectedId, scenario, split, execution.
  };
});

const text = packets.map(packet => JSON.stringify(packet)).join('\n');
const packetDir = resolve(out, 'packet');
mkdirSync(packetDir, { recursive: true });
const target = resolve(packetDir, 'review-cases.jsonl');
writeFileSync(target, `${text}\n`, 'utf8');
// Private mapping: reviewer-visible ids -> real cases. Never share this file.
writeFileSync(resolve(out, 'keymap.json'),
  `${JSON.stringify({ schema: 'frostecho.r9.blind-review-keymap/1', map: keymap }, null, 2)}\n`,
  'utf8');

// Leak checks: the packet must not contain any answer surface.
const forbidden = ['acceptableIds', 'selectedId', 'scenario', 'sourceFamily',
  'execution', 'labelSource', 'medical-zero', 'resource-contention',
  'cancel-after-work', 'wrong-location'];
const leaks = forbidden.filter(token => text.includes(token));

const manifest = {
  schema: 'frostecho.r9.blind-review/1',
  cases: packets.length,
  candidates: packets.reduce((sum, packet) => sum + packet.visible.candidates.length, 0),
  packetsSha256: sha(text),
  sourceCorpusSha256: sha(readFileSync(resolve(corpusPath), 'utf8')),
  forbiddenTokensChecked: forbidden,
  leaks,
  note: 'Reviewers see decisions, never outcomes. Join by caseId + inputSha256.',
};
writeFileSync(resolve(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: leaks.length === 0, ...manifest, out: target }, null, 2));
if (leaks.length > 0) process.exitCode = 1;
