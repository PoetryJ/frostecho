# v3 审查记录（REVIEW NOTES）

范围：`research/decision-choice/jev04/data/v3/` 下 39 道 v3 渲染题的两份新盲审。

## 会话标识

- `s1-20261112`：过程 `rule-table@rev1`，依据 v1 anchors oracle 推导文本蒸馏的规则表，只读 facts 表。
- `s2-20261112`：过程 `narrative-only@rev1`，只读叙述文本与候选文本，不读 facts 表。
- 每条记录含逐题原文（`cases.v3.jsonl` 的 contentHash 绑定）、建议标签（动作与不透明ID）、理由、置信度。

## 诚实声明（操作者身份）

两个会话均由同一个操作者（本 sprint 执行代理）编写并在独立进程中先后运行；
s2 先运行且不读 s1 输出，s1 不读 s2 输出，两者均不读 sealed 标签文件。所谓
"独立"仅是过程独立（预先登记的两套规则、分开运行），不是人类独立审查。若
下游需要人类双盲，须另行安排并重跑本文件全部字段。

## 分歧与裁决

- 初版审查脚本有两处实现错误（动作文本映射表用词不一致；s2 撤销权限解析
  反转），修复后重跑；错误与修复过程保留在 git 历史中，不在数据文件内静默。
- 最终分歧 1 例：`v2-gQ07-A`。v2 的 ORACLE_FIX 把该题标签从 `leave_food`
  改为 `decline/eat_self`，但同构事实组合 `gQ03-A` 在 v2 未改，规范内部不
  一致；两个会话按叙述均提出 `leave_food`，与 sealed 不相交 → 按
  `s1-disjoint-from-sealed` 隔离为 challenge-v3，H 裁决记录于
  `adjudication-v3.jsonl`。该题不进入 train/dev。
- `v2-gQ07-B`（v2 修订题）两会话与 sealed 一致（`ask_clarify`），合格。

## 可复核命令

```bash
cd research/decision-choice/jev04/data/v3
python3 generate_v3.py && python3 review_s2.py && python3 review_s1.py \
  && python3 build_v3.py && python3 validate_v3.py
```
