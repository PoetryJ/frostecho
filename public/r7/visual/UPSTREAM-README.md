# FrostEcho WebGPU · 雪原回响

一个可自由飞行的 FrostEcho 雪原村庄原型。直接使用 WebGPU；没有 Three.js、外部模型、贴图或音频文件，没有运行时依赖。

![白障风暴细化版预览](docs/previews/storm-detail.jpg)

[细化版近景](docs/previews/storm-close-detail.jpg) · [细化版屋内](docs/previews/storm-interior-detail.jpg) · [初版三种环境](docs/VALIDATION.md)

当前默认进入第三版「白障风暴」。本轮细化了枝条与针叶、枝顶积雪、雪层厚度、屋檐与门廊、风化木纹与霜窗；雪路改为程序化压雪与浅脚印，并加入分层飘雪、贴地吹雪和顺风烟囱烟。旧版截图保留作比较；[细化说明与本轮验收](docs/STORM-DETAIL.md)。

## 本地运行

需要 Node.js 20+ 和支持 WebGPU 的桌面 Edge / Chrome。无需 npm install。

```sh
node tools/serve.mjs
```

打开 **http://127.0.0.1:18765/**。WebGPU 需要安全上下文：localhost / 127.0.0.1 或 HTTPS，不能直接双击 HTML。

```sh
node tools/check.mjs
```

检查 JS 语法、地图坐标、七条门口路径、几何索引和生成确定性。WGSL 在浏览器启动时编译检查；显卡错误会直接显示到启动画面。

## 三种环境，三个距离

- **静雪守夜**：冷蓝暮色、克制的风雪、暖窗与松林。
- **微缩雪镇**：明亮晨光、较窄视角、村庄俯瞰。是同一份几何的风格预设，并非另一套独立美术资产。
- **白障风暴**：更浓的雪雾、侧风与更密集的飘雪。

各环境都能切换 **小屋近景 / 村庄总览 / 小屋内部 / 林间远望**，也可调节风雪强度、自动环游和环境声。

鼠标拖动环顾；WASD 飞行；Q/E 升降；Shift 加速；1/2/3/4 分别返回小屋、村庄、屋内、松林机位；H 隐藏界面；Esc 释放鼠标。点击「进入雪原」启动环境声并尝试锁定鼠标；不锁定也可拖动查看。环境声通过 Web Audio 合成：风、低频底噪、近屋炉火，无外部采样。默认静音。

自由相机用于观察，允许穿墙，不是玩家行走或 NPC 寻路。角色、任务、资源消耗、温度、昼夜与 JEV 决策尚未接入；这些环境预设不代表真实模拟天气。

## 地图来源与空间约定

来源：[PoetryJ/frostecho @ 586034f](https://github.com/PoetryJ/frostecho/tree/586034fbe8b10f26aa5def8e05a8d55673522e7f)，`src/spatial-v2/legacy-map-data.ts`。`data/frostecho-map.json` 记录该文件的 SHA-256、提交和原始提取 profile。

保留 50×40 村庄网格、七栋建筑足迹与门位置、村墙、两个门洞、固定树位置及炊事房家具相对位置。1 格对应 2 米，地面坐标为 `worldX = (gridX - 25) × 2`、`worldZ = (gridY - 20) × 2`。道路是从原网格寻得的展示路径，不声明它就是原作全部道路纹理。高度、木屋外观、积雪、补充松林、灯光与天气为本原型创作。

更新地图必须显式给出来源文件和提交：

```sh
node tools/import-map.mjs /absolute/path/legacy-map-data.ts FULL_40_CHARACTER_COMMIT
node tools/check.mjs
```

更新后还要检查机位和建筑体积；2D 拓扑测试不能替代 3D 视觉验收。

## 接手时从哪里读

1. `data/frostecho-map.json`：冻结的空间数据与来源。
2. `src/world.js`：网格到米的转换、门口路径、几何生成、实例批次和固定机位。只在加载阶段生成。
   `src/detail-geometry.js` 提供枝条、积雪与远山几何；`src/ground-map.js` 在内存中生成压雪/脚印贴图。房屋与路径拓扑仍由 `world.js` 对接原地图。
3. `src/shaders.js`：所有表面共享的高度雾、材质、暖光、阴影、风雪与后处理。
4. `src/renderer.js`：GPU 资源、静态阴影、4× MSAA 的浮点 HDR 场景、reversed-Z、实例剔除、六级 Bloom、色调映射、可选 GPU 时间戳和动态分辨率。
5. `src/main.js`：界面、三种环境参数、自由相机。`src/audio.js`：独立的固定 Web Audio 图。

没有框架、ECS、跨仓库运行时导入或模型服务依赖。以后接入游戏时，应增加一个明确的只读状态适配器，将权威世界快照映射到可视对象；不要把游戏状态推进写入每帧绘制函数。

## 复用与取舍

受 [Noniv/abyssal-garden @ a596354](https://github.com/Noniv/abyssal-garden/tree/a596354eff400d458bc2aeb9bdf5e0a9734b2bcf) 启发，并复用其 MIT 数学与网格构造代码；原作者 Maksymilian Dendura，许可证见 `licenses/abyssal-garden-MIT.txt`。`src/math.js` 保留相关帮助函数，移除了水下世界尺寸与密度网格常量并加 ESM 导出。渲染器重新组织为独立模块，借鉴共享雾、预分配状态、HDR/MSAA、reversed-Z、instancing、Bloom 与 GPU 时间预算的方法。

雪地是高度场，不需要海底拱洞的密度场和 Surface Nets；这减少初始化内存与接手成本。窗光使用局部衰减近似，静态方向光阴影加载时烘焙；没有全局光照、光线追踪或全分辨率体积散射。飘雪为解析运动，不参与积雪、碰撞或资源系统。

逐帧复用 uniform、实例缓冲、后处理描述符和提交数组；WebGPU 命令编码、异步计时读取与低频 UI 更新仍分配对象，**不声称严格零逐帧分配**。有 GPU 时间戳时以约 9.8–13.6 ms 为调整死区；清晰度下限是 CSS 视口像素数的 90%（最高 960×720 像素预算）。达到下限后先缩短精细树冠的绘制距离，强风雪中可进一步缩短远景装饰距离。目标可能达不到，不会无限降低分辨率，也不会影响地图拓扑或游戏推进速度。

## 设计依据与反例

- 大气透视与辐射传输：统一衰减与散射能让不同表面属于同一空间，而不是分别增加雾色。[GPU Gems 2 / Atmospheric Scattering](https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-16-accurate-atmospheric-scattering)。本原型是解析高度雾近似，不是该章完整的大气模型。
- 控制系统的反馈与迟滞：用 GPU 耗时死区和限幅调像素预算，避免逐帧追涨杀跌；不把“60 fps”当作未经测量的保证。[WebGPU 规范](https://www.w3.org/TR/webgpu/)。
- 仿真与显示解耦：相机时间步有上限，原始帧间隔另记；未来的权威游戏 tick 与画面插值分离。[Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/)。
- 最强反对意见：漂亮的自由飞行未必改善可玩性，浓雾会隐藏道路，三种美术方向也可能制造三套维护负担。因此共享几何、保留总览、将浓雾作为可选预设，并把本次范围限定为世界呈现验证。

二阶影响：更多几何和粒子会占用 GPU 与电量；自适应像素预算只能缓解，不能证明低端设备适配。三阶影响：若展示场景复制 NPC 状态、另写寻路和事件推进，将形成双重权威、存档漂移与长期维护成本。本仓库目前只保留静态地图入口，避免提前引入这些耦合。

## 验证边界

浏览器启动编译所有 WGSL 并监听 GPU 验证错误。`window.frostEcho.stats()` 提供当前尺寸、绘制批次数、原始帧间隔与 GPU 耗时统计（累积样本最多 18,000）；这些是本地诊断，不会上传。初始化和交互切换可能进入统计，不等于固定机位、固定分辨率的跨设备基准。

`docs/VALIDATION.md` 记录本轮实际检查与已知限制。不要把动态分辨率下的 GPU 快照与原项目固定分辨率性能宣传直接比较。
