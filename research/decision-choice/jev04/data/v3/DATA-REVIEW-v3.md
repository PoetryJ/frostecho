# DATA REVIEW v3（R3 数据线交付）

日期：2026-11-12 · 基线：`394d2be`（codex/sprint-1116）· 目录：`data/v3/`

## v2 遗留缺陷与本版处理

| v2 缺陷 | v3 处理 | 证据 |
| --- | --- | --- |
| 候选按 acceptable 排前面（首位置泄漏 64/64） | 生成器不读 acceptableSet；预登记种子抽样+洗牌；不透明ID c0..c3 洗牌后赋号 | 首位置 10/34 vs 机会率 0.346（二项 p=0.59）；末位置 p=0.72；`validate_v3.py` 校验 3 |
| 39 条 challenge 记录（25 题）未隔离 | 生成入口即排除，manifest/切分复核 | `validate_v3.py` 校验 1（交集为空） |
| v2 改过标签/叙述的题未重新审查 | 39 题全部两份新盲审（含 gQ07-A/B） | `review-s1/s2-20261112.jsonl`，逐题 contentHash 绑定 |
| 无 eligible manifest | caseId+contentHash+reviewVersion 三元绑定 | `eligible-manifest.json` |

## 数字（诚实口径）

- 输入 64 题（只读 v2），入口隔离 25 题 challenge（39 条记录）。
- 生成 39；可答 34；合格 33；`no-acceptable-in-sample` 5（不回采样，回采样会把 gold 耦合回生成）。
- 新隔离 1：`v2-gQ07-A`（标签规范内部不一致，两会话与 sealed 不相交）。
- 合格小切分：train 23 / dev 10，按 sourceGroup 不相交。
- 骨架仍是 4 个（v1 家族结构未变，如实报告）；未扩 4096，未动旧 gold/账本。
- 无独立 calibration/select/cert 切分（R3 范围外，报告为缺口）。

## 复算

```bash
cd research/decision-choice/jev04/data/v3
python3 generate_v3.py && python3 review_s2.py && python3 review_s1.py \
  && python3 build_v3.py && python3 validate_v3.py   # exit 0
```

校验器会从剥离 gold 的输入重生成并逐字节比对（校验 3），任何失败给出具体
caseId 列表并以非零码退出。操作者身份与过程独立边界见 `REVIEW-NOTES-v3.md`。
