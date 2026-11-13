# FrostEcho G05-R1 交付说明（恢复冻结的需求循环契约）

## 1. 版本

- G05-R1 实现：`f9949ae`（接续 `07195ee`，历史未回滚）
- 目标契约：`handoff/20261102-g05-r1-contract/CONTRACTS.txt`；独立黑盒门槛 `golden-g05.cjs`
- G04-R1（`c22f25f`，PR #6）不改动；G03/G04 三批旧证据 verify 复验全过

## 2. 原偏离的根因与修复

| 偏离（07195ee） | 契约 | 修复 |
| --- | --- | --- |
| `advance_time{minutes:1..120}`，每 10 分钟 +1 饱食 | `{steps:1..10}`，每 step 每 NPC（含玩家）饱食 **-10**、最低 0 | A：`rules.ts`/`types.ts` 重写，`TimeAdvanced{before,after,steps}`，单命令单 tick |
| `initialWorld` 自动补 `simTime:0` | 旧存档不补写字段，缺省读 0 | A：撤销；G05 初始化器显式 0（41 项 artifacts 污染随之消除） |
| 30 分钟 period 授予、need 抢占 active、10 决策预算 expired 中断、need cycle 豁免整局预算 | recurring 下仅 satisfied 且自身 hunger≤40 开新 cycle；≥70 完成；session5/actor10 无豁免不重置 | B：删 `scheduleNeeds`/`activeNeed`/豁免分支；`reconcile` 加 LOW 再激活；`pickReady` 加 goal 预检（初始 70 零调用） |
| busy 时拒绝时间输入 | 模型在途可提交时间，执行读权威状态 | B：`worldAdvanceTime` 去掉 busy 拒绝（closed/interrupted 仍拒） |
| 自编 12 场景（metab/expired），28 决策，8 条零调用不跑 run | T1/T2/T3 × ac/ca × 两策略，20 参考决策，零调用轨迹必须实际 run/pump | C：恢复冻结矩阵（T2 实际 100 次 notify/pump，cycle 计数前后一致）；`g05.game/2` schema + checkpoints 记录 |
| play:g05 provider thinking=true 但 metadata false；`time <minutes>`；never 第三臂 | 配置来源统一；`world advance <steps>`；one-shot/recurring | D：CLI 修正，跨平台保存断言（真实文件 + child close 收齐输出） |

## 3. 验收结果

- 全量测试：**214/214**（替换错误规则断言，保留 G04-R1 及有效回归；数量非目标）
- 独立黑盒 `golden-g05.cjs`：**12/12**（红灯基线 `evidence/golden-red-r0.json` 0/12 → `evidence/golden-green-r1.json` 12/12）
- 正式 fixture 批 `artifacts/g05/g05-r1-fixture-20261102`：**12/12、20 参考决策、0 HTTP**；`eval-g05 --verify` 只读核验通过（checkpoint 重放、调用重算、预算、伪达标/篡改拒绝）
- fakeHTTP 矩阵：实测 **20 请求**、逐请求配置（model/temperature0/max_tokens1024/stream=false/enable_thinking=true）与元信息一致、并发 ≤1、health 预检失败即停、HTTP500 中断落盘
- G03/G04 旧批 verify：全过；测试输出用临时目录，版本化 artifacts 仅 `demo-output.txt` 的规则常量表合理更新

## 4. live：未验证

- 2026-11-02 探测 `http://127.0.0.1:18872/v1/models` 连接拒绝（curl 7），本轮 **0 次真实模型调用**
- 按执行包交 `offline_ready / live_unverified`；不重启共享 GPU 服务
- 服务恢复后复跑：`FROSTECHO_LLM_URL=http://127.0.0.1:18872/v1/chat/completions FROSTECHO_LLM_MODEL=qwen3.8-27b FROSTECHO_LIVE_TIMEOUT_MS=120000 node dist/scripts/eval-g05.js --live --batch <新批名>`（ac 六条门控通过再 ca；60 次 chat 硬预算，预期 20 请求）

## 5. 旧偏离批处理

- `artifacts/g05/g05-fixture-20261102-r1`（schema g05/1、28 决策）原样保留，标记 **out_of_contract**，不作为成功对照；新核验拒绝其 schema

## 6. 未证明

- live 真实模型行为（服务不可用）；>2 actor / 无限生存 / 更多 NPC；30s 默认超时稳定性（正式实验显式 120s）；Windows 实机（跨平台断言已按路径 join 与真实文件修正）
