import json, collections, hashlib
from pathlib import Path
src=Path('/data3/DATA/project/project_meishijiang/FrostEcho/artifacts/sprint-r5/delivery/traces/fourday')
out=Path('/tmp/frostecho-r5-product-TiofSV')
a=json.loads((src/'continuous.session.json').read_text())
b=json.loads((src/'segmented.session.json').read_text())
rows=[json.loads(x) for x in (src/'continuous.jsonl').read_text().splitlines() if x.strip()]
counts=collections.Counter(r.get('command','event:'+str(r.get('event'))) for r in rows)
world=a['world']; bworld=b['world']
status=[r for r in rows if r.get('command')=='task-status']
events=[e for r in rows for e in r.get('events',[])]
steps=[r for r in rows if r.get('command')=='game-step']
selected=collections.Counter(rec.get('selectedId') for r in steps for rec in r.get('records',[]))
cs=json.loads((src/'continuous.session.json.council.json').read_text())
result={'authoritativeWorldExactlyEqual':world==bworld,'differingWorldKeys':[k for k in world if world[k]!=bworld.get(k)],'minutes':world['simTime'],'hours':world['simTime']/60,'scenarioDays':world['scenarioDays'],'ending':world['ending'],'alive':sum(n['alive'] for n in world['npcs'].values()),'deliveredMeals':world.get('spatial',{}).get('deliveredMeals'),'warehouseFood':world.get('spatial',{}).get('stocks',{}).get('warehouse',{}).get('food'),'commandCounts':dict(counts),'selectedCounts':dict(selected),'explicitWorldEvents':dict(collections.Counter(e['type'] for e in events)),'dayStatuses':[{'simTime':r.get('status',{}).get('simTime'),'hoursElapsed':r.get('status',{}).get('hoursElapsed'),'deliveredMeals':r.get('status',{}).get('spatial',{}).get('deliveredMeals')}for r in status],'councils':[{'id':c.get('councilId'),'day':c.get('day'),'status':c.get('status'),'requests':len(c.get('requests',[]))}for c in cs['councils']],'note':'Submission raw evidence audited, independent acceptance-v5 rerun separately. No new model calls.'}
(out/'fourday-raw-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))