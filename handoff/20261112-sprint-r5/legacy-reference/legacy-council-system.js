/**
 * 福音镇 - CouncilSystem 营地讨论系统
 * 暂停时弹出讨论弹窗，NPC们围绕当前局势进行聊天/分析/规划/抱怨
 * 挂载到 GST.CouncilSystem
 */
(function() {
    'use strict';
    const GST = window.GST;

    // NPC头像颜色映射（与npc-renderer中一致）
    const NPC_COLORS = {
        'zhao_chef':    '#e07040',
        'lu_chen':      '#4080d0',
        'li_shen':      '#d06060',
        'su_doctor':    '#40b080',
        'ling_yue':     '#d0a040',
        'qing_xuan':    '#c070d0',
        'old_qian':     '#a09070',
        'wang_teacher': '#6080b0',
    };

    // NPC名字emoji
    const NPC_EMOJI = {
        'zhao_chef':    '🍳',
        'lu_chen':      '🪖',
        'li_shen':      '🧓',
        'su_doctor':    '🩺',
        'ling_yue':     '🎵',
        'qing_xuan':    '🧪',
        'old_qian':     '👴',
        'wang_teacher': '📚',
    };

    // taskType → 中文显示名映射（全局共用）
    const TASK_TYPE_LABELS = {
        'COLLECT_WOOD': '砍柴', 'COLLECT_FOOD': '采集食物', 'MAINTAIN_POWER': '人工发电',
        'MINE_POWER': '采矿', 'COLLECT_MATERIAL': '探索废墥', 'BUILD_GENERATOR': '建造发电机',
        'BUILD_LUMBER_MILL': '建造伐木机', 'BUILD_FOOD_COLLECTOR': '建造捕猎机', 'REPAIR_GENERATOR': '维修发电机', 'REPAIR_LUMBER_MILL': '维修伐木机',
        'REPAIR_FOOD_COLLECTOR': '维修捕猎机', 'DISTRIBUTE_FOOD': '做饭', 'PREPARE_MEDICAL': '治疗伤员', 'PSYCHOLOGY': '心理疏导',
        'WAREHOUSE': '盘点物资', 'BOOST_MORALE': '安抚士气', 'MAINTAIN_ORDER': '巡逻', 'REST': '休息',
        'TREATMENT': '治疗',    };
    const getTaskLabel = (t) => GST.i18n.translateTaskLabel(t) || TASK_TYPE_LABELS[String(t || '').trim().toUpperCase()] || t;

    // ============ 投票系统触发阈值配置 ============
    const VOTE_TRIGGER_THRESHOLDS = {
        woodFuel: 15,     // 木柴低于15触发
        food: 20,         // 食物低于20触发
        power: 10,        // 电力低于10触发
        tension: 0.5,     // 综合紧张度超过0.5触发
        cooldownHours: 8, // 【v4.20】触发后冷却8游戏小时（从6提升，避免频繁覆盖决策）
    };

    class CouncilSystem {
        constructor(game) {
            this.game = game;
            this.isActive = false;
            this.messages = [];       // 讨论消息列表 [{ npcId, name, text, emoji }]
            this.participants = [];   // 参与讨论的NPC列表
            this.isGenerating = false;
            this.currentRound = 0;
            this.maxRounds = 6;       // 最多6轮发言（每轮1人）
            this._aborted = false;    // 用户关闭弹窗时中止生成

            // 投票系统状态
            this._isVotingMode = false;     // 是否为投票模式（资源危机触发）
            this._votingPhase = 'idle';     // idle | discuss | propose | vote | result
            this._proposals = [];           // 当前提案列表
            this._voteResults = {};         // 投票结果
            this._winnerProposal = null;    // 获胜方案
            this._lastVoteTriggerHour = -999; // 上次投票触发的游戏小时（用于冷却）
            this._triggerReason = '';        // 触发原因
            this._autoTriggered = false;     // 是否为自动触发（资源危机），自动触发结束后自动关闭弹窗
            this._openingCouncilMode = false; // 是否为首日开局晨会模式
            this._discussionSanRecovered = false; // 当前会议是否已结算讨论San恢复
            this._discussionSanRecoveryInfo = null; // 最近一次讨论San恢复信息

            // DOM缓存
            this.overlay = document.getElementById('council-overlay');
            this.body = document.getElementById('council-body');
            this.statusEl = document.getElementById('council-status');
            this.closeBtn = document.getElementById('council-close');
            this.moreBtn = document.getElementById('council-more');
            this.voteBtn = document.getElementById('council-vote');

            // 绑定事件
            if (this.closeBtn) {
                this.closeBtn.addEventListener('click', () => this.close());
            }
            if (this.overlay) {
                this.overlay.addEventListener('click', (e) => {
                    if (e.target === this.overlay) this.close();
                });
            }
            // 【v4.34】会议期间速度调节按钮
            this.speedBtn = document.getElementById('council-speed');
            if (this.speedBtn) {
                this.speedBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // 防止冒泡到overlay导致关闭
                    e.preventDefault();
                    if (this.game) {
                        this.game.cycleSpeed();
                        this.speedBtn.textContent = `${this.game.speedOptions[this.game.speedIdx]}×`;
                        // 视觉反馈：短暂高亮
                        this.speedBtn.style.background = 'rgba(255, 140, 40, 0.5)';
                        setTimeout(() => { this.speedBtn.style.background = ''; }, 200);
                        console.log(`[CouncilSystem] 速度调节: ${this.game.speedOptions[this.game.speedIdx]}×`);
                    }
                });
            } else {
                console.warn('[CouncilSystem] 未找到 #council-speed 按钮');
            }
            // 会议面板BGM静音按钮
            this.muteBtn = document.getElementById('council-mute');
            if (this.muteBtn) {
                this.muteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (this.game && this.game.bgmSystem) {
                        const muted = this.game.bgmSystem.toggleMute();
this.muteBtn.textContent = muted ? GST.t('hud.bgm_council_off') : GST.t('hud.bgm_council_on');
                        this.muteBtn.title = muted ? GST.t('hud.bgm_tip_muted') : GST.t('hud.bgm_tip_playing');
                        // 同步主界面的静音按钮状态
                        const mainMuteBtn = document.getElementById('btn-bgm-mute');
                        if (mainMuteBtn) {
mainMuteBtn.textContent = muted ? GST.t('hud.bgm_off') : GST.t('hud.bgm_on');
                            mainMuteBtn.title = muted ? GST.t('hud.bgm_tip_muted') : GST.t('hud.bgm_tip_playing');
                        }
                    }
                });
            }
            if (this.moreBtn) {
                this.moreBtn.addEventListener('click', () => this._continueDiscussion());
            }
            if (this.voteBtn) {
                this.voteBtn.addEventListener('click', () => this._startVotingProcess());
            }

            console.log('[CouncilSystem] 初始化完成（含投票系统）');
        }

        // ============ 资源危机检测（由game._onHourChange调用） ============

        /**
         * 检测是否应触发投票会议
         * @returns {boolean} 是否触发了会议
         */
        checkResourceCrisisTrigger() {
            if (this.isActive) return false; // 已在会议中

            const rs = this.game.resourceSystem;
            if (!rs) return false;

            // 冷却检查
            const currentGameHour = (this.game.dayCount - 1) * 24 + Math.floor(this.game.gameTimeSeconds / 3600);
            if (currentGameHour - this._lastVoteTriggerHour < VOTE_TRIGGER_THRESHOLDS.cooldownHours) {
                return false;
            }

            // 检测各项资源是否低于阈值
            const triggers = [];
            if (rs.woodFuel < VOTE_TRIGGER_THRESHOLDS.woodFuel) {
                triggers.push(GST.t('council.trigger_wood', { val: Math.round(rs.woodFuel) }) || `🪵Wood critical(${Math.round(rs.woodFuel)})`);
            }
            if (rs.food < VOTE_TRIGGER_THRESHOLDS.food) {
                triggers.push(GST.t('council.trigger_food', { val: Math.round(rs.food) }) || `🍞Food critical(${Math.round(rs.food)})`);
            }
            if (rs.power < VOTE_TRIGGER_THRESHOLDS.power) {
                triggers.push(GST.t('council.trigger_power', { val: Math.round(rs.power) }) || `⚡Power critical(${Math.round(rs.power)})`);
            }
            // 综合紧张度检测
            const tension = rs.getResourceTension ? rs.getResourceTension() : 0;
            if (tension >= VOTE_TRIGGER_THRESHOLDS.tension && triggers.length === 0) {
                triggers.push(GST.t('council.trigger_tension', { pct: (tension * 100).toFixed(0) }) || `⚠️Resource tension high(${(tension * 100).toFixed(0)}%)`);
            }

            if (triggers.length === 0) return false;

            // 触发！
            this._lastVoteTriggerHour = currentGameHour;
            this._triggerReason = triggers.join('、');
            console.log(`[CouncilSystem] 资源危机触发投票会议: ${this._triggerReason}`);
            // 【v4.26c】记录到aimode_log
            if (this.game.aiModeLogger) {
                this.game.aiModeLogger.log('COUNCIL', `📢 资源危机触发紧急会议: ${this._triggerReason}`);
            }

            // 自动暂停游戏并弹出投票会议
            if (!this.game.paused) {
                this.game.paused = true;
                const btn = document.getElementById('btn-pause');
                if (btn) btn.textContent = '▶️';
            }
            this.game.addEvent(GST.t('council_panel.crisis_trigger', { reason: this._triggerReason }));
            this._autoTriggered = true; // 标记为自动触发，结束后自动关闭
            this._isNpcCrisisTrigger = false; // 【v4.18】资源危机不走分诊
            this.openVotingCouncil();
            return true;
        }

        // ============ NPC危机状态检测（由game._onHourChange调用） ============

        /**
         * 检测是否有NPC处于严重危机状态，需要召开紧急决策会议
         * 触发条件：有NPC发疯/濒死/体力+San双零（且不在死亡触发流程中）
         * @returns {boolean} 是否触发了会议
         */
        checkNpcCrisisTrigger() {
            if (this.isActive) return false; // 已在会议中

            // 冷却检查（和资源危机共享冷却机制）
            const currentGameHour = (this.game.dayCount - 1) * 24 + Math.floor(this.game.gameTimeSeconds / 3600);
            if (currentGameHour - this._lastVoteTriggerHour < VOTE_TRIGGER_THRESHOLDS.cooldownHours) {
                return false;
            }

            const aliveNpcs = this.game.npcs.filter(n => !n.isDead);
            if (aliveNpcs.length < 2) return false; // 存活不足2人不触发

            // 检测危机NPC
            const crisisNpcs = [];
            for (const npc of aliveNpcs) {
                const _dn = npc.displayName || npc.name;
                // 发疯状态
                if (npc.isCrazy) {
                    crisisNpcs.push(GST.t('council.crisis_crazy', { name: _dn }) || `🤯${_dn} mental breakdown`);
                    continue;
                }
                // 濒死状态
                if (npc._isDying) {
                    crisisNpcs.push(GST.t('council.crisis_dying', { name: _dn }) || `🚨${_dn} dying`);
                    continue;
                }
                // 体力+San双零（极度危险但还没进入发疯/濒死）
                if (npc.stamina <= 0 && npc.sanity <= 0) {
                    crisisNpcs.push(GST.t('council.crisis_double_zero', { name: _dn }) || `⚠️${_dn} stamina+sanity both zero`);
                    continue;
                }
                // 健康极低（<10）且体力或San归零
                if (npc.health < 10 && (npc.stamina <= 0 || npc.sanity <= 0)) {
                    const _zeroStat = npc.stamina <= 0 ? GST.t('stat.stamina') : GST.t('stat.sanity');
                    crisisNpcs.push(GST.t('council.crisis_low_health', { name: _dn, hp: Math.round(npc.health), stat: _zeroStat }) || `⚠️${_dn} HP critical(${Math.round(npc.health)})`);
                    continue;
                }
            }

            if (crisisNpcs.length === 0) return false;

            // 触发！
            this._lastVoteTriggerHour = currentGameHour;
            this._triggerReason = crisisNpcs.join('、');
            console.log(`[CouncilSystem] NPC危机状态触发投票会议: ${this._triggerReason}`);
            // 【v4.26c】记录到aimode_log
            if (this.game.aiModeLogger) {
                this.game.aiModeLogger.log('COUNCIL', `📢 NPC危机触发紧急会议: ${this._triggerReason}`);
            }

            // 自动暂停游戏并弹出投票会议
            if (!this.game.paused) {
                this.game.paused = true;
                const btn = document.getElementById('btn-pause');
                if (btn) btn.textContent = '▶️';
            }
            this.game.addEvent(GST.t('council_panel.npc_crisis_trigger', { reason: this._triggerReason }));
            this._autoTriggered = true;
            this._isNpcCrisisTrigger = true; // 【v4.18】标记为NPC危机触发，走分诊流程
            this.openVotingCouncil();
            return true;
        }

        /** 打开普通讨论弹窗（暂停时手动触发） */
        open() {
            if (this.isActive) return;
            this._isVotingMode = false;
            this._votingPhase = 'idle';
            this._autoTriggered = false; // 手动触发，不自动关闭
            this._isNpcCrisisTrigger = false; // 【v4.18】手动触发不走分诊
            this._openCommon();
            this._startDiscussion();
        }

        /** 打开投票决策会议（资源危机自动触发） */
        openVotingCouncil() {
            if (this.isActive) return;
            this._openingCouncilMode = false;
            this._isVotingMode = true;
            this._votingPhase = 'discuss';
            this._proposals = [];
            this._voteResults = {};
            this._winnerProposal = null;
            this._triageParticipantIds = null; // 【v4.18】分诊结果
            this._triageOtherOrders = null;    // 【v4.18】未参会者指令
            this._isSelfResolve = false;       // 【v4.18】自主解决模式

            // 【v4.24自治化】投票会议期间暂停游戏与移动，但不清空NPC既有行动意图
            // 会议提供团队情报，不应把系统暂停偷换成决策接管
            if (!this.game.paused) {
                this.game.paused = true;
                const btn = document.getElementById('btn-pause');
                if (btn) btn.textContent = '▶️';
            }
            // 冻结所有NPC移动：清除路径、设为IDLE，但保留行动意图供会后继续自主判断
            if (this.game.npcs) {
                for (const npc of this.game.npcs) {
                    if (npc.isDead) continue;
                    npc.currentPath = [];
                    npc.isMoving = false;
                    if (npc.state === 'WALKING') npc.state = 'IDLE';
                }
            }

            this._openCommon();

            // 投票模式标题不同
            const titleTime = document.getElementById('council-title-time');
            if (titleTime) {
                titleTime.textContent = GST.t('council.title_emergency', { day: this.game.dayCount, time: this.game.getTimeStr() });
            }

            // 显示触发原因
            this._appendSystemMessage(GST.t('council.emergency_meeting', { reason: this._triggerReason }));

            // 【v4.18】NPC危机触发 → 先走分诊，判断谁需要参与
            // 资源危机触发 → 全员参与（不走分诊）
            if (this._isNpcCrisisTrigger) {
                this._runTriagePhase();
            } else {
                this._startVotingDiscussion();
            }
        }

        /** 打开每日开局晨会（自动触发）
         *  【v4.33修复】去掉D1限制——每天都需要开晨会
         *  根因：之前只有D1有晨会，D2/D3/D4 NPC醒来后带着旧分工执行，
         *  导致D4清璇按D3的旧计划出去干活冻死
         */
        openOpeningCouncil() {
            if (this.isActive) return false;

            // 【v4.24自治化】晨会期间暂停游戏与移动，避免讨论时乱跑，但不清空NPC既有行动意图
            if (!this.game.paused) {
                this.game.paused = true;
                const btn = document.getElementById('btn-pause');
                if (btn) btn.textContent = '▶️';
            }
            // 冻结所有NPC移动：清除路径、设为IDLE，但把是否继续原计划留给NPC会后自主判断
            if (this.game.npcs) {
                for (const npc of this.game.npcs) {
                    if (npc.isDead) continue;
                    npc.currentPath = [];
                    npc.isMoving = false;
                    if (npc.state === 'WALKING') npc.state = 'IDLE';
                }
            }

            this._openingCouncilMode = true;
            this._autoTriggered = true;
            this._isNpcCrisisTrigger = false; // 【v4.18】晨会不走分诊
            this._triggerReason = GST.t('council.morning_reason') || 'Morning briefing: exchange today\'s work assignments';
            this._isVotingMode = true;
            this._votingPhase = 'discuss';
            this._proposals = [];
            this._voteResults = {};
            this._winnerProposal = null;
            this._openCommon();

            const titleTime = document.getElementById('council-title-time');
            if (titleTime) {
                titleTime.textContent = GST.t('council.title_morning', { day: this.game.dayCount, time: this.game.getTimeStr() });
            }

            this._updateStatus(GST.t('council_panel.title_morning', { day: this.game.dayCount, time: '' }));
            this._appendSystemMessage(GST.t('council.morning_discuss'));
            this._appendSystemMessage(GST.t('council.morning_plan'));
            this._startVotingDiscussion();
            return true;
        }

        /** 内部通用打开逻辑 */
        _openCommon() {
            this.isActive = true;
            // 通知BGM系统：会议开始（根据严重程度决定是否切换BGM）
            // 只有死亡触发的会议才播放告急会议BGM，其他会议保持当前背景音乐
            if (this.game.bgmSystem && this.game.bgmSystem.onCouncilOpen) {
                const hasDeaths = this.game.deathSystem && this.game.deathSystem.getDeadCount() > 0;
                const isDeathTrigger = this._triggerReason && (this._triggerReason.includes('遇难') || this._triggerReason.includes('died') || this._triggerReason.includes('death'));
                const severity = (hasDeaths || isDeathTrigger) ? 'death' : 'normal';
                this.game.bgmSystem.onCouncilOpen(severity);
            }
            this._aborted = false;
            this.messages = [];
            this.currentRound = 0;
            this._discussionSanRecovered = false;
            this._discussionSanRecoveryInfo = null;

            // ★ 创建冻结快照（唯一 isDead 过滤点） ★
            this._snapshot = GST.CouncilPromptBuilder.createSnapshot(this.game);
            this.participants = this._snapshot.aliveNpcs;
            if (this.participants.length === 0) {
                this.isActive = false;
                return;
            }

            // 显示弹窗
            this.overlay.style.display = 'flex';
            this.body.innerHTML = '';
            this._updateStatus(this._isVotingMode ? GST.t('council_panel.title_vote', { day: this.game.dayCount, time: '' }) : GST.t('council_panel.speaking', { emoji: '💭', name: '' }));
            if (this.moreBtn) this.moreBtn.style.display = 'none';
            if (this.voteBtn) this.voteBtn.style.display = 'none';
            // 【v4.34】同步速度按钮显示 + 重新绑定事件（确保每次打开都能响应）
            const speedBtn = document.getElementById('council-speed');
            if (speedBtn && this.game) {
                speedBtn.textContent = `${this.game.speedOptions[this.game.speedIdx]}×`;
                // 移除旧事件（用克隆替换法）
                const newBtn = speedBtn.cloneNode(true);
                speedBtn.parentNode.replaceChild(newBtn, speedBtn);
                this.speedBtn = newBtn;
                newBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (this.game) {
                        this.game.cycleSpeed();
                        newBtn.textContent = `${this.game.speedOptions[this.game.speedIdx]}×`;
                        newBtn.style.background = 'rgba(255, 140, 40, 0.5)';
                        setTimeout(() => { newBtn.style.background = ''; }, 200);
                        console.log(`[CouncilSystem] 会议中调速: ${this.game.speedOptions[this.game.speedIdx]}×`);
                    }
                });
            }

            // 同步BGM静音按钮状态
            const muteBtn = document.getElementById('council-mute');
            if (muteBtn && this.game && this.game.bgmSystem) {
                const muted = this.game.bgmSystem._muted;
muteBtn.textContent = muted ? GST.t('hud.bgm_council_off') : GST.t('hud.bgm_council_on');
                muteBtn.title = muted ? GST.t('hud.bgm_tip_muted') : GST.t('hud.bgm_tip_playing');
            }

            // 更新标题时间
            const titleTime = document.getElementById('council-title-time');
            if (titleTime) {
                titleTime.textContent = GST.t('council.title_time', { day: this.game.dayCount, time: this.game.getTimeStr() });
            }

            // 更新环境信息摘要
            this._renderSituationSummary();
        }

        /** 关闭讨论弹窗 */
        close() {
            // 【v4.20修复】关闭前兜底结算San恢复（防止用户提前关闭导致San没恢复）
            if (this.currentRound > 0 && !this._discussionSanRecovered) {
                console.log('[CouncilSystem] 面板关闭前兜底结算San恢复');
                this._applyDiscussionSanRecovery();
            }

            this._aborted = true;
            this.isActive = false;
            this.isGenerating = false;
            this.overlay.style.display = 'none';

            // 【v4.18】清理分诊状态
            this._triageParticipantIds = null;
            this._triageOtherOrders = null;
            this._isNpcCrisisTrigger = false;
            this._isSelfResolve = false;
            // 【v5.5】清理死亡触发标记
            this._isDeathTrigger = false;
            this._deadNpcName = '';

            // 清除自动关闭计时器（防止用户提前手动关闭时重复触发）
            if (this._autoCloseTimer) {
                clearTimeout(this._autoCloseTimer);
                this._autoCloseTimer = null;
            }

            // 取消暂停，继续游戏
            if (this.game.paused) {
                this.game.paused = false;
                const btn = document.getElementById('btn-pause');
                if (btn) btn.textContent = '⏸️';
            }
            // 通知BGM系统：会议结束
            if (this.game.bgmSystem && this.game.bgmSystem.onCouncilClose) {
                this.game.bgmSystem.onCouncilClose();
            }
        }
        // [已拆分到 council-discussion.js] _getDiscussionSanRecoveryAmount
        // [已拆分到 council-discussion.js] _applyDiscussionSanRecovery
        // [已拆分到 council-discussion.js] _renderSituationSummary
        // _getSituationContext / _buildCharacterCard / _buildAddressRules
        // 已迁移到 CouncilPromptBuilder

        /** 开始讨论 */
        async _startDiscussion() {
            if (this._aborted || !this.isActive) return;
            this.isGenerating = true;

            const speakers = this._selectSpeakers();
            const chatHistory = [];

            for (let i = 0; i < speakers.length; i++) {
                if (this._aborted || !this.isActive) break;

                const npc = speakers[i];
                this._updateStatus(GST.t('council_panel.speaking', { emoji: NPC_EMOJI[npc.id] || '💬', name: npc.displayName || npc.name }));

                const text = await this._generateCouncilLine(npc, chatHistory);
                if (this._aborted || !this.isActive) break;

                if (text) {
                const msg = {
                        npcId: npc.id,
                        name: npc.displayName || npc.name,
                        text: text,
                        emoji: NPC_EMOJI[npc.id] || '💬',
                    };
                    this.messages.push(msg);
                    chatHistory.push(`${npc.displayName || npc.name}: ${text}`);
                    this._appendMessage(msg);
                    this.currentRound++;
                }

                // 短暂延迟，让用户看到逐条出现的效果
                if (i < speakers.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            this.isGenerating = false;
            if (!this._aborted && this.isActive) {
                this._applyDiscussionSanRecovery();
                this._updateStatus(GST.t('council_panel.discuss_done'));
                if (this.moreBtn) this.moreBtn.style.display = 'none';
                if (this.voteBtn) this.voteBtn.style.display = 'none';
                // 讨论结束后自动进入投票流程
                await new Promise(r => setTimeout(r, 1000));
                if (!this._aborted && this.isActive) {
                    await this._startVotingProcess();
                }
            }
        }

        /** 继续讨论（点击
        /** 继续讨论（点击"继续讨论"按钮） */
        async _continueDiscussion() {
            if (this.isGenerating || this._aborted) return;
            if (this.moreBtn) this.moreBtn.style.display = 'none';

            this.isGenerating = true;
            const chatHistory = this.messages.map(m => `${m.name}: ${m.text}`);

            // 再选2-3人发言
            const speakers = this._selectSpeakers(2 + Math.floor(Math.random() * 2));

            for (let i = 0; i < speakers.length; i++) {
                if (this._aborted || !this.isActive) break;

                const npc = speakers[i];
                this._updateStatus(GST.t('council_panel.speaking', { emoji: NPC_EMOJI[npc.id] || '💬', name: npc.displayName || npc.name }));

                const text = await this._generateCouncilLine(npc, chatHistory);
                if (this._aborted || !this.isActive) break;

                if (text) {
                    const msg = {
                        npcId: npc.id,
                        name: npc.displayName || npc.name,
                        text: text,
                        emoji: NPC_EMOJI[npc.id] || '💬',
                    };
                    this.messages.push(msg);
                    chatHistory.push(`${npc.displayName || npc.name}: ${text}`);
                    this._appendMessage(msg);
                }

                if (i < speakers.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            this.isGenerating = false;
            if (!this._aborted && this.isActive) {
                this._applyDiscussionSanRecovery();
                this._updateStatus(GST.t('council_panel.discuss_done'));
                if (this.moreBtn) this.moreBtn.style.display = 'none';
                if (this.voteBtn) this.voteBtn.style.display = 'none';
                // 继续讨论后也自动进入投票
                await new Promise(r => setTimeout(r, 1000));
                if (!this._aborted && this.isActive) {
                    await this._startVotingProcess();
                }
            }
        }
        // [已拆分到 council-discussion.js] _selectSpeakers
        /** 生成单条讨论发言（委托给 CouncilPromptBuilder） */
        async _generateCouncilLine(npc, chatHistory) {
            const Builder = GST.CouncilPromptBuilder;
            // 【v4.27】传入触发原因和讨论类型，让prompt区分"局势讨论"和"个人讨论"
            const discussionContext = {
                triggerReason: this._triggerReason || '',
                isNpcCrisis: this._isNpcCrisisTrigger || false,
                isOpeningCouncil: this._openingCouncilMode || false,
                isDeathTrigger: this._isDeathTrigger || false, // 【v5.5】死亡触发标记
                deadNpcName: this._deadNpcName || '',           // 【v5.5】死亡NPC名字
            };
            const { systemPrompt, userPrompt, maxTokens } = Builder.buildDiscussionPrompt(this._snapshot, npc, chatHistory, discussionContext);

            try {
                let reply = await GST.callLLMDirect(systemPrompt, userPrompt, maxTokens);
                if (!reply) {
                    reply = Builder.getGroundedFallback(npc.id, this._snapshot);
                }
                const allNames = this.game.npcs.map(n => n.name);
                reply = Builder.cleanReply(reply, allNames);
                if (Builder.isReplyContradictingSnapshot && Builder.isReplyContradictingSnapshot(this._snapshot, reply)) {
                    reply = Builder.getGroundedFallback(npc.id, this._snapshot);
                }
                // 【v4.15】第一世时过滤掉LLM脑补的前世/轮回词汇
                // 【v4.39d】第二世首次轮回不过滤，因为NPC确实有前世记忆
                const sit = this._snapshot.situation || '';
                const isFirstLife = !sit.includes('前世记忆') && !sit.includes('已轮回') && !sit.includes('首次轮回重生');
                if (isFirstLife && /上辈子|上一世|前世|轮回|上次咱们|上次我们|以前咱们就|以前我们就/.test(reply)) {
                    console.warn(`[CouncilSystem] 第一世过滤：${npc.name}的发言包含前世词汇，使用兜底台词`);
                    reply = Builder.getGroundedFallback(npc.id, this._snapshot);
                }
                return reply;
            } catch (err) {
                console.error('[CouncilSystem] 生成发言失败:', err);
                return Builder.getGroundedFallback(npc.id, this._snapshot);
            }
        }
        // [已拆分到 council-discussion.js] _appendMessage
        // [已拆分到 council-discussion.js] _updateStatus
        // ============================================================
        //  【v4.18】分诊阶段 — LLM判断谁需要参与决策
        // ============================================================

        /**
         * 分诊阶段：LLM判断哪些NPC需要参与本次紧急决策
         * 仅NPC危机触发时使用，资源危机和晨会全员参与
         */
        async _runTriagePhase() {
            if (this._aborted || !this.isActive) return;
            this.isGenerating = true;
            this._votingPhase = 'triage';

            this._updateStatus(GST.t('council_panel.triage_status'));
            this._appendSystemMessage(GST.t('council.triage_evaluating'));

            const Builder = GST.CouncilPromptBuilder;
            const { systemPrompt, userPrompt, maxTokens } =
                Builder.buildTriagePrompt(this._snapshot, this._triggerReason);

            let triageResult = null;
            try {
                const reply = await GST.callLLMDirect(systemPrompt, userPrompt, maxTokens);
                triageResult = this._parseJSON(reply);
            } catch (err) {
                console.error('[CouncilSystem] 分诊LLM调用失败:', err);
            }

            if (this._aborted || !this.isActive) return;

            // 解析分诊结果
            const alive = this._snapshot.aliveNpcs;
            let selectedParticipants = null;
            let isSelfResolve = false;

            if (triageResult && triageResult.participants && Array.isArray(triageResult.participants) && triageResult.participants.length >= 1) {
                // LLM返回了有效的参与者列表（最少1人）
                selectedParticipants = alive.filter(n => triageResult.participants.includes(n.name));
                isSelfResolve = triageResult.selfResolve === true;

                // 确保至少有1个有效参与者
                if (selectedParticipants.length < 1) {
                    selectedParticipants = null; // 回退到全员
                }
            }

            if (selectedParticipants && selectedParticipants.length < alive.length) {
                // 分诊成功，缩小参与者范围
                this.participants = selectedParticipants;
                this._triageParticipantIds = new Set(selectedParticipants.map(n => n.id));
                this._triageOtherOrders = triageResult.otherOrders || {};
                this._isSelfResolve = isSelfResolve;

                const participantNames = selectedParticipants.map(n => n.name).join('、');
                const otherNames = alive.filter(n => !this._triageParticipantIds.has(n.id)).map(n => n.name).join('、');

                const reason = triageResult.reason || '根据危机情况判断';

                if (selectedParticipants.length === 1 && isSelfResolve) {
                    // 【v4.18】自言自语模式：当事人自己解决
                    this._appendSystemMessage(GST.t('council.solo_resolve', { name: selectedParticipants[0].name, reason }));
                    console.log(`[CouncilSystem] 分诊结果: ${participantNames}独自解决 原因:${reason}`);
                } else if (selectedParticipants.length === 1) {
                    // 1人但不是自主解决（比如濒死呼救），系统自动加入附近的人
                    const helper = alive.find(n => !this._triageParticipantIds.has(n.id) && !n.isCrazy && !n._isDying);
                    if (helper) {
                        selectedParticipants.push(helper);
                        this._triageParticipantIds.add(helper.id);
                        this.participants = selectedParticipants;
                        const updatedNames = selectedParticipants.map(n => n.name).join('、');
                        this._appendSystemMessage(GST.t('council.call_for_help', { name: selectedParticipants[0].name, helper: helper.name, participants: updatedNames }));
                        console.log(`[CouncilSystem] 分诊结果: ${updatedNames}（自动补充${helper.name}）`);
                    } else {
                        this._appendSystemMessage(GST.t('council.solo_face', { name: selectedParticipants[0].name, reason }));
                        console.log(`[CouncilSystem] 分诊结果: ${participantNames}独自面对（无人可帮）`);
                    }
                } else {
                    this._appendSystemMessage(GST.t('council.triage_result', { reason, participants: participantNames, others: otherNames || GST.t('misc.none') }));
                    console.log(`[CouncilSystem] 分诊结果: 参与者[${participantNames}] 其他[${otherNames}] 原因:${reason}`);
                }
                // 【v4.26c】记录到aimode_log方便排查
                if (this.game.aiModeLogger) {
                    const finalNames = this.participants.map(n => n.name).join('、');
                    const finalOthers = alive.filter(n => !this._triageParticipantIds.has(n.id)).map(n => n.name).join('、');
                    this.game.aiModeLogger.log('COUNCIL', `分诊结果: 参与者[${finalNames}] 其他[${finalOthers}]继续当前任务 | 自主解决:${this._isSelfResolve} | 触发原因:${this._triggerReason}`);
                }
            } else {
                // 分诊失败或LLM认为需要全员参与
                this._triageParticipantIds = null;
                this._triageOtherOrders = null;
                this._isSelfResolve = false;
                this._appendSystemMessage(GST.t('council.all_participate'));
                console.log('[CouncilSystem] 分诊结果: 全员参与');
                // 【v4.26c】记录到aimode_log方便排查
                if (this.game.aiModeLogger) {
                    this.game.aiModeLogger.log('COUNCIL', `分诊结果: 全员参与（分诊失败或LLM判断需要全员）| 触发原因:${this._triggerReason}`);
                }
            }

            this.isGenerating = false;

            if (!this._aborted && this.isActive) {
                await new Promise(r => setTimeout(r, 500));
                this._startVotingDiscussion();
            }
        }

        // ============================================================
        //  投票决策系统 — 讨论→提案→投票→结果→应用
        // ============================================================

        /** 投票模式的讨论阶段（讨论完自动进入提案阶段） */
        async _startVotingDiscussion() {
            if (this._aborted || !this.isActive) return;
            this.isGenerating = true;
            this._votingPhase = 'discuss';

            // 【v4.18】分诊模式下只从参与者中选择发言人
            const speakerPool = this._triageParticipantIds ? this.participants : this.participants;
            const speakerCount = Math.min(speakerPool.length, 4);
            const speakers = this._selectSpeakers(speakerCount);
            const chatHistory = [];

            // 【v4.18】自言自语模式：只有1个参与者时，让他自己思考
            if (speakers.length === 1) {
                this._appendSystemMessage(GST.t('council.solo_thinking', { name: speakers[0].name }));
            }
            for (let i = 0; i < speakers.length; i++) {
                if (this._aborted || !this.isActive) break;

                const npc = speakers[i];
            this._updateStatus(GST.t('council_panel.analyzing', { emoji: NPC_EMOJI[npc.id] || '💬', name: npc.displayName || npc.name }));

                const text = await this._generateCouncilLine(npc, chatHistory);
                if (this._aborted || !this.isActive) break;

                if (text) {
                    const msg = {
                        npcId: npc.id,
                        name: npc.displayName || npc.name,
                        text: text,
                        emoji: NPC_EMOJI[npc.id] || '💬',
                    };
                    this.messages.push(msg);
                    chatHistory.push(`${npc.displayName || npc.name}: ${text}`);
                    this._appendMessage(msg);
                    this.currentRound++;
                }

                if (i < speakers.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            this.isGenerating = false;
            if (!this._aborted && this.isActive) {
                this._applyDiscussionSanRecovery();

                // 【v4.18】1人自主解决模式：跳过投票，直接生成并应用方案
                if (this._isSelfResolve && this.participants.length === 1) {
                    this._appendSystemMessage(GST.t('council.solo_decided', { name: this.participants[0].name }));
                    await new Promise(r => setTimeout(r, 500));
                    await this._generateProposals(chatHistory);
                    // 只有1个提案时直接应用，不投票
                    if (this._proposals.length > 0) {
                        this._winnerProposal = this._proposals[0];
                        this._votingPhase = 'result';
                        this._appendSystemMessage(GST.t('council.solo_decision_result', { name: this.participants[0].name, proposal: this._winnerProposal.name, description: this._winnerProposal.description }));
                        await new Promise(r => setTimeout(r, 500));
                        this._applyWinnerProposal();
                    }
                } else {
                    // 正常流程：自动进入提案阶段
                    this._appendSystemMessage(GST.t('council.discuss_end_propose'));
                    await new Promise(r => setTimeout(r, 500));
                    await this._generateProposals(chatHistory);
                }
            }
        }

        /** 手动触发投票流程（普通讨论模式下点击"发起投票"按钮） */
        async _startVotingProcess() {
            if (this.isGenerating || this._aborted) return;
            this._isVotingMode = true;
            this._votingPhase = 'propose';
            this._proposals = [];
            this._voteResults = {};
            this._winnerProposal = null;

            if (this.moreBtn) this.moreBtn.style.display = 'none';
            if (this.voteBtn) this.voteBtn.style.display = 'none';

            const chatHistory = this.messages.map(m => `${m.name}: ${m.text}`);

            this._appendSystemMessage(GST.t('council.start_propose'));
            await new Promise(r => setTimeout(r, 300));
            await this._generateProposals(chatHistory);
        }

        /** 提案阶段：用LLM根据讨论内容生成2-3个行动方案 */
        async _generateProposals(chatHistory) {
            if (this._aborted || !this.isActive) return;
            this.isGenerating = true;
            this._votingPhase = 'propose';

            this._updateStatus(GST.t('council_panel.proposals_ready'));

            // 【v4.18】分诊模式下只给参与者分配任务，全员模式给所有存活者分配
            const assignTargets = this._triageParticipantIds ? this.participants : this._snapshot.aliveNpcs;
            const Builder = GST.CouncilPromptBuilder;
            const { systemPrompt, userPrompt, maxTokens } = Builder.buildProposalPrompt(this._snapshot, chatHistory, this._triageParticipantIds ? this.participants : null);

            try {
                const reply = await GST.callLLMDirect(systemPrompt, userPrompt, maxTokens);
                const parsed = this._parseJSON(reply);

                if (parsed && parsed.proposals && parsed.proposals.length > 0) {
                    this._proposals = parsed.proposals;
                } else {
                    // 兜底方案
                    this._proposals = this._getDefaultProposals(assignTargets);
                }
            } catch (err) {
                console.error('[CouncilSystem] 提案生成失败:', err);
                this._proposals = this._getDefaultProposals(assignTargets);
            }

            // 【补全】确保每个方案都给目标NPC分配了任务
            this._fillMissingAssignments(assignTargets);

            if (this._aborted || !this.isActive) return;

            // 渲染提案卡片
            this._renderProposals();

            // 自动进入投票阶段
            await new Promise(r => setTimeout(r, 800));
            await this._executeVoting();
        }
        // [已拆分到 council-discussion.js] _renderProposals
        /** 投票阶段：每个NPC独立投票 */
        async _executeVoting() {
            if (this._aborted || !this.isActive) return;
            this.isGenerating = true;
            this._votingPhase = 'vote';

            this._appendSystemMessage(GST.t('council.start_voting'));
            await new Promise(r => setTimeout(r, 500));

            // 【v4.18】分诊模式下只有参与者投票
            const voters = this._triageParticipantIds ? this.participants : this._snapshot.aliveNpcs;
            this._voteResults = {};
            for (let i = 0; i < this._proposals.length; i++) {
                this._voteResults[i] = { votes: 0, voters: [], reasons: [] };
            }

            const _isEn = GST.i18n && GST.i18n.isEn && GST.i18n.isEn();
            const _sep = _isEn ? ', ' : '、';
            const proposalSummary = this._proposals.map((p, i) =>
                `${GST.t('council.plan_label', { idx: i + 1, name: p.name }) || `Plan ${i+1} "${p.name}"`}: ${p.description}${p.assignments ? '\n  ' + (GST.t('council.assignment_label') || 'Assignments') + ': ' + Object.entries(p.assignments).map(([n, t]) => `${n}→${getTaskLabel(t)}`).join(_sep) : ''}`
            ).join('\n');

            const Builder = GST.CouncilPromptBuilder;

            for (const npc of voters) {
                if (this._aborted || !this.isActive) break;

            this._updateStatus(GST.t('council_panel.vote_casting', { emoji: NPC_EMOJI[npc.id] || '💬', name: npc.displayName || npc.name }));

                const { systemPrompt: voteSystemPrompt, userPrompt: voteUserPrompt, maxTokens: voteMaxTokens } =
                    Builder.buildVotePrompt(this._snapshot, npc, proposalSummary);

                try {
                    const reply = await GST.callLLMDirect(voteSystemPrompt, voteUserPrompt, voteMaxTokens);
                    const result = this._parseJSON(reply);

                    if (result && result.vote) {
                        const voteIdx = parseInt(result.vote) - 1;
                        if (voteIdx >= 0 && voteIdx < this._proposals.length) {
                            this._voteResults[voteIdx].votes++;
                            this._voteResults[voteIdx].voters.push(npc.displayName || npc.name);
                            this._voteResults[voteIdx].reasons.push({ name: npc.displayName || npc.name, reason: result.reason || '' });
                            // 渲染投票消息
                            this._appendMessage({
                                npcId: npc.id,
                                name: npc.displayName || npc.name,
                                text: GST.t('council.vote_msg', { idx: voteIdx + 1, name: this._proposals[voteIdx].name, reason: result.reason || '' }) || `🗳️ I vote Plan ${voteIdx + 1} "${this._proposals[voteIdx].name}" — ${result.reason || ''}`,
                                emoji: NPC_EMOJI[npc.id] || '💬',
                            });
                    } else {
                        this._appendMessage({
                            npcId: npc.id,
                            name: npc.displayName || npc.name,
                            text: GST.t('council.vote_abstain') || '🤷 …(abstain)',
                            emoji: NPC_EMOJI[npc.id] || '💬',
                        });
                    }
                } else {
                    this._appendMessage({
                        npcId: npc.id,
                        name: npc.displayName || npc.name,
                        text: GST.t('council.vote_abstain') || '🤷 …(abstain)',
                        emoji: NPC_EMOJI[npc.id] || '💬',
                    });
                }
            } catch (err) {
                console.error(`[CouncilSystem] ${npc.name}投票失败:`, err);
                this._appendMessage({
                    npcId: npc.id,
                    name: npc.displayName || npc.name,
                    text: GST.t('council.vote_silent') || '🤷 …(silent)',
                    emoji: NPC_EMOJI[npc.id] || '💬',
                });
                }

                await new Promise(r => setTimeout(r, 300));
            }

            if (this._aborted || !this.isActive) return;

            // ===== 玩家投票阶段（10秒限时） =====
            await this._playerVotePhase();

            if (this._aborted || !this.isActive) return;

            // 显示结果
            await this._showVoteResults();
        }

        /** 玩家投票阶段：显示可点击方案 + 10秒倒计时 */
        async _playerVotePhase() {
            return new Promise((resolve) => {
                if (this._aborted || !this.isActive) { resolve(); return; }

                const TIMEOUT = 10;
                let remaining = TIMEOUT;
                let voted = false;

                // 渲染玩家投票区域
                const voteDiv = document.createElement('div');
                voteDiv.className = 'council-player-vote';
                voteDiv.innerHTML = `
                    <div class="cpv-header">🎮 <b>${GST.t('council.player_vote_title')}</b> <span class="cpv-timer" id="cpv-timer">${remaining}s</span></div>
                    <div class="cpv-hint">${GST.t('council.player_vote_hint')}</div>
                    <div class="cpv-options" id="cpv-options"></div>
                `;
                this.body.appendChild(voteDiv);

                const optionsEl = voteDiv.querySelector('#cpv-options');
                for (let i = 0; i < this._proposals.length; i++) {
                    const p = this._proposals[i];
                    const btn = document.createElement('button');
                    btn.className = 'cpv-btn';
                    btn.innerHTML = `<span class="cpv-num">${i + 1}</span> ${p.name}`;
                    btn.addEventListener('click', () => {
                        if (voted) return;
                        voted = true;
                        clearInterval(timer);

                        // 记录玩家投票
                        this._voteResults[i].votes++;
                        this._voteResults[i].voters.push('🎮玩家');
                        this._voteResults[i].reasons.push({ name: '🎮玩家', reason: '' });

                        this._appendSystemMessage(GST.t('council.player_voted', { index: i + 1, name: p.name }));

                        // 高亮选中
                        btn.classList.add('cpv-selected');
                        voteDiv.querySelector('.cpv-timer').textContent = '✓';
                        voteDiv.querySelector('.cpv-hint').textContent = GST.t('council.voted');

                        setTimeout(resolve, 500);
                    });
                    optionsEl.appendChild(btn);
                }

                this.body.scrollTop = this.body.scrollHeight;

                // 倒计时
                const timerEl = voteDiv.querySelector('#cpv-timer');
                const timer = setInterval(() => {
                    remaining--;
                    if (timerEl) timerEl.textContent = `${remaining}s`;
                    if (remaining <= 0) {
                        clearInterval(timer);
                        if (!voted) {
                            voted = true;
                            this._appendSystemMessage(GST.t('council.player_timeout'));
                            if (timerEl) timerEl.textContent = GST.t('council.abstain');
                            voteDiv.querySelector('.cpv-hint').textContent = GST.t('council.timeout_abstain');
                            setTimeout(resolve, 500);
                        }
                    }
                }, 1000);
            });
        }

        /** 显示投票结果 + 老钱总结 */
        async _showVoteResults() {
            this._votingPhase = 'result';

            // 排序
            const sorted = Object.entries(this._voteResults)
                .map(([idx, data]) => ({ idx: parseInt(idx), ...data, proposal: this._proposals[parseInt(idx)] }))
                .sort((a, b) => b.votes - a.votes);

            const maxVotes = sorted[0] ? sorted[0].votes : 0;
            const totalVoters = this.participants.length; // 【v4.18】使用实际参与者数量
            const winners = sorted.filter(r => r.votes === maxVotes);

            // 渲染结果面板
            const resultDiv = document.createElement('div');
            resultDiv.className = 'council-vote-result';
            let resultHtml = `<div class="cvr-title">📊 ${GST.t('council.vote_result_title') || 'Vote Results'}</div>`;

            for (let i = 0; i < sorted.length; i++) {
                const r = sorted[i];
                const isWinner = i === 0 && r.votes > 0;
                const pct = totalVoters > 0 ? Math.round(r.votes / totalVoters * 100) : 0;
                const barWidth = totalVoters > 0 ? (r.votes / totalVoters * 100) : 0;

                const _isEnRes = GST.i18n && GST.i18n.isEn && GST.i18n.isEn();
                const _voterSep = _isEnRes ? ', ' : '、';
                resultHtml += `
                    <div class="cvr-item ${isWinner ? 'cvr-winner' : ''}">
                        <div class="cvr-name">${isWinner ? '🏆' : ''} ${GST.t('council.plan_label', { idx: r.idx + 1, name: r.proposal.name }) || `Plan ${r.idx+1} "${r.proposal.name}"`}</div>
                        <div class="cvr-bar-wrap">
                            <div class="cvr-bar" style="width:${barWidth}%"></div>
                            <span class="cvr-bar-text">${r.votes} ${GST.t('council.votes_unit') || 'votes'} (${pct}%)</span>
                        </div>
                        <div class="cvr-voters">${r.voters.join(_voterSep) || (GST.t('council.no_votes') || 'No votes')}</div>
                    </div>`;
            }

            // 平票处理
            if (winners.length > 1 && maxVotes > 0) {
                const _oldQianName = GST.t('npc.old_qian') || '老钱';
                resultHtml += `<div class="cvr-tie">${GST.t('council.tie_break', { leader: _oldQianName, name: winners[0].proposal.name }) || `⚠️ Tie! Mayor ${_oldQianName} decides → "${winners[0].proposal.name}"`}</div>`;
            }

            resultDiv.innerHTML = resultHtml;
            resultDiv.style.opacity = '0';
            this.body.appendChild(resultDiv);
            requestAnimationFrame(() => {
                resultDiv.style.transition = 'opacity 0.5s';
                resultDiv.style.opacity = '1';
            });
            this.body.scrollTop = this.body.scrollHeight;

            this._winnerProposal = sorted[0] ? sorted[0].proposal : null;

            // 总结发言（优先老钱，老钱已死则选其他存活NPC）
            if (this._winnerProposal) {
                await new Promise(r => setTimeout(r, 600));

                // 检查老钱是否存活
                const oldQianAlive = this._snapshot.aliveNpcs.some(n => n.id === 'old_qian');
                // 选择总结发言人：老钱存活则老钱，否则选第一个存活NPC
                let summaryNpc;
                if (oldQianAlive) {
                    summaryNpc = { id: 'old_qian', name: GST.t('npc.old_qian') || '老钱', emoji: '👴' };
                } else {
                    // 按优先级选：李婶 > 王策 > 苏岩 > 其他
                    const preferOrder = ['li_shen', 'wang_teacher', 'su_doctor'];
                    const picked = preferOrder.find(pid => this._snapshot.aliveNpcs.some(n => n.id === pid));
                    const pickedNpc = picked
                        ? this._snapshot.aliveNpcs.find(n => n.id === picked)
                        : this._snapshot.aliveNpcs[0];
                    const NPC_EMOJI_MAP = { 'li_shen': '🧓', 'wang_teacher': '📚', 'su_doctor': '🩺', 'zhao_chef': '🍳', 'lu_chen': '🪖', 'ling_yue': '🎵', 'qing_xuan': '🧪' };
                    summaryNpc = {
                        id: pickedNpc.id,
                        name: pickedNpc.displayName || pickedNpc.name,
                        emoji: NPC_EMOJI_MAP[pickedNpc.id] || '🗣️',
                    };
                }

            this._updateStatus(GST.t('council_panel.summary_speaking', { emoji: summaryNpc.emoji, name: summaryNpc.displayName || summaryNpc.name }));

                const Builder = GST.CouncilPromptBuilder;
                const { systemPrompt: sumSys, userPrompt: sumUser, maxTokens: sumMax } =
                    Builder.buildSummaryPrompt(this._snapshot, this._winnerProposal, summaryNpc);

                try {
                    let reply = await GST.callLLMDirect(sumSys, sumUser, sumMax);
                    if (reply) {
                        const allNames = this.game.npcs.map(n => n.name);
                        reply = Builder.cleanReply(reply, allNames);
                        this._appendMessage({
                            npcId: summaryNpc.id,
                            name: summaryNpc.name,
                            text: reply,
                            emoji: summaryNpc.emoji,
                        });
                    }
                } catch (err) {
                    this._appendMessage({
                        npcId: summaryNpc.id,
                        name: summaryNpc.name,
                        text: GST.t('council.summary_fallback') || 'Alright! It\'s decided! Everyone, stay strong — we\'ll get through this together!',
                        emoji: summaryNpc.emoji,
                    });
                }

                // 应用到任务系统
                this._applyWinnerToTaskSystem();
            }

            this.isGenerating = false;
            if (this._openingCouncilMode) {
                this.game.addEvent(GST.t('council_panel.morning_event', { name: this._winnerProposal ? this._winnerProposal.name : '?' }));
            } else {
                this.game.addEvent(GST.t('council_panel.vote_event', { name: this._winnerProposal ? this._winnerProposal.name : '?' }));
            }

            // 【关键修复】自动触发的投票会议，结束后自动关闭弹窗恢复游戏
            // 手动暂停触发的讨论/投票，需要用户手动关闭
            if (this._autoTriggered) {
            this._updateStatus(this._openingCouncilMode ? GST.t('council_panel.vote_done_morning') : GST.t('council_panel.vote_done_auto'));
                this._autoCloseTimer = setTimeout(() => {
                    if (this.isActive) {
                        console.log('[CouncilSystem] 自动触发的投票会议结束，自动关闭弹窗恢复游戏');
                        this.close();
                    }
                }, 3000);
            } else {
            this._updateStatus(GST.t('council_panel.vote_done_manual'));
            }
        }
        // [已拆分到 council-discussion.js] _applyWinnerToTaskSystem
        /**
         * 清理过期的投票决策（在game update中每帧调用）
         * 投票决策有效期：10分钟真实时间（约对应2+游戏小时）
         */
        static cleanExpiredCouncilTasks(npcs) {
            const EXPIRY_MS = 10 * 60 * 1000; // 10分钟真实时间
            const now = Date.now();
            for (const npc of npcs) {
                if (npc._councilTask && npc._councilTaskTime) {
                    if (now - npc._councilTaskTime > EXPIRY_MS) {
                        console.log(`[CouncilSystem] ${npc.name} 的投票决策已过期，清除`);
                        npc._councilTask = null;
                        npc._councilTaskTime = null;
                        npc._councilStateDesc = null; // 同步清理投票分配的stateDesc
                    }
                }
            }
        }
        // [已拆分到 council-discussion.js] _appendSystemMessage
        // [已拆分到 council-discussion.js] _parseJSON
        // [已拆分到 council-discussion.js] _getDefaultProposals
        // [已拆分到 council-discussion.js] _fillMissingAssignments
    }
        // ============ 导出常量供拆分文件使用 ============
        GST._council_system_NPC_COLORS = NPC_COLORS;
        GST._council_system_NPC_EMOJI = NPC_EMOJI;
        GST._council_system_TASK_TYPE_LABELS = TASK_TYPE_LABELS;
        GST._council_system_VOTE_TRIGGER_THRESHOLDS = VOTE_TRIGGER_THRESHOLDS;


    GST.CouncilSystem = CouncilSystem;
})();
