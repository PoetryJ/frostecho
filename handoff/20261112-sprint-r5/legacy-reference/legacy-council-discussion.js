/**
 * 福音镇 - 会议讨论与渲染
 * 从 council-system.js 拆分，遵循SRP原则
 * 挂载到 GST.CouncilSystem.prototype
 */
(function() {
    'use strict';
    const GST = window.GST;
    const proto = GST.CouncilSystem.prototype;

    // 从原文件导入常量
    const NPC_COLORS = GST._council_system_NPC_COLORS;
    const NPC_EMOJI = GST._council_system_NPC_EMOJI;
    const TASK_TYPE_LABELS = GST._council_system_TASK_TYPE_LABELS || {};
    const getTaskLabel = (t) => (GST.i18n && GST.i18n.translateTaskLabel ? GST.i18n.translateTaskLabel(t) : null) || TASK_TYPE_LABELS[String(t || '').trim().toUpperCase()] || t;


    /** 渲染当前环境摘要 */
    proto._renderSituationSummary = function() {
        const summaryEl = document.getElementById('council-situation');
        if (!summaryEl) return;

        const game = this.game;
        const rs = game.resourceSystem;
        const ws = game.weatherSystem;
        const alive = this._snapshot.aliveNpcs;
        const deadNames = this._snapshot.deadNames;

        let html = '<div class="council-situation-grid">';

        // 天数/天气
        const dayNames = {
            1: GST.t('council_panel.prep_day'),
            2: GST.t('council_panel.cold_day'),
            3: GST.t('council_panel.respite_day'),
            4: GST.t('council_panel.extreme_cold')
        };
        const dayName = dayNames[game.dayCount] || GST.t('hud.day_n', { n: game.dayCount });
        html += `<div class="cs-item"><span class="cs-icon">📅</span>${dayName}</div>`;
        html += `<div class="cs-item"><span class="cs-icon">🌡️</span>${ws && ws.getEffectiveTemp ? ws.getEffectiveTemp().toFixed(0) + '°C' : '?'}</div>`;
        const weatherIcon = game.weather === '暴风雪' || game.weather === 'Blizzard' ? '🌨️' : '☁️';
        html += `<div class="cs-item"><span class="cs-icon">${weatherIcon}</span>${GST.i18n && GST.i18n.translateWeather ? GST.i18n.translateWeather(game.weather) : game.weather}</div>`;

        // 资源
        if (rs) {
            const woodH = Math.round(rs.getWoodFuelHoursRemaining());
            const foodM = Math.round(rs.getFoodMealsRemaining());
            html += `<div class="cs-item"><span class="cs-icon">🪵</span>${GST.t('resource.wood')}${Math.round(rs.woodFuel)}(${woodH}h)</div>`;
            html += `<div class="cs-item"><span class="cs-icon">🍞</span>${GST.t('resource.food')}${Math.round(rs.food)}(${foodM}${GST.t('council_panel.situation_food_unit')})</div>`;
            html += `<div class="cs-item"><span class="cs-icon">⚡</span>${GST.t('resource.power')}${Math.round(rs.power)}</div>`;
        }

        // 人员
        html += `<div class="cs-item"><span class="cs-icon">👥</span>${GST.t('hud.alive')}${alive.length}/${alive.length + deadNames.length}</div>`;
        if (deadNames.length > 0) {
            const _isEnMode = GST.i18n && GST.i18n.isEn && GST.i18n.isEn();
            const separator = _isEnMode ? ', ' : '、';
            const translatedNames = _isEnMode && GST.i18n.translateNpcNamesInText
                ? deadNames.map(n => GST.i18n.translateNpcNamesInText(n))
                : deadNames;
            html += `<div class="cs-item cs-dead"><span class="cs-icon">💀</span>${translatedNames.join(separator)}</div>`;
        }

        html += '</div>';
        summaryEl.innerHTML = html;
    };


    /** 选择发言NPC：优先关键角色，随机打乱 */
    proto._selectSpeakers = function(count) {
        // 【v4.18】分诊模式下只从参与者中选择发言人
        const alive = this._triageParticipantIds ? this.participants : this._snapshot.aliveNpcs;
        count = count || Math.min(alive.length, 3 + Math.floor(Math.random() * 3));
        if (alive.length === 0) return [];

        const priority = [];
        const pushPriority = id => {
            if (!priority.includes(id) && alive.some(n => n.id === id)) {
                priority.push(id);
            }
        };

        pushPriority('old_qian');
        pushPriority('su_doctor');

        const situation = this._snapshot && this._snapshot.situation ? this._snapshot.situation : '';
        if (/自动发电机|自动伐木机|自动捕猎机|人工发电|木柴|食物|伤员|San/.test(situation)) {
            pushPriority('li_shen');
            pushPriority('lu_chen');
            pushPriority('wang_teacher');
            pushPriority('zhao_chef');
        }

        if (alive.some(n => n.id === 'li_shen') && alive.some(n => n.id === 'lu_chen')) {
            pushPriority('li_shen');
            pushPriority('lu_chen');
        }

        const sorted = [...alive].sort((a, b) => {
            const ai = priority.indexOf(a.id);
            const bi = priority.indexOf(b.id);
            if (ai >= 0 && bi >= 0) return ai - bi;
            if (ai >= 0) return -1;
            if (bi >= 0) return 1;
            return Math.random() - 0.5;
        });

        const selected = [];
        for (const npc of sorted) {
            if (selected.length >= count) break;
            selected.push(npc);
        }

        for (let i = selected.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [selected[i], selected[j]] = [selected[j], selected[i]];
        }
        return selected;
    };


    /** 向弹窗中追加一条消息 */
    proto._appendMessage = function(msg) {
        const div = document.createElement('div');
        div.className = 'council-message';

        const color = NPC_COLORS[msg.npcId] || '#888';
        div.innerHTML = `
            <div class="council-msg-avatar" style="background:${color};">
                <span class="council-msg-emoji">${msg.emoji}</span>
            </div>
            <div class="council-msg-content">
                <div class="council-msg-name" style="color:${color};">${msg.name}</div>
                <div class="council-msg-text">${msg.text}</div>
            </div>
        `;

        // 入场动画
        div.style.opacity = '0';
        div.style.transform = 'translateY(10px)';
        this.body.appendChild(div);

        // 触发动画
        requestAnimationFrame(() => {
            div.style.transition = 'opacity 0.3s, transform 0.3s';
            div.style.opacity = '1';
            div.style.transform = 'translateY(0)';
        });

        // 滚动到底部
        this.body.scrollTop = this.body.scrollHeight;
    };


    /** 更新状态文字 */
    proto._updateStatus = function(text) {
        if (this.statusEl) {
            this.statusEl.textContent = text;
        }
    };


    /** 渲染提案卡片到弹窗中 */
    proto._renderProposals = function() {
        for (let i = 0; i < this._proposals.length; i++) {
            const p = this._proposals[i];
            const div = document.createElement('div');
            div.className = 'council-proposal-card';
            let assignHtml = '';
            if (p.assignments) {
                assignHtml = Object.entries(p.assignments).map(([name, task]) => {
                    const npc = this.participants.find(n => n.name === name);
                    const emoji = npc ? (NPC_EMOJI[npc.id] || '👤') : '👤';
                    return `<div class="cp-assign">${emoji} ${name} → ${getTaskLabel(task)}</div>`;
                }).join('');
            }
            div.innerHTML = `
                <div class="cp-header">
                    <span class="cp-number">${i + 1}</span>
                    <span class="cp-name">${p.name}</span>
                </div>
                <div class="cp-desc">${p.description}</div>
                <div class="cp-assignments">${assignHtml}</div>
                <div class="cp-reason">${p.reasoning}</div>
            `;
            div.style.opacity = '0';
            div.style.transform = 'translateY(10px)';
            this.body.appendChild(div);
            requestAnimationFrame(() => {
                div.style.transition = 'opacity 0.4s, transform 0.4s';
                div.style.opacity = '1';
                div.style.transform = 'translateY(0)';
            });
        }
        this.body.scrollTop = this.body.scrollHeight;
    };


    /** 将获胜方案应用到任务系统 */
    proto._applyWinnerToTaskSystem = function() {
        if (!this._winnerProposal || !this._winnerProposal.assignments) return;

        console.log('[CouncilSystem] 将投票结果应用到任务系统:', this._winnerProposal.name);

        if (this._openingCouncilMode && this.game.taskSystem && this.game.taskSystem.applyCouncilAssignments) {
            const applied = this.game.taskSystem.applyCouncilAssignments(this._winnerProposal, { day: this.game.dayCount });
            if (applied) {
                return;
            }
        }

        // ============================================================
        // 【LLM直接映射表】taskType → 目标位置 + stateDesc + resourceType
        // LLM 现在直接输出标准 taskType key，无需关键词猜测
        // stateDesc 必须精确匹配 ACTION_EFFECT_MAP 中的关键词
        // ============================================================
        const TASK_TYPE_DIRECT_MAP = {
            'COLLECT_WOOD':       { target: 'lumber_camp',    stateDesc: '砍柴',       resourceType: 'woodFuel', desc: '去伐木场砍柴' },
            'COLLECT_FOOD':       { target: 'frozen_lake',    stateDesc: '采集食物',   resourceType: 'food',     desc: '去冰湖采集食物' },
            'MINE_POWER':         { target: 'ore_pile',       stateDesc: '采矿',       resourceType: 'power',    desc: '去矿渣堆采矿' },
            'COLLECT_MATERIAL':   { target: 'ruins_site',     stateDesc: '探索废墟',   resourceType: null,       desc: '去废墟探索物资' },
            'BUILD_GENERATOR':    { target: 'workshop_door',  stateDesc: '建造发电机', resourceType: null,       desc: '去工坊建造发电机' },
            'BUILD_LUMBER_MILL':  { target: 'workshop_door',  stateDesc: '建造伐木机', resourceType: null,       desc: '去工坊建造伐木机' },
            'BUILD_FOOD_COLLECTOR': { target: 'workshop_door', stateDesc: '建造捕猎机', resourceType: null, desc: '去工坊建造捕猎机' },
            'REPAIR_GENERATOR':   { target: 'workshop_door',  stateDesc: '维修发电机', resourceType: null,       desc: '去工坊维修发电机' },
            'REPAIR_LUMBER_MILL': { target: 'workshop_door',  stateDesc: '维修伐木机', resourceType: null,       desc: '去工坊维修伐木机' },
            'REPAIR_FOOD_COLLECTOR': { target: 'workshop_door', stateDesc: '维修捕猎机', resourceType: null, desc: '去工坊维修捕猎机' },
            'MAINTAIN_POWER':     { target: 'workshop_door',  stateDesc: '人工发电',   resourceType: 'power',    desc: '去工坊人工发电' },
            'DISTRIBUTE_FOOD':    { target: 'kitchen_door',   stateDesc: '准备早餐',   resourceType: null,       desc: '去炊事房做饭' },
            'PREPARE_MEDICAL':    { target: 'medical_door',   stateDesc: '医疗救治',   resourceType: null,       desc: '去医疗站治疗' },
            'PSYCHOLOGY':         { target: 'medical_door',   stateDesc: '心理疏导',   resourceType: null,       desc: '去医疗站心理疏导' },
            'WAREHOUSE':          { target: 'warehouse_door', stateDesc: '盘点物资',   resourceType: null,       desc: '去仓库盘点物资' },
            'BOOST_MORALE':       { target: 'dorm_a_door',    stateDesc: '安抚',       resourceType: null,       desc: '去室内安抚士气' },
            'MAINTAIN_ORDER':     { target: 'dorm_a_door',    stateDesc: '巡逻',       resourceType: null,       desc: '去室内巡逻' },
            'REST':               { target: null,             stateDesc: '休息',       resourceType: null,       desc: '回去休息' },
            'TREATMENT':          { target: 'medical_door',   stateDesc: '治疗',       resourceType: null,       desc: '去医疗站接受治疗' },
        };

        // 【兜底映射表】当 LLM 输出中文标签时（旧格式兼容），用关键词匹配
        const TASK_ACTION_MAP = [
            { keywords: ['砍柴', '伐木', '木柴', '木材', '柴火', '木头', '薪火'],
              target: 'lumber_camp', stateDesc: '砍柴', resourceType: 'woodFuel', desc: '去伐木场砍柴' },
            { keywords: ['捕鱼', '采集食物', '食物', '抓鱼', '钓鱼', '打鱼', '冰湖'],
              target: 'frozen_lake', stateDesc: '采集食物', resourceType: 'food', desc: '去冰湖采集食物' },
            { keywords: ['采矿', '矿', '矿石', '矿渣'],
              target: 'ore_pile', stateDesc: '采矿', resourceType: 'power', desc: '去矿渣堆采矿' },
            { keywords: ['探索', '废墟', '搜索', '侦察', '废墟探索', '搜寻'],
              target: 'ruins_site', stateDesc: '探索废墟', resourceType: null, desc: '去废墟探索物资' },
            { keywords: ['维修发电机', '修发电机', '修理发电机'],
              target: 'workshop_door', stateDesc: '维修发电机', resourceType: null, desc: '去工坊维修发电机' },
            { keywords: ['维修伐木机', '修伐木机', '修理伐木机'],
              target: 'workshop_door', stateDesc: '维修伐木机', resourceType: null, desc: '去工坊维修伐木机' },
            { keywords: ['建造发电机', '自动发电'],
              target: 'workshop_door', stateDesc: '建造发电机', resourceType: null, desc: '去工坊建造发电机' },
            { keywords: ['建造伐木机', '自动伐木'],
              target: 'workshop_door', stateDesc: '建造伐木机', resourceType: null, desc: '去工坊建造伐木机' },
            { keywords: ['建造捕猎机', '自动捕猎', '建造捕猎机', '自动捕猎'],
              target: 'workshop_door', stateDesc: '建造捕猎机', resourceType: null, desc: '去工坊建造捕猎机' },
            { keywords: ['人工发电', '手摇发电', '手动发电', '发电', '电力'],
              target: 'workshop_door', stateDesc: '人工发电', resourceType: 'power', desc: '去工坊人工发电' },
            { keywords: ['安抚', '士气', '鼓舞', '安慰', '鼓励', '人心', '谈心'],
              target: 'dorm_a_door', stateDesc: '安抚', resourceType: null, desc: '去室内安抚士气' },
            { keywords: ['巡逻', '守夜', '值班', '看守', '监督', '警戒'],
              target: 'dorm_a_door', stateDesc: '巡逻', resourceType: null, desc: '去室内巡逻' },
            { keywords: ['做饭', '烹饪', '炊事', '加工食物', '厨房', '煮', '烧饭', '分肉', '分食', '准备早餐', '准备晚餐'],
              target: 'kitchen_door', stateDesc: '准备早餐', resourceType: null, desc: '去炊事房做饭' },
            { keywords: ['治疗', '医疗', '看病', '急救', '冻伤', '伤员', '救护', '包扎', '药剂', '制药', '草药'],
              target: 'medical_door', stateDesc: '医疗救治', resourceType: null, desc: '去医疗站治疗' },
            { keywords: ['心理', '疏导', '咨询'],
              target: 'medical_door', stateDesc: '心理疏导', resourceType: null, desc: '去医疗站心理疏导' },
            { keywords: ['盘点', '仓库', '整理', '库存', '清点', '物资管理'],
              target: 'warehouse_door', stateDesc: '盘点物资', resourceType: null, desc: '去仓库盘点物资' },
            { keywords: ['休息', '睡觉', '恢复', '养伤'],
              target: null, stateDesc: '休息', resourceType: null, desc: '回去休息' },
            { keywords: ['treatment', '预防性治疗', '预防治疗', '接受治疗'],
              target: 'medical_door', stateDesc: '治疗', resourceType: null, desc: '去医疗站接受治疗' },
        ];

        const alive = this._snapshot.aliveNpcs;
        // 【v4.26c修复】分诊模式下，只给参与者应用任务变更，非参与者保持原有任务不变
        const isTriageMode = !!this._triageParticipantIds;
        for (const [name, task] of Object.entries(this._winnerProposal.assignments)) {
            const npc = alive.find(n => n.name === name);
            if (!npc) continue;

            // 分诊模式下跳过非参与者（双重保险，_fillMissingAssignments已经移除了，但以防万一）
            if (isTriageMode && !this._triageParticipantIds.has(npc.id)) {
                console.log(`[CouncilSystem] 分诊模式跳过非参与者: ${name} → ${task}`);
                continue;
            }

            // 设置投票任务文本（供LLM感知）
            npc._councilTask = task;
            npc._councilTaskTime = Date.now();

            // 【优先】直接用 taskType key 映射（LLM 新格式输出标准 key）
            const taskKey = String(task || '').trim().toUpperCase();
            let matched = TASK_TYPE_DIRECT_MAP[taskKey] || null;

            // 【兜底】如果不是标准 key，用关键词模糊匹配（兼容旧格式中文标签）
            if (!matched) {
                const taskLower = task.toLowerCase();
                for (const mapping of TASK_ACTION_MAP) {
                    if (mapping.keywords.some(kw => taskLower.includes(kw))) {
                        matched = mapping;
                        break;
                    }
                }
            }

            const matchSource = TASK_TYPE_DIRECT_MAP[taskKey] ? 'taskType直接映射' : '关键词兜底';

            // 【P0修复】濒死NPC保护：HP<15或STA<=5的NPC强制覆盖为休息/治疗
            // 根因：紧急会议方案名叫"紧急救治"，但LLM给HP=6的王策分配了"人工发电"
            // 系统层面必须有兜底保护，不能完全依赖LLM的合理性
            const _npcInDanger = npc.health < 15 || npc.stamina <= 5 || 
                (npc.bodyTemp !== undefined && npc.bodyTemp < 34);
            if (_npcInDanger && matched && matched.target) {
                // 检查分配的任务是否为休息/治疗类
                const _isRestTask = matched.stateDesc && /休息|睡觉|治疗|坐诊|安抚/.test(matched.stateDesc);
                if (!_isRestTask) {
                    console.warn(`[CouncilSystem] ⚠️ 濒死保护: ${name} HP:${Math.round(npc.health)} STA:${Math.round(npc.stamina)} 被分配"${task}"(${matched.stateDesc})，强制覆盖为休息`);
                    npc._councilStateDesc = '休息';
                    npc._councilTask = '休息恢复';
                    npc._actionDecisionCooldown = 0;
                    if (this.game.aiModeLogger) {
                        const snap = GST.AIModeLogger.npcAttrSnapshot(npc);
                        this.game.aiModeLogger.logDeduped('COUNCIL', npc.id, 'danger_override',
                            `${name} 濒死保护: 会议分配"${task}"被强制覆盖为"休息" | ${snap}`);
                    }
                    continue; // 跳过正常的任务分配
                }
            }

            if (matched && matched.target) {
                // 【v4.24自治化】会议分工只作为团队情报保留，不再转成强制导航
                npc._councilStateDesc = matched.stateDesc;
                npc._actionDecisionCooldown = 0; // 清零决策冷却，让NPC尽快根据团队情报自主响应

                console.log(`[CouncilSystem] ${name} → 任务"${task}" → [${matchSource}] 情报:${matched.target} stateDesc="${matched.stateDesc}" resource:${matched.resourceType || '无'} (${matched.desc})`);
            } else if (matched && !matched.target) {
                // 休息类任务也只保留为会议建议，不直接改写当前行为
                npc._councilStateDesc = matched.stateDesc;
                npc._actionDecisionCooldown = 0;
                console.log(`[CouncilSystem] ${name} → 任务"${task}" → [${matchSource}] 情报建议:"${matched.stateDesc}"`);
            } else {
                // 无法映射的任务，仅靠LLM感知_councilTask来自行决策
                npc._actionDecisionCooldown = 0;
                console.log(`[CouncilSystem] ${name} → 任务"${task}" → 无法映射（非标准taskType且关键词未命中），交由LLM决策`);
            }
        }

        // 通知事件日志（包含实际效果映射信息）
        const assignLog = Object.entries(this._winnerProposal.assignments).map(([n, t]) => {
            const npc = alive.find(np => np.name === n);
            // 【v4.26c】分诊模式下跳过非参与者
            if (isTriageMode && npc && !this._triageParticipantIds.has(npc.id)) return null;
            const label = getTaskLabel(t);
            const councilDesc = npc && npc._councilStateDesc ? npc._councilStateDesc : label;
            return `${n}→${councilDesc}`;
        }).filter(Boolean).join('、');
        if (isTriageMode) {
            const otherNames = alive.filter(n => !this._triageParticipantIds.has(n.id)).map(n => n.name).join('、');
            this.game.addEvent(GST.t('council.triage_assign', { assignLog, otherInfo: otherNames ? GST.t('council.triage_others', { names: otherNames }) : '' }));
        } else {
            this.game.addEvent(GST.t('council.action_assign', { assignLog }));
        }

        // AI模式日志：投票决策完整记录（用于复盘）
        if (this.game.aiModeLogger) {
            // 【v4.26c】记录会议类型和触发原因
            const meetingType = this._isMorningMeeting ? GST.t('vote_log.type_morning') : (this._triageParticipantIds ? GST.t('vote_log.type_triage') : GST.t('vote_log.type_full'));
            let voteLog = GST.t('vote_log.meeting_end', { meetingType, trigger: this._triggerReason || GST.t('vote_log.unknown'), winner: this._winnerProposal.name }) + '\n';
            // 记录所有方案和得票
            if (this._voteResults) {
                const sorted = Object.entries(this._voteResults)
                    .map(([idx, data]) => ({ idx: parseInt(idx), ...data, proposal: this._proposals[parseInt(idx)] }))
                    .sort((a, b) => b.votes - a.votes);
                for (const r of sorted) {
                    voteLog += GST.t('vote_log.proposal_line', { idx: r.idx + 1, name: r.proposal.name, votes: r.votes, voters: r.voters.join(', ') || GST.t('hud_debug.none') }) + '\n';
                    // 记录方案内容摘要
                    if (r.proposal.assignments) {
                        const tasks = Object.entries(r.proposal.assignments).map(([n, t]) => `${n}→${getTaskLabel(t)}`).join(', ');
                        voteLog += GST.t('vote_log.assignment_line', { tasks }) + '\n';
                    }
                }
            }
            // 记录最终执行的任务分配
            voteLog += `  最终执行分工: ${assignLog}`;
            this.game.aiModeLogger.log('COUNCIL', voteLog);
        }
    };


    /** 追加系统消息（区别于NPC发言） */
    proto._appendSystemMessage = function(text) {
        const div = document.createElement('div');
        div.className = 'council-system-msg';
        div.innerHTML = `<div class="csm-text">${text}</div>`;
        div.style.opacity = '0';
        this.body.appendChild(div);
        requestAnimationFrame(() => {
            div.style.transition = 'opacity 0.3s';
            div.style.opacity = '1';
        });
        this.body.scrollTop = this.body.scrollHeight;
    };


    /** JSON解析（带容错，从testcode迁移） */
    proto._parseJSON = function(text) {
        if (!text) return null;
        try {
            // 清理 <think> 标签
            let s = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            s = s.replace(/```json|```/g, '').trim();
            const m = s.match(/\{[\s\S]*\}/);
            if (m) s = m[0];
            return JSON.parse(s);
        } catch (e) {
            // 尝试修复截断JSON
            try {
                let s = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();
                const idx = s.indexOf('{');
                if (idx >= 0) {
                    s = s.substring(idx);
                    // 补全缺失的括号
                    let depth = 0;
                    for (let i = 0; i < s.length; i++) {
                        if (s[i] === '{') depth++;
                        if (s[i] === '}') depth--;
                    }
                    while (depth > 0) { s += '}'; depth--; }
                    const brackets = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
                    for (let i = 0; i < brackets; i++) s += ']';
                    return JSON.parse(s);
                }
            } catch (e2) { /* ignore */ }
            console.error(`[CouncilSystem-JSON] 解析失败:`, e.message, text.substring(0, 200));
            return null;
        }
    };


    /** 默认方案（LLM失败时的兜底） */
    proto._getDefaultProposals = function(aliveNpcs) {
        const names = aliveNpcs.map(n => n.name);
        const assignments1 = {};
        const assignments2 = {};
        const assignments3 = {};
        // 简单分配（使用标准 taskType key）
        for (let i = 0; i < names.length; i++) {
            if (i % 3 === 0) { assignments1[names[i]] = 'COLLECT_WOOD'; assignments2[names[i]] = 'COLLECT_WOOD'; assignments3[names[i]] = 'BUILD_GENERATOR'; }
            else if (i % 3 === 1) { assignments1[names[i]] = 'COLLECT_FOOD'; assignments2[names[i]] = 'COLLECT_FOOD'; assignments3[names[i]] = 'COLLECT_WOOD'; }
            else { assignments1[names[i]] = 'BOOST_MORALE'; assignments2[names[i]] = 'COLLECT_MATERIAL'; assignments3[names[i]] = 'COLLECT_MATERIAL'; }
        }
        return [
            { name: GST.t('council_panel.default_plan_resource') || 'Resource Priority', description: GST.t('council_panel.default_plan_resource_desc') || 'Focus on replenishing most needed resources', assignments: assignments1, reasoning: GST.t('council_panel.default_plan_resource_reason') || 'Address resource urgency first' },
            { name: GST.t('council_panel.default_plan_balanced') || 'Balanced', description: GST.t('council_panel.default_plan_balanced_desc') || 'Advance all tasks evenly', assignments: assignments2, reasoning: GST.t('council_panel.default_plan_balanced_reason') || 'Slow but steady' },
            { name: GST.t('council_panel.default_plan_tech') || 'Tech Rush', description: GST.t('council_panel.default_plan_tech_desc') || 'Build automation first for long-term gains', assignments: assignments3, reasoning: GST.t('council_panel.default_plan_tech_reason') || 'Sacrifice short-term for long-term' },
        ];
    };


    /** 补全方案中遗漏的NPC，根据角色默认职责分配任务 */
    proto._fillMissingAssignments = function(targetNpcs) {
        const ROLE_DEFAULTS = {
            'old_qian':     'BOOST_MORALE',
            'li_shen':      'DISTRIBUTE_FOOD',
            'zhao_chef':    'COLLECT_WOOD',
            'su_doctor':    'PREPARE_MEDICAL',
            'wang_teacher': 'MAINTAIN_POWER',
            'lu_chen':      'COLLECT_WOOD',
            'ling_yue':     'COLLECT_MATERIAL',
            'qing_xuan':    'PREPARE_MEDICAL',
        };
        // 【v4.26c修复】分诊模式下，targetNpcs只包含参与者
        // 需要移除LLM可能错误分配给非参与者的任务
        const targetNames = new Set(targetNpcs.map(n => n.name));
        for (const proposal of this._proposals) {
            if (!proposal.assignments) proposal.assignments = {};
            // 移除非参与者的分配（LLM可能不遵守指令给全员分配了任务）
            if (this._triageParticipantIds) {
                for (const name of Object.keys(proposal.assignments)) {
                    if (!targetNames.has(name)) {
                        console.log(`[CouncilSystem] 方案「${proposal.name}」移除非参与者分配: ${name} → ${proposal.assignments[name]}`);
                        delete proposal.assignments[name];
                    }
                }
            }
            // 补全缺失的参与者分配
            for (const npc of targetNpcs) {
                if (!proposal.assignments[npc.name]) {
                    const defaultTask = ROLE_DEFAULTS[npc.id] || 'REST';
                    proposal.assignments[npc.name] = defaultTask;
                    console.log(`[CouncilSystem] 方案「${proposal.name}」补分配: ${npc.name} → ${defaultTask}`);
                }
            }
        }
    };


    /** 计算讨论结束时的San恢复量（按难度递减）【v4.20】整体提升约50%，让讨论更有价值 */
    proto._getDiscussionSanRecoveryAmount = function() {
        const sanDecayMult = this.game.getDifficultyMult ? this.game.getDifficultyMult('sanDecayMult') : 1.0;

        if (sanDecayMult >= 1.8) return 8;   // hell (原5)
        if (sanDecayMult >= 1.5) return 12;  // arctic (原7)
        if (sanDecayMult >= 1.3) return 15;  // harder (原10)
        if (sanDecayMult >= 1.2) return 18;  // hard (原12)
        if (sanDecayMult >= 1.1) return 20;  // normal (原13)
        return 22;                           // easy (原15)
    };


    /** 讨论结束后统一结算一次San恢复，防止继续讨论反复刷San */
    proto._applyDiscussionSanRecovery = function() {
        if (this._discussionSanRecovered) {
            console.log('[CouncilSystem] San恢复已结算过，跳过重复结算');
            return this._discussionSanRecoveryInfo;
        }

        // 【v4.20修复】不管是NPC危机还是资源危机，只要讨论了，所有存活NPC都恢复San
        // 讨论是集体行为，即使分诊模式下只有部分人参与决策，其他人也能从"问题被讨论解决"中获得安心感
        const aliveParticipants = this._snapshot ? this._snapshot.aliveNpcs : (this.participants || []);
        const amount = this._getDiscussionSanRecoveryAmount();
        let recoveredCount = 0;
        let totalRecovered = 0;

        console.log(`[CouncilSystem] San恢复结算: 目标${aliveParticipants.length}人, 每人+${amount}`);

        for (const npc of aliveParticipants) {
            if (npc.isDead) continue; // 安全检查
            const before = npc.sanity || 0;
            npc.sanity = Math.min(100, before + amount);
            const gained = npc.sanity - before;
            if (gained > 0) {
                recoveredCount++;
                totalRecovered += gained;
                // 【v4.20修复】设置San保护期，防止恢复的San被各种惩罚瞬间吃光
                // 保护期300游戏秒（约5游戏分钟），期间San不会因惩罚性衰减而下降
                npc._councilSanProtection = 300;
                console.log(`[CouncilSystem] ${npc.name} San: ${Math.round(before)} → ${Math.round(npc.sanity)} (+${Math.round(gained)})`);
            }
        }

        const info = {
            amount: amount,
            recoveredCount: recoveredCount,
            totalRecovered: totalRecovered,
            participantCount: aliveParticipants.length,
        };

        this._discussionSanRecovered = true;
        this._discussionSanRecoveryInfo = info;

        if (recoveredCount > 0) {
            const totalRecoveredText = Number.isInteger(totalRecovered) ? totalRecovered : totalRecovered.toFixed(1);
            this._appendSystemMessage(GST.t('council.discuss_san_recover_detail', { amount, count: recoveredCount, total: totalRecoveredText }));
            if (this.game.addEvent) {
                this.game.addEvent(GST.t('council.discuss_san_recover', { amount, count: recoveredCount }));
            }
        } else {
            this._appendSystemMessage(GST.t('council.discuss_san_no_recover'));
        }

        return info;
    };

})();
