# ProofLoop v0.1

AI 编程任务的本地验收与人工返工工具。

Codex 负责实现，ProofLoop 按事先确定的验收条件启动真实检查，保存与本次代码对应的证据；失败后生成返工任务，由用户交给 Codex 修改，再重新验收。

本版不是独立自动编程 Agent、模型训练项目或通用 Harness 框架。它不调用模型，不自主修复，也不把 Codex 的“完成”总结当作通过证据。

## 这个项目如何完成

这是由 [qinhaiyangy](https://github.com/qinhaiyangy) 主导、在本人监督下使用 Codex 辅助实现的个人工程作品。

- **项目负责人**：确定要解决的问题、冻结第一版范围与验收要求，要求保留失败证据，并决定哪些能力不进入发布。具体选择包括：不把训练或 GPU 作为前提、不做自主 Agent、检查失败不能改标准凑通过、人工返工后必须重新验证。
- **Codex**：在上述要求下完成具体代码与测试实现、运行检查、修复示例源码，并整理文档和脱敏证据。代码并非全部由项目负责人逐行手写；本仓库不以人工代码占比作为能力证明。
- **ProofLoop**：执行已配置的真实检查并记录结果。项目负责人或 Codex 说“完成”，都不能替代本次验收证据。

这个作品展示的是 AI 辅助开发中的需求判断、范围控制、验收设计和结果监督，以及可运行的工程实现。首次公开提交是已有本地工作的精选发布快照，不伪造逐步手写的提交历史，也不公开私人对话来证明贡献。

建议先运行下面的演示，再对照 [真实失败与通过记录](docs/evidence/acceptance-v0.1/)、[固定验收契约](examples/keyword-filter/contract.json) 和 [核心编排函数 `verify`](src/acceptance/verify.mjs) 阅读代码。设计测试验证抽象规则；运行层测试才实际启动检查进程，二者不能相互替代。

## 运行要求

- Node.js 24；当前验收 CLI 仅使用 Node.js 内置模块，无需额外安装依赖。
- 可信的本地项目与检查命令；无需模型 API、GPU、CUDA、ROCm 或云端算力。
- Windows 路径可以包含空格和中文。下面命令均从本仓库根目录运行。

本次交付入口是 `src/acceptance/cli.mjs`，仅包含验收 CLI、示例、测试、证据及使用说明。原有 `design-tests/` 与 `docs/domain/examples/` 的 JSON 夹具保留，用于检验历史抽象设计规则，不代表完整审批、事件流或恢复能力已经实现。完整历史设计、Recorded/React 路线、其它前端草案和历史构建配置留在开发工作仓库，不进入本次精选发布，也不是本版运行依赖；无需执行 `pnpm install` 或 `pnpm build`。设计测试不是产品验证器。

## 先看演示

首次获取仓库：

```powershell
git clone https://github.com/qinhaiyangy/AI-Proof-Loop.git
cd AI-Proof-Loop
```

然后运行（已经位于仓库目录时只需这一条）：

```powershell
node scripts/demo-acceptance.mjs
```

脚本在新建的 `.proofloop/demo-*` 独立目录中复制关键词筛选小例子，先使用明确标注的错误实现运行真实验收，再换入预设正确实现并重新验收。每次演示使用新目录，不覆盖之前的记录，也不修改日常开发项目。

这是**确定性的失败→返工→通过流程演示**，不是实时模型自主修复。两次检查都会真正启动 Node.js 进程；脚本打印证据位置。演示验收标准是：关键词大小写不敏感、空查询返回全部、无匹配返回空数组。

本轮由 Codex 实际修改源码得到的失败与通过证据、文件标识和差异，见 [真实运行记录](docs/evidence/acceptance-v0.1/)。它与可重复执行的预设演示明确区分。

## 验收一个任务

检查仓库自带的小例子：

```powershell
node src/acceptance/cli.mjs verify examples/keyword-filter/contract.json
```

终端显示结论和证据目录。每次执行都在被检查项目的 `.proofloop/acceptance/<taskId>/<recordId>/` 下生成独立记录，包含：

- `contract.json`：本次使用的原契约；
- `report.json`、`report.md`：任务、代码与契约标识、检查结果、要求覆盖和未验证事项；
- `checks/*.stdout.log`、`checks/*.stderr.log`：实际进程的原始输出；
- `snapshots/before/`、`snapshots/after/`：显式列入范围的文件内容；
- 非通过时的 `repair-prompt.md`：原目标和验收条件、失败事实、证据位置、允许修改范围与复验命令。

将 `repair-prompt.md` 交给 Codex，审查其修改，再运行相同验证命令。ProofLoop 不替你启动 Codex。不得通过删除测试、放宽断言、修改预期答案或忽略失败来达标。

日志文件保留原始字节；JSON 中的 stdout/stderr 是 UTF-8 文本预览。报告还记录 Node 版本与 ProofLoop 运行层文件的内容标识。

## 手工编写验收契约

使用 JSON，参考完整的 [关键词筛选契约](examples/keyword-filter/contract.json)。最小单检查结构如下：

```json
{
  "schemaVersion": 1,
  "taskId": "my-task",
  "version": 1,
  "goal": "明确说明要完成的任务",
  "projectDir": ".",
  "sourceFiles": ["src/target.mjs"],
  "allowedChanges": ["src/target.mjs"],
  "requirements": [
    {
      "id": "R1",
      "description": "需要由检查证明的具体行为",
      "required": true,
      "checkIds": ["behavior"]
    }
  ],
  "checks": [
    {
      "id": "behavior",
      "executable": "node",
      "args": ["checks/behavior.mjs"],
      "cwd": ".",
      "timeoutMs": 3000,
      "passExitCodes": [0],
      "files": ["checks/behavior.mjs"]
    }
  ]
}
```

这个结构示意需要对应的真实源码和检查脚本，不能原样复制后期望通过。

| 字段 | 含义 |
|---|---|
| `taskId` / `goal` | 稳定任务标识与目标；目标文字本身不是可执行检查 |
| `version` | 正整数契约版本；不得用同一版本悄悄更换标准 |
| `projectDir` | 相对契约文件所在目录解析的被检查项目目录 |
| `sourceFiles` | 显式纳入快照的源码文件，至少一个；相对项目目录，不支持目录或通配符 |
| `allowedChanges` | 返工任务允许修改的源码子集，不是权限隔离；不能包含验收脚本 |
| `requirements` | 需求与检查 ID 的对应关系，至少一个必需要求 |
| `executable` / `args` | 可执行文件与字符串参数数组，分开传给进程，不拼接任意 shell 文本 |
| `cwd` | 检查工作目录，相对项目目录且必须留在项目内 |
| `timeoutMs` | 每项检查必须提供，范围为 1–300000 毫秒 |
| `passExitCodes` | 明确的通过退出码列表；本版不按自然语言日志判断通过 |
| `files` | 该检查使用的脚本及依赖文件清单；内联命令可以用空数组 |

检查列表不能为空，错误配置会被拒绝。`checkIds: []` 的要求标为需要人工验收；若它是必需要求，则整体无法判定，不默认通过。本版没有人工验收签署界面。

必须手工列全参与验收的源码、检查脚本和本地依赖。ProofLoop 不自动发现 import、系统库、安装包或外部服务依赖；未列入文件不受版本快照覆盖。契约自动纳入快照；证据目录 `.proofloop` 不得列入，测试产生的临时文件也不应列入。

直接执行的本地文件必须在清单中。`node script.mjs` 的入口及 `node --test` 的显式测试文件必须列入 `files`，不能当作允许修改的源码。Windows 下 `.cmd`/`.bat` 不保证能被无 shell 的进程调用直接启动；优先使用真实可执行文件和明确参数。

## 结论与版本边界

| 结论 | CLI 退出码 | 含义 |
|---|---|---|
| `PASSED` / 通过 | `0` | 所有列出的检查及必需要求满足契约，且本次证据与文件稳定性检查可用 |
| `FAILED` / 未通过 | `1` | 检查实际执行并返回不满足契约条件的明确结果 |
| `INCONCLUSIVE` / 无法判定 | `2` | 无法启动、超时、中断、证据不完整、必需要求未覆盖或输入不稳定等 |
| 拒绝执行或保存 | `3` | 配置、契约版本或证据存储等错误；不表示检查通过 |

退出码 0 只按契约解释，不证明产品绝对正确。无法判定优先于失败；报告仍保留每个已执行检查的事实。

没有 Git HEAD 也能运行：源码内容生成 `codeId`，契约原始字节生成 `contractId`，契约与验收脚本内容共同生成 `standardId`。报告保存实际纳入的文件清单和 SHA-256；它们用于识别版本，不是防篡改或可信执行证明。

检查前后快照与文件变动监控发现源码、契约或检查脚本变化时，本次不能通过，必须重新验收。监控是尽力观察，不是对恶意仓库的可信执行保证。旧报告永远只对应旧代码，不能沿用为新代码的通过结论。

每次验证创建新的 Run 和其中一个 Attempt，`previousRecordId` 仅关联同一任务的历史记录，不复用旧 Run，不覆盖日志，也不是断点恢复。缺失或损坏的历史报告会明确拒绝继续，不默默跳过。

同一项目、同一任务同时只允许一次验证。强制结束 ProofLoop 可能留下 `active.lock` 或不完整记录；工具不会自动重放或自动删除它们。先确认原进程已经停止、人工检查记录，再决定如何保留和处理，不要把清锁当作断点恢复。

契约或验收脚本确需改变时，先取得用户确认，再递增 `version` 并执行：

```powershell
node src/acceptance/cli.mjs verify path/to/contract.json --approve-contract-change
```

该参数只用于已获用户确认的新标准，不能由 Codex 自行批准。即使只更改契约格式，原始字节标识也会改变。首版的手工契约与主动运行代表用户提交，不实现历史设计中完整的审批界面或审批事件系统。

## 验证产品

```powershell
node --test --test-timeout=30000 design-tests/*.test.mjs
node --test --test-timeout=30000 runtime-tests/*.test.mjs
```

第一条运行原有设计契约测试；第二条验证真实进程和文件系统运行层。测试数量不是任务成功率。每次验收的通过条件以契约和原始日志为准，不能拿设计夹具中预设的 `PASSED` 代替运行证据。

## 核心数据流与限制

`JSON 契约 → 配置校验与历史标准核对 → 文件快照 → 启动检查进程 → 检查后快照 → 要求结果与最终结论 → 报告及人工返工任务`。

运行编排在 `src/acceptance/verify.mjs` 的 `verify`，实际进程执行在 `src/acceptance/process-runner.mjs` 的 `runCheck`。它们不是模拟状态迁移的设计测试。

- 这是运行用户信任命令的工具，不是安全沙箱，不适合安全执行任意陌生仓库。
- 超时或中断只尝试处理本次检查的进程；Windows 使用针对当前检查 PID 的有界进程树清理，不能保证脱离或重挂进程树的后代已经停止。报告明确保留清理限制，不管理用户其它服务。
- Windows 进程树清理失败时，会有界尝试终止本次直接子进程并记录是否观察到退出。后代清理未确认时，不再启动本轮后续检查。实际等待上限还包括最多约 1.5 秒的清理阶段，不只配置的检查时间。
- 单次检查 stdout/stderr 合计捕获上限为 1 MiB；超出时证据截断且结论无法判定，不会假装保留了完整日志。
- 报告、快照与原始日志可能含绝对路径、源码或命令输出中的敏感内容。公开前必须人工检查，不能直接上传整个 `.proofloop`、环境配置或私人工作记录。
- 没有自动模型调用、自动修复循环、RAG、浏览器控制、安全沙箱、Checkpoint 恢复或新前端。本版只交付本地验收与人工返工闭环。

版本范围见 [v0.1 发布说明](docs/releases/acceptance-v0.1.md)。公开仓库为 [AI-Proof-Loop](https://github.com/qinhaiyangy/AI-Proof-Loop)，采用 [MIT 许可证](LICENSE)。
