# 署名与来源（E / R10）

本目录的 3D 展示来自 **PoetryJ/FrostEcho-WebGPU @ f77bf5453465d0ade53070c4589498867209aabe**（提交 `Refine blizzard cabin geometry, snow and forest detail`，即"白障风暴"细化版）。

- `index.html`、`style.css`、`src/*.js`、`data/frostecho-map.json`、`docs/STORM-DETAIL.md`、`UPSTREAM-README.md`：**逐字节原样**复制，SHA256 见 `VENDORED.json`，并与上游 clone 对账一致。上游没有任何一个文件被修改。
- `licenses/abyssal-garden-MIT.txt`：上游保留的第三方 MIT 许可证。原作者 **Maksymilian Dendura**（[Noniv/abyssal-garden @ a596354](https://github.com/Noniv/abyssal-garden/tree/a596354eff400d458bc2aeb9bdf5e0a9734b2bcf)），其数学与网格构造代码被上游复用；本仓原样保留该许可证与署名。
- 上游仓库自身未附独立 LICENSE 文件，仅 README 声明来源与 MIT 第三方许可。本目录按上游 README 的要求保留其署名与 MIT 声明，不改变上游许可。
- 地图空间数据来源：上游 `data/frostecho-map.json` 记录自 **PoetryJ/frostecho @ 586034f** 的 `src/spatial-v2/legacy-map-data.ts`（50×40 村庄网格、七栋建筑足迹与门、1 格 = 2 米、`worldX=(gridX-25)*2`、`worldZ=(gridY-20)*2`）。

## 本仓新增（E 编写，不属于上游）

- `game.html` / `game.css` / `game.js`：游戏画面入口。只替换**状态来源**（读 `VisualSnapshot/1`），场景、着色器、白障风暴、地形与地面细节全部走上游原文件。
- `npc-projection.js`：纯函数投影（快照 → 实例数据），无 DOM/WebGPU 依赖，可被 Node 直接导入核对。
- `package.json`：仅为让 `node --check` 与 `import` 把这些 ESM 文件当作模块处理，不参与浏览器逻辑。

## 已知边界

- 没有浏览器二进制，本轮**没有**浏览器录像、没有帧率/GPU 统计、没有"实际渲染"截图。上游 `docs/previews/*.jpg` 被有意排除，避免把静态图当成本轮渲染证据。
- NPC 不参与静态阴影烘焙（实例缓冲在 `Renderer.create` 之后才接管），所以只有身体/头部/回执标记的直射与雾效，没有投影。这是取舍，不是"已完成"。
- 相机仍是观察者，允许穿墙；不是玩家碰撞。
