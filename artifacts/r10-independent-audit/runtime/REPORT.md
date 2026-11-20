# R10 独立 CPU 运行审查

源码 `288a28859a4eb872345771d25618769e127e434b`；本审查0次GPU/API，不改生产。根目录构建后运行 `node ../audit/runtime/r9-regression.cjs` 与 `node ../audit/runtime/extra.cjs`。Node绝对路径见主报告；`source`工作区存在的offline-timing漂移不属于本审查。

**已验证进展**：R9原来的7个负控全部不再复现，并行工时正控继续通过。generation撤销后0回执；非整点490准确完成，整段/拆段最终体力均98.75；错误地点在session层也被拒；第二个同类任务只结第二个；正在送饭保存后真实新进程恢复也fulfilled、receipt相同；取消后0送达；未听见取消前后bridge view逐字节相同。原始明细 `independent-runtime.json`，脚本 `r9-regression.cjs`。`issueReproduced:false`表示旧缺陷未再出现，不是缺少断言自动算成功。

需求去重正控：同actor、同候选/实例的在途需求以新attemptId重发，返回同intent、duplicate=true，最终1intent/1receipt，见 `extra.json` 的 `queued-demand-dedup-positive`。这只证明**在途同需求**去重，不代表完成后禁止重复采集（持续生产应允许）。

## 新发现1：完整原图移动进入新的结算重入边界

- 复现：`node ../audit/runtime/extra.cjs --fullmap`，或在本目录 `node extra.cjs --fullmap`；正常Node栈即可复现，`fullmap-normal-stack.json`是原始stdout。主 `extra.cjs`另用小栈子进程作快速对照，结果相同，不以小栈制造缺陷。
- 初始：D1 08:00=480，启用真实原图，npc_01在宿舍，只有1个 `move→warehouse` intent，due=495；执行`advanceWorld(495)`。
- 期望：每个intent只被认领并结算一次。若路径本身另计工时，必须有明确持续移动阶段和唯一时钟所有者；结果不能在同一个intent反复结算时产生冲突回执。
- 实际：clock=516，npc确已到warehouse，同一个intent生成22条workLog，最终status=rejected、failureReason=original_exit_interrupted，且带已发生的真实步行事件。
- 根因：runtime.ts:587收集working due，:624同步调用session.executeCandidate，直到:636才改终态；spatial.ts:44-57把move转为真实travel，:153每格再次调用advanceWorld，重新发现同一个仍working的due intent。原始移动有副作用，外层却记录拒绝，破坏exactly-once与统计口径。
- 最小正确边界：结算前把intent原子认领到不可重入状态，nested advance不能再次取得它；移动应由唯一事件调度推进，不能“一次性due动作”内同步跑另一套完整时钟。把每步行进作为同intent的可恢复阶段，或把旅行的时间成本完全交给外层调度；两种都须保留中途取消/存档恢复。加单intent1终态/1投影、2并发原图移动、旅行与另一工时同due的负控。不要只忽略第二条workLog或把rejected改为applied。

## 新发现2：首条长记忆突破预算，并真正进入模型渲染输入

- 复现：`node ../audit/runtime/extra.cjs`，查看 `extra.json:first-oversized-memory-bypasses-budget`。
- 明示初始数据：一条玩家来源commitment_accepted，条件解释文本重复500次；memoryTokenBudget=64，正常可读长条件，无模型调用。
- 期望：硬预算应保持≤64，或明确拒绝/裁剪并标注被省略证据。
- 实际：visibleMemory保留1条、按**当前实现自己的计数器**记6580；runStep StepRecord也记budget64/tokens6580，真实render memory segment 19748字节，尾部commitmentId仍在。不是“真实tokenizer和估算器略有误差”，而是同一估算器自身超限100倍。
- 根因step.ts:277使用 `chosen.length > 0 && count(trial)>budget`，第一条无条件收入。最小修正应规定单条超长记录的截断/证据指针策略，不可简单静默丢掉关键撤销。新增raw/conditional同超长义务、预算0/负数、来源/时间字段仍保留的控制。
- 另：B统一了渲染行与计数口径，source/subjectIds已真实进入renderer；但默认 `utf8-bytes/3-ceil/1`仍是字节估算，不应命名为模型实际token。scorer-client.ts:46/73计数的是同一memory block，未证明它等于27B tokenizer实测。

## 新发现3：地点已加强，正确地点的低层兼容口仍可0工时执行

- 复现同extra脚本：npc_01在village，外层R8 executeCandidate拒绝 `work_requires_intent`，同一对象的session.executeCandidate不传grant却成功采木30→33，simTime仍480。原始结果 `extra.json:correct-place-undefined-grant-bypasses-time`。
- session.ts:527仅在 `grant !== undefined` 时验证grant，因此undefined保持老调用行为。这是有意兼容旧入口的实现，不应说新runStep本身仍未排队。
- 实际调用方：session.ts:642的legacy stepActor；gameplay-v2/loop.ts:786/789/792旧step；R8 step.ts:374（瞬时动作出口）；R8 runtime.ts:624（结算携带有效grant）；spatial.ts的包装。CLI `scripts/play-sprint.ts:311` 的`step`无profile分流，Gospel仍可触发旧session stepActor；而标准网页game-step/R8 runStep走新队列。手动withdraw/deliver/deposit也保留旧命令接口，其作用不等于新intent履约。
- 定性：**可达兼容API的约束分叉**；已独立证明直接API可绕过，尚未构造Gospel用户输入令旧planner恰好选中采集的产品漏洞。下一工单给legacy authority明确profile/能力边界，新profile所有需工时命令统一归队，旧存档迁移单列，避免为了旧测试使新契约永久旁路。

## 8人存活与官方4/5人存活为何不可直接归因

D `d-fourday.ts`复用同authority，但不是同策略/同实验驱动：:129自写runCouncil（使用planAssignments）；:260给reference增加 `+d-weather-veto/1`，D4会替换户外候选；:325主动撤销所有户外任务；:358额外驱动生存退出；还有独立救援与夜走逻辑。官方r8的runCouncil仍是另一实现，`hunger<35`等响应也不同。两份结果的seed、元数据均不同，D三seed sourceHEAD=null，不能把8对5的全部差异归给“修夜路/救援”两项。

`artifacts/r10/d/fourday/seed-r10-d-ref-1/summary.json`为8活并记录2次天气veto；`canonical-runner-after/summary-*.json`为5活；两者均非full-map模式，不能把fullmap差异当它们**之间**的原因，也不能以D存活证明真实八图整局已过。它们是不同前提下的有效CPU观察，不是相互矛盾的数字。

最小整合：保留D运行作为显式 `reference-survival/1` 策略臂，提取共同runner/夜行/救援能力；冻结同seed、地图模式、任务生成、干扰、自动退出/天气veto开关，逐项ablation后才归因。不能把D脚本复制到H当新默认并仍叫旧reference。

## 53行共享文件改动的性质

`git show --numstat 612f4de -- src/r7/agency/options.ts src/execution/place-rules.ts scripts/play-sprint.ts`：27/9、11/1、15/0，合计53行新增/10行删除。medical20→30、rest按place、PREPARE_WARMTH改仓库准备、refuel阈值/数量、CLI propose-change都是**有实际语义的共享接口变更**，不是纯越权格式问题；其中地点/工时/候选须A/C/H共同确认、重新绑定训练renderer/候选输入，CLI新命令则合理补全玩家能力。D已主动披露，宜集成审查并保留差分，不应仅按文件所有权否决整个玩法成果。

本审查建议：通过R9持久执行七反例收口这一里程碑；完整原图结算重入和预算超限必须在新实模四日对照前修正。其余兼容口/策略归因纳入同一执行—驱动—输入契约整合工单；不新增GPU，保持当前实模证据归属和正式门状态。
