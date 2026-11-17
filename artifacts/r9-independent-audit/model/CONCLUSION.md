R9 模型/数据独立核查（冻结 a669890，只读；没有新模型/GPU调用）
1. NumPy独立读取5份safetensors与真实feature缓存，LN+点积重算全部96题；旧头45/48、新random43 24/48；双审一致集38/41与41/41，NLL最大复算差1.80e-8。
2. warm17、warm43均与旧头字节相同。训练器仍完整运行40epoch；因初始dev float32 NLL=0且仅严格改善才换checkpoint，最终恢复epoch0；不是“早停”或“没有梯度”的证明。
3. 官方dev选头是warm17，整局实际用了看完test审阅结果后的random43；属于探索性部署选择，应另留新episode做确认，不把当前test当未触碰验证集。
4. 96案全截取npc_01，55个不同可见输入（train/dev/test唯一数18/5/32），无跨分区重复；有去重，但样本数不是独立有效信息量。
5. 四个失败族全在test；train36/dev12全部标签恰为所有非wait动作。其loss实质为-log(1-p_wait)，不给采食/采木/添柴/休息之间的任务收益排序。
6. “medical-zero”12/12无medical候选；health有时改在别的actor，capture仍取npc_01。取消族只propose/accept/cancel，没有beginWork；标签却排除所有gather。争资源12题仅4题有本人非空目标；其余任务给他人。
7. 所谓on-policy语料是手造初态、拦在scorer前的真实引擎输入，全部modelCalls=worldCommits=0，未提供从已训策略实际访问轨迹抽样的证据。
8. 41双审一致题有32题接受全部候选；均匀随机选候选期望命中率96.34%。新头对A/B完整48题均48/48，7题隔离没有制造其满分，但宽集合使满分几乎不测策略进步。
9. 48份A/B输出的id/hash与候选合法性可复核；只有JSONL不能独立确认两个模型会话的调用身份与隔离，需原始会话元信息。
10. 320请求→回复→trajectory的inputSHA/candidateSetHash/selectedId逐一相符，真实新头9af669…；stderr恢复的ready证明GPU1(层0–22)+CPU offload，峰值19561.997MiB。
11. 训练特征身份39c1…的metadata却录全部参数CPU，线上392cea…不同；线上trainingManifestSha256=null，没传manifest则已有训练/部署身份检查不执行。需先核身份/跨布局数值资格，不能默认缓存与线上同分布。
12. 四日runStep确实用conditional-experience/obligation-first，但没有goalBridge；320输入自身/关系promises均空，目标只有原作任务。它是生存生产局，不是送饭/供仓承诺的长程对照；四故事另为0模型CPU脚本。
13. 决策摘要“0拒绝”漏延迟结算：JEV workLog232=217applied+15rejected（添柴），reference276=264+12rejected（移动）；runtime.rejections空且advanceWorld丢弃completedWork结果。
14. JEV149次采食全部有gathered，产607食物；另4次采木产14。重复是有产出的持续生产与机会成本问题，不能直接等同无效循环。参考采食114、采木32。
15. 两臂8活/perfect/4920平局；JEV木柴0但炉内51.2且lit=true，参考木柴31/炉内61.2。无木柴库存不等于炉火已灭；应量缺口、承诺进度、资源覆盖时长，而非强求动作多样性。
16. 下一步优先单一权威义务/进度/时钟/结算反馈，再同状态对照新头与记忆；重复抑制只做消融对照，不能直接默认转正。512/128是现有工程门阈值，不能代替独立分组、代表性、校准假设或长程证据。
复跑：python independent_model_audit.py --repo <a669890源码> --features <features-v3c> --out <新JSON>（只依赖NumPy；不导入训练器/Torch）。
原始输出：independent-model-audit.json、train-online-identity.json；日志与脚本同目录。没有修改源码/历史证据、没有commit或push。
