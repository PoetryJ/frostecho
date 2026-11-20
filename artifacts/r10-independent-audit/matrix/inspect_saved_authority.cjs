// CPU-only load inspection. No scorer, model, clock advance or production writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const repo=path.resolve(process.env.FROSTECHO_REPO_ROOT || path.join(__dirname,'../../..'));

const auditOut=process.env.FROSTECHO_AUDIT_OUT || fs.mkdtempSync(path.join(require('node:os').tmpdir(),'frostecho-r10-audit-'));fs.mkdirSync(auditOut,{recursive:true});
const {R8Runtime}=require(path.join(repo,'dist/src/r7/integration/runtime.js'));
const {GameplayLoop}=require(path.join(repo,'dist/src/gameplay-v2/loop.js'));
const {TaskBoard}=require(path.join(repo,'dist/src/gameplay-v2/tasks.js'));
const {CommitmentBoard}=require(path.join(repo,'dist/src/gameplay-v2/commitments.js'));
const {CouncilBoard}=require(path.join(repo,'dist/src/council-v2/council.js'));
const {ExperienceStore}=require(path.join(repo,'dist/src/memory/experience.js'));
const {createCommitmentBridge}=require(path.join(repo,'dist/src/r7/integration/commitment-bridge.js'));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const encode=x=>JSON.parse(JSON.stringify(x,(_k,v)=>typeof v==='number'&&!Number.isFinite(v)?{$frostechoNumber:String(v)}:v));
const equal=(a,b)=>JSON.stringify(sort(a))===JSON.stringify(sort(b));
const differences=(a,b,prefix='',found=[])=>{
 if(equal(a,b))return found;
 if(found.length>=30)return found;
 if(a&&b&&typeof a==='object'&&typeof b==='object'){
  for(const k of new Set([...Object.keys(a),...Object.keys(b)]))differences(a[k],b[k],prefix+'/'+k,found);
 }else found.push({path:prefix,saved:a??null,loaded:b??null});
 return found;
};
const results=[];
for(const arm of ['new-raw','new-conditional'])for(const seed of ['r10h-1','r10h-2']){
 const prefix=path.join(repo,'artifacts/r10/matrix/arms',arm,seed,'d2/session.json');
 const saved=read(prefix),r8=read(prefix+'.r8.json'),ltm=read(prefix+'.long-term-memory.json');
 const r=R8Runtime.load(prefix),s=r.session;
 const play=new GameplayLoop(s,TaskBoard.fromJSON(read(prefix+'.tasks.json')),{
  commitments:CommitmentBoard.fromJSON(read(prefix+'.commitments.json')),
  council:CouncilBoard.fromJSON(read(prefix+'.council.json')),
  experience:ExperienceStore.fromJSON(read(prefix+'.experience.json'))});
 const session={world:s.world,memories:Object.fromEntries([...s.memories].map(([id,store])=>[id,store.toJSON()])),
  outcomes:s.outcomes,plans:s.plans,instances:s.instances,generations:Object.fromEntries(s.generations),sequence:s.sequence,seed:s.seed,inputSequence:s.inputSequence,inputReceipts:s.inputReceipts};
 const sessionFields=Object.fromEntries(Object.entries(session).map(([k,v])=>[k,equal(saved[k],v)]));
 const document=encode(r.toDocument());
 const runtimeFields=Object.fromEntries(Object.entries(document).map(([k,v])=>[k,equal(r8[k],v)]));
 const before=r.committedEvents().map(e=>e.eventId);const beforeWorld=JSON.stringify(s.world);
 const memoryBefore=play.longTermMemory.serialize();
 const bridge=createCommitmentBridge(r,play);
 const bridgeWorldUnchanged=beforeWorld===JSON.stringify(s.world);
 const bridgeReceiptsUnchanged=equal(before,r.committedEvents().map(e=>e.eventId));
 const goals=Object.fromEntries(s.npcIds.map(id=>[id,bridge.view(id)]));
 play.syncLongTermMemory();const memoryAfter=play.longTermMemory.serialize();
 const entry={arm,seed,pid:process.pid,scope:'Independent CPU load on integration source; not a re-run of old H game',sessionFields,runtimeFields,runtimeDifferenceExamples:differences(r8,document),
  taskBoardEqual:equal(play.board.toJSON(),read(prefix+'.tasks.json')),commitmentBoardEqual:equal(play.commitments.toJSON(),read(prefix+'.commitments.json')),
  councilEqual:equal(play.council.toJSON(),read(prefix+'.council.json')),experienceEqual:equal(play.experience.toJSON(),read(prefix+'.experience.json')),
  longTermMemory:{savedEvents:ltm.memory.events.length,beforeSyncEvents:memoryBefore.events.length,afterSyncEvents:memoryAfter.events.length,
   exactBeforeSync:equal(memoryBefore,ltm.memory),exactAfterSync:equal(memoryAfter,ltm.memory),
   savedPolicy:{mode:ltm.mode,tokenBudget:ltm.tokenBudget},harnessPolicy:{mode:play.decisionMemoryMode,tokenBudget:play.decisionMemoryTokenBudget}},
  bridgeWorldUnchanged,bridgeReceiptsUnchanged,restoredGoalViews:goals};
 results.push(entry);
}
const output={schema:'frostecho.h-independent-saved-authority-load/1',method:'No scorer/GPU/time advance/save; exact structural comparison of persisted fields after load; H reconstruction copied explicitly',results};
fs.writeFileSync(path.join(auditOut,'saved-authority-load.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(results.map(({restoredGoalViews,...rest})=>rest),null,2));
