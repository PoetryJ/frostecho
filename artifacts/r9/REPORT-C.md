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
