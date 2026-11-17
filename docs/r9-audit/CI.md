# 近14天PR与CI复盘范围

查询窗口2026-11-04至17，GitHub连接器按updated搜索返回3个PR：#10（G07，11/2创建、11/4更新）、#11（G08，11/4）、#12（R6，11/13），均draft/open/未合并。PR和运行时间为GitHub UTC时间；不能用未合并年龄替代代码开发用时。R7–R9没有对应PR，故Git历史复盘与PR分析是两个范围。

已下载每个PR尖端关联的最新工作流12个job，以及R6.1成功续作4个job的原始日志；没有宣称穷举两周所有历史CI重试。公共REST请求遭rate-limit 403后，改用已连接的官方GitHub工具取原始日志，未用猜测补时间。

最慢的已观察任务（日志首尾跨度，包含setup/清理）：

- PR#11 Windows22，run41763821429/job126357405548，21640.015秒，npm test阶段被取消。
- PR#12 Ubuntu22，run43364432889/job131685373652，21612.225秒，npm test阶段被取消；最后输出停在G04 CLI相关状态/退出测试，之后到取消没有完成记录。
- PR#12 Windows22，同run/job131685373948，21601.962秒，取消。
- 同一R6运行的Windows20/Ubuntu20成功job分别180.401/153.542秒，不能因此把六小时差距解释成正常平台性能。
- R6.1 run43393992212四job成功：Ubuntu20 56.720秒、Ubuntu22 59.846秒、Windows20 96.778秒、Windows22 115.666秒。npm test阶段约42.156/44.479/67.493/78.569秒。

这与a86c8a1/b70dd2c的有界子进程/exit promise、假HTTP请求与条件同步修正相符；单次日志不足以断言同一race在每个平台都完全相同。不要用“重试CI直到绿”代替确定的启动/退出与资源清理。

当前R9可独立复现的更重要问题：默认只发现dist/tests，src同目录测试虽编译却漏跑。已修发现器，同时收dist/src；原默认780项779pass/1skip，扩展后811项808pass/1skip/2fail。两个失败与延迟动作迁移相关，保持非零退出。未把它们混同safe-delete或Python环境问题。

优化顺序：先保证发现/失败信号完整，再给每个子进程有界退出与正确事件监听，最后量慢测试/checkout。PR#12 API统计跨192提交/5854文件/约120万新增行，含大量历史证据；后续用有当前base的增量PR与SHA归档控制评审面，不删原始证据、不改旧冻结运行来减少diff。

证据：artifacts/r9-independent-audit/github/connector-metadata.json 与 job-logs-raw.json.gz；数据只来自上述16个job和3个PR。CI链接：[G08](https://github.com/PoetryJ/frostecho/actions/runs/41763821429)、[R6](https://github.com/PoetryJ/frostecho/actions/runs/43364432889)、[R6.1](https://github.com/PoetryJ/frostecho/actions/runs/43393992212)。
