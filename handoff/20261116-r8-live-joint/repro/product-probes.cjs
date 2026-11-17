// Independent CPU probes on 8d100c4; does not edit production sources.
const path = require('node:path');
const fs = require('node:fs');
const repo = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, {recursive:true});
const {R8Runtime} = require(path.join(repo, 'dist/src/r7/integration/runtime.js'));
const {runStep} = require(path.join(repo, 'dist/src/r7/integration/step.js'));
const {referenceAgencyScorer} = require(path.join(repo, 'dist/src/r7/agency/reference.js'));

function task(rt, type, actor) {
  rt.dispatch('tasks','propose',actor,{type,assigneeId:actor});
  const t=rt.states.tasks.tasks.at(-1);
  rt.dispatch('tasks','respond',actor,{taskId:t.taskId,verdict:'accept'});
  return t.taskId;
}
function doWork(rt, actor) {
 const result=rt.session.submitWorldCommand({commandId:'wood-for-food-probe',type:'gather',actorId:actor,resource:'firewood',amount:2});
 rt.recordCommitted(result.events);
 return result.events.at(-1).eventId;
}

(async()=>{
 const results=[];
 const wrong=R8Runtime.create({seed:'wrong-resource'});
 const actor=wrong.context().actorIds[0];
 const tid=task(wrong,'COLLECT_FOOD',actor);
 const beforeFood=wrong.world.resources.food;
 const receipt=doWork(wrong,actor);
 const close=wrong.dispatch('tasks','complete',actor,{taskId:tid,receiptEventId:receipt});
 results.push({probe:'wood_receipt_completes_food',beforeFood,afterFood:wrong.world.resources.food,
  receipt:wrong.committedEvent(receipt),status:wrong.states.tasks.tasks.find(t=>t.taskId===tid).status,rejected:close.rejected});

 const restore=R8Runtime.create({seed:'restore-receipt'});
 const aid=restore.context().actorIds[0];
 const id=task(restore,'COLLECT_WOOD',aid);
 const rid=doWork(restore,aid);
 const count=restore.committedEvents().length;
 const file=path.join(out,'pending-receipt.save');
 restore.save(file);
 const loaded=R8Runtime.load(file);
 const after=loaded.dispatch('tasks','complete',aid,{taskId:id,receiptEventId:rid});
 results.push({probe:'restore_loses_committed_receipt',beforeCount:count,afterCount:loaded.committedEvents().length,
  sameClock:restore.world.simTime===loaded.world.simTime,receiptId:rid,
  status:loaded.states.tasks.tasks.find(t=>t.taskId===id).status,rejected:after.rejected});

 const slow=R8Runtime.create({npcCount:1,seed:'cancel-during-score'});
 const sid=slow.context().actorIds[0];
 const reference=referenceAgencyScorer();
 let release, started;
 const startedPromise=new Promise(r=>started=r);
 const port={identity:reference.identity,score:request=>new Promise(resolve=>{
  release=()=>resolve(reference.score(request));started(request);
 })};
 const beforeVersion=slow.world.version;
 const pending=runStep(slow,port);
 const req=await startedPromise;
 const beforeGeneration=slow.session.generationFor(sid);
 slow.session.bumpGeneration(sid,'audit_cancel');
 release();
 const returned=await pending;
 results.push({probe:'cancel_generation_then_late_result',requestId:req.requestId,beforeGeneration,
  afterGeneration:slow.session.generationFor(sid),beforeVersion,afterVersion:slow.world.version,
  executed:returned.executed,records:returned.records.map(r=>({actorId:r.actorId,executionStatus:r.executionStatus,eventIds:r.eventIds}))});
 fs.writeFileSync(path.join(out,'product-probes.json'),JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
