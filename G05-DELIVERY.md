# FrostEcho G05 交付说明（needs loop）

## 1. 版本

- 基线：`e2177b4`（G04 最终交付）
- G04-R1 修复（`codex/g04-reactive-npcs` 分支）：`4dc0d36` close 同步闩锁；`c22f25f` play:g04 超时优先级 `--timeout > FROSTECHO_LIVE_TIMEOUT_MS > 30s`
- G05 分支：`codex/g05-needs-loop`（基于 `c22f25f`）
  - `3fc5e62` A+B：模拟时间/代谢 + needs 循环（never/one-shot/recurring、10 决策预算、expired 中断）
  - `ede4a28` C：12 轨迹矩阵、批驱动与 G05 感知核验（顺带修复 G04 verify 的 LogEntry 嵌套结果读取 bug——只影响含被拒命令的记录，旧证据不受影响）
  - `c2cca79` D：play:g05 交互 CLI 与子进程系统测试

## 2. 机制摘要

- `advance_time`：仅 world、整数 1..120 分钟、tick+1；每跨 10 分钟边界每 NPC `hunger+1`（钳 100，饱和静默）；`simTime` 为可选字段，pre-G05 记录 canonical 不变
- needs：跨 30 分钟边界授予；`NEED_HUNGER_AT_LEAST=30` 门槛；每 actor 每周期至多一次；每 actor 同时至多一个未决 need；need 优先于自主 cycle 调度（含接管 active）；`NEED_DECISION_BUDGET=10` 内未吃到即 `expired` 并中断整局；吃到（eat accepted）即 `satisfied`
- need cycle 豁免通用 `EPISODE_CALL_LIMIT`（记录核验按 cycle reason 分类）

## 3. 轨迹矩阵与证据

- 12 条轨迹（ac/ca 两链镜像）：8 条零调用（never 代谢×3、advance 拒绝、restock 静默）+ 4 条需模型（one-shot feed-loop ×2、recurring expired ×2）
- fixture 批 `g05-fixture-20261102-r1`：12/12 PASS，28 参考决策，0 HTTP；`node dist/scripts/eval-g05.js --verify --batch g05-fixture-20261102-r1` 通过
- live 批：**未执行**。两次健康探测（间隔 20s）均 `ECONNREFUSED 127.0.0.1:18872`，端口无监听；按执行包"健康预检失败则完成离线交付并报告 live 未验证，不重启服务"，未产生任何 chat 请求（0/60 预算消耗）

## 4. 复跑

- 测试：`npm test`（199/199，含 G05 矩阵离线系统测试与 CLI 子进程测试）
- fixture：`npm run eval:g05 -- --batch <批名>`（默认 reference，零 HTTP）
- 只读核验：`node dist/scripts/eval-g05.js --verify --batch <批名>`
- live（服务可用时）：`FROSTECHO_LLM_URL=http://127.0.0.1:18872/v1/chat/completions FROSTECHO_LLM_MODEL=qwen3.8-27b FROSTECHO_LIVE_TIMEOUT_MS=120000 node dist/scripts/eval-g05.js --live --chain ac --batch <批名>`；ac 六条全过再 `--chain ca`；默认 `--max-calls 60`
- 交互：`npm run play:g05 -- [--need never|one-shot|recurring] [--order ac|ca]`

## 5. 未证明

- G05 live 对照（endpoint 不可达，0 请求；fixture 已覆盖全部 12 轨迹判定与核验）
- 更长时程（>120 分钟/局）与多 NPC（>2）下的 need 行为
- 30s 默认超时稳定性（沿 G04 结论，正式批仍显式 120s）
