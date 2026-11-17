"""Read-only V2 evidence audit. NumPy math is independent of production scoring.

Usage: python audit-real-story.py --evidence /path/to/v2-training-story --repo /path/to/source --node /path/to/node
No torch, transformers, network, GPU, model call, game action, or source mutation.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--evidence', required=True, type=Path)
ap.add_argument('--repo', required=True, type=Path)
ap.add_argument('--node', default=shutil.which('node'))
ap.add_argument('--out', type=Path, default=Path(__file__).with_name('real-story-independent.json'))
args = ap.parse_args()
base, repo = args.evidence.resolve(), args.repo.resolve()
checks, rows, failures = [], [], []
sha = lambda b: hashlib.sha256(b).hexdigest()
load = lambda name: json.loads((base / name).read_text(encoding='utf-8'))
lines = lambda name: [json.loads(x) for x in (base / name).read_text(encoding='utf-8').splitlines() if x.strip()]
canonical = lambda x: json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def check(name, passed, details=None):
    row = {'check': name, 'pass': bool(passed)}
    if details is not None:
        row['details'] = details
    checks.append(row)
    if not passed:
        failures.append(name)


index = load('EVIDENCE-INDEX.json')
actual_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
check('source_commit_matches_evidence', actual_head == index['sourceHEAD'])
bad = [item['path'] for item in index['items'] if not (base / item['path']).is_file()
       or (base / item['path']).stat().st_size != item['bytes']
       or sha((base / item['path']).read_bytes()) != item['sha256']]
check('all_61_manifest_files_size_and_sha', len(index['items']) == 61 and not bad, bad)

manifest, startup = load('training/selected.json'), load('service/startup.json')
checkpoint = base / 'training' / manifest['selectedCheckpoint']
weights_bytes = checkpoint.read_bytes()
header_len = struct.unpack('<Q', weights_bytes[:8])[0]
header = json.loads(weights_bytes[8:8 + header_len])
weight_info = header['score.weight']
check('head_format_and_selected_hash', set(header) == {'score.weight'}
      and weight_info == {'dtype': 'F32', 'shape': [1, 5120], 'data_offsets': [0, 20480]}
      and sha(weights_bytes) == manifest['selectedCheckpointSha256'])
weights = np.frombuffer(weights_bytes, dtype='<f4', offset=8 + header_len, count=5120)
check('head_is_new_not_old_checkpoint', sha(weights_bytes) != manifest['initialHeadSha256'])
check('manifest_identity_pinned', startup['identity']['headSha256'] == sha(weights_bytes)
      and startup['identity']['trainingManifestSha256'] == sha((base / 'training/selected.json').read_bytes())
      and startup['identity']['featureIdentityHash'] == manifest['featureIdentityHash']
      and startup['featureIdentity'] == manifest['featureIdentity'])
source_paths = ['src/r7/integration/commitment-bridge.ts', 'src/r7/integration/step.ts',
                'src/r7/ui/joint-scorer.ts', 'src/r7/jev/render.ts', 'scripts/r8/live-commitment-story.mjs',
                'research/decision-choice/jev05/action/joint_encoder.py',
                'research/decision-choice/jev05/action/serve_joint.py']
source_hashes = {name: sha((repo / name).read_bytes()) for name in source_paths}
check('served_python_sources_match_checkout', startup['serveSourceSha256'] == source_hashes[source_paths[-1]]
      and startup['encoder']['encoderSourceSha256'] == source_hashes[source_paths[-2]])
check('weak_training_stays_experimental', manifest['labelSource'] == 'reference-imitation'
      and manifest['independentReviews'] == 0 and manifest['researchTrainReady'] is False
      and manifest['mayTrainOnJev'] is False and manifest['countsAsAdmitted'] is False
      and manifest['calibrated'] is False)

# Invoke only existing CPU renderer/contract validation, not runtime or scoring.
node_source = r'''
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [base,repo]=process.argv.slice(1);
const {renderRequest}=require(path.join(repo,'dist/src/r7/jev/render.js'));
const {validateChoiceRequest}=require(path.join(repo,'dist/src/decision/contracts.js'));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const results=[];
for(let i=1;i<=9;i++){
 const e=JSON.parse(fs.readFileSync(path.join(base,`service/${String(i).padStart(6,'0')}.request.json`),'utf8'));
 validateChoiceRequest(e.request); const r=renderRequest(e.request);
 results.push({i,requestJson:JSON.stringify(e.request)===e.requestJson,
  source:sha(fs.readFileSync(path.join(repo,'src/r7/jev/render.ts')))===e.rendererSourceSha256,
  text:r.text===e.rendered.text,spans:JSON.stringify(r.candidateSpans)===JSON.stringify(e.rendered.candidateSpans),
  segments:JSON.stringify(r.segments)===JSON.stringify(e.rendered.segments)});
}
process.stdout.write(JSON.stringify(results));
'''
render_audit = json.loads(subprocess.check_output([args.node, '-e', node_source, str(base), str(repo)], text=True))
check('all_original_request_bytes_contracts_and_renderer_recomputed',
      len(render_audit) == 9 and all(all(value for key, value in row.items() if key != 'i') for row in render_audit))

decisions = [x['result']['records'][0] for x in lines('story/decisions.jsonl')]
transcript = lines('story/scorer.jsonl')
requests = [x['envelope'] for x in transcript if x['event'] == 'score_request']
replies = [x['reply'] for x in transcript if x['event'] == 'score_reply']
runtime = load('story/session.json.r8.json')
session = load('story/session.json')
events = {event['eventId']: event for event in runtime['committed']}
check('nine_live_requests_replies_and_commits', len(decisions) == len(requests) == len(replies) == 9
      and len(events) == len(runtime['committed']))
previous_version, max_logit_error, max_probability_error = None, 0.0, 0.0
envelopes = []
for i in range(1, 10):
    prefix = f'service/{i:06d}'
    envelope, result, decision = load(prefix + '.request.json'), load(prefix + '.result.json'), decisions[i - 1]
    envelopes.append(envelope)
    request = envelope['request']
    candidate_ids = [x['id'] for x in request['candidates']]
    npz_bytes = (base / (prefix + '.features.npz')).read_bytes()
    with np.load(base / (prefix + '.features.npz'), allow_pickle=False) as feature_file:
        features, stored_ids = feature_file['cand'], feature_file['candidateIds'].tolist()
    # Independent safetensors parsing + LN/linear + softmax implementation.
    centered = features.astype(np.float32) - features.astype(np.float32).mean(axis=1, keepdims=True)
    normalized = centered / np.sqrt(np.mean(centered * centered, axis=1, keepdims=True) + np.float32(1e-5))
    logits = (normalized @ weights).astype(np.float64)
    temperature, tau = result['identity']['temperature'], result['identity']['tau']
    exp_scores = np.exp(logits / temperature - np.max(logits / temperature))
    probabilities = exp_scores / exp_scores.sum()
    best = int(probabilities.argmax())
    selected_id = candidate_ids[best] if probabilities[best] >= tau else None
    logit_error = float(np.max(np.abs(logits - [x['logit'] for x in result['scores']])))
    probability_error = float(np.max(np.abs(probabilities - [x['probability'] for x in result['scores']])))
    max_logit_error, max_probability_error = max(max_logit_error, logit_error), max(max_probability_error, probability_error)
    check(f'{i}:input_feature_and_transcript_binding',
          json.loads(envelope['requestJson']) == request
          and sha(envelope['requestJson'].encode()) == envelope['inputSha256'] == result['inputSha256'] == decision['inputSha256']
          and envelope == requests[i - 1] and result == replies[i - 1]
          and request['requestId'] == result['requestId'] == decision['requestId']
          and request['candidateSetHash'] == result['candidateSetHash'] == decision['candidateSetHash']
          and sha(npz_bytes) == result['featureEvidence']['sha256']
          and sha(features.astype(np.float32).tobytes()) == result['encoder']['featureSha256']
          and stored_ids == candidate_ids == result['encoder']['candidateIds']
          and candidate_ids == [x['candidateId'] for x in result['scores']]
          and features.shape == (len(candidate_ids), 5120) and 2 <= len(candidate_ids) <= 8)
    # Encoder hashes the chat-template-wrapped text, not the raw renderer text.
    wrapped = '<|im_start|>user\n' + envelope['rendered']['text'] + '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
    check(f'{i}:raw_and_chat_template_text_binding',
          envelope['rendered']['text'] == decision['jointText']
          and sha(envelope['rendered']['text'].encode()) == envelope['renderedTextSha256'] == decision['renderSha256']
          and sha(wrapped.encode()) == result['encoder']['renderedTextSha256'])
    check(f'{i}:independent_math_and_actual_selection', logit_error <= 1e-6 and probability_error <= 1e-9
          and selected_id == result['selectedId'] == decision['selectedId']
          and result['disposition'] == decision['disposition'] == 'accept'
          and result['identity']['headSha256'] == sha(weights_bytes)
          and result['identity']['featureIdentityHash'] == manifest['featureIdentityHash']
          and result['identity']['encoderForwardCalls'] == i and result['encoder']['encoderForwardCalls'] == 1
          and result['identity']['experimental'] is True and result['identity']['countsAsAdmitted'] is False)
    chosen = next(x for x in request['candidates'] if x['id'] == selected_id)
    actual_events = [events[event_id] for event_id in decision['eventIds'] if event_id in events]
    check(f'{i}:selected_action_committed_not_noop', decision['executionStatus'] == 'applied'
          and len(actual_events) == len(decision['eventIds']) > 0
          and all(x['actorId'] == request['actorId'] for x in actual_events)
          and decision['worldVersion'] > request['stateVersion']
          and (previous_version is None or previous_version == request['stateVersion']))
    action = chosen['parameters']['action']
    receipt_type = {'move': 'legacy_spatial_command', 'gather': 'gathered', 'refuel': 'refuelled',
                    'deposit': 'stock_deposited', 'withdraw': 'stock_withdrawn',
                    'rest': 'rested', 'deliver': 'meal_delivered'}[action]
    typed = [x for x in actual_events if x['type'] == receipt_type]
    semantic_match = bool(typed)
    if action == 'move':
        movement = [json.loads(x['payload']['resultJson']) for x in typed]
        semantic_match = any(x.get('position', {}).get('mapId') == chosen['parameters']['to']
                             and x['reason'] == 'original_maps_traversed' for x in movement)
    elif action == 'gather':
        semantic_match = any(x['payload']['resource'] == chosen['parameters']['resource']
                             and x['payload']['amount'] > 0 for x in typed)
    check(f'{i}:receipt_semantics_match_selected_action', semantic_match)
    previous_version = decision['worldVersion']
    rows.append({'call': i, 'requestId': request['requestId'], 'inputSha256': envelope['inputSha256'],
                 'K': len(candidate_ids), 'selectedIndex': best, 'selectedId': selected_id,
                 'parameters': chosen['parameters'], 'pmax': float(probabilities[best]),
                 'logitMaxAbsError': logit_error, 'probabilityMaxAbsError': probability_error,
                 'versionBefore': request['stateVersion'], 'versionAfter': decision['worldVersion'],
                 'eventCount': len(actual_events), 'eventTypes': sorted({x['type'] for x in actual_events})})

cli, inputs = lines('story/cli.jsonl'), lines('story/player-input.jsonl')
report, initial = load('story/report.json'), load('story/request.json')
commitments = load('story/session.json.commitments.json')
tasks = load('story/session.json.tasks.json')
cm, task = initial['commitment']['commitmentId'], initial['task']['taskId']
allowed = {'request npc_01 deliver-meal', 'r8-step npc_01', 'commitment-status',
           f'respond-change {cm} accept', 'r8-status', 'save'}
check('player_did_not_select_npc_actions_or_inject_resources', all(x['line'] in allowed for x in inputs)
      and sum(x['line'] == 'r8-step npc_01' for x in inputs) == 9
      and sum(x['line'] == f'respond-change {cm} accept' for x in inputs) == 1)
final = next(x for x in commitments['commitments'] if x['commitmentId'] == cm)
meal = [event for event in events.values() if event['type'] == 'meal_delivered']
fulfil = [receipt for key, receipt in commitments['receipts'].items() if key.startswith('fulfil:')]
check('same_instance_and_single_real_fulfil_receipt', len(commitments['commitments']) == len(tasks) == 1
      and initial['commitment']['revision'] == 1 and final['revision'] == 2 and final['status'] == 'fulfilled'
      and final['taskId'] == task == tasks[0]['taskId'] and tasks[0]['commitmentId'] == cm
      and tasks[0]['status'] == 'done' and len(meal) == len(fulfil) == 1
      and meal[0]['eventId'] in final['evidenceEventIds'] and meal[0]['eventId'] in decisions[-1]['eventIds']
      and meal[0]['payload']['amount'] == 1 and meal[0]['payload']['to'] == 'kitchen'
      and final == report['finalCommitment'] and fulfil[0]['result']['commitment'] == final)
check('world_receipt_and_resource_completion_match',
      session['world']['receipts']['npc_01-r8-146']['eventIds'] == [meal[0]['eventId']]
      and session['world']['version'] == previous_version == 147
      and session['world']['spatial']['deliveredMeals'] == 1
      and session['world']['spatial']['stocks']['warehouse']['food'] == 0
      and session['world']['spatial']['carry']['npc_01']['meals'] == 0)

stock_kinds = {'warehouse_stock_observed', 'stock_deposited', 'stock_withdrawn', 'out_of_stock', 'stock_restocked'}
actor_records = session['memories']['npc_01']['records']
stock_records = [x for x in actor_records if x['kind'] in stock_kinds]
observed = next(x for x in stock_records if x['kind'] == 'warehouse_stock_observed')
check('private_stock_known_only_after_committed_observation',
      envelopes[0]['request']['observation']['belief']['level'] is None
      and not any(x['kind'] in stock_kinds for x in envelopes[0]['request']['memoryFacts'])
      and observed['eventId'] in decisions[0]['eventIds']
      and observed['payload']['remaining'] == 0 and observed['observedAt'] == 501
      and envelopes[1]['request']['observation']['belief']['level'] == 0
      and all(x['source'] == x['authority'] == 'engine' and x['observerId'] == 'npc_01' for x in stock_records)
      and all(not any(x['kind'] in stock_kinds for x in memory['records'])
              for actor, memory in session['memories'].items() if actor != 'npc_01'))
check('goals_and_selected_bridge_candidates_bind_current_revision', all(
      (not x['parameters'].get('commitmentId')) or
      (x['parameters']['commitmentId'] == cm and x['parameters']['legacyTaskId'] == task
       and x['parameters']['commitmentRevision'] == (1 if x['call'] == 1 else 2)) for x in rows))

status = [x for x in cli if x.get('command') == 'r8-status']
commitment_status = [x for x in cli if x.get('command') == 'commitment-status']
ready = [x for x in cli if x.get('event') == 'ready']
saved = [x for x in cli if x.get('command') == 'save']
check('actual_second_process_restored_raw_domain_state_and_task_binding', len(status) == len(ready) == len(saved) == 2
      and status[0]['runtime'] == status[1]['runtime']
      and commitment_status[-2]['commitments'] == commitment_status[-1]['commitments'] == commitments['commitments']
      and commitment_status[-2]['tasks'] == commitment_status[-1]['tasks'] == tasks
      and ready[1]['restored'] is True and ready[1]['simTime'] == 526
      and saved[0]['version'] == saved[1]['version'] == 147
      and status[1]['runtime']['committed'] == runtime['committed'])

output = {'schema': 'frostecho.real-story-independent-audit/1', 'decision': 'pass' if not failures else 'rework',
          'scope': 'Existing V2 nine-action real-encoder commitment story; independent CPU evidence audit only',
          'auditor': 'r8c_request_capture; did not implement commitment bridge; previously implemented map/runtime movement',
          'sourceHEAD': actual_head, 'evidenceSourceHEAD': index['sourceHEAD'],
          'evidenceIndex': {'absolutePath': str(base / 'EVIDENCE-INDEX.json'),
                            'sha256': sha((base / 'EVIDENCE-INDEX.json').read_bytes()), 'filesVerified': len(index['items'])},
          'auditMethodSha256': sha(Path(__file__).read_bytes()), 'sourceHashes': source_hashes,
          'numpyVersion': np.__version__, 'newModelCalls': 0, 'newWorldActions': 0,
          'checksPassed': sum(x['pass'] for x in checks), 'checksFailed': len(failures), 'checks': checks,
          'math': {'headSha256': sha(weights_bytes), 'logitMaxAbsError': max_logit_error,
                   'probabilityMaxAbsError': max_probability_error}, 'calls': rows,
          'result': {'commitmentId': cm, 'taskId': task, 'status': final['status'], 'revision': final['revision'],
                     'fulfilledReceipt': meal[0], 'rawRestoreDomainEqual': status[0]['runtime'] == status[1]['runtime'],
                     'elapsedSimMinutes': 526 - 480, 'explicitPlayerChangeAcceptances': 1},
          'observedIssues': [{
              'id': 'manual_action_duration_not_world_elapsed', 'status': 'observed_existing_gameplay_semantics',
              'effect': 'Rest credits 60 minutes of recovery without advancing simTime; this story does not prove realistic elapsed work/rest cost.',
              'requestBefore': {'file': 'service/000008.request.json',
                                'minuteOfDay': envelopes[7]['request']['observation']['minuteOfDay'],
                                'stamina': envelopes[7]['request']['observation']['self']['stamina']},
              'selectedParameters': rows[7]['parameters'],
              'receipt': events[decisions[7]['eventIds'][0]],
              'requestAfter': {'file': 'service/000009.request.json',
                               'minuteOfDay': envelopes[8]['request']['observation']['minuteOfDay'],
                               'stamina': envelopes[8]['request']['observation']['self']['stamina']},
              'source': 'src/survival/world-v2.ts:346; rest applies recovery, simTime is advanced separately',
              'sourceSha256': sha((repo / 'src/survival/world-v2.ts').read_bytes())
          }],
          'sourceReview': {
              'actualWorldActionSelection': 'All nine selections equal independently recomputed head argmax, 6..8 candidates; three choose non-bridge refuel/gather-wood/rest.',
              'planningScaffold': 'commitment-bridge.ts proposes rule-authored legal progress options; shortage proposal and sentence are rules. One loop; afterCommit closes only on committed typed receipt.',
              'permission': 'Bridge checks accepted active commitment/task/actor/revision and resume readiness; direct player change acceptance advances revision. Input contains actor-local engine stock memory.',
              'renderHashDifference': 'Raw renderer hash differs from encoder hash because encoder hashes chat-template wrapper; all nine exact wrapper hashes recomputed.'},
          'limitations': [
              'A 46-minute single-actor story is not long-horizon or cross-scenario generalization evidence.',
              'Initial commitment acceptance is reference-rules/1; change proposal wording and progress candidates are rule-authored. Only world-action selection used the learned head.',
              'Head is trained on 64 weak reference-imitation examples; independentReviews=0, no formal training admission, calibration or risk guarantee. T=1/tau=0 accepts every finite maximum.',
              'GPU forwards are supported by preserved requests/features/call/placement logs; this audit independently recomputes the head on stored features, not a second backbone execution or hardware attestation.',
              'Checkpoint identity covers manifest and local model metadata, not newly hashed full backbone shards.',
              'Raw CLI pre/post domain state plus commitments/tasks are equal. Distinct pre-restore base-session and long-term-memory bytes were not retained here; full base-save equality is producer assertion, not independently byte-rechecked by this audit.',
              'No tokenizer assets in this evidence package: chat text hash is independently verified; token IDs/readout token positions remain encoder trace evidence.',
              'No negative cancellation/spoofed-source experiment was rerun; observed stock provenance and current source binding were inspected.'
              , 'visibleMemory projects every record source as engine; this story contains only engine-source records, so it cannot establish correct differentiation of rumor/user/inferred sources. This source-level concern is outside the demonstrated story.'
          ]}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'decision': output['decision'], 'checksPassed': output['checksPassed'],
                  'checksFailed': output['checksFailed'], 'failed': failures, 'math': output['math'], 'out': str(args.out)}))
sys.exit(1 if failures else 0)
