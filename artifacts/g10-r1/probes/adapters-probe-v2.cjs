/** Adapted from the shipped probe: writeRunRecord now returns {ok,path}; record authority lives under `authoritative`. Assertions unchanged. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const repo=path.resolve(process.argv[2]||'.');
const out=process.argv[3]||fs.mkdtempSync(path.join(os.tmpdir(),'g10-adapter-audit-'));
fs.mkdirSync(out,{recursive:true});
const {createG10Runtime,loadG10Runtime}=require(path.join(repo,'dist/src/application/adapters.js'));
const {createApplicationController}=require(path.join(repo,'dist/src/application/session.js'));
const {openCampaign,loadCampaign}=require(path.join(repo,'dist/src/eval/campaign-budget.js'));
const posts=[];
const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{posts.push(JSON.parse(raw));const goal=raw.includes('candidateGoals:');res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'adapter-audit-'+posts.length,choices:[{message:{content:goal?'{"goal":"yield_once"}':'{"type":"wait"}'}}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}));});});
function controller(runtime){return createApplicationController({game:runtime.game,config:runtime.config,root:runtime.root,slot:runtime.slot,meta:runtime.meta,ports:runtime.ports});}
async function main(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;
 const original=path.join(out,'original-campaign'),replacement=path.join(out,'replacement-campaign');
 openCampaign(original,1,'task-original');openCampaign(replacement,1,'task-replacement');
 const made=createG10Runtime({root:out,slot:'demo',goals:'negotiated',candidates:'choice',satiety:40,fixture:null,live:true,http:url,model:'audit-model',campaign:original,campaignLimit:null});
 if(!made.ok)throw Error(JSON.stringify(made));const runtime=made.value,c=controller(runtime);
 await c.execute({kind:'request',actorId:'npc_a',goal:'yield_once'});
 const goal=await c.execute({kind:'step'});const saved=await c.execute({kind:'save',slot:'chosen'});
 const savedPath=path.join(out,'chosen.g09.json');const bytes=fs.readFileSync(savedPath);
 const beforeCalls=posts.length;
 const switched=loadG10Runtime(savedPath,{live:true,model:'audit-model',fixture:null,http:url,campaign:replacement,campaignLimit:null});
 let action=null,afterView=null;
 if(switched.ok){const rc=controller(switched.value);action=await rc.execute({kind:'step'});afterView=rc.view();}
 const report={repo,out,realModelCalls:0,loopbackPosts:posts.length,originalTaskLimit:1,goal,saved,loadDifferentCampaignAccepted:switched.ok,loadOnlyPosts:0,postDeltaAfterSwitch:posts.length-beforeCalls,action,afterView,originalLedger:loadCampaign(original),replacementLedger:loadCampaign(replacement),inputSlotUnchanged:bytes.equals(fs.readFileSync(savedPath)),savedApp:JSON.parse(bytes).payload.app};
 const written=runtime.writeRunRecord(c.view());const runPath=written.ok?written.path:null;const runRecord=runPath===null?{payload:{}}:JSON.parse(fs.readFileSync(runPath));
 report.runRecord={path:runPath,payloadKeys:Object.keys(runRecord.payload),hasWorldRecord:'authoritative'in runRecord.payload,hasCommands:'commands'in (runRecord.payload.authoritative??{}),hasEvents:'events'in (runRecord.payload.authoritative??{})};
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await new Promise(r=>server.close(r));
}
main().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
