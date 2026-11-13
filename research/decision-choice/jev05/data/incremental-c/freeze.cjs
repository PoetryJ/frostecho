// Preserves the old semantic/2 task. Author labels never enter blind inputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const canonical = value => value === null || typeof value !== 'object'
  ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (name, data) => fs.writeFileSync(path.join(root, name), data, 'utf8');
const json = (name, value) => write(name, `${JSON.stringify(value, null, 2)}\n`);
const lines = rows => rows.map(row => canonical(row)).join('\n') + '\n';
const authoredBytes = fs.readFileSync(path.join(root, 'authoring.json'));
const authored = JSON.parse(authoredBytes);
const contractPath = path.resolve(root, '../../../jev03/data/contract.json');
const contractBytes = fs.readFileSync(contractPath);
const contract = JSON.parse(contractBytes);
if (contract.schema !== authored.contract) throw new Error('original semantic contract mismatch');
const cases = [], labels = [], groups = [];
const seen = new Set(), seenGroups = new Set();
for (const group of authored.groups) {
  if (seenGroups.has(group.groupId)) throw new Error(`duplicate group ${group.groupId}`);
  seenGroups.add(group.groupId);
  groups.push({ groupId: group.groupId, split: group.split, scene: group.scene,
    semanticConflict: group.semanticConflict, count: group.cases.length });
  for (let index = 0; index < group.cases.length; index++) {
    const row = group.cases[index];
    const caseId = `${group.groupId}-${String(index + 1).padStart(2, '0')}`;
    const visibleInput = { context: row.context, playerText: row.playerText };
    const contentHash = sha(canonical(visibleInput));
    if (seen.has(contentHash)) throw new Error('duplicate visible dialogue');
    seen.add(contentHash);
    if (!contract.classes.includes(row.labelId)) throw new Error('unknown author class');
    cases.push({ caseId, groupId: group.groupId, split: group.split, scene: group.scene,
      source: authored.source, context: row.context, playerText: row.playerText, contentHash });
    labels.push({ caseId, contentHash, labelId: row.labelId, reason: row.reason, rule: row.rule,
      status: row.status ?? 'author-proposed', author: authored.author,
      independentReview: false, contract: contract.schema });
  }
}
const makeInputs = rows => rows.map(row => ({ caseId: row.caseId, groupId: row.groupId,
  visibleInput: { context: row.context, playerText: row.playerText } }));
for (const count of [16, 64]) {
  if (cases.length < count) continue;
  const batch = cases.slice(0, count);
  const name = `batch-${String(count).padStart(3, '0')}`;
  // Existing frozen batches are immutable while more groups are authored.
  const bytes = lines(batch);
  const existing = path.join(root, `${name}.blind.jsonl`);
  if (fs.existsSync(existing) && fs.readFileSync(existing, 'utf8') !== bytes) {
    throw new Error(`refuse to rewrite frozen ${name}`);
  }
  write(`${name}.blind.jsonl`, bytes);
  write(`${name}.inputs.jsonl`, lines(makeInputs(batch)));
  write(`${name}.author-labels.jsonl`, lines(labels.slice(0, count)));
  json(`${name}.freeze.json`, { schema: 'frostecho.jev03.incremental-freeze/1', count,
    contract: contract.schema, contractSha256: sha(contractBytes),
    blindSha256: sha(bytes), inputsSha256: sha(lines(makeInputs(batch))),
    authorLabelsSha256: sha(lines(labels.slice(0, count))),
    source: authored.source, worldTraceUsed: false, playerHumanAuthored: false,
    independentReviewCompleted: false, trainingReady: false,
    scope: 'Original four-class priority-request task; not general gameplay decision certification.' });
}
write('all.blind.jsonl', lines(cases));
write('author-labels.jsonl', lines(labels));
for (const split of ['train', 'dev']) {
  const subset = cases.filter(row => row.split === split);
  write(`${split}.blind.jsonl`, lines(subset));
  write(`${split}.inputs.jsonl`, lines(makeInputs(subset)));
}
json('groups.json', groups);
json('manifest.json', { schema: 'frostecho.jev03.incremental-manifest/1', contract: contract.schema,
  contractPath: '../../../jev03/data/contract.json', contractSha256: sha(contractBytes),
  authoringSha256: sha(authoredBytes), cases: cases.length,
  counts: Object.fromEntries(['train', 'dev'].map(split => [split, cases.filter(row => row.split === split).length])),
  groups: groups.length, source: authored.source, worldTraceUsed: false,
  oldTestRead: false, oldDataModified: false, independentReviews: 0,
  note: 'Author labels are proposals only. Independent blind A/B review and adjudication are pending.' });
console.log(JSON.stringify({ cases: cases.length, groups: groups.length, output: root }));
