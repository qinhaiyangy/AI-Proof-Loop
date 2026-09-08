# ProofLoop v0.1：真实人工返工验收证据

这是本仓库合成关键词筛选任务的真实检查记录。先固定验收脚本，ProofLoop 实际启动进程得到失败；随后 Codex 修改 src/filter.mjs，再由 ProofLoop 真实复验通过。没有调用额外模型 API，不是 ProofLoop 自主修复。

| 记录 | 结论 | 开始时间（UTC） | 代码标识 |
|---|---|---|---|
| [失败报告](failed/report.md) | FAILED | 2026-09-08T02:42:12.818Z | 6b25a584b12aa3383b67b946e76c7be8288a02061411084f4b85f971eb2315ef |
| [通过报告](passed/report.md) | PASSED | 2026-09-08T02:43:13.030Z | 766203a1b0f62697fab1a4d965fd942d8e7ac4ee5fe9a1bf4116081376cf53ac |

同一任务：keyword-filter；契约版本：1。

契约 SHA-256：87a8bfd6cff9d2c2d8b626b4c074503b4bc11afcc1c477a359a5069e2b51373a

验收标准标识（包含验收脚本）：817d8b596496934f3b4abc5190542e212ac214a613625d8d61c4a4ca32525dc9

两次相同的工具代码标识：c0444970d3b6c207b73aa5cda9783dce3c91c27d584085ac13d3318f14a6b8df

失败 Run：10acb530-80e7-4aa4-ac8e-2cbe6a6e72e1；通过 Run：56c625c6-fc05-49bf-8e0d-d085b705caa2；后者 previousRecordId 指向前者。

## 实际结果

失败时 case-insensitive 检查退出码为 1，实际得到 []，固定期望为 ["Alpha", "alphabet"]；empty-query 与 no-match 均退出 0。修改后上述三个检查均退出 0。

两次契约与验收脚本内容未改变，源码内容改变。[source.diff](source.diff) 从两次保存的源码直接生成完整替换差异；[返工任务](failed/repair-prompt.md) 保留原目标、条件及修改范围。

## 导出与可信边界

这些是公开用的派生脱敏副本，不是逐字节原始日志。本机路径被替换为 <RUN_RECORD>、<EXAMPLE_PROJECT>、<PROOFLOOP_REPO>、<NODE_EXECUTABLE>；修复任务中的占位路径需替换为自己的实际路径后才能执行。源码、验收脚本及契约快照保持原始字节。原本机记录未修改。

导出前重新验证了原始日志 SHA-256、报告内日志内容、检查前后快照内容及代码/契约/标准/工具标识关系。manifest.json 列出所有公开 artifact 的 exportedSha256 及对应原文件 originalSha256；生成的摘要和差异没有单一原文件，因此原始哈希为空。manifest 本身不自包含哈希。report.json 的日志 sha256 指向公开日志字节，同时保留 originalSha256。

导出脚本仅适用于本仓库合成 keyword-filter 示例，不是通用自动脱敏或安全审计产品。公开前仍需检查敏感信息。哈希只识别内容版本，不是防篡改、可信执行或数学正确性证明。

本记录只验证固定的三个条件，不是模型任务成功率或大型 benchmark，也不代表未列入快照的环境和依赖已经验证。两次独立 Run/Attempt 保留历史，不等于断点恢复。

从仓库根目录运行 node scripts/demo-acceptance.mjs 可以重新体验固定错误/正确实现的确定性流程演示；它会生成新的记录，不会冒充这里的人工修改历史。
