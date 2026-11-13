const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const repo=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);
const CLI=path.join(repo,'dist/scripts/play-sprint.js');
function save(p,x){fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n')}
async function scenario(name,input){
 const out=path.join(root,name);fs.mkdirSync(out);const state=path.join(out,'state.json'),started=path.join(out,'started'),release=path.join(out,'release');
 const child=spawn(process.execPath,[CLI,'--fresh','--npc','2','--state',state,'--scorer',path.join(repo,'tests/fixtures/async-scorer.cjs')],{cwd:repo,stdio:['pipe','pipe','pipe'],env:{...process.env,R3_SCORER_STARTED:started,R3_SCORER_RELEASE:release,R3_SCORER_TARGET:'c-eat',R4_BARRIER_MS:'350',R4_STEP_TIMEOUT_MS:'5000'}});
 let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const rows=()=>stdout.split('\n').slice(0,-1).filter(Boolean).map(JSON.parse);
 const closed=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
 const wait=async f=>{const until=Date.now()+15000;while(!f()){if(Date.now()>until||child.exitCode!==null)throw new Error('wait failed '+stdout+' '+stderr);await new Promise(r=>setTimeout(r,8));}};
 try {
  await wait(()=>rows().some(r=>r.event==='ready'));child.stdin.write('step npc_01\n');await wait(()=>fs.existsSync(started));
  child.stdin.write(input);await wait(()=>rows().some(r=>r.command==='save'&&r.saved));
  const firstSaved=JSON.parse(fs.readFileSync(state));save(path.join(out,'first-save.json'),firstSaved);
  fs.writeFileSync(release,'go');await wait(()=>rows().filter(r=>r.command==='step').length===2);
  if(name==='two-save')await wait(()=>rows().filter(r=>r.command==='save'&&r.saved).length===2);
  const firstTwo=rows().filter(r=>r.command==='step');
  child.stdin.write('step npc_01\n');await wait(()=>rows().filter(r=>r.command==='step').length===3);
  const beforeSave=rows().filter(r=>r.command==='save'&&r.saved).length;child.stdin.write('save\n');await wait(()=>rows().filter(r=>r.command==='save'&&r.saved).length===beforeSave+1);
  const last=JSON.parse(fs.readFileSync(state));child.stdin.write('quit\n');const process=await closed;
  const summary={scenario:name,controlInput:input,process,firstSavedVersion:firstSaved.world.version,steps:rows().filter(r=>r.command==='step'),firstTwo,finalVersion:last.world.version,cancelSeen:rows().some(r=>r.command==='cancel')};
  save(path.join(out,'summary.json'),summary);
  assert.equal(process.code,0);assert.equal(firstSaved.world.version,0);assert.equal(firstTwo[0].decisions[0].executed,false);assert.deepEqual(firstTwo[0].decisions[0].eventIds,[]);
  if(name==='explicit-cancel'){assert.equal(firstTwo[1].decisions[0].executed,false);assert.deepEqual(firstTwo[1].decisions[0].eventIds,[]);assert.equal(summary.cancelSeen,true);assert.equal(last.world.version,1)}
  return {name,old:firstTwo[0].decisions[0],outside:firstTwo[1].decisions[0],finalVersion:last.world.version};
 } finally {fs.writeFileSync(path.join(out,'stdout.jsonl'),stdout);fs.writeFileSync(path.join(out,'stderr.txt'),stderr);if(child.exitCode===null)child.kill('SIGKILL');}
}
function thirdSupply(){
 const out=path.join(root,'supply'),state=path.join(out,'supply.json');
 const before=JSON.parse(fs.readFileSync(state)),cmBefore=JSON.parse(fs.readFileSync(state+'.commitments.json')).commitments.find(x=>x.goal==='supply-warehouse');
 const run=spawnSync(process.execPath,[CLI,'--state',state],{cwd:repo,input:'game-step\ngame-step\ncommitment-status\nsave\nquit\n',encoding:'utf8',timeout:15000});
 fs.writeFileSync(path.join(out,'third.jsonl'),run.stdout);fs.writeFileSync(path.join(out,'third.stderr'),run.stderr);assert.equal(run.status,0);
 const after=JSON.parse(fs.readFileSync(state)),cmAfter=JSON.parse(fs.readFileSync(state+'.commitments.json')).commitments.find(x=>x.commitmentId===cmBefore.commitmentId);
 const receiptId=cmBefore.evidenceEventIds[0];const events=[];
 function scan(x){if(!x||typeof x!=='object')return;if(x.kind==='stock_deposited'&&(x.eventId===receiptId||(x.sourceEventIds??[]).includes(receiptId)))events.push(x);for(const v of Object.values(x))scan(v);}
 scan(after.memories);
 assert.equal(cmAfter.status,'fulfilled');assert.deepEqual(cmAfter.evidenceEventIds,cmBefore.evidenceEventIds);assert.equal(after.world.spatial.stocks.warehouse.food,6);assert.equal(before.world.spatial.stocks.warehouse.food,6);assert.equal(after.world.version,before.world.version);assert.ok(events.length);
 const summary={beforeVersion:before.world.version,afterVersion:after.world.version,warehouseFood:6,commitment:cmAfter,linkedReceiptRecords:events};save(path.join(out,'third-restore-receipt-links.json'),summary);return {commitment:cmAfter.commitmentId,receiptId,linkedRecords:events.length,afterVersion:after.world.version};
}
(async()=>{const results={supply:thirdSupply(),cancel:await scenario('explicit-cancel','save\nstep npc_01\ncancel npc_01\n'),twoSave:await scenario('two-save','save\nstep npc_01\nsave\n')};save(path.join(root,'extra-summary.json'),results);console.log(JSON.stringify(results,null,2));})().catch(e=>{console.error(e);process.exitCode=1});
