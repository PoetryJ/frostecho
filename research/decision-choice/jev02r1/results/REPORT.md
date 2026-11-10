# JEV-02R1 选择性拒答返工报告（2026-11-10）

**结论：两条冻结策略均未通过预注册门槛，`policy.valid=false`，本轮不提供可用的选择性决策。**
机制、接线、计量与数据都已修好并有行为证据；失分点在模型本身与标签类别难度，不在参数搜索。

- 工作树 `/data3/DATA/project/project_meishijiang/FrostEcho-jev02-r1`，分支 `codex/jev02-r1-selective`，基线 `e12ac4c`。
- 未重训任何头；复用 M1-seed17（`candidate.safetensors` sha `d53d9b36…634e`，张量 sha `5cda925f…172b`）；
  主干 `Qwen3_8/Qwen3_5` 27B、tokenizer、候选描述与渲染器全部沿用冻结版本（身份哈希在 policy 内）。
- 未 push/merge，未改生产默认，未调用 18872，未重启共享服务。

## 1. 已修好的验收缺口（带行为证据）

| 缺口（ACCEPTANCE） | 本轮做法 | 证据 |
| --- | --- | --- |
| 预测阶段先读了 `test.gold.json` 再写 `goldRead:false` | 删除该读取；预测进程全程 `GoldSeal`，对 gold 的 open/read_text/os.open 全部拦截并计数 | `predict_batch.py` 在封存态做**正向对照**：主动开 gold 得到 `blocked:GoldBlocked`，`evidence/extract-seal.json` 记 1 次被拒 |
| CLI 用默认 T=1/threshold=0，与评测不一致 | 唯一 `policy.json`；CLI 与评测共用 `policy.load_policy()+decide()`；无 `--temperature/--threshold` 参数 | `evidence/cli-s1.json`/`cli-s2.json` 里的 T 与 policy 一致；`--temperature 0.5` → 参数错误 exit 2，0 计费 |
| 无效/冲突配置不拒绝 | schema/键集/方法/支持序/gating/T 有限正/tau 边界/head 字节与张量/主干/tokenizer/prompt/cal 指纹全部校验，**载模前**失败 | 篡改 T=0 的 policy 被拒（`policy_rejected`），`evidence/jobs.jsonl` 行数不变 |
| 生成额度按展示 kind 记，JSON 延迟可绕开上限 | ledger 改为按 `operation` 计（generate/forward），窗口从首次预留起算，失败不退款 | `tests/test_r1.py::LedgerTest`（`generation_jobs=0` 时 JSON 任务在计算前被拒；`decode` 次数按真实解码调用计） |
| 温度/策略按行奇偶拆、族重叠 | cal-temperature 与 cal-policy 用**互不相交的 16+16 个来源族**，文件级硬门控 | `data/families.json`，`datagate.py` 0 重叠 |
| 只报 order0 | 全部指标按 4 序（S1）/2 对（S2）分别给分母，另给等权均值 | 见 §4、§5 |
| 未来训练 dev 选模只看原序 | 新增 `devselect.py`（按 base 与四序等权、缺失格拒绝），fixture 证明与原序规则选到不同 epoch | `tests/test_r1.py::DevSelectTest`（order0 选 epoch1，均衡选 epoch2） |
| 标签用同作者正则脚本冒充独立复核 | 4 个独立会话盲标（只给合同+无标签输入） | `data/blind/labels-1..4.jsonl`，一致 507/512 |

## 2. 数据（详见 `data/card.md`）

- 512 条：cal-temperature 128 / cal-policy 128 / test 256；来源族 16/16/32，**互不重叠**（64 族）。
- 玩家原文去重率 **100% / 100% / 100%**；完全重复 0；同 split 近重复 0；
  跨 split 0.75–0.9 共 2 对，已复核并记录（同一省略式邀请换场景复现）。
- 类分布接近均衡（test 64/65/65/62）。标签、族名、caseId 均不进入 prompt（泄漏检查 0 命中）。
- 合成对话，不是真人数据；单作者 + 同源盲标，属弱监督。

## 3. 温度与阈值（只在 cal 上做，解封前冻结）

温度：cal-temperature 等权拟合 **T=2.0186**（NLL 0.6494→0.5149）。在 cal-policy 上 Tfit 的 NLL 0.6667→0.5133、
Brier 0.2925→0.2727，两者都不劣 → 采用 Tfit（`results/calibration.json`）。**温度改善概率质量，不改变 argmax，也不改变排序错误。**

cal-policy 上的门槛结果（固定网格，逐支持序/对全过才有效）：

| 策略@T | 最好 pooled 点 | 覆盖面 | 失败原因（决定性项） |
| --- | --- | --- | --- |
| S1@T1 | tau=0.99，risk 4.71% | 49.8% | order2 risk 16.95%；order1 的 NC 仅接受 3 个 base |
| S1@Tfit | tau=0.90，risk 4.26% | 45.9% | order2 risk 14.81%；order1 的 NC 仅 3 个 base |
| S2@T1 | tau=0.50，risk 3.98% | 68.8% | pair2 risk 6.49% |
| S2@Tfit | tau=0.50，risk 2.53% | 61.7% | pair2 risk 5.48%；tau=0.6 时 pair2 的 NC 只接受 4 个 base |

即：S1 无论 T 如何都在 order2 崩（最低也有 12.2% 风险，见 `candidate-tables.json`）；
S2 把风险压到 2.5–5.5%，但要么差一点点超过 5%，要么在更高 tau 上 NC 的接受基数不足 5。
按合同不放松条件、不看 test 调阈值，因此两份 policy 均 `valid=false`、`tau=null`、`decisionMode=unavailable`。

## 4. 新 test（只解封一次）

预测字节在解封前哈希固定（`results/unseal-record.json`），gold 自校验后由独立进程读取；
`results/unseal-attempt-1/2.json` 记录两次计分过程，第 2 次仅修“完整性比对拿逐序 argmax 去比决策”的代码缺陷，
**预测字节未变（哈希先校验）**，未重选任何参数。

未加门控的分类器（描述性，不是验收结论）：

| 臂 | 四序合计 | order0 | order1 | order2 | order3 | 族 bootstrap 95% |
| --- | --- | --- | --- | --- | --- | --- |
| 冻结 M1 头 | 802/1024 = **78.3%** | 88.7% | 79.3% | **58.2%** | 87.1% | [75.7, 81.0] |
| Qwen JSON 直出 | 870/1024 = **85.0%** | 81.3% | 94.1% | 83.6% | 80.9% | [83.0, 87.0] |

按类（M1 / JSON）：PF 84.4/80.5，NF 81.9/96.2，NO 93.8/97.7，NC **52.0**/64.5（召回%）。
按族（M1）：32 族中位 78.1%，最差 `test-13-表哥婚宴` 62.5%，最好 96.9%（逐族见 `results/report-stats.json`）。

**关键发现：冻结头不是排列稳健的。** order0（原序）上它 88.7%，好于 JSON 的 81.3%；换到 order2 只剩 58.2%，
把四序均值拉到 78.3%，低于 JSON 的 85.0%。上一轮“M1 优于 JSON 87 项”的结论只成立于单一序列，
本轮按合同报四序后优势消失。`NEEDS_CLARIFICATION` 是共同短板（两臂都<65%）。

S2 共识机制（描述性）：两个反向序 argmax 一致的 pair 占 **70.5%**（361/512），
一致时准确 **91.4%**；不一致 29.5% 直接拒答。这就是 S2 风险低但覆盖面被封顶的机制原因。

## 5. 成本（真实调用边界）

- 预留 **3146** 个模型任务（上限 3300）：feature/forward 2120、generate 1026。
  其中 1 个为首次加载环境不匹配时留下的一次未完成兼容前向，**照常计费不退款**；失败 0。
- prefill 调用 3145、decode 调用 **7182**（按增量解码次数，不用输出 token 数替代）；输入 377,543 token、输出 7,182 token；
  模型内耗时 1637 s。GPU 窗口（首次预留起算）2419 s；含 5 次串行加载的整段 GPU 墙钟约 48 min，上限 4 h。
  单实例 27B 四卡分片、每卡 24 GiB 上限，未触碰共享服务的 187–18.8 GB 占用。
- 在线决策（32 次真实前向，`results/latency.json`，标注 `mechanismCostOnly=true`，因为本轮没有可接受的决策路径）：
  **S1 中位 215 ms/次（1 次前向）；S2 中位 438 ms/次（2 次前向）**，最慢单次 883 ms（首次预热）。

## 6. 风险、覆盖率与“全拒答不算通过”

- 发布态：coverage 0、risk null、decision=`unavailable` —— 这是**明确不可用**，不是高置信。
- 全网格曲线（`results/final.json.arms`，解封前登记的诊断）：
  S1@Tfit 在 tau=0.995 时 risk 0 但只接受 4.3% 的 base（<50）；S2@Tfit 在 tau=0.9 时 risk 0、覆盖 15.2%。
  这些点**不得**替换线上参数：它们是在 test 上事后读出的，合同已预先声明只能作诊断。
- 报告不把“某序能过”当作通过：所有门槛逐序/逐对判定，任一序不过即整体无效。

## 7. 局限（未证明项）

1. 合成数据、单作者 + 同源盲标；标签正确性只有弱证据（99% 一致是同源相关，不是人工复核）。
2. 未证明对真实玩家文本的泛化；64 个“族”是写作场景，不是采集来源。
3. 未做重训：头在本轮数据上的缺陷（order2、NC 类）只能用新头/新数据解决，不在本轮范围。
4. 结论是“这套冻结策略不可用”，**不是**“所有阈值都不可能”；诊断曲线里存在更低风险/覆盖的操作点，
   但按合同不能事后采用。
5. 环境需要 transformers>=5.22 才能加载 `qwen3_5`；本轮用隔离目录 `…/.r1deps` 前置 PYTHONPATH，未改共享 env。

## 8. 复现

```bash
cd research/decision-choice/jev02r1
python3 datagate.py                 # 数据门控（应 passes=true）
python3 adjudicate_r1.py            # 重建 gold（一致率与分歧）
python3 -m unittest tests.test_r1   # 28 项 CPU 测试
# 以下需要 4 张 H20 与隔离环境
PYTHONPATH=/data3/DATA/project/project_meishijiang/.r1deps python3 extract.py --tag a2
python3 cal_scores.py && python3 fit.py
python3 predict_batch.py            # 封存预测 + 正向阻断对照
PYTHONPATH=… python3 latency.py --cases 32
python3 unseal.py --attempt 1       # 只允许一次；重复必须给 --reason
python3 report_stats.py && python3 verify.py   # 只读重算，应 passes=true
```
