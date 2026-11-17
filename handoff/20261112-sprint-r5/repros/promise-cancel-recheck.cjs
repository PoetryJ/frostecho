const assert = require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const repo=process.argv[2], out=process.argv[3]; fs.mkdirSync(out,{recursive:true});
const write=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=path.join(repo,'tests/fixtures/async-scorer.cjs');
function cli(name,input,extra=[]){const state=path.join(out,name+'.session.json');const p=spawnSync(process.execPath,[path.join(repo,'dist/scripts/play-sprint.js'),'--state',state,...extra],{cwd:repo,input,encoding:'utf8'});assert.equal(p.status,0,p.stderr);const rows=p.stdout.trim().split('\n').map(x=>JSON.parse(x));return {state,rows,stderr:p.stderr};}
function start(name,target='c-eat'){
 const state=path.join(out,name+'.session.json'),started=path.join(out,name+'.started.json'),release=path.join(out,name+'.release');
 const child=spawn(process.execPath,[path.join(repo,'dist/scripts/play-sprint.js'),'--state',state,'--fresh','--npc','2','--scorer',fixture],{cwd:repo,env:{...process.env,R3_SCORER_STARTED:started,R3_SCORER_RELEASE:release,R3_SCORER_TARGET:target},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const rows=()=>stdout.trim()?stdout.trim().split('\n').map(x=>JSON.parse(x)):[];
 const wait=async f=>{const deadline=Date.now()+20000;while(!f()){if(Date.now()>deadline)throw Error('wait timeout '+stdout+stderr);await sleep(10)}};
 const done=new Promise((res,rej)=>child.on('close',code=>{fs.writeFileSync(path.join(out,name+'.jsonl'),stdout);res({code,stdout,stderr,rows:rows()})}));
 return {child,state,started,release,rows,wait,done};
}
(async()=>{
 const p=start('actual-promise-cancel','c-help-p-food-npc_01');
 await p.wait(()=>p.rows().some(x=>x.event==='ready'));
 p.child.stdin.write('promise npc_01\nstep npc_01\n');
 await p.wait(()=>fs.existsSync(p.started));
 p.child.stdin.write('cancel npc_01\n');
 await p.wait(()=>p.rows().some(x=>x.command==='cancel'));
 assert(!fs.existsSync(p.release));
 fs.writeFileSync(p.release,'go');
 await p.wait(()=>p.rows().some(x=>x.command==='step'));
 p.child.stdin.write('save\n');
 await p.wait(()=>p.rows().some(x=>x.command==='save'));
 const cancelled=JSON.parse(fs.readFileSync(p.state));write('actual-promise-cancel.before-fresh.json',cancelled);
 assert.equal(cancelled.world.version,0);assert.equal(Object.keys(cancelled.outcomes).length,0);assert.equal(cancelled.instances[0].state,'cancelled');
 p.child.stdin.write('step npc_01\nsave\nquit\n');
 const result=await p.done;assert.equal(result.code,0);
 const after=JSON.parse(fs.readFileSync(p.state));assert.equal(after.world.version,1);write('actual-promise-cancel.summary.json',{passed:true,oldWorldVersion:cancelled.world.version,newWorldVersion:after.world.version,outcomesBefore:Object.keys(cancelled.outcomes).length,outcomesAfter:Object.keys(after.outcomes).length,steps:result.rows.filter(x=>x.command==='step')});

 console.log('R3 actual promise cancel proof passed on R4');
})().catch(e=>{console.error(e);process.exit(1)});
