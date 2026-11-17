# Git 演变、返工共因与接手成本（只读审计）

核查仓库：R8 `586034f` 与R9干净源码 `a669890241cdfc419719e23e41d18211da14432e`。范围为2026-11-04至17日、各HEAD可达祖先；R9共123提交，R8为117。52条R8主题匹配fix/restore/correction等词，**不是52个独立Bug**。没有用提交时差冒充开发工时或PR等待时间；PR元数据由独立核查补充。

结论：重复返工的共因是**边界上的语义与所有权没有完整进入可执行契约**。单一world/clock/receipt的方向本来正确，但新功能经常只接到部分入口，或用同名字段表示不同层的状态。仅增加防重复惩罚、扩大数据或再加一次整局测试，不能独立解决这些问题。

## 有意设计与历史负担

1. `07d5df3` 明确规定domain只产生intent，事件须经统一提交，domain自己不推进时钟（`src/r7/contracts.ts:8-14`，历史行号）。因此不能把“外层统一推进”一概删掉；R8问题是旧PlaySession动作即时结算、新原图旅行逐格advance、网页/四日另外补时混在一起。R9 `f17ca0c` 的beginWork/settleWork是对时间语义的实质补充。
2. `7bb7cf3` 曾把`game-step`直接改到R8；`8d100c4` 明文恢复旧路径，理由是R2–R5故事及旧存档依赖它；`680c207` 才通过profile将新网页/CLI共享runStep。保留legacy适配是有意迁移策略，不宜再次“统一替换”回滚一次。
3. `181907d` 引入承诺修订与真实送餐回执；`97f21c2`补承诺终态→任务取消，`c82b089`补供仓任务→承诺fulfilled，`9fba236`补资源/目标谓词，`680c207`补R8候选→旧承诺桥接。同一业务对象在task、commitment、world event三层映射，才是持续漏接的主战场。
4. `8a4a895→0349347→97f21c2→6a2dac0→f366d94` 不是五次同样的超时修补：它们依次暴露了异步等待、排队新任务、显式取消与多个barrier捕获集合的所有权差别。保留generation与不可变capture有实际反例依据；它们不是可删的“防御代码”。
5. `afebda4→54214bd→12cc208→a86c8a1` 反复处理打包G11证据在不同运行入口未恢复、marker不代表齐全等问题。成熟做法是一个可调用bootstrap由所有入口共用；不是删除历史证据或放松校验。

## R9交付身份核对（修正了初始推断）

- `artifacts/r9/patch/r9-status.txt`记录的是历史脏树，不能当作当前HEAD状态。已在a669890执行 `git apply --reverse --check artifacts/r9/patch/r9-b-d-tracked.patch`，退出0；**所有tracked B/D改动已经进入HEAD**，主要包含在`872454d`，不能宣称生产B/D未集成。
- 实际遗留是new-files tar里的`tests/r9/{memory-invariants,work-proxy}.test.ts`和`R9-B-D-DELIVERY.md`在clean HEAD没有对应跟踪文件；`scripts/r9/memory-stories.ts`已经跟踪。因此交付中的全套791项不能仅凭branch HEAD就复现，需要明确提取命令或把测试正常入库。故事runner本身可以从HEAD构建。
- 根目录`REPORT-r9.json`仍声称B/C/D未完成、0 GPU；后来的`REPORT-C.md`/`paired/REPORT-PAIR.md`已经记录训练和实模。新接手者会读到互相冲突的“当前状态”。这是状态报告分裂，不是GPU训练不存在。
- 下一次一次集成收口即可：保留旧报告作历史，新增唯一当前DELIVERY，绑定运行源码tree/hash、独立测试文件清单、实际命令与原始产物。不要为每个报告漂移再开一轮小返工。

## 新工程师的认知成本

R9立即可玩与承诺路径跨9个关键文件、4746行；还未计入世界/模型内部。文件包括`play-sprint`、PlaySession、GameplayLoop、CommitmentBoard、R8Runtime、runStep、commitment-bridge、CliBridge、JointScorerClient。R8对应4303行。这里只量化阅读面，没有根据行数编造“需要几天”。

命名同时混用r7目录、R8Runtime、Gospel profile、v2 session、R4承诺与G00–G11包入口；`package.json`描述仍是G00/G01。强工程师不难读懂单函数，但需要大量历史才能判断哪条路径具有产品权威。

建议保留五个稳定职责：transport只传输；world/session验证并提交动作；runtime管理时间与领域；commitment管理协商义务、task管理执行；scorer只建议候选。写一页当前调用图并用一条原始实模故事解释这五者，比全面改目录更省成本。协议/存档/renderer身份暂不机械改名。

## 可以安全简化的范围

- 候选删除：`src/r7/jev/scorer-client.ts`的`ScorerServiceClient`在生产/测试没有调用者；当前两入口实际导入`JointScorerClient`。归档旧客户端并跑干净build与真实协议测试即可；不要删除对应历史证据。复核命令：`git grep -n ScorerServiceClient HEAD -- :!artifacts :!handoff :!evidence`。
- 重复代码合并：Gospel的`game-step`/`r8-step`处理器可以提取一个函数，保留命令名与旧profile适配。不能再把legacy默认悄悄换掉。
- 运行器共享：npm/eval的G11恢复统一到一个纯工具，保留不覆盖已有字节、SHA损坏非零的语义。当前两个入口的恢复触发条件不同，正是历史返工源头。
- 实验选项收窄：旧`summary` memory arm与raw同实现，当前实验不再提供它；旧存档值仍可读作历史兼容。不要因此编造第四臂。
- 不做大清洗：旧save schema、事件账本、取消授权、G00–G11回归保护目前有真实依赖；删除它们不满足“已不存在的问题”。

## 可沉淀的最小项目规则与自动化

1. **一个动作契约验三入口**：同场景在CLI、网页、四日runner对照actor/地点/资源/开始结束时间/任务实例/提交回执，工作中save→新进程恢复也要对照；接受排队不等于工作完成。
2. **异步所有权不可变**：每个barrier只拥有接受时捕获的job集合；显式cancel与超时不能相互覆盖。固定cancel/save/save/new-step排列复验，使用可控制释放的scorer。
3. **交付从干净树验证**：唯一manifest记录HEAD和tree hash，测试发现列表来自Git跟踪文件；禁止把仅tar中的测试计入HEAD自动验收。仍允许独立原始证据包，但恢复命令必须可执行。
4. **模式与收益分开**：真实前向、规则晨会、fixture/replay分别计数；同seed同存活写平局。总任务数不同不能直接比完成个数；盲审一致率也不等于实际履约。
5. **先证伪故障归因**：例如不要仅凭旧r9-status判源码未集成；用反向patch检查/逐文件比对。重复采集也要从任务终态、资源目标和已完成回执查起，再决定是否加惩罚。

复现：运行同目录`collect_history.py --repo <R9 source> --suffix=-r9`生成逐提交JSON与hotspot统计。`history-findings.json`为R8冻结快照，`history-findings-r9.json`为R9范围；历史文件行号以586034f为准，使用`git show 586034f:<path>`还原。
