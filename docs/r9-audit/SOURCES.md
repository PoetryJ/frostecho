# 跨领域核实与适用边界

以下为本轮实际检索、阅读的原始论文/官方实现。类比用于设计实验，不是这些方法在FrostEcho上已经有效的证据。

1. **离散事件仿真与资源仲裁**：[SimPy时间调度](https://simpy.readthedocs.io/en/latest/topical_guides/time_and_scheduling.html)、[共享资源](https://simpy.readthedocs.io/en/latest/topical_guides/resources.html)。仿真进程可逻辑并行，事件仍按时间与稳定顺序处理；占用/排队/中断/释放需要显式建模。对应R9多NPC工时、精确due和争最后资源。借用事件队列语义，当前无需引入Python仿真框架或重写TS世界。
2. **持久工作流与事件溯源**：[Temporal Workflow](https://docs.temporal.io/workflows)。命令、事件与完成结果进入持久历史，恢复利用既有结果而不重新做副作用。对应R9保存WorkItem但丢settleHooks、物理回执与义务投影分离。借鉴可恢复执行描述和幂等投影，不安装Temporal集群，避免为单机游戏引入服务运维。
3. **BDI意图保持与重考虑**：[Rao与Georgeff，1995](https://cdn.aaai.org/ICMAS/1995/ICMAS95-042.pdf)。信念、目标、已承诺的行动意图区分；每步重新规划太贵，一直执行旧计划又会失效。对应跨天义务与条件变化；以相关证据变化触发重考虑，保留有效持续生产，不为动作多样性频繁切工种。
4. **真值/理由维护**：[Doyle原始论文](https://www.sciencedirect.com/science/article/pii/0004370279900080)、[MIT原始技术报告](https://dspace.mit.edu/entities/publication/c76b7ef0-47a3-4afc-b12b-6c8a0c90898a)。为推断保存理由，前提撤销时更新依赖结论。对应“曾缺货所以不再去”的经验失效，来源和当事人的已知信息不可丢失。该机制维护推断有效性，不替代世界真相，也不授权传播私有事实。
5. **层级记忆与离线整理**：[Anthropic Components of agent memory，2026-11-06](https://www.anthropic.com/research/components-of-agent-memory)。原始日志、笔记、组织表示和注入上下文分层；整理需要回查原始记录，注入层保持精简。报告也展示记忆组织并非越多越好。对应持久义务索引+个人观察+条件经验；不应先做大wiki或把所有失败永久升级成禁令。
6. **模仿学习分布偏移**：[DAgger，Ross等，2011](https://proceedings.mlr.press/v15/ross11a.html)。序列行动改变后续状态，训练分布与策略实际访问分布不同。对应真实采食偏好之后的冷门状态；需采真实策略访问和纠错数据。把手造状态捕获叫on-policy并不满足这个目的，DAgger本身也不能保证有缺陷专家/标签正确。
7. **时间扩展行动**：[Sutton、Precup、Singh，1999](https://www.sciencedirect.com/science/article/pii/S0004370299000521)。Options把多步闭环行动建模为有起始条件、内部策略和终止条件的时间扩展行动。对应送饭这种多步承诺和不同动作耗时，可为长程数据记录完整回报/期限。当前先完善执行契约，不必立即上完整层级RL。
8. **合法动作屏蔽**：[Huang与Ontañón原文](https://arxiv.org/abs/2006.14171)。研究state-dependent invalid action masking。可借鉴公开可知的硬约束过滤；不能把隐藏库存、未听见取消或“重复次数”当作非法动作条件，也不能把policy-gradient理论直接当本项目线性头的收益保证。
9. **持续委托系统**：[SuperAgent领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[执行与恢复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)。长期工作单元、授权范围、一次执行分配与报告各有生命周期，工作状态不应跟某个执行会话一起消失。对应同承诺跨重启与替代NPC，借用职责分离即可，不能照搬一套Ticket系统再与现有TaskBoard竞争权威。
10. **评测与校准**：[Anthropic agent evals](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)、[Guo等2017温度校准](https://proceedings.mlr.press/v70/guo17a.html)、[Conformal Risk Control](https://arxiv.org/abs/2208.02814)。需要看真实最终状态与轨迹、识别任务/评分器偏差；温度缩放改善概率解释但不改变argmax；风险控制有损失与数据假设。对应本轮宽acceptable-set、遗漏结算错误和小样本证书。512/128不是一般智能或整局风险保证。

本项目可检验的创新假设：**将有来源和失效条件的个人记忆，与持久义务的修订/授权及已提交行动结果绑定，提升跨天、干扰和重启后的履约与合理退出。** 各组件有成熟前例；组合是否有研究贡献，要靠固定世界/候选下的2×2消融、新episode和成本数据说明，不能把采用BDI或记忆分层本身称新算法。
