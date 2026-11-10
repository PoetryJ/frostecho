# JEV-03R1 CPU 收口（≤4h，只读派生，不改旧证据）

## 1. 五条硬 gold 更正

`corrections/gold-corrections.json`，每条带原 context/playerText 与 evidenceSha256：

| case | pair | 旧 | 新 | 规则 |
| --- | --- | --- | --- | --- |
| b-0186 | pF4-13 A | NPC_FIRST | PLAYER_FIRST | 约定承载者=陪客的对面，承载者后吃 |
| b-0149 | pF4-13 B | PLAYER_FIRST | NPC_FIRST | 约定承载者=路过帮忙的玩家，承载者后吃 |
| b-0056 | pF4-14 A | NPC_FIRST | PLAYER_FIRST | 没活的人先吃；玩家闲着 |
| b-0155 | pF4-14 B | PLAYER_FIRST | NPC_FIRST | 有活的人先吃；对面有活 |
| b-0006 | pI1-14 B | NEEDS_CLARIFICATION | NPC_FIRST | 值班室收话人唯一，让 NPC 先吃 |

只做敏感性复算：JSON 臂 470 → **476/768**，与 01-OWNER-REPORT 一致；旧 gold/预测/账本未改。

## 2. 双口径 pair 指标（不再混叫）

`recompute.py` 同时输出：
- `perOrderBothCorrect`：固定某一呈现顺序下，一对两例都对；
- `fourOrderStress`：四序共 8 行全对。

| 臂 | 准确率 | 每序两例全对 | 四序 stress |
| --- | --- | --- | --- |
| M0 | 47.40% | 6/6/2/5 | 0/64 |
| C | 53.65% | 17/5/6/7 | 0/64 |
| Q | 59.64% | 6/5/6/7 | 4/64 |
| JSON | 61.20% | 12/13/16/16 | 9/64 |

结论仍不达标，且 C 的单序最好值不是稳定上下文利用。

## 3. 16 条缺标

`corrections/missing-blind-16.jsonl`：逐 ID 规则+理由+evidence hash，全部与冻结 gold 一致。
**provenance 明示为单会话合同派生，不算独立双标**；仍需第二会话复核。

## 4. 成本接线

`runtime/cost.py` 消费并校验 `payload.measuredCost`；对 1552 份真实 evidence 复算：
1552/1552 measured，tokensIn 194940 / tokensOut 5432 / decode 5432 / prefill 1552，
与派生表完全一致；旧账本 unknown=1552 保留不动。

## 复跑

```bash
cd research/decision-choice/jev04/cpu-closeout
python3 make_corrections.py && python3 make_blind_16.py && python3 recompute.py
cd ../../..            # repo root
python3 research/decision-choice/jev04/runtime/verify_evidence_cost.py
python3 -m unittest discover -s research/decision-choice/jev04/tests -p "test_*.py"
```
