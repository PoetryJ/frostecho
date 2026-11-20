const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.env.FROSTECHO_REPO_ROOT || path.join(__dirname,'../../..'));
const {R8Runtime}=require(root+'/dist/src/r7/integration/runtime.js');

const auditOut=process.env.FROSTECHO_AUDIT_OUT || fs.mkdtempSync(path.join(require('node:os').tmpdir(),'frostecho-r10-audit-'));fs.mkdirSync(auditOut,{recursive:true});
const {runStep,visibleMemory,executeCandidate}=require(root+'/dist/src/r7/integration/step.js');
const {makeChoiceResult}=require(root+'/dist/src/decision/contracts.js');
const {referenceAgencyScorer}=require(root+'/dist/src/r7/agency/reference.js');
const {renderRequest}=require(root+'/dist/src/r7/jev/render.js');
const c=(action,p={})=>({id:'extra-'+action,kind:action,description:'independent CPU '+action,parameters:{action,...p},preconditions:[],expectedEffects:{},utilityComponents:{}});
async function main(){
 if(process.argv[2]==='--fullmap'){
  const r=R8Runtime.create({seed:'fullmap-single-due'});r.enableLegacySpatial();
  r.beginIntent({intentId:'original-move',commandId:'original-move',actorId:'npc_01',candidate:c('move',{to:'warehouse',purpose:'travel'}),minutes:15});
  const start=r.world.simTime;r.advanceWorld(start+15);
  console.log(JSON.stringify({clock:r.world.simTime,target:start+15,workLog:r.workLog.length,status:r.intents.get('original-move')?.status,failures:r.workLog.slice(-3),actor:r.world.npcs.npc_01.location}));return;
 }
 const out={sourceHead:'288a288',gpuCalls:0,cases:[]};
 {const r=R8Runtime.create({seed:'budget-large-commitment'});
  r.session.memories.get('npc_01').append({eventId:'large-realistic-commitment',observerId:'npc_01',occurredAt:480,observedAt:480,kind:'commitment_accepted',source:'player_statement',authority:'player',subjectIds:['npc_01','player'],speakerId:'player',payload:{text:'本次送饭任务的条件及解释。'.repeat(500),commitmentId:'cpu-c1',revision:1}});
  const m=visibleMemory(r,'npc_01',12,'obligation-first',64);let request;
  const scorer={identity:referenceAgencyScorer().identity,score(q){request=q;return makeChoiceResult({request:q,scorerId:'extra-budget',scores:q.candidates.map(x=>({candidateId:x.id,logit:0})),disposition:'abstain',selectedId:null,reason:'CPU input capture'});}};
  const step=await runStep(r,scorer,{actorIds:['npc_01'],memoryTokenBudget:64});
  out.cases.push({name:'first-oversized-memory-bypasses-budget',budget:64,kept:m.kept,tokens:m.tokens,renderedMemorySegment:renderRequest(request).segments.filter(s=>s.kind==='memory').map(s=>({bytes:Buffer.byteLength(s.text),hasTail:s.text.includes('cpu-c1')})),stepRecorded:step.records.map(x=>({memoryBudget:x.memoryBudget,memoryTokens:x.memoryTokens})),issueReproduced:m.tokens>64&&m.kept===1});}
 {const r=R8Runtime.create({seed:'correct-place-direct'});r.session.submitWorldCommand({commandId:'to-village',type:'move',actorId:'npc_01',to:'village'});const before={time:r.world.simTime,wood:r.world.resources.firewood};const choice=c('gather',{resource:'firewood',amount:2});const wrapper=executeCandidate(r,'npc_01',choice,'wrapper'),low=r.session.executeCandidate('npc_01',choice,'no-grant');out.cases.push({name:'correct-place-undefined-grant-bypasses-time',before,wrapper,low,after:{time:r.world.simTime,wood:r.world.resources.firewood},issueReproduced:wrapper.status==='rejected'&&low.status==='applied'&&before.time===r.world.simTime});}
 {const r=R8Runtime.create({seed:'dedupe'}),choice=c('rest',{minutes:60});const start=r.beginIntent({intentId:'first',commandId:'first',actorId:'npc_01',candidate:choice,minutes:60});const repeated=r.beginIntent({intentId:'retry',commandId:'retry',actorId:'npc_01',candidate:choice,minutes:60});r.advanceWorld(540);out.cases.push({name:'queued-demand-dedup-positive',first:start.intent?.intentId,repeat:repeated.intent?.intentId,duplicate:repeated.duplicate,intents:r.intents.size,receipts:r.committedEvents().filter(e=>e.type==='rested').length,ok:start.intent?.intentId===repeated.intent?.intentId&&r.committedEvents().filter(e=>e.type==='rested').length===1});}
 const child=require('node:child_process').spawnSync(process.execPath,['--stack-size=128',__filename,'--fullmap'],{encoding:'utf8',timeout:10000});
 out.cases.push({name:'original-map-due-move-reentrancy',exit:child.status,signal:child.signal,error:child.error?.message,stdout:child.stdout.slice(-4000),stderr:child.stderr.slice(-500)});
 fs.writeFileSync(path.join(auditOut,'extra.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
