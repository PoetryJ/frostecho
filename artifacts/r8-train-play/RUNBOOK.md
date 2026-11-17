# R8 真实训练与可玩入口

从 `codex/r8-train-play-20261117` 接续；本轮运行源码为 `3f8121aaeb7057dc928606cd41a6ce4568fec193`。以下为 **Linux Bash**，参数取自 `reproduction/run_round_v2.py` 和 `results/v2/training/selected.json`。使用新输出目录，保留已经完成的实验；不要在仍运行的 `source-v2` 内切换代码。

当前 GPU 运行目录：`/data/home/user_00/frostecho-r7/workbench/r8-train-play-20261117/source-v2`。归档的 `run_round_v2.py` 原本放在该目录的父目录，依赖同级 `online-deploy-v2.json`；**不要在仓库里的 reproduction 目录直接运行它**。下面是可从仓库直接执行的等价步骤。

## 1. 取代码、构建、恢复原作素材

```bash
git clone --branch codex/r8-train-play-20261117 https://github.com/PoetryJ/frostecho.git frostecho-r8-next
cd frostecho-r8-next
git merge-base --is-ancestor 3f8121aaeb7057dc928606cd41a6ce4568fec193 HEAD
set -euo pipefail
export PY=/data/home/user_00/frostecho-r7/.venv/bin/python
export PATH=/data/home/user_00/.local/node22/bin:$PATH
export FROSTECHO_SOURCE_HEAD=$(git rev-parse HEAD)
export RUN="$PWD/artifacts/r8-train-play/reproduce-$(date +%Y%m%d-%H%M%S)"
mkdir "$RUN"
npm ci
npm run build
"$PY" handoff/20261113-r7-full-goal/bootstrap.py
node --test scripts/r8/live-entry.test.mjs scripts/r8/commitment-bridge.test.mjs
```

Bootstrap 校验归档并恢复 `handoff/20261113-r7-full-goal/reference-extracted/`。不要只恢复地图 JSON 而漏掉 PNG；指挥室原作没有 PNG，使用家具绘制。上面的测试含 HTTP 三室路线、取消、全状态恢复和承诺回执；协议 fixture 不代表真实模型结果。

## 2. 已验证环境与双卡布局

复用上述 Python 环境：Python 3.12.2、PyTorch `2.5.1+cu121`、Transformers `5.2.0`、Accelerate `1.6.0`，Node 使用服务器已有 Node 22。实际导入版本应现场核对，`environment.json` 的包列表含系统与虚拟环境的重复记录，不能直接作为安装锁文件。

```bash
"$PY" -c 'import sys,torch,transformers,accelerate; from transformers import Qwen3_5ForCausalLM; print(sys.executable,torch.__version__,transformers.__version__,accelerate.__version__,torch.cuda.is_available())'
nvidia-smi --query-gpu=index,name,memory.free,utilization.gpu --format=csv
export ENCODER=/data2/model_weights/Qwen3.8-27B
test -f "$ENCODER/config.json"
test -f "$ENCODER/model.safetensors.index.json"
export INITIAL_HEAD="$PWD/artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors"
test -f "$INITIAL_HEAD"
```

目录名是 `Qwen3.8-27B`，实际加载类为 `Qwen3_5ForCausalLM`；以配置与记录的 SHA 为身份依据，不把目录名当官方型号证明。权重不在 Git 仓库中；新机器须先提供同一检查点和上述兼容环境。

双 A10 分别 23028/24564 MiB，驱动 550.90.07。使用 `--physical-gpus 0,1 --placement auto`、BF16、不量化、eager attention；按实时空闲显存每卡预留 1536 MiB，并允许 CPU offload。CPU 内存预算为 `min(55 GiB, 可用内存−12 GiB)`，至少须有 16 GiB 预算。本轮实际层分配为 GPU0 的 0–20 层、GPU1 的 21–50 层、CPU 的 51–63 层及输出头；不同空闲容量可能产生不同分配，不能强行对半切。不得终止不属于本轮的进程。

## 3. 真实编码 96 例，再训练四个头

恢复已归档 V2 输入并验证压缩文件与原始内容 SHA：

```bash
"$PY" - <<'PY'
import gzip, hashlib, json, os
from pathlib import Path
base = Path('artifacts/r8-train-play/data')
row = next(r for r in json.loads((base/'index.json').read_text())
           if r['file'] == 'corpus-96-v2-cases.jsonl.gz')
packed = (base/row['file']).read_bytes()
assert hashlib.sha256(packed).hexdigest() == row['compressedSha256']
raw = gzip.decompress(packed)
assert hashlib.sha256(raw).hexdigest() == row['rawSha256']
with (Path(os.environ['RUN'])/'cases.jsonl').open('xb') as f: f.write(raw)
PY
"$PY" -u research/decision-choice/jev05/action/encode_joint_corpus.py \
  --encoder "$ENCODER" --inputs "$RUN/cases.jsonl" --out "$RUN/features" \
  --physical-gpus 0,1 --placement auto --batch-size 1 --limit 96 --max-length 4096 \
  2>&1 | tee "$RUN/encode.log"
"$PY" -u research/decision-choice/jev05/action/train_action_experiment.py \
  --corpus "$RUN/cases.jsonl" --features-dir "$RUN/features" --head "$INITIAL_HEAD" \
  --out "$RUN/training" --device cuda:0 --epochs 40 --batch-size 16 --lr 0.001 \
  --allow-weak-reference 2>&1 | tee "$RUN/train.log"
export TRAINED="$RUN/training"
```

“批量”指整批真实案件逐例编码；编码 batch=1 与线上相同，不能擅改为曾未通过数值资格检验的 batch=2。训练器冻结主干，梯度经过无可训练仿射参数的 LayerNorm，只更新共享候选评分头；自动运行 warm/random × seed17/43，AdamW weight decay=0.01，按 dev set-NLL 选头，不按 test 选头。数据为参考策略弱标签，64/16/16；本轮选中 `random-43.safetensors`，具体指标在 `results/v2/training/selected.json`。

只体验已有模型时可跳过本节训练，改用 `export TRAINED="$PWD/artifacts/r8-train-play/results/v2/training"`。仍须有真实主干权重；若服务拒绝 encoder/renderer/placement 身份不匹配，应在当前布局重新编码训练，不得删校验或改 manifest。

## 4. 配置常驻评分进程，跑真实承诺故事

```bash
export FROSTECHO_SCORER_TIMEOUT_MS=300000
export FROSTECHO_SCORER_COMMAND_JSON=$("$PY" - <<'PY'
import json, os
from pathlib import Path
t = Path(os.environ['TRAINED'])
s = json.loads((t/'selected.json').read_text())
print(json.dumps([os.environ['PY'], '-u',
 'research/decision-choice/jev05/action/serve_joint.py',
 '--encoder', os.environ['ENCODER'], '--physical-gpus', '0,1', '--placement', 'auto',
 '--max-length', '4096', '--temperature', '1', '--tau', '0',
 '--mode', 'jev-experimental', '--head', str(t/s['selectedCheckpoint']),
 '--training-manifest', str(t/'selected.json'),
 '--output-dir', str(Path(os.environ['RUN'])/'service')]))
PY
)
node scripts/r8/live-commitment-story.mjs --mode jev-experimental \
  --max-steps 24 --out "$RUN/commitment"
```

CLI 自动启动服务，一个游戏进程内主干只加载一次、每次 NPC 决策真实编码，不需要另开服务占用双卡。输入是 TS renderer 产生的完整 joint envelope，不能把裸 ChoiceRequest 或静态 feature-map 冒充线上输入。场景中玩家只请求送饭并明确接受改约；NPC 行动由模型选择，最多 24 次，不强制候选、不回退参考策略。退出码 2 表示未履约，保存 partial 与报告，不能改成成功。

检查 `commitment/report.json` 的原始 task/commitment ID、`meal_delivered` 回执、fulfilled 与 `restoreEqual`；`decisions.jsonl`、`scorer.jsonl`、`cli.jsonl` 和所有存档 sidecar 是交付证据。本轮 V2 具体结果由最终报告统一汇总。

## 5. 新进程恢复与完整地图四日对照

以下顺序运行，避免同时加载两个主干：

```bash
node scripts/r8/online-play.mjs --mode jev-experimental --fresh --full-map \
  --steps 6 --actors npc_01,npc_02 --seed live-pair-2 --out "$RUN/restore"
node dist/scripts/r8/playthrough.js --mode reference --full-map \
  --seed live-pair-2 --out "$RUN/reference"
node dist/scripts/r8/playthrough.js --mode jev-experimental --full-map \
  --seed live-pair-2 --out "$RUN/jev"
```

`online-report.json` 比较跨进程恢复的完整权威状态及任务、承诺等 sidecar，不只比时钟。四日读取双方 `summary-*.json` 和 `trajectory-*.jsonl` 的实际日历、存活、结局、执行/拒绝及回执；失败保留 partial 和非零退出。模型好坏都报告，不以故事成功代替整局结果，也不以参考策略轨迹代替模型轨迹。

## 6. 网页试玩

在完成 GPU 实验后，于同一终端启动（沿用第 4 节配置）：

```bash
export FROSTECHO_MODE=jev-experimental
export FROSTECHO_PROFILE=gospel-5.8.19
node dist/scripts/r7/play-web.js --port 18747
```

浏览器访问 `http://127.0.0.1:18747`；远端运行时使用已有 SSH 配置转发该端口，服务只监听 loopback。若本机旧 18747 窗口仍在，先在游戏内保存退出，再正常关闭旧服务，不覆盖它的存档。无需 GPU 体验时将 mode 改为 `reference`。

新游戏 → 启用完整地图 → 选择居民 → 点击地格/门移动 → NPC 单步或自动运行 → 保存退出 → 继续。界面和 CLI 使用同一 session/world；新 Gospel 局初始食物130，旧存档保持原资源。保存须一起保留 session JSON 及 `.r8.json`、任务/承诺等全部 sidecar，不能只拷单文件。

## 交付边界

独立重算故事无需GPU：将 `results/v2/training-story-evidence.tar.gz` 解到新的证据目录；另外建立源码 `3f8121a` 的独立worktree并构建，再运行：

```bash
"$PY" artifacts/r8-train-play/verification/root/audit-real-story.py \
  --evidence /absolute/path/to/extracted-story --repo /absolute/path/to/frozen-3f8121a \
  --node "$(command -v node)" --out "$RUN/independent-story.json"
```

审计故意校验运行源码HEAD，不能拿后补报告的分支尖端替代原始运行提交。`reproduction/independent_head_check_v2.py` 是原始服务器复验脚本，放在workbench父目录执行，所需features缓存位于完整原始归档；它不导入训练器或Torch。

- 实模候选评分、真实世界提交、个人库存观察、两类旧承诺桥接、八张原作地图移动与存档链已接通；晨会提案/投票和接受/改约仍为参考规则，不能称模型自主议会。
- `COLLECT_MATERIAL / BOOST_MORALE / COORDINATE / MAINTAIN_ORDER / SCOUT_RUINS` 仍有 `work-proxy` 标记；一般工作回执不证明原作探索或社会玩法完成。
- 冻结 V2 还有动作工时缺口：原图旅行推进时钟，`rest/work` 的分钟目前用于立即结算，四日运行器在回合外推进时间；CLI 故事不自动补该工时、网页自动则条件补15分钟。真实履约回执仍有效，但故事时长不能当作完整劳动成本，跨入口时间语义尚待统一；不要只在休息命令里加时而保留旧调度，造成重复计时。
- 弱标签实验不是正式研究准入：`researchTrainReady=false`、`mayTrainOnJev=false`、`countsAsAdmitted=false`；T=1、tau=0 是运行参数，没有概率校准或选择性风险保证。不能宣称完整原作或长程智能已经完成。
- 交付保存源码 HEAD、环境、输入与头 SHA、全部失败/成功日志、模型前向计数、故事回执、完整存档与整局摘要。不要覆盖本轮原始数据，也不把大体积原始存档无选择地加入 Git。
