/**
 * G10 worker B — the read-only presenter.
 *
 * Every line is derived from the AppView (itself derived from the game). No
 * business decision lives here, and a scripted demo is always labelled as
 * scripted: these lines never claim real-model behaviour.
 */
import {
  G10_HELP, type AppNpcView, type AppRequestView, type AppView, type ExecuteResult,
} from './contracts';

export function renderHelp(): string[] {
  return [
    '操作（输入命令后回车；输入 help 随时回看）：',
    ...G10_HELP.map(entry => `  ${entry.usage.padEnd(30)} ${entry.meaning}`),
  ];
}

function requestLine(request: AppRequestView | null): string {
  if (request === null) return '请求: 暂无';
  const base = `请求 ${request.requestId}: ${request.status}/${request.outcome} 到期=${request.expiresAtSimTime} 接受序号=${request.acceptedAfterSeq ?? '-'}`;
  if (request.status === 'declined') return `${base} — 拒绝合作（feed_self）`;
  if (request.status === 'accepted' && request.outcome === 'pending') return `${base} — 接受请求，尚未履约`;
  switch (request.outcome) {
    case 'fulfilled': return `${base} — 请求已履约：玩家已吃到`;
    case 'violated': return `${base} — 请求违约：接受后自己先吃`;
    case 'expired': return `${base} — 请求已到期，未履约`;
    case 'cancelled': return `${base} — 请求已取消`;
    default: return base;
  }
}

function goalLines(npc: AppNpcView): string[] {
  const selected = npc.selectedGoal === null ? '未选择' : npc.selectedGoal;
  const basis = npc.selectedGoal === 'feed_self' ? '（按饱食判定）' : '';
  return [
    `  选定目标=${selected} ${npc.selectedGoal === null ? '' : npc.selectedGoalAchieved ? '已达成' : '未达成'}${basis}`,
    `  饱食目标=${npc.hungerNeedSatisfied ? '已满足' : '未满足'}（独立于选定目标）`,
    `  wait截止=${npc.wakeAtSimTime ?? '-'}`,
    `  ${requestLine(npc.request)}`,
  ];
}

export function renderStatus(view: AppView): string[] {
  const lines: string[] = [];
  const mode = `${view.goalMode}/${view.providerKind}${view.fixtureId === null ? '' : `/${view.fixtureId}`}`;
  lines.push(`[状态] 模式=${mode}${view.scripted ? '（脚本/离线，非实模）' : ''} simTime=${view.simTime} tick=${view.tick}`);
  lines.push(`  世界: 厨房食物=${view.food.kitchen} 宿舍食物=${view.food.dorm} | 玩家 ${view.player.actorId}@${view.player.location} 饱食=${view.player.hunger}`);
  for (const npc of view.npcs) {
    lines.push(`  ${npc.actorId}: cycle=${npc.cycle} 阶段=${npc.phase} 状态=${npc.status} 调用=${npc.providerCalls}/${view.budget.sessionLimit}`);
    lines.push(...goalLines(npc));
  }
  const campaign = view.campaign === null ? '未授权（离线）' : `${view.campaign.spent}/${view.campaign.limit}`;
  lines.push(`  预算: 本会话 ${view.budget.sessionCalls}/${view.budget.sessionLimit} 本局 ${view.budget.episodeCalls}/${view.budget.episodeLimit} | campaign ${campaign}`);
  lines.push(`  存档: ${view.savedPath ?? '未保存'}`);
  if (view.closed) lines.push('  本次运行已关闭');
  return lines;
}

export function renderExecute(result: ExecuteResult, view: AppView): string[] {
  const lines: string[] = [];
  if (result.ok) {
    if (result.advanced !== undefined && result.advanced > 0) lines.push(`[推进] ${result.advanced} 次${result.detail === undefined ? '' : `（${result.detail}）`}`);
    else if (result.detail !== undefined) lines.push(`[完成] ${result.detail}`);
    else lines.push('[完成]');
    return lines;
  }
  const labels: Record<string, string> = {
    BUSY: '忙碌：已有决策在途',
    CLOSED: '已关闭：不再接受写操作',
    IDLE: '空闲：没有可推进的决策（用 world/player 输入改变条件）',
    LIMIT: '超出允许范围',
    NO_REQUEST: '没有请求',
    REQUEST_REJECTED: '请求被拒',
    WORLD_REJECTED: '世界拒绝（正常游戏结果）',
    SAVE_BUSY: 'SAVE_BUSY：决策在途，本次不落档',
    SAVE_FAILED: '存档失败',
    PROVIDER_ERROR: 'Provider 失败：退出码将为非零',
    PERSISTENCE_FAILED: '持久化失败：退出码将为非零',
    BAD_INPUT: '输入不合法',
  };
  lines.push(`[${labels[result.code] ?? result.code}]${result.detail === undefined ? '' : ` ${result.detail}`}`);
  // Never claim an evidence file was saved unless one actually landed.
  if (!result.ok && (result.code === 'PROVIDER_ERROR' || result.code === 'PERSISTENCE_FAILED')) {
    lines.push(result.evidencePath != null
      ? `  失败证据已记录：${result.evidencePath}`
      : '  失败证据未能落盘；原始原因见 stderr，退出码非零');
  }
  return lines;
}

export function renderWelcome(view: AppView): string[] {
  const demo = view.fixtureId === null ? null : `脚本演示=${view.fixtureId}（机制演示，不是模型合作率）`;
  return [
    'FrostEcho G10 持续交互厨房（离线默认；世界修改只走既有游戏接口）',
    demo === null ? `模式=${view.goalMode}/${view.providerKind}${view.scripted ? '（离线脚本，非实模）' : ''}` : demo,
    '输入 help 查看命令；save SLOT 存档；quit 收束。',
  ];
}
