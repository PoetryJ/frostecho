# 可直接转交Vibe：先CPU共同契约，再按负责人选择运行三版之一

从仓库 https://github.com/PoetryJ/frostecho 的 codex/r9-independent-audit-20261117 接续（包含原R9 a669890，不重建工程）；新建codex/r10-commitment。读本文件、ACTION-CONTRACT.md及分配模块即可。长程履约优先，完整原作并行。本轮Codex只做独立核查，没有启动新增GPU；A/B/C三版和预算见DECISION.md，负责人选择前先完成CPU工作。

O集成负责人开5个有界执行agent，真实记录启动数与贡献。先冻结接口与独占文件：A独占runtime/权威执行；B独占memory/renderer/bridge；C独占research+数据；D独占domains剩余玩法与UI；H独占runner/测试/交付。共同step/play-sprint由O集成，各worker只交接口补丁不并改。若工具并发限额不足，分两批，禁止虚称并行。每个agent交复现、实现、正负验收和原始证据，不只写审计意见。

**A 持久执行整合**：修复独立probe的7项反例，按ACTION-CONTRACT.md把generation/实例/revision/地点/due/完成投影纳入同一可恢复执行描述；去掉对settleHooks闭包的恢复依赖。所有入口复用，精确事件due进入单时钟，不串行加8个人的工时。先保留完成时资源仲裁并报告真实失败；任何预留政策变化另作对照。验收有rest并行正控、工作中取消、D2新进程恢复、两同类任务精确结案、非整点分块一致、直接命令地点约束、资源竞争，不可一律拒绝来过门。

**B 个人记忆与持续义务**：把四日runner真正接同一goalBridge与notes实现。去掉unheard-cancellation等隐藏终态提示；source/subjectIds/原observedAt要实际进入模型渲染，且未听见记录不泄漏。四类故事覆盖取消听见/未听见、改源待同意、旧失败解除、两承诺争资源；同token预算raw/conditional，保存原记录与依赖。每个故事跨天加干扰，并在有pending工作时退出恢复。先CPU证明两臂输入区别正好来自有权知道的历史，不能让规则把所有差异提前解决。

**C 真实长程训练**：别继续用“所有非wait都可接受”训练行动权衡。修case capture总取npc01、无medical候选、没开始工作却叫cancel-after-work等问题。实际运行策略采状态，保存model request与源episode；同快照候选分支+固定后续控制器产生可审核结果标签，允许多条合理路线，统计全可接受题和随机/规则基线。train/dev/test各有代表性但源episode完全隔离。只dev选头，test后选的random43标探索并用新episode确认。旧缓存与线上特征身份先资格对齐，必须传training-manifest/output-dir；不省校验。交4头真实训练权重/曲线/dev决策、留出结果、真实成本。正式admitted继续按原门，不因弱训练成功就开门。

**D 完整玩法**：保留八张原图，补真正步行救援、门/危机时序与原作任务地点/耗时/效果对账；5类新work不再只是报告里声称完成。与A共用工时契约，不在各领域另加时钟。网页可自由派工、协商、取消、自主执行和保存恢复；录一条包含危机+承诺改约+实际送达的真实模型故事，失败也保存。

**H 长程评测/harness**：默认npm test已补dist/src发现，tar内两份测试已原样入库，现822项819过/1skip/2fail；修语义不降低断言。先跑 `node scripts/r9/audit-work-lifecycle.cjs --strict`（当前7反例存在故exit1），修好应成为0。让所有decision与queued/working/最终applied/rejected/cancelled/unresolved对账，补JEV漏报15、reference漏报12的结算错误；忙碌skip不算模型失败。CPU参考可复跑，实模必须同入口。

负责人选B后：先冻结公共执行基线和数据，再old/new头×raw/conditional的2×2、至少两个全新留出seed（8局；单卡估计8–10卡时总预算，须按实测前向重估）。每局8NPC完整四日、四类承诺干扰，D2工作中save→退出→新进程恢复到结局。参考臂另CPU跑。所有臂世界/候选/事件脚本一致，记忆同token预算，模型自己选行动；不存在承诺输入则实验非零拒绝启动。

主指标：真实履约、授权退出/超时、取消后的新物理效果、未授权改约、同实例重复回执、无进展循环；辅指标：存活、资源覆盖时长、危机、工时、真实前向和GPU卡时。持续采集有真实进展是正控；重复抑制仅消融，不默认加入主策略。一般校准与整局风险保证分开写。

交付一次完整里程碑：当前DELIVERY.json绑定干净源码HEAD/tree、renderer/encoder/head/memory身份、actual command、环境、SHA、所有成功失败和未完成项；不要依靠过时REPORT拼状态。HEAD文件+原始小包可独立clone复跑，大缓存按SHA备份。可玩入口、整局恢复、新训练、同源对照同时交付；未合main。给Codex12行短报与唯一证据入口，接着接受独立复验。
