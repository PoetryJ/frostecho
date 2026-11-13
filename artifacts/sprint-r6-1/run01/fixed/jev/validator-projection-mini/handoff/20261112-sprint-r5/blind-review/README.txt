39题独立语义审查交接（2026-11-12）

来源：db34123423a06cc5118fb92e1c3cfb9f0c03fceb 的 data/v3/cases.v3.jsonl，39例、26 sourceGroup。
packet.jsonl仅保留task/K/narrative/facts/完整候选文字与params，以及caseId/sourceGroup。未提供sealed标签、旧review、生成oracle或其他审查者答案。
canonical-inputs.jsonl保留精确serializedInput；contentHash=SHA256(该UTF-8字符串)，完整覆盖visibleInput，输入与审查39条均独立核hash通过。它是本次审查hash协议，不等于旧v3/v4的hash协议，导入时不得静默混用。

审查会话
A /root/r4_blind_review_a；B /root/r4_blind_review_b；均fork_turns=none创建，不继承主会话。仅给packet路径和下述审查约定，不给旧gold或代码。两者独立先读后写，输出为各自review-a/b.jsonl；非人类双标，也不声称不同底模。
提示限制只读packet，不是OS文件沙箱证明。两审查者自述遵守限制；原始逐题理由保留，不由root改写标签。

审查约定
逐题理解，不能写规则程序批量生成答案。可接受集合允许多个候选；缺关键事实标ambiguous，叙述/事实冲突标inconsistent。候选中的错误选项正常，不因此把整题判矛盾。
意图文字判断与world params执行能力分开；wait不能证明已经澄清、核实或拒绝，但意图合理可以列为可接受并注明执行占位。两会话都收到同样口径补充，没有针对具体case提示答案。
输出caseId/contentHash/reviewVersion/reviewer/acceptableCandidateIds/status/reason/missingInformation。

结果（不是eligible数量）
A supported8/ambiguous21/inconsistent10；B supported10/ambiguous19/inconsistent10。
39/39各覆盖，candidate ID与hash校验错误0；35/39可接受集合一致，4例集合不同；21/39状态分类一致，18例状态不同；10例共同标inconsistent。
没有“双方supported且集合相同”的样本，这主要包含状态口径差异，不能据此宣布39题全错：例如同一缺收话人题，A认为“澄清意图有充分依据”所以supported，B认为“题中身份信息不足”所以ambiguous，但两者均选同一澄清候选。
因此needsAdjudication=39是保守工作队列，不是39条错误统计。SUMMARY的统计不作真值，人工/独立裁决者应先统一“状态评的是题目可判定性还是候选意图可接受性”。不得改写原始输出来制造一致。

优先裁决事项
1. 10条共同标记的问题：9条foodStock与stockPortions不同且未说明口径，1条叙述存在取消表态但retractionExists=false。先定义字段语义；若其实两个不同库存/有效取消与原话不同，补明含义后再审，不直接凭多数当错误。
2. reference_resolution的行动主体、承诺的承诺人/受益者/内容，以及“你先吃”是否改变承诺都要显式，不能让审查者自行补条件。
3. 文本“澄清/核实/明确拒绝”与params wait暂时是语义占位；作为语义训练样本须明确层次，作为执行候选则需真实命令实现。
4. 4条acceptable-set分歧和18条状态差异逐例处理；保留可接受集合，不强行压成单标签。

下一步
H提供逐case裁决/缺条件清单，D修订内容就生成新hash并重审；旧审查只认证旧文本。先完成39题质量门，随后才按原协议扩量。正式训练仍false，不能把35个集合一致当合格样本，也不能把两次模型会话等同人类或跨模型验证。
