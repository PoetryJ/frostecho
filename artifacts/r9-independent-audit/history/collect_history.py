"""Read-only Git/architecture inventory; no model, game, network or source edits."""
from pathlib import Path
import argparse, collections, json, re, subprocess

parser=argparse.ArgumentParser()
parser.add_argument('--repo',type=Path,default=Path('C:/Users/Administrator/Documents/ChatGPT/工作学习/research/FrostEcho/reviews/R8LIVE-9fba236-20261117/source'))
parser.add_argument('--suffix',default='')
args=parser.parse_args()
repo=args.repo
out=Path(__file__).resolve().parent
def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True,encoding='utf-8')
def loc(p):return len((repo/p).read_text(encoding='utf-8').splitlines())
log=git('log','HEAD','--since=2026-11-04','--until=2026-11-18','--format=%H%x09%aI%x09%cI%x09%s')
rows=[]
for line in log.splitlines():
 sha,authored,committed,subject=line.split('\t',3)
 files=git('diff-tree','--no-commit-id','--name-only','-r',sha).splitlines()
 rows.append({'sha':sha,'authoredAt':authored,'committedAt':committed,'subject':subject,'changedFiles':files})
source_touches=collections.Counter(p for r in rows for p in r['changedFiles'] if p.startswith(('src/','scripts/','tests/')))
critical=['scripts/play-sprint.ts','src/application-v2/session.ts','src/gameplay-v2/loop.ts','src/gameplay-v2/commitments.ts','src/r7/integration/runtime.ts','src/r7/integration/step.ts','src/r7/integration/commitment-bridge.ts','src/r7/ui/cli-bridge.ts','src/r7/ui/joint-scorer.ts']
facts={'schema':'frostecho.history-architecture-inventory/1','head':git('rev-parse','HEAD').strip(),
 'scope':'Current HEAD ancestry; author/committer date range 2026-11-04 to 2026-11-17. Not all remote branches or all PRs.',
 'commitCount':len(rows),'fixRestoreCorrectionSubjectMatches':sum(bool(re.search('fix|revert|restore|correction|更正',r['subject'],re.I)) for r in rows),
 'warning':'Subject matches are not unique bugs; timestamps and commit count do not measure engineering hours or PR lead time.',
 'sourceFileCounts':{prefix:len([p for p in git('ls-tree','-r','--name-only','HEAD',prefix).splitlines() if p.endswith(('.ts','.mjs','.js'))]) for prefix in ('src','scripts','tests')},
 'hotspots':[{'path':p,'touches':n} for p,n in source_touches.most_common(15)],
 'criticalPathFiles':[{'path':p,'lines':loc(p),'touches':source_touches[p]} for p in critical],
 'criticalPathLines':sum(loc(p) for p in critical),
 'intentional':[
  {'decision':'One world, one clock, one committed-event authority; domain reducers do not advance time.', 'evidence':['07d5df3 commit body','src/r7/contracts.ts:8-14','src/r7/integration/runtime.ts:2-8']},
  {'decision':'Preserve legacy game-step and older saves while migrating the Gospel profile.', 'evidence':['8d100c4 scripts/play-sprint.ts diff','680c207 scripts/play-sprint.ts diff','scripts/play-sprint.ts:90-119,364-407']},
  {'decision':'Cancellation grants and per-barrier captured job sets are authority boundaries, not retry policy.', 'evidence':['8a4a895','0349347','97f21c2','6a2dac0','f366d94','scripts/play-sprint.ts:188-267']},
  {'decision':'Physical receipts determine task/commitment completion; model output is only a proposal.', 'evidence':['181907d','c82b089','7bb7cf3','9fba236','680c207','src/r7/integration/step.ts:136-157','src/r7/integration/commitment-bridge.ts:172-180']}
 ],
 'reworkFamilies':[
  {'id':'authority_projection','pattern':'Separate projections became stronger claims than the actual authority: task done vs commitment active, resource/goal receipt mismatch, model-selected action vs original physical location/time.',
   'commits':['73ec2ad','181907d','97f21c2','c82b089','7bb7cf3','9fba236','680c207'],
   'prevention':'One action contract carries task instance, actor, revision, authorized scope, resource, location, work interval and committed receipt. Add causal story invariants, not only field-shape validators.'},
  {'id':'async_ownership','pattern':'A global actor generation was reused to reason about several overlapping queues/barriers; a later save could change ownership of an earlier captured set.',
   'commits':['8a4a895','0349347','97f21c2','6a2dac0','f366d94'],
   'prevention':'Record immutable capture ownership and explicit cancellation cause per accepted job; test cancel/save/save/new-step permutations with a controllable scorer.'},
  {'id':'provenance_and_semantic_binding','pattern':'Mode labels, review IDs and candidate task family were mistaken for evidence identity or semantic correctness.',
   'commits':['cf9f581','70bdd56','498c000','6af6bf7','c2866c7','007f315','f1dab96','680c207'],
   'prevention':'Bind full rendered visible input, candidate actions, raw review and source episode before import; independently rederive labels and real/fixture class; keep on-policy counterexamples.'},
  {'id':'harness_observation','pattern':'Packaged evidence was not bootstrapped at every entry, and process/listener setup or synchronous fake HTTP tests hid actual outcomes.',
   'commits':['afebda4','54214bd','12cc208','a86c8a1','b70dd2c'],
   'prevention':'One evidence bootstrap API shared by npm/eval; register exit listeners at spawn, verify real request markers asynchronously, use unique temp roots and bounded cleanup.'},
  {'id':'semantic_migration_gap','pattern':'New shared runStep coexisted with old immediate actions and entry-specific advance policies; preserving old tests did not prove the new action lifecycle matched gameplay.',
   'commits':['07d5df3','7bb7cf3','8d100c4','680c207'],
   'prevention':'Maintain an explicit profile adapter; test the same timed scenario through CLI/web/fourday and restore. Change lifecycle centrally, not by incrementing time in each transport.'}
 ],
 'safeSimplificationCandidates':[
  {'path':'src/r7/jev/scorer-client.ts','action':'Archive/remove unused ScorerServiceClient from current production source after a clean build + joint-service contract checks.',
   'evidence':'git grep ScorerServiceClient HEAD outside historical artifacts/handoff/evidence returns only its own definition; current CLI and fourday both import JointScorerClient.',
   'risk':'Do not delete historical evidence or replay protocol files. Recheck R9 before removal.'},
  {'path':'scripts/play-sprint.ts:364-407','action':'Extract the duplicated Gospel game-step/r8-step handler into one function; preserve both command names and legacy profile routing.',
   'evidence':'Both current branches call runStep with matching goalBridge, actorIds, expectedGenerations and notes. Only emitted profile and gospel-guard placement differ.',
   'risk':'Do not silently map legacy game-step to Gospel; this is precisely the migration reverted at 8d100c4.'},
  {'path':'scripts/run-tests.mjs and scripts/eval-full.ts:102-119','action':'One callable packaged-evidence bootstrap, with each runner retaining its own reporting.',
   'evidence':'npm uses full-file missing-copy restoration; eval uses a single marker and shell bootstrap. Recurrent 54214bd/12cc208/a86c8a1 changes were the same environmental contract.',
   'risk':'Preserve existing bytes and SHA failure behavior; never convert historical packaged evidence into a new live model claim.'},
  {'path':'package.json description and public developer docs','action':'Present one current product entry and explicit legacy/replay references; keep schema values stable.',
   'evidence':'Package description still says G00/G01; current product spans r7 path, R8Runtime class, Gospel profile, v2 session and R4 commitments.',
   'risk':'Do not mechanically rename hashed renderer/protocol IDs or saved schemas.'}
 ],
 'notSafeToDelete':['Legacy profile/saved schemas and G00-G11 test fixtures still protect migration and reproducibility.','The authority ledger, cancellation guards and immutable evidence are not defensive clutter; deleting them reopens verified failures.','Summary memory arm is a legacy raw alias; remove it from current experiment choices, but older saves may retain the value.'],
 'lineReferenceScope':'Historical architectural line ranges refer to baseline 586034f. Use git show 586034f:<path> when current R9 offsets differ.',
 'newEngineerMap':{'problem':f'Nine named layers and {sum(loc(p) for p in critical)} lines lie on the immediate web/commitment path before world/model internals; no honest hours estimate can be derived.',
  'stableBoundaries':['CLI/HTTP transport owns no simulation time or task semantics.','PlaySession owns world execution and cancellation grants.','R8Runtime owns domain commit/time and deferred work.','CommitmentBoard owns negotiated obligations; task board owns execution work.','ScorePort proposes a bound candidate; authority validates and produces the receipt.'],
  'firstRead':['RUNBOOK.md for current path','src/r7/contracts.ts for contracts','src/r7/integration/runtime.ts + step.ts for authority','src/gameplay-v2/commitments.ts + commitment-bridge.ts for obligations','one real story request->feature->score->receipt->restore trace'],
  'renamePolicy':'Add current architecture names in docs and explicit adapters first; avoid renaming stored protocol identifiers during the critical round.'}
}
(out/('commits'+args.suffix+'.json')).write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(out/('history-findings'+args.suffix+'.json')).write_text(json.dumps(facts,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'head':facts['head'],'commits':len(rows),'criticalPathLines':facts['criticalPathLines'],'files':str(out)},ensure_ascii=False))
