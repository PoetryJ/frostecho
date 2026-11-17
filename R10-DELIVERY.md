# R10 里程碑交付（codex/r10-commitment，基于 main@55c92ae）

一句话：**执行与记忆的地基是本轮的真实成果；新训练与 8 局实模对照没有做，原因与代价在下面写清楚了，没有用旧数字冒充。**

## 12 行短报

1. 分支 `codex/r10-commitment`，源码 HEAD `c4e78f7`，tree `8b9900b`，基线 `main@55c92ae`；未合 main。
2. A：独立审计的 7 个反例全部关闭，`audit-work-lifecycle.cjs --strict` 退出 0（当前 `artifacts/r10/audit/independent-runtime.json`），并保留并行 rest 正控。
3. A：一个持久 `ActionIntent` 统一保存 generation、实例/revision、地点、start/due、回执与失败原因；due 进入单一时钟边界，分段/整段/新进程结果一致。
4. A：取消零迟到效果（工作外取消后 0 回执）、恢复不丢履约（D2 退出后新进程恰好一次）、第二个同类任务只结自己那一条。
5. B：渲染器升级 `joint-c-action/2`，`source`/`subjectIds`/原 `occurredAt`/得知时间真正进入模型文本；两臂同一 640 token 预算。
6. B：删除 `unheard-cancellation` 及 `observedTerminal` 一类隐藏终态提示；未听见者的目标与"真活跃"目标键集完全一致，输入里不出现 cancel/unheard 字样。
7. B：四类故事（听见/未听见取消、改源待同意、旧失败解除、两承诺争一份饭）全过，每个都在有 pending 工作时退出、由新进程结算且只结算一次。
8. D：候选层与权威共用一张地点/时长表，做不到的动作不再被提出；参考循环同回合"先真实步行再执行"；四日 runner 接同一 goalBridge/记忆投影。
9. H：`npm test` 822 项、821 过、0 skip；唯一失败是 IDE 注入的 safe-delete shim 写 `/.Trash-1003` 的权限问题，不是产品路径。
10. H：结算对账补齐——一个四日参考局 252 decisions，190 个动作全部终态（183 applied / 7 refused），`unsettledWork=[]`、`reconciled=true`；R9 漏报的结算失败现在计入 `rejected`。
11. 参考四日实测：endings `bleak`、8 人中 4 人存活、0 次主动退出——诚实地点约束下规则策略守不住柴火，炉子灭、四个承诺人冻死；这是结论，不是被隐藏的回归。
12. **未完成**：新语料/四头训练、8 局实模 2×2、实模 D2 恢复、3D/WebGPU。GPU 使用 0 卡时（上限 10）。原因见下：渲染器身份升级后 R9 特征与权重只能当旧控制，必须重编码才能训新头。

## 本轮真正的改动

### A 执行契约（`src/r7/integration/action-intent.ts`、`runtime.ts`、`step.ts`、`execution/place-rules.ts`）

- 工作不再是"保存一个稍后调用的闭包"，而是一条可序列化意图：`intentId/commandId/actorId/candidateId/candidate/inputSha256/generation/taskId/taskType/commitmentId/commitmentRevision/startedAt/dueAt/requiredPlace/startPlace/status/receiptIds/failureReason/projections/settledAt`。
- `advanceWorld` 把每个未完成 due 加入时钟边界，按 `(due, intentId)` 固定顺序结算；结算前重新检查存活、generation、地点、任务仍开启、承诺 revision/终态（由各子系统注册 guard，恢复后重新注册）。
- 提交后先写回执，再做"确定性投影"：任务按 `taskId` 精确结案；承诺/看板由注册的 projector 应用，claim 落在意图里，新进程 `replayPendingProjections()` 重放，不会二次产生物理效果。
- 退出被拒绝的授权（如承诺被撤回）现在给当事人一条**真实的 `action_rejected` 观察**，措辞中性（`authorisation_withdrawn`），精确原因只留在引擎侧 `failureReason`。
- 直接命令也受地点约束：`session.executeCandidate` 与 `step.executeCandidate` 共用 `execution/place-rules` 一张表；R8 入口的时间型动作必须由意图铸造的 grant 才能执行。

### B 记忆与持续义务（`src/r7/jev/render.ts`、`step.ts`、`commitment-bridge.ts`）

- 记忆文本从 `- kind@t {payload}` 变为 `- [来源] kind 知于T 发生于X 关于ids {...}`；来源/时间/主体不再只存在于结构体里。
- `visibleMemory` 同时受限"条数"和"token 预算"（默认 640），两臂同预算，差异只来自选择规则。
- 承诺目标只由本人记录推导：听到终态才显示终态；没听到就仍是 `active`，且不再有任何能区分"听到/没听到"的字段。

## 可复跑

```bash
npm run build
npm test                                                        # 822 项
FROSTECHO_AUDIT_OUT=/tmp/audit node scripts/r9/audit-work-lifecycle.cjs --strict
node dist/scripts/r9/memory-stories.js --out /tmp/stories        # 四故事
node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --seed r10-ref-final \
  --out artifacts/r10/reference-arm/final                        # CPU 参考四日
node scripts/r10/write-delivery.mjs                              # 重新绑定 DELIVERY.json
```

`DELIVERY.json` 由脚本从工作树现算：commit/tree、渲染器身份（`src` 与服务端一致）、编码器 config SHA、旧头 SHA、每条证据的 SHA256、全部成功/失败/未完成项。它是在源码提交 `c4e78f7` 之后追加提交的（自引用问题），以 `source.head` 为准。

## 未完成与原因（不掩饰）

1. **新语料 + 四头权重**：未训练。B 要求把来源/时间写进渲染文本，这必然改变输入身份（`joint-c-action/2`）；R9 的 96 条 case 特征与四个头是 `/1` 文本下的产物，只能当"旧渲染控制"，不能拿去当新头。要训新头必须用 27B 重编码（96 case × 约 6 候选 ≈ 576 前向，按 R9 实测 9.45 s/前向 ≈ 1.5 卡时/次，还要留出重跑余量）。
2. **8 局 old/new × raw/conditional**：未跑。它依赖上面的新头；按 R9 的 160 前向/臂估算，8 局约 7.6 卡时（不含装载与波动），在 10 卡时上限内是可以做的，但没有新头时跑了也只能回答记忆问题、不能回答训练问题，所以没有拿旧头凑数。
3. **实模 D2 恢复**：CPU 上已证明（意图队列持久化 + 新进程恰好一次），但没用真实 scorer 整局跑过。
4. **3D/WebGPU**：本机没有任何浏览器二进制（`chromium/chrome/playwright` 均无），无法产出"实际浏览器录像"；按 R10-APPROVED 的约定，这一项明确标未完成，不用静态图或预录轨迹冒充。
5. **D 的逐项 parity**：地点/步行/五类 work 已在 CPU 门里覆盖，但"原作任务地点/耗时/效果逐字段对账"没有本轮重新审完。

## 一个必须写进结论的实测发现

把"任何地点都能即时 gather"修成"必须去冰湖/伐木场"之后，参考策略在四日里守不住柴火：252 次决策中 7 次结算被拒（`insufficient_firewood`），炉子熄灭，四个承诺人（npc_01..04）体力归零冻死，另四人存活。R9 里"8 人 perfect"部分是靠一个不可能的即时采集动作撑住的。这不是回归，是把假象换成了真实代价；也正是 2×2 需要回答的问题（模型能否在承诺与生存之间做取舍）。
