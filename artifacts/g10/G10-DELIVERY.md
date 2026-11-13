# FrostEcho G10 — 持续交互厨房（离线）

**一条启动命令**

```bash
npm run play:g10 -- --goals negotiated --fixture cooperate --root artifacts/g10-play --slot play
```

默认（不写参数）是离线 reference + `--goals legacy`，不因环境变量联网。

**三份输入脚本（逐行 stdin；均标注脚本演示，不是真实模型行为）**

```bash
# 合作：请求 → NPC 选 yield → wait → 玩家吃到 → 请求 fulfilled
npm run play:g10 -- --goals negotiated --fixture cooperate --root artifacts/g10-play --slot coop < scripts/g10-demo/cooperate.txt

# 拒绝：请求 → NPC 选 feed_self → eat → 玩家 NO_FOOD，请求 declined
npm run play:g10 -- --goals negotiated --fixture decline --root artifacts/g10-play --slot decline < scripts/g10-demo/decline.txt

# 违约：请求 → NPC 选 yield → 却 eat → 玩家 NO_FOOD，请求 violated
npm run play:g10 -- --goals negotiated --fixture violate --root artifacts/g10-play --slot violate < scripts/g10-demo/violate.txt
```

**恢复命令**（存档槽由脚本里的 `save SLOT` 产生；恢复是 0 调用、不重选、不重投递）

```bash
npm run play:g10 -- --load artifacts/g10-play/cooperate-slot.g09.json
```

**验收数字**（离线；真实模型 0 次；HTTP 只打本地随机端口）

- 全量测试 472/472；G10 独立验收 9/9；P0 定向 5/5。
- 合同门 16/16；golden 12/12；G08 旧 live 与 G09-R2 loopback 只读复验 exit 0 且字节未变。
- 评审探针：core 9/9；restore 全量 checkpoint 11/11（每步跨进程）；transport 16/16 wire 精确 + 80ms 超时 1 POST 留证。
- 三场景均 2 次脚本决策；合作 A40/B70/food0/fulfilled；拒绝 A70/B40/food0/declined；违约 A70/B40/food0/violated 且顶层标签不是 goal_reached。

**未证明**

- 真实模型行为、真实模型 wait 续跑与 120s 生产超时（仅本地 80ms 注入验证同一条 abort/留证路径）。
- 长期合作/完整原作玩法覆盖；脚本演示只证明机制，不代表合作率。
- G10 没有新增自由文本理解、长期记忆、学习、多人联网或图形界面。

**文档更正**：G09-R2 交付中的 F7b 标题写的是“接受后跨进程继续”，但两路分别用了 stop 与 wait、只比较了部分字段。本交付以评审方的 `restore-audit-probe`（同动作、全量 checkpoint、每步新进程，11 次比较）作为正式回归；旧证据字节不改。
