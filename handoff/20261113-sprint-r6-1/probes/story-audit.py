import hashlib, json, pathlib, re, sys
root=pathlib.Path(sys.argv[1]); repo=pathlib.Path(sys.argv[2])
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def arm(path):
 return {'session':read(path/'session.json'),'tasks':read(path/'session.json.tasks.json'),
         'commitments':read(path/'session.json.commitments.json'),'council':read(path/'session.json.council.json'),
         'experience':read(path/'session.json.experience.json') if (path/'session.json.experience.json').exists() else None}
def diffs(a,b,path='',out=None):
 out=[] if out is None else out
 if type(a)!=type(b):out.append(path+': type');return out
 if isinstance(a,dict):
  for k in sorted(a.keys()|b.keys()):
   if k not in a or k not in b:out.append(path+'/'+k+': missing')
   else:diffs(a[k],b[k],path+'/'+k,out)
 elif isinstance(a,list):
  if len(a)!=len(b):out.append(path+': length')
  for i,(x,y) in enumerate(zip(a,b)):diffs(x,y,path+'/'+str(i),out)
 elif a!=b:out.append(path)
 return out
def normalize(value):
 aliases={}
 for council in value['council']['councils']:
  for request in council.get('requests',[]):
   if request.get('commitmentId'):aliases[request['commitmentId']]='CM_FOR:'+request['requestId']
 for cm in value['commitments']['commitments']:
  if cm['commitmentId'] not in aliases:raise ValueError('unmapped commitment: '+cm['commitmentId'])
  for i,ch in enumerate(cm.get('changes',[])):
   if ch.get('changeId'):aliases[ch['changeId']]='CHANGE_FOR:'+aliases[cm['commitmentId']]+':'+str(i)
 def mapped(text):
  for old,new in sorted(aliases.items(),key=lambda x:len(x[0]),reverse=True):text=text.replace(old,new)
  return text
 for actor,memory in value['session'].get('memories',{}).items():
  for record in memory.get('records',[]):
   if record.get('recordId'):
    aliases[record['recordId']]='MEM:'+actor+':'+mapped(str(record.get('eventId')))+':'+str(record.get('revision'))
 for old,note in (value.get('experience') or {}).items():
  aliases[old]='EXP:'+note['ownerActorId']+':'+note['lesson']+':'+hashlib.sha256(json.dumps(note['conditions'],sort_keys=True).encode()).hexdigest()
 if len(set(aliases.values()))!=len(aliases):raise ValueError('normalization is not a bijection')
 text=json.dumps(value,sort_keys=True)
 for old,new in sorted(aliases.items(),key=lambda x:len(x[0]),reverse=True):text=text.replace(old,new)
 return json.loads(text),aliases
def inspect(play):
 a,b=arm(play/'continuous'),arm(play/'segmented')
 na,aa=normalize(a);nb,ab=normalize(b)
 failures=[]
 for label,doc in [('continuous',a),('segmented',b)]:
  cms={x['commitmentId']:x for x in doc['commitments']['commitments']}
  for task in doc['tasks']:
   cid=task.get('commitmentId')
   if cid:
    c=cms.get(cid)
    if not c or c.get('taskId')!=task['taskId'] or c['promisorId']!=task['actorId']:failures.append([label,task['taskId'],'broken binding'])
    if c and task['status']=='done' and c['status']!='fulfilled':failures.append([label,task['taskId'],'done without fulfilled'])
  for council in doc['council']['councils']:
   for request in council.get('requests',[]):
    cid=request.get('commitmentId')
    if cid and (cid not in cms or cms[cid]['promisorId']!=request['actorId'] or cms[cid]['goal']!=request['goal']):failures.append([label,request['requestId'],'request binding'])
 return {'wholeWorldEqual':a['session']['world']==b['session']['world'],
 'wholeWorldDifferences':diffs(a['session']['world'],b['session']['world'])[:30],
 'allStateAfterUuidOnlyMappingEqual':na==nb,'remainingDifferences':diffs(na,nb)[:40],
 'mappingRule':'Map commitment ids by requestId; change ids by parent and ordinal; memory ids by actor/event/revision; experience ids by owner/lesson/conditions. No fields removed.',
 'bindingFailures':failures,'simTime':a['session']['world']['simTime'],'day':a['session']['world']['day'],
 'mappingCounts':[len(aa),len(ab)]}
result={'submitted':inspect(repo/'artifacts/sprint-r6/run01/integration-refit/play'),'independent':inspect(root/'story')}
(root/'story-audit.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,indent=2))
