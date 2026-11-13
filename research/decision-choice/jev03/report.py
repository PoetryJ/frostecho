#!/usr/bin/env python3
"""Render results/REPORT.md from the sealed artefacts. Read-only on the results."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import j3config as R  # noqa: E402
from r1ledger import Ledger  # noqa: E402


def pct(value) -> str:
    return "n/a" if value is None else f"{100 * value:.2f}%"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(R.RESULTS / "REPORT.md"))
    args = parser.parse_args(argv)
    final = R.read_json(R.RESULTS / "final.json")
    seal = R.read_json(R.RESULTS / "selection-seal.json")
    trainings = R.read_json(R.RUNS / "trainings.json")["runs"]
    record = R.read_json(R.RESULTS / "unseal-record.json")
    ledger = Ledger(R.EVIDENCE / "jobs.jsonl").summary()
    extract = sorted(R.EVIDENCE.glob("extract-*.json"))
    extract_reports = [R.read_json(path) for path in extract]

    lines = []
    add = lines.append
    add("# JEV-03 读出位置对照：新 checkpoint 与新留出集（2026-11-10）")
    add("")
    add(f"- 分支 `codex/jev03-readout-training`，基线 `ab56847`；未 push/merge，未改默认，未调用 18872。")
    add(f"- test 共 {final['test']['cases']} 例 / {final['test']['presentations']} 次呈现；"
        f"计分 {final['test']['scored']} 例，challenge {final['test']['challenge']} 例不计分。")
    add(f"- 三臂同一 27B 冻结主干、同一 renderer/候选描述、同一批特征缓存；未训练任何主干参数。")
    add("")

    add("## 1. 主结果（test，四序分别计分母）")
    add("")
    add("| 臂 | 参数量 | 四序准确率 | 最差序 | macro-F1 | NC 召回 | 四序一致率 | NLL | Brier |")
    add("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for arm in R.ARMS:
        block = final["arms"][arm]
        cal = block.get("calibration", {})
        add(f"| {arm} | {seal['selected'].get(arm, {}).get('params', seal['M0']['params'])} | "
            f"{pct(block['accuracy'])} ({block['correct']}/{block['n']}) | {pct(block['worstOrder'])} | "
            f"{block['macroF1']:.4f} | {pct(block['perClass']['NEEDS_CLARIFICATION']['recall'])} | "
            f"{pct(block['consistency']['rate'])} | {cal.get('nll', 'n/a')} | {cal.get('brier', 'n/a')} |")
    js = final["json"]
    add(f"| JSON | n/a | {pct(js['accuracy'])} ({js['correct']}/{js['n']}) | {pct(js['worstOrder'])} | "
        f"{js['macroF1']:.4f} | {pct(js['perClass']['NEEDS_CLARIFICATION']['recall'])} | "
        f"{pct(js['consistency']['rate'])} | n/a | n/a |")
    add("")
    add(f"JSON 解析率 {pct(js['parseRate'])}（{js['generations']} 次生成）；四序呈现不是四个独立玩家样本。")
    add("")

    add("## 2. 逐序与逐类")
    add("")
    add("| 臂 | order0 | order1 | order2 | order3 | PF | NF | NO | NC |")
    add("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for arm in R.ARMS + ("JSON",):
        block = final["arms"][arm] if arm in final["arms"] else final["json"]
        order = [pct(block["perOrder"][str(index)]["accuracy"]) for index in range(4)]
        classes = [pct(block["perClass"][cls]["recall"]) for cls in R.CLASSES]
        add(f"| {arm} | " + " | ".join(order + classes) + " |")
    add("")
    add("族 bootstrap（按 32 个来源组重采样，95% 区间）：")
    for arm in R.ARMS + ("JSON",):
        block = final["arms"][arm] if arm in final["arms"] else final["json"]
        boot = block["bootstrap"]
        add(f"- {arm}: [{pct(boot['lo'])}, {pct(boot['hi'])}]，{boot['groups']} 组")
    add("")

    add("## 3. 选定与封存")
    add("")
    add(f"规则：{seal['rule']}。")
    for arm in ("C", "Q"):
        chosen = seal["selected"][arm]
        add(f"- {arm}: seed {chosen['seed']}，epoch {chosen['bestEpoch']}，dev 四序 NLL "
            f"{chosen['devNll']:.6f}，tensor sha `{chosen['tensorSha256'][:16]}`")
    add(f"- M0: 冻结 JEV-02 M1，tensor sha `{seal['M0']['tensorSha256'][:16]}`，"
        f"{seal['M0']['params']} 参数")
    add("")
    add("六次训练（同一目标与调度，仅 seed 不同）：")
    add("")
    add("| 臂 | seed | 最优 epoch | dev NLL |")
    add("| --- | --- | --- | --- |")
    for run in sorted(trainings, key=lambda item: (item["arm"], item["seed"])):
        add(f"| {run['arm']} | {run['seed']} | {run['bestEpoch']} | {run['devNll']:.6f} |")
    add("")

    add("## 4. 配对比较与一致性")
    add("")
    for key, value in final["paired"].items():
        add(f"- {key}: 0/4 全错但对照全对 {value['casesAllWrongArmOnlyM0AllRight']} 例；"
            f"全对而对照全错 {value['casesAllRightArmOnlyM0AllWrong']} 例（共 {value['cases']} 例）")
    for arm in R.ARMS:
        block = final["arms"][arm]
        add(f"- {arm} 四序一致率 {pct(block['consistency']['rate'])}"
            f"（{block['consistency']['allFourSamePrediction']}/{block['consistency']['cases']} 例四序预测同一类）")
    add("")

    add("## 5. 成本与一次预算事故")
    add("")
    add("`extract.py` 首次调用 ledger 时没有传入 JEV-03 的 caps，默认沿用了 R1 的 3300 上限，"
        "在 P2 第 3300 个 operation 处 BudgetExceeded 中止：204 次生成已完成但文本未落盘。"
        "修复后按 jobId 续跑，这 204 次照常计费且不重跑（重跑会突破 1100 生成上限），"
        "所以 JSON 臂只有 820/1024 次呈现（205/256 例），缺口如实标注。")
    add("")
    add(f"- 模型 operation：{ledger['reserved']} / 上限 {R.CAPS['model_jobs']}；"
        f"生成 operation：{ledger['generationJobs']} / 上限 {R.CAPS['generation_jobs']}；"
        f"失败 {ledger['failed']}，未完成 {ledger['unfinished']}。")
    add(f"- prefill {ledger['prefillCalls']} 次、decode {ledger['decodeCalls']} 次、"
        f"输入 {ledger['tokensIn']} token、输出 {ledger['tokensOut']} token、"
        f"模型内 {ledger['modelSeconds']:.1f}s、窗口 {ledger['windowSeconds']:.0f}s / "
        f"{R.CAPS['window_seconds']}s。")
    for item in extract_reports:
        add(f"- {item['outputs'].get('json', {}).get('split', '')}"
            f"{sorted(item['outputs'])}：加载 {item['loadSeconds']:.1f}s，"
            f"整段 {item['wallSeconds']:.1f}s，GPU 峰值 "
            f"{max(item['gpuPeakGiB'].values()):.2f} GiB/卡，阻断尝试 {item['seal']['blockedAttempts']}")
    add("")

    timing_path = R.RESULTS / "timing.json"
    if timing_path.exists():
        timing = R.read_json(timing_path)["summary"]
        add("")
        add("在线计时（16 个事先固定的 test 呈现 × 2 次重复；负载与预热单列，小样本不给 p95）：")
        add("")
        add("| 路径 | 中位端到端 | tokenize | prefill | 头打分 | decode |")
        add("| --- | --- | --- | --- | --- | --- |")
        for kind, name in (("shared_feature", "一次共享特征（三臂共用）"), ("json", "JSON 生成")):
            block = timing[kind]
            stage = block["stages"]
            add(f"| {name} | {block['medianMs']:.1f} ms | {stage['tokenizeMs']:.2f} | "
                f"{stage['prefillMs']:.1f} | {stage['readoutMs']:.2f} | {stage['decodeMs']:.1f} |")
        add("")
        add("头打分本身 <3 ms，区别在调用次数：C/M0 每例每序 1 次前向，Q 也是 1 次（共用同一次前向的 hq）。")
        add("")

    add("## 6. 封存与阻断")
    add("")
    add(f"- 预测阶段 gold 阻断正向对照：`{record['goldSealControl']}`，被拒 {record['blockedAttempts']} 次。")
    add(f"- 分数哈希 `{record['scores']['sha256'][:16]}`，预测哈希 `{record['predictions']['sha256'][:16]}`；"
        f"选择封存哈希 `{record['selectionSha256'][:16]}`。")
    add("- 解封只有一次（`results/unseal-attempt-1.json`），无第二次计分。")
    add("")

    matched_path = R.RESULTS / "matched.json"
    if matched_path.exists():
        matched = R.read_json(matched_path)
        add("## 6b. 同案例对照（限制在有四次 JSON 输出的 case 上）")
        add("")
        add(f"JSON 臂因预算护栏中断少了 51 个 case（见 §5），因此 §1 的 246 例与 JSON 的 205 例不是同一批样本。"
            f"这里把四臂都限制在 {matched['cases']} 个 case（{matched['presentations']} 次呈现）上重算：")
        add("")
        add("| 臂 | 准确率 |")
        add("| --- | --- |")
        for arm in R.ARMS + ("JSON",):
            add(f"| {arm} | {pct(matched['arms'][arm]['accuracy'])} |")
        add("")

    add("## 7. 未证明项")
    add("")
    add("1. 数据仍是合成对话、单一作者 + 同源独立会话盲标；已记录 93.8%/87.5%/71.9% 的一致率与逐条裁决，"
        "但不是人工复核，也不证明真实玩家分布。")
    add("2. 标签争议集中在“都行/再说/还没定”这一类（NC2）：冻结合同判 NEEDS_CLARIFICATION，"
        "盲标方多判 NO_PRIORITY_REQUEST；正文按冻结标签计分，敏感性见 §8，该规则应由负责人下一轮定夺。")
    add("3. C 只改变监督数据（与 M0 同函数类、同参数量），Q 同时改变读出位置与参数化；"
        "因此 C/Q 差异不能单独归因于因果掩码或结构。")
    add("4. dev 只用 8 个基础句型，test 另有 4 个困难变体；选 epoch 的分布比 test 简单。")
    add("5. 未拟合温度、未发 valid=true 策略；本轮不声称任何可靠拒答能力。")
    add("")
    if "sensitivity" in final:
        add("## 8. 敏感性（含 challenge 与全部 test 例）")
        add("")
        add("| 臂 | 计分例准确率 | 全 256 例准确率 |")
        add("| --- | --- | --- |")
        for arm in R.ARMS:
            add(f"| {arm} | {pct(final['arms'][arm]['accuracy'])} | "
                f"{pct(final['sensitivity'][arm]['accuracy'])} |")
        add("")
    Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
