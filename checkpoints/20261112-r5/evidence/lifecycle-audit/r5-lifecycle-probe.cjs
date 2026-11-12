const fs=require('node:fs');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const repo=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});
const CLI=path.join(repo,'dist/scripts/play-sprint.js');
const save=(n,x)=>fs.writeFileSync(path.join(out,n),JSON.stringify(x,null,2)+'\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state=path.join(out,'outside.session.json'),started=path.join(out,'started'),release=path.join(out,'release');
const child=spawn(process.execPath,[CLI,'--fresh','--npc','2','--state',state,'--scorer',path.join(repo,'tests/fixtures/async-scorer.cjs')],{cwd:repo,stdio:['pipe','pipe','pipe'],env:{...process.env,R3_SCORER_STARTED:started,R3_SCORER_RELEASE:release,R3_SCORER_TARGET:'c-eat',R4_BARRIER_MS:'350',R4_STEP_TIMEOUT_MS:'5000'}});
let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
const rows=()=>stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
const wait=async f=>{const end=Date.now()+10000;while(!f()){if(Date.now()>end)throw Error('timeout '+stdout+' '+stderr);await sleep(10)}};
const done=new Promise(resolve=>child.on('close',(code,signal)=>{fs.writeFileSync(path.join(out,'outside.jsonl'),stdout);save('process.json',{code,signal,stderr});resolve({code,signal})}));
(async()=>{
 await wait(()=>rows().some(x=>x.event==='ready'));
 child.stdin.write('step npc_01\n');await wait(()=>fs.existsSync(started));
 child.stdin.write('save\nstep npc_01\n');
 await wait(()=>rows().some(x=>x.command==='save'&&x.saved));
 const saved=JSON.parse(fs.readFileSync(state));save('saved-before-release.json',saved);
 const atSave=rows();fs.writeFileSync(release,'go');await wait(()=>rows().filter(x=>x.command==='step').length===2);
 const afterOutside=rows().filter(x=>x.command==='step');
 child.stdin.write('step npc_01\n');await wait(()=>rows().filter(x=>x.command==='step').length===3);
 child.stdin.write('save\n');await wait(()=>rows().filter(x=>x.command==='save'&&x.saved).length===2);
 const final=JSON.parse(fs.readFileSync(state));child.stdin.write('quit\n');const result=await done;
 save('outside-result.json',{expected:'job accepted after save capture, before timeout should remain valid',savedVersion:saved.world.version,atSave,afterOutside,allSteps:rows().filter(x=>x.command==='step'),finalVersion:final.world.version,process:result});
 assert.equal(result.code,0);assert.equal(saved.world.version,0);
 console.log(JSON.stringify({savedVersion:saved.world.version,outsideDecision:afterOutside[1]?.decisions,thirdDecision:rows().filter(x=>x.command==='step')[2]?.decisions,finalVersion:final.world.version},null,2));
 // Canonical travel replay after restarting, then a changed target with same id.
 const tstate=path.join(out,'travel.session.json');
 function cli(label,input,args=[]){const p=spawnSync(process.execPath,[CLI,'--state',tstate,...args],{cwd:repo,input,encoding:'utf8',timeout:10000});fs.writeFileSync(path.join(out,label+'.jsonl'),p.stdout);return{code:p.status,rows:p.stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)),stderr:p.stderr};}
 const first=cli('travel-first','travel npc_01 warehouse id=travel-one\nsave\nquit\n',['--fresh','--npc','2']);
 const second=cli('travel-second','travel npc_01 warehouse id=travel-one\ntravel npc_01 kitchen id=travel-one\nsave\nquit\n');
 const f=first.rows.find(x=>x.command==='travel'),s=second.rows.filter(x=>x.command==='travel');
 assert.equal(first.code,0);assert.equal(second.code,0);assert.equal(s[0].duplicate,true);assert.deepEqual(s[0].eventIds,f.eventIds);assert.equal(s[0].tiles,f.tiles);assert.equal(s[0].minutes,f.minutes);assert.equal(s[1].reason,'command_id_conflict');
 save('travel-crossprocess-result.json',{first,second,verified:true});
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{if(child.exitCode===null)child.kill('SIGKILL')});