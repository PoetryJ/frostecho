# R9 C 线：on-policy 语料、真实编码与四头训练

## 语料
- 生成器 `scripts/r8/export-r9-corpus.mjs`：从真实 R8 运行时捕获 `frostecho.joint-encoding-request/1` envelope。
- 4 类对照反例族（各 12 个初态变体）：medical-zero-resource、resource-contention、cancel-after-work、wrong-location-gather → test。
- 2 族 train（verify-stock、food-shortage）、1 族 dev（fatigue）、1 族 train（promise-and-food-task，因与 food-shortage 可见文本相同而移入 train）。
- 96 例、55 个不同可见文本、0 跨分区重复；标签来源 `on-policy-failure`，独立人类审查 0，弱实验标记 researchTrainReady=false。

## 编码
- 真实 27B（Qwen3_5ForCausalLM, BF16, 未量化），单卡 GPU1 + CPU offload，batch=1。
- 96 例 / 98 次真实前向 / featureIdentityHash `39c1b378…`；单例约 8.4 秒，峰值约 19.4 GiB（logical cuda:0）。

## 训练
- 4 头 warm/random × seed17/43，dev setNLL 选模；仅 train 行进优化器；训练 2.2 秒。
- dev 在 epoch 0 即为 0 NLL，选中 `warm-17`，其权重 SHA 与旧 C 头完全相同（2a54971…），即**本轮没有更新权重**。
- random 头需要 5–7 个 epoch 才收敛到 dev 0。

## 同一 test（48 例，已冻结）
| head | top1∈acceptable | set NLL |
|---|---|---|
| 旧 C 头 | 0.9375 (45/48) | 0.3749 |
| warm-17（选中） | 0.9375 | 0.3749 |
| random-43 | 0.5000 | 1.8027 |

结论：**平局**，不是提升。旧头已解 93.75% 的这些弱标签状态，3 例仍错；语料难度不足以区分新旧头，也没有证明模型优于 reference。

## 未证明
- 未做 512/128 规模；未做两独立模型盲审；未做温度/阈值校准与证书。
- 未接整局：四日 JEV/记忆对照仍用上一轮的头与证据。
- 语料标签仍是“可执行/规则可接受”，不等于人类偏好真值。

## 独立盲审（本轮新增）

- 48 例 test 盲审包：只有观察/问题/候选/可见记忆/目标，匿名 id，keymap 私有；导出器自检泄漏（0 泄漏）。
- 两份独立模型审阅返回 48/48 条，校验通过（id、inputSha256 全部一致，无编造候选）。
- 一致 41 例、隔离 7 例（wrong-location 6、contention 1），平均 Jaccard 0.974。

### 用双审一致集（41 例）重算
| head | top1 | set NLL |
|---|---|---|
| 旧 C 头 | 0.9268 (38/41) | 0.4215 |
| warm-17（=旧头） | 0.9268 | 0.4215 |
| random-43（本轮新训） | **1.0000 (41/41)** | **0.0445** |

分场景：medical-zero 12/12、cancel-after-work 12/12、wrong-location 6/6 三者旧头已满分；差异全部来自 resource-contention——旧头 8/11，新头 11/11。

结论修正：在本轮语料上 warm 头不更新是平局，但 random-43 用同一批训练标签、在同一 test 一致集上把旧头的 3 个争资源错误全部改对。n=41，单头单种子，未校准，不能外推。
