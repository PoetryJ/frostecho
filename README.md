# gospel-rebuild — G00 最小动作执行与事件重放内核

GitHub 仓库：PoetryJ/frostecho（https://github.com/PoetryJ/frostecho）。

TypeScript + Node 20，测试用 `node:test`，无其他运行时依赖。

```
npm install        # 仅 typescript / @types/node
npm test           # tsc 编译 + 运行 A–G 及附加测试；原始记录写入 artifacts/tests/*.json
npm run demo       # 可读演示；写 artifacts/demo-output.txt 与 artifacts/demo-records.json
npm run build      # 仅编译
npm run manifest   # 生成 MANIFEST.sha256
```

结构：`src/types.ts`（四类数据+实验常量）、`src/rules.ts`（纯验证 decide / reducer applyEvent / 不变量）、`src/engine.ts`（统一入口 submit、去重、save/restore、replay）、`tests/`、`scripts/demo.ts`。
设计见 DESIGN.md，验收见 ACCEPTANCE.md。
