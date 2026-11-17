# FrostEcho G08-R1 交付说明（验收重做，offline_ready/service_unreachable）

## 1. 基线、分支与提交

- 基线 `65ea754`（上一轮 G08 交付 HEAD）；分支 `codex/g08-r1-acceptance`
- 提交序列：
  - `509e119` worker A：状态机与恢复一致性（探针 P1–P6 转回归）
  - `475f899` worker B：CLI 模式/模型配置绑定、失败存证、正确退出码
  - `078ecbf` worker C：非法即停、共同提示模板、可审计记录
  - `470ccff` worker D：独立重算核验器、账本、篡改黑盒
  - `6540462` 离线门控证据
- 接口冻结：`handoff/20261103-g08-r1/CONTRACTS-R1.txt`（主 agent 先冻结，4 worker 并行只改各自文件）
- 默认 legacy / messages off 不变；世界规则、目标、S1 均未改动

## 2. 探针与验收（三支独立探针全绿）

| 探针 | 断言 | 结果 |
|---|---|---|
| state-probe | P1–P6 | **全绿**：缺 simTime 在调用前拒绝；deadline/actionSet/state 三类矛盾以命名错误码拒绝恢复且不半恢复；到期未 reconcil 的合法存档可恢复；actor 第 10 次 wait 在本次 advance 内结算 budget_exhausted（记录/cycle/结果一致，deadline 清空）；100 次 pump 0 调用；恢复 0 调用 |
| cli-probe | B1/B2 | **全绿**：live 档保存 requestModel=model-alpha/thinking/timeout=120000；换模型加载 exit 2 且 0 请求；live 档无 `--live` 加载 exit 2 且 0 请求；HTTP500 step/run 均 exit 1 不保存并写失败证据；打印调用数=存档权威值 |
| eval-audit-probe | C1/D1 | **8/8**：合法基线 8 POST exit 0；impossible-world、actual-timeout-mismatch、wrong-request-config、raw-response-disagrees、missing-ledger、empty-batch 全部被检出；非法 legacy wait 1 请求即停 |

旧错误断言已纠正：缺 simTime 回退 0、非法输出仍算整批成功、legacy 永不出现 wait 行。

## 3. 四个 worker 的修复

- **A**（`src/agent/runner.ts`、`src/agent/checkpoint.ts`、`src/reactive/{game,checkpoint}.ts`、`src/temporal/{contracts,checkpoint}.ts`）：命名恢复错误 `ACTION_SET_CONFLICT / DEADLINE_CONFLICT / SESSION_STATE_CONFLICT / MISSING_SIMTIME`，全部在重建任何对象前校验；timed_wait 构造拒绝无 simTime 世界（legacy 不受影响）；legacy 会话不可为 waiting_time；actor 预算在 advance 内即时结算并反映到 turn 日志/cycle/返回值；`G08EffectiveConfig` 冻结为 envelope 必需字段
- **B**（`scripts/play-g08.ts`）：全进程唯一 effectiveConfig；live 档必须 `--live` + 同一 `FROSTECHO_LLM_MODEL` 才可加载（冲突 CONFIGURATION exit 2，HTTP/world 之前）；脚本档拒绝 `--live` 升级；step/run 共用 finalize（transport 失败 exit 1 + `<root>/failures/<slot>/` 证据，输入槽与 --save 目标字节不动）；totalCalls 取权威记录；game 记录与 envelope 的配置互相交叉校验
- **C**（`scripts/eval-g08.ts`、`src/agent/providers/http.ts`、`scripts/g08-eval-lib.ts`）：非法动作即停（`invalid_output`，不执行玩家动作、不重试、剩余 not_run，通用会话重试策略不改）；wait 说明移入共同骨架（带能力守卫），四臂只差 allowedActions 与 playerMessages 数据行；运行记录保留 plan/prompt/source 指纹
- **D**（`scripts/g08-eval-lib.ts`）：核验器全部从原始材料重算（请求体 vs 冻结采样、raw 响应重解析、事件重放重建终态、snapshot/plan/attempt/summary 超时交叉、账本 1:1）；`G08BatchVerdict{evidenceOk, complete, runSucceeded}`，ok=evidenceOk&&complete（失败/空批不可能 ok）；`verifyG08Prefix` 独立前缀作用域；未知 JSON 结构为命名 issue 不抛异常

## 4. 服务与正式实验

- 只读预检（2026-11-03）：`GET /health` → **HTTP 000**，`GET /v1/models` → **HTTP 000**，chat 端点 → 000（连接拒绝）
- **正式 8 局实模实验未执行，真实 chat 消耗 0/8**；未重启或改动共享 GPU 服务，未建服务台；按执行包交 `offline_ready / service_unreachable`
- 服务恢复后的精确复跑（仅主 agent 串行、无重试、不追加批次）：

```bash
export FROSTECHO_LLM_URL=http://127.0.0.1:18872/v1/chat/completions
export FROSTECHO_LLM_MODEL=qwen3.8-27b
npm run build
node dist/scripts/eval-g08.js --out artifacts/g08-r1 --batch g08-r1-live-<date> --live
node dist/scripts/eval-g08.js --verify --out artifacts/g08-r1 --batch g08-r1-live-<date>
```

- 执行前先确认 `artifacts/g08-r1` 无既有 live 批；失败即停、其余 not_run；live 冻结 8 chat 上限 / timeout 120000 / 预检只读

## 5. 离线门控与证据

| 门控 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `node scripts/run-tests.mjs` | **383/383** |
| golden | `node handoff/20261102-g08-timed-wait/golden-g05.cjs` | **12/12** |
| G07 旧批只读 | `node dist/scripts/eval-g07.js --verify --out artifacts/g07 --batch g07-live-20261102-r1` | exit 1，`behaviorAndCost=ok configuration=mismatch`（R1 更正的既有差异，不白名单） |
| 新合法 fake 批 | `artifacts/g08-r1/fixture-r1-legal` | 8/8 completed、8 请求、verify ok |
| 新非法 fail-stop 批 | `artifacts/g08-r1/fixture-r1-illegal` | 1 请求、exit 1、剩余 7 not_run |
| 恢复演示 | `artifacts/g08-r1/wake-demo2` | wait(1 调用)→save→新进程 load(0 调用)→`--time 1`→同 cycle 继续(第 2 次调用)；轴冲突 load 拒绝 |

旧证据 `artifacts/g07`、`artifacts/g08`、`artifacts/g08-play` 未改。

## 6. 局限

- 真实模型动作选择、消息效应与 wait 的社会语义仍未经实测（0/8 chat）；本轮只证明机制、配置与证据链
- 服务不可达，live 后等待恢复/续跑未经验证；fake 批始终带 `fake` 标识，不作行为证据
- 本机 Node 实为 v22.20.0（/root/.codebuddy-server-cn/bin/stable-*）；文档中的 24.14.0 路径不存在，未覆盖其他平台实跑
- 默认仍为 legacy / messages off，是否启用 timed_wait 交负责人依 live 数据决定

## 7. 交付包

- bundle：`handoff/20261103-g08-r1/frostecho-g08-r1.bundle`（`codex/g08-r1-acceptance`）
- SHA256 与独立 clone 核对：`handoff/20261103-g08-r1/PACKAGE-SHA256.txt`
- 服务器不 push / 不 merge / 不启动 G09；停在 Codex 验收
