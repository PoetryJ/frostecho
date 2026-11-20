# R10 H/E 独立证据核查

核查源码 `288a28859a4eb872345771d25618769e127e434b`。仅读取原始文件并运行CPU反序列化检查；没有GPU、模型调用、世界推进、浏览器启动或生产修改。H历史运行源码自报 `4479999 / tree24a8c57 / codex/r10-H`，E为 `054cab0 / treeacac9d3 / codex/r10-E`。本次加载检查不冒充这些历史进程的重跑。

结论：**实模前向、四日运行、进程恢复与只读展示适配有证据；完整2×2比较、跨D2活跃履约对照和实际3D产品未被证明。** 这属于实验设计/入口兼容缺口；四个未启动的old臂不能当成旧模型能力失败，也不能据此说新记忆胜出或失败。

## 1. 矩阵实际做了什么

- 设计为 old/new × raw/conditional × 两seed，共8实模局；实际old四局在preflight退出14，原因 `head_was_trained_on_another_renderer`。old `warm-17` SHA `2a549715…dd04`来自R9 `/1`，当前renderer为`joint-c-action/2`，没有模型前向。
- new四局确有945份原始request/result：260/233/226/226；逐一重算requestJson输入SHA、候选集绑定、trajectory选中ID，945/945一致。每份reply head为 `f3eb6a95…0e3a`，feature identity为 `4dae52c7…15d0`，未发现替换为规则回退。
- new四局的实际服务命令**全部不传 `--training-manifest`**；945份身份的trainingManifestSha256均null。H先独立读manifest，再以head SHA/feature identity/renderer绑定，原因明确写在preflight：服务生产入口只接受reference-imitation，而C产物为same-snapshot-branch-rollout。因此这些是带自定义H校验的真实实验，不等于正式服务入口验收通过。应修生产manifest兼容契约，不能继续删除参数来取得绿灯。
- 原始证据摘要见 `independent-matrix-evidence.json`。四实模已入库可用文件共2008份SHA一致，另缺945份features.npz，恰与每前向一次对应；缺项已明示为服务器缓存，不把哈希声明当作本地特征重算证明。

原始路径：`artifacts/r10/matrix/matrix-table.json`、`arms/{old-raw,old-conditional,new-raw,new-conditional}/{r10h-1,r10h-2}/preflight.json`、`scorer/**/{*.request.json,*.result.json,startup.json}`、`decisions-{start,resume}.jsonl`。

关键代码：`scripts/r10/run-matrix.mjs:209-286` preflight；`:1243-1268`省略manifest的服务构造；`:403-512`自定义LiveScorer；`:1431-1446`矩阵状态汇总。

## 2. 干扰的机会分母并不相同

- 每局初始4个active承诺，D2干扰实际在simTime1680（D2 04:00）执行。选择方式是从当时仍active的rows按index0/1取，不固定到原始四个任务实例。
- new-raw两seed干扰时仅剩1个active：执行取消，改源分支null。D2存档为3fulfilled+1cancelled。
- new-conditional两seed干扰时剩2个active：取消1个、另1个pending-change。D2存档为2fulfilled+1cancelled+1pending-change。
- reference四局D1已把4承诺全部完成；干扰时activeRows=0，取消和改源均未触发。因此该臂“0迟到/0越权”在这些指标上是**0-of-0**，不是已验证零风险。
- H矩阵没有注入“旧失败条件解除”或“两承诺争一份饭”的受控干扰；只存在D2取消/未同意改源脚本。独立CPU四故事不能替代这两个类型的真实在线暴露。
- 所以raw3/4与conditional2/4包含不同的撤销/待同意机会，不能直接当作记忆条件效应。应分别报告最终fulfilled/cancelled/pending-change/withdrawn及其机会数；未暴露写null。

原始路径：各局`d2-exit.json.interference`、`d2/session.json.commitments.json`、`final-state.json`；代码`run-matrix.mjs:699-721`从active rows取干扰。

## 3. 四日新进程恢复的证明边界

- start/resume PID均不同，确有新进程继续；四实模D2存档全在simTime2160，即**D2 12:00**。未完成intent分别为8/7/6/6，全部是rest，`commitmentBound=0`；不是每局8项，也没有跨边界的活跃承诺工作。
- 各局权威承诺都没有active状态：raw为3fulfilled+1cancelled，conditional为2fulfilled+1cancelled+1pending-change。干扰在存档前480分钟已执行，因此不能称作“新进程恢复后再接受取消/改约并长程完成”。
- 原H的resume检查只校验simTime、pending数和每个intent的id/status/dueAt（`:1132-1153`）。replay fingerprint包含资源/身体/简化任务承诺/intent/回执/workLog，但省略完整world facts、原图cell、记忆关系、完整task payload和投影claim（`:336-373`）。它证明选择投影的同动作重放，不证明连续实模整局与分段实模整局的完整权威等价。
- 本次新增CPU反证检查：4份D2存档经当前集成代码加载后，**world、session.memories（含关系/来源记录）、outcomes、plans、instances、generations、sequence、inputReceipts全部结构相等；task/commitment/council/experience也相等**。没有观察到这些资料丢失。
- H的`gameplayOn`没有直接读`.long-term-memory.json`，但按原始session records执行sync后，4041/3867/3799/3799个长期事件与原保存memory逐结构完全相同。因此**不能将其写成已证实长期记忆丢失**。同步前缓存为0只是构造方式不同；本轮640token模型选择另由runStep参数控制。
- 当前加载器为旧H意图回填demandId，并为duplicateDemands补默认[]，所以intents/work字节不是原样不变；这是可定位迁移，不是资料损坏。加载后注册bridge没有改变world或已提交receipt IDs。原始边界未保存goal view，不能声称已经独立比较存档前后的goal投影。

独立证据：`saved-authority-load.json`、`inspect_saved_authority.cjs`。历史H的PID与restoreraw见`resume-load.json`、`d2-exit.json`。原报告`H-R10.md`把8rest泛化到全部局、把本轮恢复扩大为履约恢复，应收窄措辞。

## 4. 结算失败与coverage的分母

- H四实模报告settlement failures为23/6/9/9，分母每局都为200个**保留在runtime.intents中的最近记录**。对应完整workLog却为241/220/213/213项；全量rejected为24/6/9/9，applied为214/211/202/202，cancelled为3/3/2/2。故全量至少48次拒绝，而非47；不能用保留窗口直接作整局失败率分母。
- 报告保留窗口中的47次失败原因：raw1=14 commitment_cancelled +9 insufficient_firewood；raw2=6 insufficient_firewood；两个conditional各9 insufficient_firewood。额外一条早期pruned拒绝的精确原因不能从最终简化workLog恢复，不编造归因。
- 其中授权撤销后的rejected是权威正确拒绝，也属于未完成工作；应同时记安全拒绝与无效尝试，不能只因“没有物理效果”便忽略。一般资源失败、越权拦截、取消、未结算分别报告。
- 表中coverage h=0来自`min(food/7.2,firewood/1,power/2)`，四局最终木柴、电力均0，参考也如此。原始food coverage仍为16.25/16.3889/16.5278/16.5278小时，参考15小时。这个硬编码最终资源代理没有区分原因，也不随剩余人口更新，不能单独代表整个四日经济质量。应保留向量并加缺口持续时间/炉灭时段，而不是把0解释成没有进展。

代码：`run-matrix.mjs:742`只读保留intents；`:828-838`失败/工时计算；`:918-928`资源coverage；`:1348-1353`最小值。原始`metrics.json`与`final-state.json.fingerprint.workLog`可复算。

## 5. GPU预算：只继承原余额

H四局start+resume服务wall为9325.6秒，即单GPU配置下约**2.59044服务卡时**。这是进程从启动到close的墙钟，包含加载，不能当作GPU利用率或云计费；没有nvidia-smi逐时账本证明精确活跃卡时。`phase-{start,resume}.json.scorer`可逐局相加，replay不算模型结果。

C-R10.md另报告GPU编码27.9分钟（约0.465卡时），由C审计核对。若其成立，已知R10总量至少约**3.05544卡时**，10卡时原上限的理论余额至多约6.94456，仍需扣其他GPU探针、失败/重启和未归账任务。all-CPU无GPU卡时但有CPU/墙钟代价。不能因开启下一轮就再次给满10卡时；先合账，后按余额冻结上限。

## 6. E展示适配：有效，但尚非3D产品验收

- 9个tick原始2D.gz和3D JSON的session、simTime、资源、炉、8NPC map/cell逐项独立复算一致。14个vendor文件与VENDORED.json声明SHA全部一致。这证明同一权威快照的只读投影和静态资源，方向正确。
- 报告明确`browser.available=false`，没有浏览器二进制、录像、截图、真实GPU帧/帧率、WebGPU设备初始化或用户点击证据；不能把HTTP端点返回称为实际渲染通过。室内只投影到门口，不代表7室内3D空间已完成。
- E观察到after_batch_step后`advance15`响应from480/to495，实际observe605；无pending时observe495。投影一致会忠实复现这个上游时钟问题，不会因此替玩法正确性背书，交给A独立复现。

原始路径：`artifacts/r10-e/parity/2026-11-18T08-29-51-291Z/{report.json,ticks/*}`；`public/r7/visual/VENDORED.json`。适配代码`src/r7/visual/adapter.ts:68-98`；HTTP投影对照`scene-parity.ts:150-225`。

## 下一轮一次有效矩阵的验收条件

1. 先统一可运行身份：在生产serve入口支持真实R10 manifest schema/labelSource，保留head/renderer/encoder/qualification绑定及unadmitted语义；先做CPU契约与一次实模smoke，四臂全部通过再批量。旧`/1`头拒绝留作完整性负控，不计能力结果；可选同`/2`、同编码身份的base/discharge两有效头来回答训练目标效应。
2. 固定4臂×2seed与每局同原始起点、候选/规则/预算；预先锁定任务实例和D2边界。四类机会要有真实存在的可观察前提及计数，不能只“尝试触发”后用0替代未暴露。
3. D2至少一份**active承诺绑定的pending intent**，在新进程恢复后才注入听见/未听见取消或未同意改源；另保留一个active承诺可后续真实履约。条件解除/争资源各有固定机会。没有这些前提的局标inconclusive，不用强制模型选择制造成功。
4. 原进程离开前、恢复后首次动作前均落完整authority snapshot：world/原图位置、domain states、generations/input receipts、intent/projection/receipt IDs、task/commitment/revision关联、每个NPC记忆关系与goal view；明确批准的纯迁移单列。另用同动作CPU重放比较连续vs分段全权威，replay不计模型能力。
5. 指标使用全量不可裁剪账本；fulfilled以仍有效的可履行机会为分母，cancelled/pending-change/withdrawn单列。安全零违规必须有有效机会；无机会null。保留资源向量、缺口与炉灭持续时间、结算失败分类、模型请求数和真实成本。
6. 继承10卡时的**剩余余额**，把C/H/探针合到一个账本再冻结四臂预算；达到余额上限保存部分结果，不能续满或静默换CPU/规则。对照与成本齐备后交负责人决定是否转正。

复跑本次只读审计：`python audit/matrix/audit_matrix.py`；构建后 `node audit/matrix/inspect_saved_authority.cjs`（二者路径相对review根；脚本内部定位source）。不会启动模型或浏览器。
