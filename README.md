# Codex Pi Subagents

用 TypeScript 和 pi-coding-agent SDK 给 Codex CLI 的 Astra 提供独立 worker；用户通过复用 pi-tui 的 `cpi-monitor` 查看执行过程。通信设计参考本地 `dsh-delegation-rust` 的状态、进度、最终交接分层。

## 安装前准备

当前以本地 **MCP 服务 + Codex skill** 的形式接入，支持 Windows、macOS、Linux。各平台提供一键项目安装脚本，完成环境检查、依赖安装、编译、平台配置和 `cpi-monitor` 快捷命令注册；首次使用仍需选择 pi 模型、完成认证，并把脚本输出的 MCP 配置接入 Codex。

| 依赖 | 要求与用途 | 安装方式 |
| --- | --- | --- |
| Node.js | **≥ 22.19.0**，运行 MCP 服务、worker 和 monitor | 从 [Node.js](https://nodejs.org/) 安装满足版本要求的发行版，并加入 PATH |
| npm | 安装锁定依赖、编译 TypeScript | 通常随 Node.js 安装 |
| Git / Bash | Windows 必须有 Git Bash；macOS/Linux 使用系统 Bash 或既有 pi shell 配置 | Windows 将 [Git for Windows](https://gitforwindows.org/) 安装到 **`C:\Git`**，必须能运行 `C:\Git\bin\bash.exe`；其他平台无需配置 Windows 路径 |
| Codex CLI | 作为 Astra 调用 MCP 的宿主，需要已安装且能正常启动会话 | 按 [Codex CLI 文档](https://developers.openai.com/codex/cli)安装并完成认证 |
| pi 模型服务与认证 | 至少配置一个 pi 能调用、支持工具调用的模型；可使用已有 pi 配置 | 见下文“配置 pi 的认证、模型与思考强度” |
| ripgrep（`rg`）、fd | 分别用于 pi 的 grep、find 工具 | 可预装并加入 PATH；未找到时，锁定版本的 pi 会尝试下载，因此首次使用需要网络 |
| 目标项目自己的工具链 | worker 要运行构建或测试时才需要，例如 Python/uv、Java、Docker | 按被委派项目的要求安装 |

本项目运行和编译无需 Rust、Cargo、DSH 或 Python。**UV 是可选依赖**：安装前检测 `uv --version`；可用时，subagent 的 system prompt 加入 `When Python is needed, use \`uv run\`.`，仅约束需要 Python 的任务；不可用时不添加这条指令，也不阻止安装。每个 worker 启动时会在 MCP 继承的 PATH 中复查，避免安装后的环境变化造成误判。终端中有 UV、Codex 环境中没有时，以 worker 检测结果为准。

`npm ci` 会自动安装本地依赖，包括 `@earendil-works/pi-coding-agent@0.86.1`、`@earendil-works/pi-tui@0.86.1`、MCP SDK、TypeScript 等，版本由 `package-lock.json` 固定。**不必另外全局安装 TypeScript、pi-tui，也不必全局安装 pi CLI。** 已有可用的 pi CLI 可以继续用于管理配置；下文同时提供本地 CLI 的用法。

Windows 下先在 Git Bash 检查基础环境：

```bash
node --version
npm --version
git --version
codex --version
test -x /c/Git/bin/bash.exe && /c/Git/bin/bash.exe --version
```

Node 版本需要满足最低要求，且上述 Bash 路径必须存在。Codex 启动 MCP 时也必须能找到 `node`；如果其 PATH 不同，请在 MCP 配置中把 `command` 改成 `node.exe` 的绝对路径。

## 各平台一键安装

先安装上表中的 Node.js/npm；Windows 还必须先安装到指定位置的 Git for Windows。取得源码后，在**仓库根目录**执行对应命令。Windows 使用 Git Bash，macOS/Linux 使用自己的终端：

| 平台 | 安装命令 |
| --- | --- |
| Windows | `bash scripts/install-windows.sh` |
| macOS | `bash scripts/install-macos.sh` |
| Linux | `bash scripts/install-linux.sh` |

也可在任意平台执行 `node scripts/install.mjs`，它会自动识别操作系统。入口脚本支持从其他目录以绝对路径调用，仓库路径可包含空格。无需 `sudo`，脚本不会安装操作系统依赖或修改 shell 初始化文件。

安装脚本按顺序执行：

1. 检查 Node.js ≥ 22.19.0、npm、UV 和 pi `settings.json` 的格式。Windows 额外实际运行指定 Git Bash，并检查 Git 是否可用；缺失时停止并提示安装。
2. 在仓库中执行 `npm ci` 与 `npm run build`。依赖安装或编译失败时，不修改 pi 设置。
3. **仅 Windows** 合并写入 `shellPath`，已有配置先逐字备份为同目录的 `settings.json.cpi-backup-<随机ID>`；保留模型、思考强度和其他字段。配置已正确时不重写、不新增备份。macOS/Linux 不创建或改写 pi 设置。
4. 将 `cpi-monitor` 启动脚本注册到 npm 全局命令目录（Windows 为 `npm prefix --global`，macOS/Linux 为该目录下的 `bin/`），固定使用本次安装的 Node 与编译后的 `dist/monitor-cli.js`。Windows 同时提供 PowerShell/CMD 可调用的 `.cmd` 与 Git Bash 入口；macOS/Linux 提供可执行 shell 入口。参数原样转发；重复安装更新本安装器管理的入口，不覆盖其他同名命令。
5. 输出使用当前 Node 和仓库绝对路径的 MCP 配置、技能位置和 monitor 命令，供首次接入使用。已有可用的 Codex 接入可以继续沿用。

快捷命令无需修改 `.zshrc`、`.bashrc` 或 PowerShell profile。安装器检查目标目录是否在当前 PATH 中；目录不可写时可传 `--bin-dir <已在 PATH 的用户可写目录>`，无需 sudo。例如 `bash scripts/install-macos.sh --bin-dir "$HOME/.local/bin"`，前提是该目录已在 PATH。若指定目录未在 PATH，安装器会明确提示，添加后才能通过短命令调用。移动仓库或 Node 后重新运行安装脚本以更新入口。

只检查、不安装或修改文件：

```bash
node scripts/install.mjs --check
```

指定其他 pi 配置目录（同样可追加到各平台脚本后）：

```bash
node scripts/install.mjs --agent-dir '/path/to/pi/agent'
```

默认目录在各平台都是 `~/.pi/agent`，不会把 Windows 用户名 `leahd` 硬编码进安装器。`--agent-dir` 会同时出现在输出的 MCP 参数中；它不会自动采用 `PI_CODING_AGENT_DIR`。`settings.json` 须为普通文件，不支持该文件自身为符号链接；可用 `--agent-dir` 选择实际目录。损坏的 JSON 会阻止安装，不会被空配置覆盖。

Windows 必须在当前使用的 pi 设置文件中保存：

```json
{
  "shellPath": "C:\\Git\\bin\\bash.exe"
}
```

本机对应 **`C:\Users\leahd\.pi\agent\settings.json`**。这只是要合并的字段，不要用它覆盖完整文件。worker 启动时再次校验文件中的路径和 Git Bash 是否可运行，未满足要求会直接失败；不再靠内存覆盖掩盖未配置的状态。

安装时需要能访问 npm 依赖源。编译结果位于 `dist/`；后续 MCP 和 monitor 都运行这里的 JavaScript 文件。源码更新后重新运行对应安装脚本。脚本不读取认证文件、不替用户登录或选择模型；这些步骤见下一节。

### 手动安装

如需分步执行，在仓库根目录运行：

```bash
npm ci
npm run build
```

手动方式下，Windows 需要自行合并上述 `shellPath` 字段；macOS/Linux 无需这项配置。

## 配置 pi 的认证、模型与思考强度

### 配置文件在哪里

默认读取当前系统用户的 `~/.pi/agent/`。Windows 通常对应 `C:\Users\<用户名>\.pi\agent\`；例如本机用户的设置文件是 `C:\Users\leahd\.pi\agent\settings.json`。

| 文件 | 配置什么 | 何时需要 |
| --- | --- | --- |
| `~/.pi/agent/settings.json` | **默认供应商、默认模型、思考强度**，以及 pi 的其他设置 | 本项目必需，且必须有 `defaultProvider`、`defaultModel` |
| `~/.pi/agent/auth.json` | pi 登录得到的凭据，由 `/login` 管理 | 使用 pi 保存的认证时需要；也可按供应商要求使用环境变量 |
| `~/.pi/agent/models.json` | **自定义供应商地址、API 协议、模型定义** | 使用 pi 内置目录之外的服务、代理或自建模型时需要；内置模型通常无需创建 |

模型与思考强度在 **pi 的 `settings.json`** 中选择，不在本仓库的 `package.json`、任务参数或 Codex 主模型设置中选择。`models.json` 负责让 pi 认识模型；只添加模型定义不会自动把它设成 worker 的默认模型。

已有 pi 配置的用户可以直接沿用，不要用下面的示例覆盖整个文件；只合并需要修改的字段。本项目不自动把 Codex CLI 的登录状态转成 pi 认证。

### 方式一：通过 pi 界面配置

已安装 pi CLI 时运行 `pi`。没有全局命令时，完成上面的 `npm ci` 后，在仓库根目录运行相同版本的本地 CLI：

```bash
./node_modules/.bin/pi
```

在 pi 交互界面中依次操作：

1. 输入 `/login`，选择供应商，按提示登录或输入 API key。已有有效认证时跳过。
2. 输入 `/model`，找到希望所有 worker 使用的模型，**按 Ctrl+S 保存为启动默认模型**。这会保存 `defaultProvider` 和 `defaultModel`；仅切换当前会话模型不能替代这一步。
3. 输入 `/thinking`，选择思考强度，**按 Ctrl+S 保存默认值**。如需按模型指定，进入 `/settings` 的 **Default thinking level per model** 配置项。
4. 退出并重新打开 pi，确认启动时的模型和思考强度符合预期。

这些保存操作及字段含义见 [pi 设置文档](https://pi.dev/docs/latest/settings)。认证方式见 [pi 供应商文档](https://pi.dev/docs/latest/providers)。如果希望安装全局 `pi` 命令，可自行执行 `npm install -g @earendil-works/pi-coding-agent@0.86.1`；本项目运行时仍使用仓库本地锁定的 SDK。

### 方式二：直接修改默认模型和思考强度

编辑 `~/.pi/agent/settings.json`，合并以下字段。`my-provider` 和 `my-model-id` 是占位符，替换为 pi `/model` 中对应的供应商 ID、模型 ID，或下面自定义模型配置中的实际值：

```json
{
  "defaultProvider": "my-provider",
  "defaultModel": "my-model-id",
  "defaultThinkingLevel": "high"
}
```

| 字段 | 含义 |
| --- | --- |
| `defaultProvider` | 供应商的精确 ID；自定义服务时对应 `models.json` 中 `providers` 下的键 |
| `defaultModel` | 该供应商下模型的精确 `id`，不是界面显示名；不额外拼接供应商前缀 |
| `defaultThinkingLevel` | 全局默认思考强度；接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `modelThinkingLevels` | 可选的模型专属强度映射，键为精确的 `供应商ID/模型ID`；优先于全局默认值 |

例如，全局默认 `medium`，但当前选中的模型固定使用 `high`：

```json
{
  "defaultProvider": "my-provider",
  "defaultModel": "my-model-id",
  "defaultThinkingLevel": "medium",
  "modelThinkingLevels": {
    "my-provider/my-model-id": "high"
  }
}
```

worker 的实际解析顺序是：**模型专属值 → 全局默认值 → 锁定版本 SDK 的默认值 `medium` → 按模型能力调整**。因此，只修改 `defaultThinkingLevel`，已有的模型专属值仍然优先；要统一强度，需要同时调整或移除对应映射。非推理模型或不支持某档位的模型可能得到不同的有效值，monitor 会显示实际生效的强度。

全局值和模型专属映射均校验上述档位；`max` 是否实际可用仍由模型能力决定。

### 自定义供应商或 API 地址

使用已经可用的 pi 内置供应商时可以跳过此节。自定义服务需在 `~/.pi/agent/models.json` 中添加定义，再用 `settings.json` 选中它。例如：

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://YOUR_API_HOST/v1",
      "api": "openai-completions",
      "apiKey": "$PI_SUBAGENTS_API_KEY",
      "models": [
        {
          "id": "my-model-id",
          "name": "我的子代理模型",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

这是需替换的配置模板：地址、模型 ID、上下文长度、最大输出和推理能力都应按服务实际能力填写。`api` 也必须匹配服务协议；此例是 OpenAI Chat Completions 兼容协议，Responses 或 Anthropic Messages 服务需要使用对应的 pi 协议标识。模型必须支持工具调用；`reasoning: true` 只是声明能力，不能让不支持推理的模型获得该能力。协议及能力字段见 [pi 自定义模型文档](https://pi.dev/docs/latest/models)。

`"$PI_SUBAGENTS_API_KEY"` 表示读取同名环境变量，`$` 不能省略，否则该字符串会被当成字面量 key。由启动 Codex 的环境提供此变量，并在 MCP 配置表中增加：

```toml
env_vars = ["PI_SUBAGENTS_API_KEY"]
```

该行应放在下文的 `[mcp_servers.pi_subagents]` 下，用于把变量转发给 MCP 服务。只在另一终端设置环境变量不会改变已启动 Codex 的环境；通过桌面启动 Codex 时，也需要确保它能获得该变量。若使用 pi `/login` 保存的凭据，可省略示例中的 `apiKey` 字段；不要在 `settings.json` 或仓库内填写明文密钥。

### 自定义配置目录与生效时机

本项目默认固定读取系统用户目录下的 `.pi/agent`。如果你的 pi 使用 `PI_CODING_AGENT_DIR` 改过目录，需要在 MCP 的 `args` 中**显式指定同一个目录**，例如：

```toml
args = ["E:/gitProjects/codex-subagents/dist/cli.js", "--agent-dir", "E:/pi-config/agent"]
```

此时会读取 `E:/pi-config/agent/settings.json`、`auth.json` 和 `models.json`。给 pi CLI 配置这套目录时，在 Git Bash 使用 `PI_CODING_AGENT_DIR='E:/pi-config/agent' ./node_modules/.bin/pi`。

每个新 worker 启动时重新加载设置；已运行的 worker 不会中途切换模型。为保证一批任务使用一致配置，请在上一批全部结束后修改设置，再提交下一批。修改 MCP 启动参数或环境变量后，需要重新连接 MCP / 重启 Codex。worker 不合并目标项目的 `.pi/settings.json`，所以修改项目级模型设置不会改变这些默认值。

## 接入 Codex 并启动 monitor

在 `~/.codex/config.toml`（Windows 通常为 `C:\Users\<用户名>\.codex\config.toml`）中合并 [MCP 配置示例](examples/codex-mcp.toml)，也可使用目标项目的 `.codex/config.toml`。不要覆盖原有配置；已有同名表时修改该表即可。基础配置如下：

```toml
[mcp_servers.pi_subagents]
command = "node"
args = ["E:/gitProjects/codex-subagents/dist/cli.js"]
startup_timeout_sec = 20
tool_timeout_sec = 3900
```

调整其中的绝对路径；环境变量认证或自定义配置目录按前文追加。重新启动 Codex 后通过 `/mcp` 检查 `pi_subagents`。服务是 stdio MCP，`node dist/cli.js` 单独运行时会等待 MCP 输入，不会出现 pi 聊天界面。配置项参考 [Codex MCP 文档](https://developers.openai.com/codex/mcp)。

本仓库的 [pi-subagents 技能](.agents/skills/pi-subagents/SKILL.md)提供委派与等待约定。在其他项目中使用时，将该技能目录复制到目标项目的 `.agents/skills/`，或安装到用户技能目录。无需更改 Astra 的模型设置。

主 agent 每次启动 workers 时，必须明确给出 `cpi-monitor --state-dir {path_state-dir}`，将占位符替换为当前 MCP 连接使用的绝对状态目录，并按用户的 shell 引用路径。MCP 初始化指令会提供该目录；用户可以直接复制命令打开监控。消息回执和失败恢复的细节按需读取技能的 `references/`。

用户在另一终端运行：

```bash
cpi-monitor
```

monitor 启动后先显示任务列表，Enter 进入分类时间线。阶段（包括思考、压缩、重试）、工具、公开输出和最终交接有不同颜色与文字标签；工具参数与结果按调用归组，长内容默认收起；公开文本按 Markdown 渲染，交接按结论、改动、验证和证据展示。思考仅显示开始/结束等可观察阶段，不采集或展示私有推理正文；供应商没有发出思考事件时，不推测思考状态。

所有平台都可使用以下普通字母键，macOS 无需专用 Home/End/PageUp/PageDown 键：

| 操作 | 通用键 | 兼容键 |
| --- | --- | --- |
| 选择 / 逐行滚动 | `j` / `k` | `↓` / `↑` |
| 上一页 / 下一页 | `u` / `d` | `Ctrl+U` / `Ctrl+D`、PageUp / PageDown；空格也可下一页 |
| 回到顶部 / 跟随最新 | `g` / `f`（或 `G`） | Home / End |
| 进入任务 / 返回列表 | Enter / `b` | Esc 返回 |
| 分类：全部、阶段、工具、输出、交接 | `1`–`5` | Tab 循环切换 |
| 展开 / 收起工具参数与结果 | `e` | — |
| 显示帮助 / 退出监控 | `?` / `q` | Ctrl+C 退出 |

退出只关闭 monitor，任务继续运行。可以使用 `--session <ID>` 过滤 MCP 会话，或 `--once` 在非交互环境打印无颜色列表。`--no-color` 或 `NO_COLOR` 环境变量可关闭颜色。MCP 与 monitor 指定相同的 `--state-dir` 即可查看独立状态目录；默认 `~/.cpi/state/`。例如 `cpi-monitor --state-dir <目录>`。

手动安装未注册快捷命令时，也可执行 `node /绝对路径/codex-subagents/dist/monitor-cli.js`（注意是 `.js`，不是 `.ts`）。一键脚本不会自动改写 Codex 配置或复制技能；请按本节完成首次接入。若已有 `npm link` 管理的同名入口，安装器会报告冲突并保留它，可继续沿用原入口或自行整理后再注册。

### 首次使用前确认

完成配置后，在 pi 中发送一个简单请求，确认模型服务能正常响应；这一步会实际调用所选服务。随后在 Codex 中通过 `pi-subagents` 委派一个小型只读任务，并在 monitor 中核对模型、思考强度与最终 handoff。`/mcp` 显示连接成功只证明服务启动成功，不能证明模型认证和配置已通过验证。

| 现象 / 错误码 | 检查位置 |
| --- | --- |
| MCP 无法启动 | Node 版本、`command` 的 PATH、`dist/cli.js` 是否已编译、配置中的绝对路径 |
| `pi_settings_unreadable` | `--agent-dir` 是否正确，`settings.json` 是否存在且是合法 JSON；不支持注释或尾随逗号 |
| `pi_default_model_required` | `settings.json` 是否同时保存了 `defaultProvider` 和 `defaultModel`；在 pi 的 `/model` 中用 Ctrl+S 保存 |
| `pi_configured_model_unavailable` | 供应商 / 模型 ID 是否匹配；自定义模型是否写入正确目录的 `models.json` |
| `pi_thinking_invalid` | `defaultThinkingLevel` 与 `modelThinkingLevels` 是否使用有效档位，映射是否是 JSON 对象 |
| `windows_shell_path_required` | Windows 的 pi `settings.json` 是否包含 `"shellPath": "C:\\Git\\bin\\bash.exe"`；重新执行 Windows 安装脚本可合并配置 |
| `windows_git_bash_required` | `C:\Git\bin\bash.exe` 是否存在、可运行，且 Git 可用；请按指定目录安装 Git for Windows |
| `pi_extension_load_failed` / `pi_extension_start_failed` | 配置的扩展能否加载、注册供应商和执行 `session_start`；在 pi 中排查扩展自身错误 |
| `pi_extension_runtime_failed` / `pi_reserved_tool_conflict` | 扩展运行错误，或扩展使用了保留名称 `report_progress` / `submit_handoff` |
| `model_request_failed` | 用同一套配置在 pi 中确认认证、环境变量、服务连通性及模型协议；MCP 不回传供应商原始错误正文 |
| 改了强度但没有生效 | 是否改到了项目 `.pi/settings.json`；是否有 `modelThinkingLevels` 覆盖；是否查看的是已启动 worker；模型是否支持该强度 |

## 任务与通信

| 接口 | 用途 |
| --- | --- |
| `delegate_batch` | 提交 1–4 个任务，等待整批收尾后返回 handoff；默认并发 3 |
| `send_message` | 给活跃 worker 补充新要求；支持 `steer`、`followUp`、消息 ID 去重和分阶段回执 |
| `read_handoff` | 再次读取当前连接已完成批次的交接；不是状态查询接口 |

参数示例见 [batch.json](examples/batch.json)。每项任务包含 `id`、`title`、`instruction`、`acceptance` 和可选 `mode`，默认 `coding`。顶层 `context` 承载主任务背景、文件分工和已有授权。任务目录必须是绝对路径。一个 MCP 连接同时执行一批，批内超过并发上限的任务排队；并发数通过 `--parallelism 1..4` 设置。

补充消息示例：

```json
{
  "batchId": "my-batch",
  "taskId": "worker-1",
  "messageId": "correction-1",
  "mode": "steer",
  "message": "Additional acceptance criterion: cover empty input and report the result in your handoff."
}
```

`mode` 默认 `steer`：在 SDK 的工具边界参与当前任务，不会强行中断正在执行的工具。`followUp` 等当前轮结束后再处理。`messageId` 可省略，由服务生成；需要重试传输时应自行指定并复用，同任务下相同 ID、相同内容与模式不会重复注入，不同参数会报 `message_id_conflict`。每项任务最多接收 128 条消息。

回执中的 `received` 仅表示 worker 收到；`accepted` 表示 SDK 通过输入处理（扩展也可能消费消息）；`queued` 表示 SDK 已入队；`delivered` 表示观察到带对应 ID 的用户消息进入会话。**这些状态都不表示模型已理解或执行完成。** 最终结果仍以 handoff 为准。`rejected`、`cancelled`、`unknown` 分别表示拒绝、取消或无法确认。首次调用最多等待 5 秒取得 SDK 回执；超时返回 `unknown`，不自动重发。扩展消费/改写消息后无法关联、worker 提前退出时，也会保留明确的未知状态。后续状态由 monitor 展示，Astra 不应轮询回执。

通信有三个独立出口：

1. worker → supervisor：Node IPC 发送就绪信息、5 秒心跳、工具事件、公开进展、结构化交接。每个任务运行在独立 Node 进程和 pi 会话中。
2. supervisor → monitor / MCP 客户端：monitor 读取原子替换的状态快照；订阅了 `progressToken` 的 MCP 调用收到合并后的状态通知。执行详情只供 monitor 展示，不进入最终工具结果。
3. supervisor → Astra：原 `delegate_batch` 调用结束时返回全部任务的终态和 handoff。失败任务有明确的运行时错误码，不伪造 worker 总结。

**MCP progress 不是向 Astra 主动追加消息的机制。** 主模型应等待原调用；宿主有异步调用包装器时，可以继续独立工作，随后续接原句柄。本项目不会修改 Codex harness，也不保证靠工具描述完全消除模型主动查看日志的行为。

worker 使用 `report_progress` 上报公开进展，使用 `submit_handoff` 提交针对原任务的总结。交接包含 `status`、`summary`、`changes`、`verification`、`evidence`、`unresolved`、`nextSteps`，结构和大小经过校验。没有交接时追加一次只允许交接工具的总结轮次；仍缺失则失败，不把最后一条聊天文本冒充交接。提交后如继续工作或接收新用户消息，旧交接失效。

只有 SDK 发出 `agent_settled`、输入队列清空、压缩和重试结束、交接通过校验且 worker 正常退出后，任务才转为交接指定的终态。`agent_end` 可能随后继续重试或处理队列，不作为完成信号。`completed` 不允许同时声明未解决项；`partial`、`blocked`、取消与异常均以 `isError=true` 标记整批工具结果，同时保留其他已成功任务的交接。证据来自 worker，当前版本不自动核验引用行号或文件内容，主 Agent 仍负责验收。

## 配置继承与执行约定

前文说明了配置位置与模型选择方法。执行时还有以下约定：

- `settings.json` 加载为内存副本；模型缺失时直接失败，避免静默选择其他供应商。全局的 retry、compaction、skills、extensions 等仍交给 pi 资源加载器处理。
- worker 不回写全局设置。会话使用内存存储，不持久化完整模型对话或私有推理。认证刷新和模型缓存仍遵循 pi SDK 的行为，模型目录缓存使用标准 `~/.pi/agent/models-store.json`（`--agent-dir` 会一并改变目录）。
- 初始化先通过 `createAgentSessionServices` 加载资源并注册扩展供应商，再解析指定模型；通过 `bindExtensions` 以无交互界面的模式执行 `session_start`。扩展加载、启动或运行失败会报告固定错误码，不输出原始异常内容。需要交互确认或自定义 TUI 的扩展不能依赖 monitor 提供界面。
- 默认编码模式继承 pi 的 `defaultTools` 和扩展工具，同时保留 `report_progress`、`submit_handoff`。未配置 `defaultTools` 时使用 pi 默认内置工具。`read-only` 使用显式列表：read、grep、find、ls 和两项通信工具，不启用扩展注册的工具；扩展钩子仍是受信代码，不构成安全隔离。
- Windows 要求设置文件中的 `shellPath` 为 `C:\Git\bin\bash.exe`，启动时验证 Git Bash 与 Git。其他平台保留 pi 配置的 shell，不检查 Windows 路径。

### 所有平台的 system instruction

[src/instructions.ts](src/instructions.ts) 保存英文 worker 指令和授权边界：**共享/生产系统、不可恢复删除、敏感文件、敏感 Git 操作**。任务模板、补充消息模板、MCP 工具说明和 skill 同样使用英文；用户任务内容原样传递，界面及本使用文档保留中文。worker 通过 SDK 的 `appendSystemPrompt` 为每个任务追加，仅对适用平台和可用工具添加条件指令，无需用户复制到 `AGENTS.md` 或全局 pi prompt 文件。

- 删除前核实目标；不可恢复删除或删除非本会话创建的文件需要明确授权，优先可恢复方式。
- shell 初始化文件、SSH/GPG、pi 认证、私钥与其他凭据默认禁止读写。诊断仅检查存在性；用户明确授权后的读取输出须脱敏，修改须先说明具体操作并获授权。
- 推送、历史重写、丢弃改动等 Git 操作须先说明命令、目标和影响，并取得明确授权；不能擅自绕过钩子。

Windows 再追加 Git Bash/POSIX 语法要求；所有平台仅在检测到 UV 时追加前述 Python 指令。默认仍允许修改任务目录内的普通代码文件，且保留已有 handoff 和通信约定。这些是模型指令，不能视为文件系统沙箱或操作拦截器。

## 生命周期与边界

`requestId` 在同一 MCP 连接内幂等：相同参数返回原执行结果，不再次运行；同 ID 不同参数拒绝。重启后不具备跨连接幂等或断点恢复能力。MCP 断连、调用取消或进程收到终止信号会取消所属任务；不会因为一个 worker 失败自动取消其他 worker。

单任务默认上限 30 分钟，可用 `--task-timeout-ms` 调整（最多 24 小时）。worker 连续 30 秒无 IPC 活动则视为无响应。取消时停止接收新消息、清空本地及 SDK 的 steer/followUp 队列，再中止 SDK；3 秒仍未退出则尝试回收进程树。取消不撤销文件修改，任意 shell 命令自行脱离的外部进程不保证被回收。硬杀宿主不会恢复任务，monitor 在心跳过期后显示“连接失联·状态未知”。没有自动重跑整项收费任务或切换模型的降级路径；单次请求的自动重试仍遵循 pi 设置。

编码模式按当前用户权限执行。**工作目录、read-only 工具列表和提示不是操作系统级沙箱，也没有自动接入 Codex 的宿主审批机制。** 全局 pi 扩展属于用户信任的代码，能自行执行副作用。主 Agent 应只传递已授权任务；需要强隔离时，在容器或受限用户环境中运行本服务。

monitor 只读状态文件，不连接认证配置、不调用模型、不向 worker 输入指令。每个任务保留最近 200 条有界执行事件，旧事件计数明确显示；完整 handoff 单独保留在快照内。状态文本去除终端控制字符并对常见令牌形式脱敏，但无法识别任意格式的秘密，因此状态目录仍应视为用户私有数据。任务指令与主任务上下文不写入快照，供应商原始错误正文不进入 MCP 或日志。

时间线显示公开 assistant 文本和工具中间结果，约 100ms 合并一次；同一工具调用按 `toolCallId` 关联、覆盖累计输出，最终结果覆盖中间版本，避免重复堆叠。单条文本最多 4,000 字符；thinking 事件仅转换为阶段标记，不读取或存储其推理正文、增量文本或签名。旧快照仍可显示已有工具和公开输出，不会凭空补出思考阶段。状态快照约 200ms 合并写入，monitor 每 500ms 刷新。

详情顶部显示压缩阶段、模型/摘要重试与倒计时、两类队列长度、token 用量、缓存读写、工具调用数、上下文占用和估算费用。压缩后尚无新模型用量时，上下文显示“未知”。费用由模型配置的价格计算，零费用也可能表示未配置价格；这些不是供应商账单。消息回执可在详情中查看，Home 返回时间线顶部。

## 为什么使用 SDK

| 模式 | 对当前需求的适用性 |
| --- | --- |
| SDK（当前实现） | TypeScript 中直接注册进展与交接工具、订阅会话事件、管理消息队列和配置；每个 worker 仍放在独立进程，便于取消和故障隔离 |
| RPC | 适合外部程序通过 JSONL 协议控制 pi CLI，尤其是跨语言宿主；当前 TS 实现改用 RPC 还需额外维护协议和扩展安装，不增加已有事件能力 |
| JSON | 适合单次非交互执行并消费事件流；不适合需要在执行中发送纠正和后续任务的双向通信 |

当前已接入 services/扩展生命周期、设置与工具继承、steer/followUp、流式事件、队列状态、压缩/重试、用量统计和 settled 判定。会话持久化、恢复、fork、完整 pi 聊天界面与交互扩展 UI 暂不实现；monitor 保持只读。模式说明见 [SDK](https://pi.dev/docs/latest/sdk)、[RPC](https://pi.dev/docs/latest/rpc)、[JSON](https://pi.dev/docs/latest/json)。

## 开发验证

```bash
npm run check
npm test
```

测试使用本地模拟 worker、MCP 客户端，以及真实 pi SDK 对接的本地 HTTP 模拟模型。覆盖三平台安装分支、UV 有无、Windows 配置合并/备份/重复执行、失败时保护原配置，以及模型请求中的完整安全指令。运行时测试还覆盖配置继承、扩展供应商与启动钩子、工具选择、流式文本和工具结果、消息顺序与回执、自动重试和压缩、用量、取消队列、handoff、幂等、并发、异常、超时和 monitor 交互。所有测试数据位于系统临时目录下的 `pi-subagents-tests/run-*`，不读取正式凭据，不访问真实模型服务。平台分支测试不等于已在每个操作系统上执行原生验收。

目前完成的是本地协议与 SDK 验证；真实供应商、Astra 的委派行为和用户终端观感仍需接入后验收。不能把本地模拟模型测试当作真实模型遵循度或 Codex UI 通知展示的证明。

上游依据：[pi SDK](https://pi.dev/docs/latest/sdk)、[pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui)、[Codex MCP 配置](https://developers.openai.com/codex/mcp)。实际调用接口以锁定 npm 包的类型与实现为准。
