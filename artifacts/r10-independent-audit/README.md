# R10 独立核查证据

冻结源码288a288、tree d641ed0。没有新GPU/API调用。主结论与下一轮任务见 `docs/r10-audit/`。

- root-full-tests.log：构建后的全量测试，848 / 847 pass / 0 fail / 1 skip（Windows）。
- root-lifecycle.log：R9 strict生命周期门退出0。
- root-memory-stories.log与summary：四故事独立CPU复跑。
- root-fullmap-normal-stack.log：原图单移动在正常栈重入的根agent复现。
- runtime：七旧反例、三新增边界及恢复子进程记录。
- model：NumPy独立评分/标签/分区/成本复算，metadata-only服务manifest拒绝测试。
- matrix：945请求绑定、全事件分母、机会暴露、E资源投影与完整存档CPU加载检查。
- raw-cpu-audit.tar.gz：全部原始审查文件（含真实子进程存档和四故事快照），保留原字节和原目录。

精简脚本副本仅改了仓库查找及输出目录。默认以本仓库为源码，结果写新临时目录，不覆盖冻结证据。可设 `FROSTECHO_REPO_ROOT` 和 `FROSTECHO_AUDIT_OUT`。归档中的原脚本仍使用审计worktree相邻目录；两者区别见ENVIRONMENT.json。SHA256SUMS校验当前精简副本和原始归档。

从仓库根目录构建后复跑（Node和Python在PATH；NumPy可用）：

```sh
npm run build
node scripts/r9/audit-work-lifecycle.cjs --strict
node artifacts/r10-independent-audit/runtime/r9-regression.cjs
node artifacts/r10-independent-audit/runtime/extra.cjs --fullmap
node artifacts/r10-independent-audit/runtime/extra.cjs
python artifacts/r10-independent-audit/model/audit_r10_training.py --repo . --out /tmp/r10-training-recheck.json
python artifacts/r10-independent-audit/model/check_manifest_contract.py --repo . --out /tmp/r10-manifest-recheck.json
node artifacts/r10-independent-audit/matrix/inspect_saved_authority.cjs
python artifacts/r10-independent-audit/matrix/audit_matrix.py
```

这些是冻结源码的调查脚本：`issueReproduced=true`表示确认该缺陷，不应包装成修复验收通过。R11须另立正反断言，修复后该字段转false并检查有用动作仍能完成。不要把本报告SHA改成新源码，或把历史实模结果重新盖章。
