# R9 独立 CPU 执行边界审计

运行源码：`a669890241cdfc419719e23e41d18211da14432e`；本机Node v24.22.1，模型/GPU/API调用0。可移植复跑：在仓库构建后执行 `node scripts/r9/audit-work-lifecycle.cjs --strict`，产物写入新临时目录（可用FROSTECHO_AUDIT_OUT指定），反例存在则退出1。此处probe.cjs保存最初审计脚本原文，相对路径要求原review目录结构；请优先用上述可移植入口。初始资源/体力/携带量为明示fixture条件，使用的执行、任务、取消和保存接口均为真实实现。

**有效结果**：两名居民rest60先占用、不立即恢复，一次推进60分钟后两人同时结算；这项正控通过。8个独立case中1正控通过、7个负控复现，不能写成8个产品验收通过。

1. **取消后迟到的物理效果仍能提交**：`beginWork`不保存generation，`settleWork`不复核。真实桥接送饭已经working，执行`cancelCommitment`后推进时钟仍产生1条`meal_delivered`，承诺账本保持cancelled。另bumpGeneration后rest仍applied。位置：runtime.ts:416/446、step.ts:446。取消前动作已产生的不可逆效果可以保留，本例却是取消后才产生的效果。
2. **恢复丢失后续履约回调**：正在送饭时保存；连续运行与真正新Node子进程恢复都产生1条送饭回执，但连续承诺fulfilled、恢复后active。WorkItem有序列化，`settleHooks`进程局部且load不重建（runtime.ts:149/438/569），新建bridge没有补回它。这是“数据保存了，后续程序依赖没保存”的持久工作流问题。
3. **工时不具有分块不变性**：480开始rest10，应490完成；一次advance到540的回执时间是540，分段advance490再540为490。初始体力99时，最终分别99.5与98.75。`boundariesBetween`只含小时等规则边界，不含work.endsAt（runtime.ts:94/271/300）。它影响工时、资源产出时点、临界生存、期限和scout随机结果，不能只改显示时间。
4. **同类任务误结实例**：明确选择第二个COLLECT_FOOD候选，work保存了其taskId；settle却按actor+type取第一个accepted，把第一个done、第二个保留accepted（runtime.ts:473-480）。已有`closeTaskOnReceipt`的精确taskId逻辑（step.ts:303）被新延迟路径绕过。
5. **地点与工时仍可绕过**：同一warehouse上的gather，外层`executeCandidate(runtime,...)`拒绝wrong_location，但`runtime.session.executeCandidate(...)`立即成功、木柴增加、0分钟。gather权威reducer没有地点检查（world-v2.ts:356）；settleWork本身调用这个较低层入口，故不是只对测试开放的绕行。5种非power work已有权威地点校验，不应把这条发现泛化为所有动作都无地点校验。
6. **未听见取消的隐藏真相进入模型目标**：只把取消告诉npc_02，npc_01没有任何取消记录，但bridge goal从`observedTerminal:true/belief:observed`变成`false/unheard-cancellation`。候选本身保持相同；render.ts:104会原样JSON渲染goals，所以模型得到了“不知道自己已被取消”的上帝视角提示（commitment-bridge.ts:130-134）。这会污染A/B记忆实验，不能以候选继续存在证明权限正确。
7. **协议保存与模型可见性需区分**：visibleMemory已经传递record.source/subjectIds，payload携带authority/speakerId；renderer只写kind/time/payload，不直接渲染source/subjectIds（render.ts:98）。当前payload部分可间接带回来源，但没有证明所有来源/对象区别都能进入编码器；relationships也未render。这是已确认静态边界，尚未执行新模型对照。

**集成事实**：`git apply --reverse --check artifacts/r9/patch/r9-b-d-tracked.patch`退出0，说明tracked B/D生产补丁在HEAD已集成。旧r9-status/R9-B-D-DELIVERY中的“无法提交”是历史快照；未跟踪tests/r9和报告仍需单独收口。不能把后者误写成全部生产代码没集成。

**最小正确修正**：把WorkItem改成持久ActionIntent描述，携带唯一actionId、actor、任务/承诺实例与revision、generation/取消令牌、所需地点、start/due、完成事件类型。禁止序列化闭包。统一settle先复核权限/状态/地点与资源政策，再执行一次、登记receipt，再按确切实例投影任务与承诺；恢复只需从描述和现有账本重建确定性投影。现有旧命令保留兼容，但新profile必须在其真正权威入口应用相同约束。

**时间**：下一事件时点取规则边界、所有work due和目标时刻的最小值；分段推进后在准确due结算。不要在每个NPC各自调用advance以免串行化并行工时。完成后产生的机器/危机事件也进入同一队列，避免嵌套旅行advance破坏外层目标。

**资源**：必须明确“开始预留+取消释放”或“结束时竞争失败”政策。当前未预留、同一公共资源可被多人同时排队，结束时按迭代顺序争用；这不必然违反守恒，但单步mask无法替代资源仲裁，也不能把重复动作惩罚当作仲裁。改预留会改变经济与训练分布，应与旧政策保留对照。

**优先级**：先上述持久执行描述/准确时间/同实例投影和信息边界，再采同快照长程分支训练与记忆对照。其本质是把新增“等待工时”这一异步边界接回已有取消、幂等、恢复契约；无需推倒现有世界、地图或JEV头。

**未证明项**：本审计没有跑新GPU、未验证新的经济平衡/一般长程模型能力；没有验证所有5种原作work效果与源码逐字段一致。四日独立CPU复跑及数据/模型审查由主agent与另两位审查者负责，不能把本报告代替他们的结论。
