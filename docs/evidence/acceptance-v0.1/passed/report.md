> 公开派生副本：已替换本机绝对路径；原始本地证据未修改。日志字节如有脱敏变化，原始与导出 SHA-256 见 manifest.json 及 report.json。

# ProofLoop 本地验收报告

结论：**PASSED**

任务：keyword-filter — 实现字符串数组关键词筛选：大小写不敏感，空查询返回全部，无匹配返回空数组。

Run：56c625c6-fc05-49bf-8e0d-d085b705caa2；Attempt：f74410d8-5353-4924-883a-6883b744371d

开始：2026-09-08T02:43:13.030Z；结束：2026-09-08T02:43:13.209Z

代码标识：766203a1b0f62697fab1a4d965fd942d8e7ac4ee5fe9a1bf4116081376cf53ac

契约 v1：87a8bfd6cff9d2c2d8b626b4c074503b4bc11afcc1c477a359a5069e2b51373a

验收标准（含检查脚本内容）：817d8b596496934f3b4abc5190542e212ac214a613625d8d61c4a4ca32525dc9

ProofLoop 0.1.0；Node v24.19.0；运行层代码标识 c0444970d3b6c207b73aa5cda9783dce3c91c27d584085ac13d3318f14a6b8df

前次记录：10acb530-80e7-4aa4-ac8e-2cbe6a6e72e1。本次是新的 Run / Attempt，不覆盖历史，不是断点恢复。

## 要求与检查

| 要求 | 必需 | 检查 | 结果 |
|---|---|---|---|
| R1: 关键词匹配不区分大小写；ALP 匹配 Alpha 与 alphabet。 | 是 | case-insensitive | PASSED |
| R2: 空查询返回全部输入项，保持顺序。 | 是 | empty-query | PASSED |
| R3: 没有匹配项时返回空数组。 | 是 | no-match | PASSED |

## 实际检查

### case-insensitive: PASSED

程序："<NODE_EXECUTABLE>"；参数：["checks/filter.check.mjs","case-insensitive"]

工作目录：<EXAMPLE_PROJECT>

开始：2026-09-08T02:43:13.042Z；结束：2026-09-08T02:43:13.099Z；退出码：0；超时：3000ms

原因：Process exited with code 0; accepted exit codes: 0.

[stdout](checks/case-insensitive.stdout.log) · [stderr](checks/case-insensitive.stderr.log)

进程清理：No process-tree cleanup was requested.

### empty-query: PASSED

程序："<NODE_EXECUTABLE>"；参数：["checks/filter.check.mjs","empty-query"]

工作目录：<EXAMPLE_PROJECT>

开始：2026-09-08T02:43:13.100Z；结束：2026-09-08T02:43:13.152Z；退出码：0；超时：3000ms

原因：Process exited with code 0; accepted exit codes: 0.

[stdout](checks/empty-query.stdout.log) · [stderr](checks/empty-query.stderr.log)

进程清理：No process-tree cleanup was requested.

### no-match: PASSED

程序："<NODE_EXECUTABLE>"；参数：["checks/filter.check.mjs","no-match"]

工作目录：<EXAMPLE_PROJECT>

开始：2026-09-08T02:43:13.153Z；结束：2026-09-08T02:43:13.202Z；退出码：0；超时：3000ms

原因：Process exited with code 0; accepted exit codes: 0.

[stdout](checks/no-match.stdout.log) · [stderr](checks/no-match.stderr.log)

进程清理：No process-tree cleanup was requested.

## 纳入快照的文件

| 文件 | 类型 | SHA-256 |
|---|---|---|
| contract.json | contract | 87a8bfd6cff9d2c2d8b626b4c074503b4bc11afcc1c477a359a5069e2b51373a |
| project/checks/filter.check.mjs | check | 448a9917a139cc9dd0a3ec89c2677e67faa117fb239c9a25791799697806c836 |
| project/src/filter.mjs | source | 8017641bc6618671ee97120c91c940c3e69b522f58abeb261e2867acf6a91e00 |

文件内容见 snapshots/before；检查后的内容见 snapshots/after。未列出的文件、系统库、外部服务及环境不在内容快照内。

## 未验证与限制

- 通过仅表示当前列明文件在本次检查中满足契约条件，不代表程序绝对正确。
- 检查命令必须由用户信任；这不是安全沙箱。哈希识别内容版本，不是防篡改或可信执行证明。
- ProofLoop 没有调用模型或自主修复；返工由用户与 Codex 完成。
