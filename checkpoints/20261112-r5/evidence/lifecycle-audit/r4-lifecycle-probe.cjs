const fs = require('node:fs');
const path = require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const repo=process.argv[2], out=process.argv[3];fs.mkdirSync(out,{recursive:true});
const CLI=path.join(repo,'dist/scripts/play-sprint.js');
const save=(name,x)=>fs.writeFileSync(path.join(out,name),JSON.stringify(x,null,2)+'\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const active=[];
function start(name){
 const state=path.join(out,name+'.session.json'),started=path.join(out,name+'.started'),release=path.join(out,name+'.release');
 const child=spawn(process.execPath,[CLI,'--fresh','--npc','2','--state',state,'--scorer',path.join(repo,'tests/fixtures/async-scorer.cjs')],{cwd:repo,stdio:['pipe','pipe','pipe'],env:{...process.env,R3_SCORER_STARTED:started,R3_SCORER_RELEASE:release,R3_SCORER_TARGET:'c-eat',R4_BARRIER_MS:'400',R4_STEP_TIMEOUT_MS:'5000'}});
 active.push(child);let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const rows=()=>stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
 const wait=async f=>{const end=Date.now()+12000;while(!f()){if(Date.now()>end)throw Error('timeout '+name+' '+stdout+' '+stderr);await sleep(10)}};
 const done=new Promise(resolve=>child.on('close',(code,signal)=>{fs.writeFileSync(path.join(out,name+'.jsonl'),stdout);resolve({code,signal,rows:rows(),stderr})}));
 return {child,state,started,release,rows,wait,done};
}
function cli(name,input,extra=[]){const state=path.join(out,name+'.json');const p=spawnSync(process.execPath,[CLI,'--state',state,...extra],{cwd:repo,input,encoding:'utf8',timeout:15000});fs.writeFileSync(path.join(out,name+'.jsonl'),p.stdout);return{state,code:p.status,rows:p.stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)),stderr:p.stderr};}
(async()=>{
 // Recheck normal new intent vs explicit retry, including an intent with a derived route.
 const first=cli('restart','promise npc_01\ncancel npc_01\nrestock 2 player\nsave\nquit\n',['--fresh','--npc','2']);
 const second=cli('restart','promise npc_01\nrestock 3 player\nknowledge\nsave\nquit\n');
 assert.equal(first.code,0);assert.equal(second.code,0);assert.equal(second.rows.find(x=>x.command==='promise').duplicate,false);assert.equal(second.rows.find(x=>x.command==='restock').warehouseFood,9);
 save('restart-result.json',{first:first.rows,second:second.rows});
 const travel=cli('travel-retry','travel npc_01 warehouse id=travel-one\ntravel npc_01 warehouse id=travel-one\nsave\nquit\n',['--fresh','--npc','2']);
 save('travel-retry-result.json',travel);
 // Two pre-save steps, only the first has started when the save times out.
 const q=start('queued-actors');await q.wait(()=>q.rows().some(x=>x.event==='ready'));
 q.child.stdin.write('step npc_01\nstep npc_02\n');await q.wait(()=>fs.existsSync(q.started));
 q.child.stdin.write('save\n');await q.wait(()=>q.rows().some(x=>x.command==='save'));
 const before=JSON.parse(fs.readFileSync(q.state));save('queued-before-release.json',before);
 const rowsAtSave=q.rows();fs.writeFileSync(q.release,'go');await q.wait(()=>q.rows().filter(x=>x.command==='step').length===2);
 q.child.stdin.write('save\n');await q.wait(()=>q.rows().filter(x=>x.command==='save'&&x.saved).length===2);
 const after=JSON.parse(fs.readFileSync(q.state));q.child.stdin.write('quit\n');const qr=await q.done;
 save('queued-result.json',{beforeVersion:before.world.version,afterVersion:after.world.version,generationsAtSave:before.generations,rowsAtSave,...qr});
 // EOF and an already accepted save have a separate settle timer.
 const e=start('eof-with-save');await e.wait(()=>e.rows().some(x=>x.event==='ready'));
 e.child.stdin.write('step npc_01\n');await e.wait(()=>fs.existsSync(e.started));
 const at=Date.now();e.child.stdin.end('save\n');const er=await e.done;
 save('eof-with-save-result.json',{elapsedMs:Date.now()-at,saveExists:fs.existsSync(e.state),...er});
 console.log(JSON.stringify({restartFixed:true,travel:travel.rows.filter(x=>x.command==='travel').map(x=>({status:x.status,reason:x.reason})),queuedBefore:before.world.version,queuedAfter:after.world.version,eofSaveExists:fs.existsSync(e.state),eofCode:er.code},null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{for(const p of active)if(p.exitCode===null)p.kill('SIGKILL')});
