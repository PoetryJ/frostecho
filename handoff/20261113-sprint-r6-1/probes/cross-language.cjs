const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const {assessEvidence,fitTemperature} = require(path.join(repo,'dist/src/decision/jev-evidence.js'));
const result = {};
for (const name of ['fixture','cpu-mechanism']) {
  const payloads=JSON.parse(fs.readFileSync(path.join(out,name,'payloads.json'),'utf8'));
  const identity=JSON.parse(fs.readFileSync(path.join(out,name,'identity.json'),'utf8'));
  const fitted=fitTemperature(payloads.calT.records.map(r=>r.logits),payloads.calT.records.map(r=>r.label));
  result[name]={assessment:assessEvidence(payloads,identity),rawJsFittedT:fitted,
    declaredPythonT:payloads.calT.temperature,gap:Math.abs(fitted-payloads.calT.temperature)};
}
fs.writeFileSync(path.join(out,'cross-language.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
