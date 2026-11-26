# FrostEcho 暂停检查点 · 2026-11-26

FrostEcho 让八位居民在同一时钟和资源账本上行动。玩家可以托付任务，居民可接受、改约或退出。JEV 用真实 27B 编码器和行动头给居民可见的候选打分，游戏按实际行动回执结算承诺。项目暂存于 `pause-r11-20261126`。此版适合演示派工与跨天恢复。原图生存、3D 呈现和新行动头对履约的提升仍有待验证。

## 当前交付

| 线 | 保存的版本与结果 |
|---|---|
| O 集成 | 服务器集成尖端 `2a8ed80` 含 A/B/C/D/H。暂停版另外合入 E 的 `bbd8daf` 和手动工单 `cc3722f`。如需复现历史模型输入，使用冻结 v1 的 `1d140c2`。 |
| A 动作 | `8e2f881`。完整地图移动拆成可保存的路段，由同一时钟推进。服务器保留重入、取消、封路、并行行走与恢复的对照。[行动证据](../../artifacts/r11/A/) |
| B 记忆 | `a21225d`。超长首条记录受预算约束，有限输入优先保留承诺。后来修复改动了 96 个冻结状态中 24 个的记忆文本（48 个标注样本中 12 个）。v1 训练和盲审继续绑定旧输入，v2 文件是草案。 |
| C 训练 | `6458aeb`。真实 GPU 编码 96 个参考策略访问状态，按相同截止时刻标注 48 个状态、12 局、243 项候选。按局分 28/12/8。两种配方各跑四头，八个权重与特征缓存均已保存。base 全部候选都可接受，选中 epoch 0 的 warm-17；履约头 random-43 只有 2 个训练区分样本、1 个测试区分样本。另有 4 个真实 JEV 访问状态，未混入参考语料。[权重、身份与评估](../../artifacts/r11/c/real-run/) |
| D 玩法 | `857cbd7`。共同四日驱动、议会、生产、危机、夜行与步行救援已接入。15 类任务规则对账 15 MATCH。O 的同一参考策略检查中，三图模式 8/8 存活；完整原图在世界分钟 2640 时 0/8 存活，记录有夜间户外滞留和体力不足。仍需查真实步行距离、室内外生存消耗和回家决策。 |
| E 网页 | `bbd8daf`，浏览器记录对应 `2ed0825`。演示中玩家同意改换来源，居民采集、交存，D2 以 active/rev2 保存。新进程恢复同一承诺，取餐送达并继续至 D4。Chromium 记录 37/37 项通过，2D 截图和操作回执可查看。该环境下 3D 画布纯色，硬件 WebGPU 视觉验收仍待做。[演示和环境](../../E-R11.md) |
| F/G 盲审 | 两位审阅者都已交齐 A、B 两阶段，每份 48 案，校验过文件 SHA、案例集合和候选 ID。按每案可接受 ID 集合严格相等计算，事前判断 25/48 相同，看到分支结果后的判断 15/48 相同；这些是审阅一致数。保留四份原件、分歧 ID 和复算脚本，尚未将分歧裁成训练标签。[核对结果](review-check.json) |
| H 四日评测 | 方法分支 `ca3b166`，运行树 `b0919f1`，现场未提交的运行器改动另存补丁。base + conditional 两局从 D2 新进程恢复，分别有 2 项有效承诺、1 个绑定工作。履约 4/6、4/7，真实前向 143、184 次。fulfil + conditional 的两次起跑遇时钟倒退，现有记录中没有修后两局的完成证据。raw 臂受清单的记忆策略/启动条件阻塞。未能比较两头和两种记忆的长程收益。[实际运行矩阵](MATRIX.md) |

## 从干净环境恢复

在安装了 Git、Node（服务器使用 22 系列）、npm 与 Python 3 的环境中运行：

```bash
git clone https://github.com/PoetryJ/frostecho.git
cd frostecho
git switch --detach pause-r11-20261126
npm ci
python handoff/20261113-r7-full-goal/bootstrap.py
npm run build
node dist/scripts/r11-e/visual-server.js --port 18766 --saves ./saves/r11-resume
```

打开 `http://127.0.0.1:18766/`，点“新游戏”进行派工。在同一浏览器另开 `http://127.0.0.1:18766/2d.html` 查看同一世界。保留 saves 目录，重启相同命令后点“继续存档”。这条入口默认使用 CPU 参考策略。暂停版已独立构建、核验并解出原作素材，从网页服务新建 D1 08:00 八人世界，检查 2D 页面和状态接口均返回 200。经仓库测试运行器共 885 项，884 通过、1 跳过、0 失败，使用 Windows / Node 24.22.1。浏览器全故事记录来自 E 的提交，暂停时没有重新训练或运行 GPU 四日实验。[测试日志](suite.log)

## 取回实验、现场与环境

从 [GitHub Release](https://github.com/PoetryJ/frostecho/releases/tag/pause-r11-20261126) 下载以下附件。示例在仓库根目录执行；有 GitHub CLI 时可直接下载。单纯玩参考模式无需这些大文件。

```bash
mkdir -p pause-data
gh release download pause-r11-20261126 --repo PoetryJ/frostecho --dir pause-data
(cd pause-data && sha256sum -c ../checkpoints/r11-pause-20261126/SHA256SUMS)
for name in training runs environment r11-handoff; do
  tar -xzf "pause-data/$name.tar.gz" -C pause-data
done
(cd pause-data && python ../checkpoints/r11-pause-20261126/verify_seals.py)
```

- **training.tar.gz** → `r11-real/`。保存服务器临时目录下的原始训练快照、候选分支、编码缓存、标签、训练曲线和全部八头。两个被选中的头及其 manifest 也在 main 的 `artifacts/r11/c/real-run/`。
- **runs.tar.gz** → `h/`、`h-run/`、`e/`、`o/` 和运行日志。保留 CPU 场景、实模请求/响应与错误、D2 存档、恢复与回放、浏览器操作和截图。实模以 `h-run/artifacts/r11/matrix/` 为准。各角色状态里的历史路径与旧阶段报告保留原样。
- **r11-handoff.tar.gz** → `r11-handoff/`。O 的看板和预算、A–H 的交接、F/G 双阶段原始材料、E 的精简浏览器证据包在此。暂停时原始返回按 seal 校验，全部分歧保留。
- **environment.tar.gz** → `python-packages.json`、`patches/`、库存及矩阵。记录服务器 Python 包版本、现场 GPU 进程查询、H 和 h-run 两份未提交的运行器差分。先查看补丁，再在其**原始提交**恢复，例如 `git worktree add ../h-run-replay b0919f1`，接着在该 worktree 中对解出的 `patches/h-run.patch` 运行 `git apply --check` 和 `git apply`。修复时钟的集成提交为 `159a608`。
- **r11.bundle** 保存服务器八个 Git 分支，包括独立运行树。包依赖 `24406c4`，该提交在暂停标签历史中。需要还原原分支时，从已有暂停标签的仓库执行 `git bundle verify pause-data/r11.bundle` 和 `git fetch pause-data/r11.bundle 'refs/heads/*:refs/remotes/r11-saved/*'`。

真实推理还需要服务器原预训练主干 `/data2/model_weights/Qwen3.8-27B` 或身份校验一致的副本，以及相容的 CUDA/PyTorch 环境。GitHub 保存项目训练的行动头与编码数据，外部 27B 主干单独供应。加载前用冻结 manifest 的模型元数据、特征身份、渲染器及记忆策略校验。原服务环境在 `/data/home/user_00/frostecho-r7/.venv`；现场命令与环境版本见归档。

## 重新开工时的顺序

1. 先在 CPU 上重放 H 两个倒退时钟的失败案例，确认 `159a608` 在冻结 v1 运行树的兼容移植。保留基线、补丁与新运行的真实源码身份。由 F/G 已封存的分歧中抽查何种承诺选择能由结局区分。
2. 再决定研究版本。直接续 v1 就使用 `1d140c2` 的输入和所选头；续最新记忆版本需重编码受影响记录并更新验证。raw 需要匹配其记忆策略的合法 manifest 与特征证据。
3. 恢复算力前先复核 `GPU-BUDGET.json`。总上限累计 10 卡时，O 最后入账 5.84、未知预留 0.50。历史 1.30 卡时是重跑计划，账内 3.66 也只是当时余额；实际晚间消耗须凭进程和日志冲账。冻结期间没有新开 GPU。
4. 玩法侧先复现完整原图 D2 夜间滞留；画面侧用支持硬件 WebGPU 的浏览器检查可见 NPC 和门路径。研究侧补齐配对与更有区分度的留出样本，再决定是否采用新头。此前 `researchTrainReady`、`mayTrainOnJev`、校准与正式执行准入均保持关闭。
