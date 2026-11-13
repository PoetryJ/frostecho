'use strict';
const $ = id => document.getElementById(id);
const names = { warehouse: '仓库', medical: '医疗站', 'dorm-a': '宿舍 A', 'dorm-b': '宿舍 B', kitchen: '炊事房', workshop: '工坊', command: '指挥所' };
const kinds = { 'gather-food': '采集食物', 'gather-wood': '采集木柴', heating: '维持供暖', 'leave-food': '为人留饭', 'supply-warehouse': '补充仓库', 'deliver-meal': '送饭', 'rest-first': '先休息' };
const states = { active: '进行中', proposed: '已提出', 'pending-change': '等待改约回应', suspended: '已暂停', fulfilled: '已履约', cancelled: '已取消', declined: '已拒绝', withdrawn: '已退出', done: '已完成', pending: '等待回应', accepted: '已接受', countered: '提出条件', reassigned: '已改派', superseded: '已替代', voting: '投票中', propose: '提案中', resolved: '已决议' };
let catalog = { npcs: [], buildings: [] }, state = {}, selected = 'npc_01', tab = 'work';
let logs = [], seen = new Set(), lastKnowledge = null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = id => catalog.npcs.find(row => row.id === id)?.name ?? id;
const identity = () => catalog.npcs.find(row => row.id === selected) ?? catalog.npcs[0];
const numeric = value => Number.isFinite(Number(value)) ? Number(value).toFixed(1).replace(/\.0$/, '') : '—';
const commandButton = (label, line) => `<button data-command="${escape(line)}">${escape(label)}</button>`;

function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : 'success'; }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
async function command(line) {
  notice(`执行：${line}`);
  try {
    const response = await api('/api/command', { line });
    $('raw-result').textContent = JSON.stringify(response.result ?? response, null, 2);
    if (response.state) render(response.state);
    if (response.result?.error) throw new Error(response.result.error);
    if (response.result?.command === 'knowledge') { lastKnowledge = response.result; renderMemory(); }
    notice(response.result?.saved ? '已保存世界、任务、承诺与记忆。' : `收到真实回执：${line}`);
    return response.result;
  } catch (error) { notice(error.message, true); return null; }
}
async function session(action) {
  notice(action === 'new' ? '正在创建新世界…' : '正在恢复存档…');
  try {
    const next = await api('/api/session', { action });
    logs = []; seen.clear(); lastKnowledge = null;
    render(next); notice(action === 'new' ? '新游戏已开始。选择居民，派工或提出承诺，再开始持续行动。' : '存档已恢复。行动前可先检查任务与承诺。');
  } catch (error) { notice(error.message, true); }
}
async function control(action, value) {
  try { render(await api('/api/control', { action, value })); }
  catch (error) { notice(error.message, true); }
}
function choose(id) { selected = id; render(state); renderMemory(); }

function render(next) {
  state = next;
  const observation = state.observation, status = state.status ?? {};
  $('welcome').classList.toggle('hidden', Boolean(observation));
  $('continue-game').disabled = !state.canContinue;
  $('run').textContent = state.running ? 'Ⅱ 暂停行动' : '▶ 开始行动';
  $('speed').value = String(state.speed ?? 1);
  $('mode').textContent = observation ? (status.mode ?? 'reference-rules/1') : '未运行';
  $('save-status').textContent = state.savedAt ? `已保存 ${new Date(state.savedAt).toLocaleTimeString()}` : '尚未保存';
  for (const id of ['run', 'one-step', 'save', 'save-exit', 'assign-task', 'request-supply', 'request-delivery', 'withdraw', 'deposit', 'deliver', 'tell-restock']) $(id).disabled = !state.active;
  if (!observation) { renderRoster([]); return; }
  const minutes = Math.floor(observation.simTime ?? 0), day = observation.day ?? 1;
  const clock = `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  $('calendar').innerHTML = `第 ${day} 日 · ${clock}<small>${escape(observation.weather)} · 已经过 ${numeric(minutes / 60)} 小时</small>`;
  const resources = observation.resources ?? {};
  const resourceRows = [['◈', '食物', resources.food], ['♨', '木柴', resources.firewood], ['ϟ', '电力', resources.power], ['✚', '药品', resources.medicine], ['♨', '炉内燃料', observation.furnace?.fuel], ['▣', '仓库存粮', status.spatial?.warehouseFood ?? '—']];
  $('resources').innerHTML = resourceRows.map(([icon, label, value]) => `<div class="resource"><i>${icon}</i><div><label>${label}</label><br><b>${numeric(value)}</b></div></div>`).join('');
  renderRoster(observation.npcs ?? []); renderMap(); renderDetail(); renderWork(); renderCouncil();
  const ending = status.ending;
  $('ending').classList.toggle('hidden', !ending || ending === 'none');
  if (ending && ending !== 'none') {
    const alive = (observation.npcs ?? []).filter(npc => npc.alive).length;
    $('ending').innerHTML = `<div class="eyebrow">本局结算</div><h2>${ending === 'all-dead' ? '雪镇失去了所有居民' : '这一段寒冬结束了'}</h2><p>${alive} 位居民仍然存活<br>已履约 ${(status.commitments ?? []).filter(row => row.status === 'fulfilled').length} 份承诺</p><p class="small muted">结算来自当前权威世界。完整原作结局与轮回模块接入后，以该模块实际结果为准。</p>${commandButton('保存这一局', 'save')}`;
  }
  if (state.lastError) notice(state.lastError, true);
}
function renderRoster(npcs) {
  $('living-count').textContent = `${npcs.filter(npc => npc.alive).length || (state.active ? 0 : 8)} / 8 位`;
  $('roster').innerHTML = catalog.npcs.map(meta => {
    const npc = npcs.find(row => row.id === meta.id), alive = npc?.alive ?? true;
    return `<button class="roster-item ${selected === meta.id ? 'selected' : ''} ${alive ? '' : 'dead'}" data-npc="${meta.id}"><img class="portrait" src="${meta.portrait}" alt="${meta.name}"><div><strong>${meta.name}</strong><small>${npc ? escape(alive ? names[npc.location] ?? npc.location : '已死亡') : escape(meta.occupation)}</small><div class="mini-bars">${[npc?.hunger, npc?.stamina, npc?.health, npc?.san].map(value => `<i class="${value >= 35 ? 'healthy' : ''}"></i>`).join('')}</div></div></button>`;
  }).join('');
}
function renderMap() {
  $('selected-hint').textContent = `${nameOf(selected)} · 点击建筑可指挥移动`;
  const npcs = state.observation?.npcs ?? [];
  $('npc-layer').innerHTML = npcs.filter(npc => npc.alive).map((npc, index) => {
    const meta = catalog.npcs.find(row => row.id === npc.id), cell = state.positions?.[npc.id]?.cell;
    if (!cell || !meta) return '';
    // Small visual separation for residents sharing one authoritative tile.
    const offset = ((index % 3) - 1) * .35;
    return `<button class="map-npc ${selected === npc.id ? 'selected' : ''}" data-npc="${npc.id}" style="left:${(cell.x + .5) / 50 * 100 + offset}%;top:${(cell.y + .5) / 40 * 100}%" title="${escape(meta.name)} · (${cell.x}, ${cell.y})"><img src="${meta.portrait}" alt=""><span>${escape(meta.name)}</span></button>`;
  }).join('');
  $('road-layer').innerHTML = (state.status?.spatial?.closedCells ?? []).map(value => {
    const [x, y] = value.split(',').map(Number);
    return `<div class="road-block" style="left:${x / 50 * 100}%;top:${y / 40 * 100}%" title="道路封闭"></div>`;
  }).join('');
}
function renderDetail() {
  const meta = identity(); if (!meta) return;
  const npc = state.observation?.npcs?.find(row => row.id === selected);
  $('npc-detail').innerHTML = `<div class="identity"><img class="portrait" src="${meta.portrait}" alt="${escape(meta.name)}"><div><h2>${escape(meta.name)}</h2><p>${escape(meta.occupation)}<br>${escape(meta.id)} · ${escape(meta.legacyId)}</p></div></div>${npc ? `<div class="vitals">${[['hunger', '饱食'], ['stamina', '体力'], ['health', '健康'], ['san', '精神']].map(([key, label]) => `<div class="vital"><label>${label}<span>${numeric(npc[key])}</span></label><progress max="100" value="${Number(npc[key]) || 0}"></progress></div>`).join('')}</div><div class="detail-location">${npc.alive ? '● 存活' : '● 已死亡'} · ${escape(names[npc.location] ?? npc.location)} · 携带 ${numeric(state.status?.spatial?.carry?.[selected]?.meals ?? 0)} 份饭</div>` : '<p class="small muted">开始游戏后查看居民状态。</p>'}`;
}
function renderWork() {
  const tasks = (state.status?.tasks ?? []).filter(row => row.actorId === selected);
  const commitments = (state.status?.commitments ?? []).filter(row => row.promisorId === selected);
  const rows = commitments.map(row => {
    const open = (row.changes ?? []).filter(change => change.status === 'open');
    const terminal = ['fulfilled', 'cancelled', 'withdrawn', 'declined'].includes(row.status);
    return `<article class="card"><div class="card-heading"><strong>${escape(kinds[row.goal] ?? row.goal)} · 承诺 r${row.revision}</strong><span class="badge ${row.status}">${escape(states[row.status] ?? row.status)}</span></div><p>${escape((row.conditions ?? []).join(' / ') || '无附加条件')}</p>${open.map(change => `<p>改约：${escape(change.reason)}<br>${escape(JSON.stringify(change.terms))}</p><div class="actions">${commandButton('接受改约', `respond-change ${row.commitmentId} accept`)}${commandButton('拒绝改约', `respond-change ${row.commitmentId} reject`)}</div>`).join('')}<code>${escape(row.commitmentId)}</code>${row.evidenceEventIds?.length ? `<p>履约依据：${row.evidenceEventIds.map(escape).join('<br>')}</p>` : ''}<div class="actions">${terminal ? '' : commandButton('取消承诺', `cancel-commitment ${row.commitmentId}`)}${row.status === 'suspended' ? commandButton('请求恢复', `resume-commitment ${row.commitmentId}`) : ''}</div></article>`;
  });
  rows.push(...tasks.map(row => `<article class="card"><div class="card-heading"><strong>${escape(kinds[row.kind] ?? row.kind)}</strong><span class="badge ${row.status}">${escape(states[row.status] ?? row.status)}</span></div><p>${row.commitmentId ? '关联承诺的执行任务' : '直接派工任务'}</p><code>${escape(row.taskId)}</code>${row.status === 'active' ? `<div class="actions">${commandButton('取消任务', `cancel-task ${row.taskId}`)}</div>` : ''}</article>`));
  $('work-list').innerHTML = rows.reverse().join('') || '<p class="empty">还没有任务。可以直接派工，或先向居民提出补仓、送饭请求。</p>';
}
function renderCouncil() {
  const councils = [...(state.status?.council ?? [])].reverse();
  $('council-list').innerHTML = councils.map(row => `<article class="card"><div class="card-heading"><strong>第 ${row.day} 日晨会</strong><span class="badge">${escape(states[row.status] ?? row.status)}</span></div><p>议会模式：${escape(row.resolution?.source ?? row.votes?.[0]?.source ?? 'fixture-reference/1')}</p>${(row.proposals ?? []).map(proposal => `<h3>${escape(proposal.name)}</h3><p>${escape(proposal.description)}<br>预计 ${proposal.cost?.estimatedMinutes ?? '?'} 分钟 · ${proposal.cost?.restBlocks ?? 0} 个休息时段</p><p>${(proposal.assignments ?? []).map(item => `${escape(nameOf(item.actorId))}：${escape(kinds[item.taskKind] ?? item.taskKind)}`).join('<br>')}</p>${row.status !== 'resolved' ? commandButton('支持这个方案', `council-vote ${proposal.proposalId}`) : ''}`).join('')}${(row.requests ?? []).map(request => `<h3>${escape(nameOf(request.actorId))} · ${escape(kinds[request.taskKind] ?? request.taskKind)}</h3><p>请求：${escape(states[request.status] ?? request.status)} · 承诺：${escape(states[request.commitmentStatus] ?? request.commitmentStatus ?? '尚未建立')}<br>执行任务：${escape(states[request.taskStatus] ?? request.taskStatus ?? '尚未建立')}</p>${request.status === 'pending' ? `<p class="muted">当前引擎需显式居民回应；此处为角色操作。</p><div class="actions">${commandButton('居民接受', `council-respond ${request.requestId} accept`)}${commandButton('居民拒绝', `council-respond ${request.requestId} decline`)}${commandButton('提出条件', `council-respond ${request.requestId} counter`)}</div>` : ''}<div class="actions">${commandButton(`请求改派给${nameOf(selected)}`, `council-reassign ${request.requestId} ${selected}`)}</div>`).join('')}</article>`).join('') || '<p class="empty">召开晨会，比较真实成本不同的分工方案，再形成决议与居民请求。</p>';
}
function renderMemory() {
  if (!lastKnowledge) return;
  const knowledge = lastKnowledge.knowledge?.[selected];
  $('memory-view').textContent = JSON.stringify({ actorId: selected, knowledge: knowledge ?? null,
    plan: lastKnowledge.plans?.[selected] ?? null }, null, 2);
}
function record(row) {
  if (['observe', 'task-status', 'where', 'map'].includes(row.command)) return;
  if (!row.command && !['process_exit', 'job_terminal', 'stderr'].includes(row.event)) return;
  const id = `${state.sessionId}:${row.jobId}:${row.command}:${row.event}`;
  if (seen.has(id)) return; seen.add(id);
  let text = row.error ? `操作失败：${row.error}` : row.command ?? row.event;
  if (row.command === 'game-step') text = `居民行动：${row.executed ?? 0} 次已执行 · ${(row.records ?? []).map(entry => `${nameOf(entry.actorId)} ${entry.selectedId}${entry.executed ? '' : '（未执行）'}`).join('；')}`;
  else if (row.command === 'save' && row.saved) text = `存档已写入 · 世界版本 ${row.version}`;
  else if (row.events?.length) text = `${row.command} · ${row.events.map(event => event.type).join(' / ')}`;
  else if (row.status) text += ` · ${row.status}`;
  else if (row.commitment) text += ` · ${nameOf(row.commitment.promisorId)} ${states[row.commitment.status] ?? row.commitment.status}`;
  logs.unshift({ time: new Date().toLocaleTimeString(), text, error: Boolean(row.error) });
  logs = logs.slice(0, 60);
  $('event-log').innerHTML = logs.map(item => `<div class="event-row ${item.error ? 'error' : ''}"><time>${item.time}</time>${escape(item.text)}</div>`).join('');
}

document.addEventListener('click', event => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.npc) choose(target.dataset.npc);
  if (target.dataset.command) void command(target.dataset.command);
  if (target.dataset.building) void command(`travel ${selected} ${target.dataset.building}`);
  if (target.dataset.tab) {
    tab = target.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    ['work', 'council', 'memory'].forEach(key => $(`tab-${key}`).classList.toggle('hidden', tab !== key));
  }
});
$('new-game').onclick = () => { if (!state.active || confirm('当前游戏会先保存。确定开始一个独立的新游戏？')) void session('new'); };
$('welcome-start').onclick = () => void session('new');
$('continue-game').onclick = () => void session('continue');
$('run').onclick = () => void control(state.running ? 'pause' : 'run');
$('one-step').onclick = () => void command('game-step');
$('speed').onchange = () => void control('speed', Number($('speed').value));
$('save').onclick = () => void command('save');
$('save-exit').onclick = () => void command('quit');
$('assign-task').onclick = () => void command(`assign ${selected} ${$('task-kind').value}`);
$('request-supply').onclick = () => void command(`request ${selected} supply-warehouse`);
$('request-delivery').onclick = () => void command(`request ${selected} deliver-meal`);
$('withdraw').onclick = () => void command(`withdraw ${selected} 1`);
$('deposit').onclick = () => void command(`deposit ${selected} 1`);
$('deliver').onclick = () => void command(`deliver ${selected} 1`);
$('tell-restock').onclick = () => void command(`tell-restock ${selected}`);
$('load-memory').onclick = () => void command('knowledge');
$('command-form').onsubmit = event => { event.preventDefault(); const value = $('command-input').value.trim(); if (value) void command(value); };
$('music').onclick = async () => {
  const bgm = $('bgm'); bgm.volume = .3;
  if (!bgm.paused) { bgm.pause(); $('music').textContent = '♫ 音乐'; }
  else { try { await bgm.play(); $('music').textContent = '♫ 静音'; } catch (error) { notice(`音乐暂不可用：${error.message}`, true); } }
};
async function init() {
  try {
    catalog = await api('/api/catalog');
    $('building-layer').innerHTML = catalog.buildings.map(building => `<button class="building" data-building="${building.id}" style="left:${building.x / 50 * 100}%;top:${building.y / 40 * 100}%;width:${building.w / 50 * 100}%;height:${building.h / 40 * 100}%" title="前往${names[building.id]}"><img src="/assets/asset/buildings/${building.id.replace('-', '_')}.png" alt="${names[building.id]}" draggable="false"><span>${names[building.id]}</span></button>`).join('');
    render(await api('/api/state')); renderDetail();
    if (!catalog.assetsReady) notice('原作素材未解包。请运行任务包 bootstrap.py 后刷新。', true);
    else notice('本地服务已连接。可以开始新游戏，或继续上次保存的世界。');
    const stream = new EventSource('/api/events');
    stream.addEventListener('state', event => render(JSON.parse(event.data)));
    stream.addEventListener('record', event => record(JSON.parse(event.data)));
    stream.onerror = () => notice('正在重新连接本地服务；游戏状态以服务端存档为准。', true);
  } catch (error) { notice(error.message, true); }
}
void init();
