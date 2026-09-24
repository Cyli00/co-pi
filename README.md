# co-pi

为 Codex 提供独立的 pi 子代理和终端监控器 `cpi-monitor`。主 agent 负责分工与验收，worker 执行任务并返回结构化交接。通过本地 stdio MCP 和 `$co-pi` 技能接入，无需 Web 服务或数据库。当前版本为 0.1.2。

| 能力 | 用途 |
| --- | --- |
| 并行委派 | 每批 1–4 项任务，默认并发 3；支持编码和只读调查 |
| 执行中纠正 | 通过 `steer` / `followUp` 补充要求，消息 ID 去重 |
| 结构化交接 | 返回结果、改动、验证、证据和未完成项 |
| 主 agent 接管 | worker 失败后，主 agent 用自己的上下文完成剩余任务 |
| 权限检查 | 工作区路径与 Bash AST 检查，外部访问和未知范围进入 Codex 审批 |
| 终端监控 | 自动开窗，查看时间线、交接、模型用量和主线程 cache-hit |
| 配置继承 | 沿用 pi 的模型、认证、思考强度及扩展 |
| 跨平台安装 | Windows、macOS、Linux 共用安装器，支持源码和预编译运行包 |

## 极速上手：三步跑通

前提：Node.js ≥ 22.19.0、npm、Bash，以及已登录的 Codex。Windows 的 Git Bash 必须位于 `C:\Git\bin\bash.exe`。首次准备环境请看[安装前准备](#安装前准备)。

### 1. 取得项目并安装

从维护者取得 `co-pi-0.1.2.tgz`，替换归档路径后执行：

```bash
mkdir cpi-runtime-0.1.2
tar -xzf '/path/to/co-pi-0.1.2.tgz' -C cpi-runtime-0.1.2 --strip-components=1
cd cpi-runtime-0.1.2
bash scripts/install.sh
```

没有运行包时，按[源码安装](#获取项目与安装)取得项目，再执行相同安装命令。运行包由维护者本地构建，不假定已发布到 npm 或 GitHub Releases。

### 2. 配置 worker 模型

在刚才的目录运行：

```bash
./node_modules/.bin/pi
```

在 pi 中用 `/login` 登录供应商，用 `/model` 选择模型并按 Ctrl+S 保存默认值，再用 `/thinking` 选择并保存思考强度。已有可用配置时直接沿用。

### 3. 接入 Codex，运行第一个任务

把安装器输出的 `[mcp_servers.co-pi]` 配置合并到 `~/.codex/config.toml`，然后重启 Codex。技能已由安装器安装。

在 Codex 输入：

```text
$co-pi 派发一个 read-only 任务，阅读当前项目的 README 和 package.json，概括入口与测试命令。不得修改文件；返回结构化交接，标明证据及未运行的验证。
```

主 agent 会尝试自动打开 monitor。在其中核对 worker 模型、思考强度和最终交接。此任务会调用配置的 pi 模型服务，认证和费用与 Codex 主模型分开。

## 阅读导航

- [安装前准备](#安装前准备)
- [获取项目与安装](#获取项目与安装)
- [配置 pi](#配置-pi)
- [接入 Codex 与 monitor](#接入-codex-与-monitor)
- [任务、通信与权限](#任务通信与权限)
- [排障指南](#排障指南)
- [附录：迁移、构建与技术参考](#附录)

## 安装前准备

| 依赖 | 要求 |
| --- | --- |
| Node.js / npm | Node ≥ 22.19.0，使用[匹配系统架构的发行版](https://nodejs.org/en/download)；Codex 自带运行环境不能代替它 |
| Bash / Git | Windows 安装 [Git for Windows](https://gitforwindows.org/) 到 `C:\Git`；macOS/Linux 准备 Bash，克隆和更新源码时需要 Git |
| Codex CLI | 按[官方文档](https://learn.chatgpt.com/docs/codex/cli)安装，运行 `codex` 完成登录 |
| 模型服务 | 至少一个支持工具调用的模型及其认证 |
| 终端 / 解压工具 | 交互监控需要 UTF-8 终端和 TTY；解压 `.tgz` 可用 `tar` 或图形归档工具 |

安装依赖需要访问 npm，取得项目需要访问源码或归档来源，worker 需要访问模型服务。pi 找不到 `rg`、`fd` 时会尝试从 GitHub 下载。离线环境应预先提供这两个命令；部分 Linux 发行版的 `fdfind` 需提供为 pi 可找到的 `fd`。

UV 可选。检测到 `uv --version` 可用时，worker 收到使用 `uv run` 执行 Python 的指令。项目所需的 Python、Java、Docker、编译器等另行准备。标准安装不要求全局 pi CLI、TypeScript、Rust、Cargo 或 DSH；特殊平台的原生构建依赖以安装错误为准。

| 平台 | 特别约定 |
| --- | --- |
| Windows | 使用 Windows 版 Node/npm。Bash 示例在 Git Bash 中执行；PowerShell 入口需要可选的 PowerShell 7，不支持 Windows PowerShell 5.1。worker 仍使用 Git Bash |
| macOS | Node 需匹配 Apple Silicon / Intel。需要 Git 时可用 Apple Command Line Tools 或包管理器；保留 pi 原有 shell，无需 Windows 路径 |
| Linux | 检查发行版提供的 Node 版本。使用版本管理器时先激活所需版本 |
| WSL | 在同一发行版内按 Linux 流程安装并配置；使用 Linux 路径，不混用 Windows 的 Node、安装目录或凭据目录 |

工具必须能在启动 Codex 的环境中找到。调整 PATH 后重启终端或桌面应用；MCP 可直接使用 Node 的绝对路径。

## 获取项目与安装

源码路线适合开发或没有运行包的情况：

```bash
git clone https://github.com/Cyli00/codex-subagents.git
cd codex-subagents
bash scripts/install.sh
```

也可下载源码归档。进入包含 `package.json`、`package-lock.json`、`src/`、`scripts/` 的目录。默认分支版本以 `package.json` 为准。

运行包的解压命令见[极速上手](#极速上手三步跑通)。图形解压后，进入同时包含 `package.json`、`npm-shrinkwrap.json`、`dist/`、`scripts/` 的目录。Windows Git Bash 可使用 `C:/Users/用户名/Downloads/...tgz` 形式的路径。

| 路线 | 安装器执行 |
| --- | --- |
| 源码 | `npm ci`，再执行 `npm run build` |
| 运行包 | 校验资源和 WASM，再执行 `npm ci --omit=dev`；无本地编译步骤 |

运行包不带 `node_modules`，首次安装仍需 Node 和 npm 网络访问。它不提供 `npm run build`；文件损坏时重新解压完整包。

### 统一入口与参数

三平台使用同一个入口，自动识别操作系统：

```bash
bash scripts/install.sh --check
bash scripts/install.sh
```

`--check` 只预检，可按需使用。也可直接运行 `node scripts/install.mjs`。支持从其他目录用绝对路径调用，路径可以包含空格。

旧入口继续兼容，并校验所在操作系统：

| 平台 | 兼容命令 |
| --- | --- |
| Windows Git Bash | `bash scripts/install-windows.sh` |
| Windows PowerShell 7 | `pwsh -NoProfile -File scripts/install-windows.ps1` |
| macOS | `bash scripts/install-macos.sh` |
| Linux / WSL | `bash scripts/install-linux.sh` |

| 参数 | 默认值 / 行为 |
| --- | --- |
| `--check` | 检查环境、配置、目标冲突和运行包完整性，不写文件 |
| `--agent-dir <目录>` | pi 配置目录，默认 `~/.pi/agent`；不自动采用 `PI_CODING_AGENT_DIR` |
| `--bin-dir <目录>` | 快捷命令目录；Windows 为 npm 全局 prefix，macOS/Linux 为该 prefix 下的 `bin/` |
| `--plugin-dir <目录>` | 插件目录，默认 `~/.codex/plugins/co-pi` |
| `--skills-dir <目录>` | 技能父目录，默认 `~/.codex/skills`，其下安装 `co-pi/` |
| `--help` | 显示帮助 |

设置 `CODEX_HOME` 时，全局插件和技能默认安装到该目录。显式参数优先。安装属于当前用户，无需管理员权限。

Windows 安装器会备份并合并 pi 的 `shellPath: "C:\Git\bin\bash.exe"`，保留模型等已有字段。macOS/Linux 保留原 shell。

全局命令目录不可写时，可改用用户目录：

```bash
bash scripts/install.sh --bin-dir "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
```

`export` 只影响当前终端。安装器不修改 shell 初始化文件，也不代装 Node/Git/Codex、登录认证或选择模型。[安装顺序、备份和失败处理](.agents/skills/co-pi/references/maintenance-guide.md#安装器的执行顺序)见附录。

### 更新或重装

先结束任务，关闭 MCP 连接和 monitor，再运行安装器。源码改动后也需要重装，才会同步全局副本。

```bash
# 仅重装当前源码或运行包
bash scripts/install.sh

# Git 更新：先保存本地改动，且当前分支已有上游
git pull --ff-only && bash scripts/install.sh
```

运行包更新时，将新版解压到新目录后安装。旧目录不会被自动删除。首次用过的路径参数需继续传入；改变 Node 或全局目标路径后，还需按安装器输出更新 MCP 配置。

完成后重连 MCP、重开 monitor。移动原源码或解压目录不会影响已安装的全局副本。只做本地开发构建时使用 `npm run build`；它不会更新全局安装或快捷命令。

## 配置 pi

默认目录为系统用户的 `~/.pi/agent/`。Windows 通常是 `C:\Users\<用户名>\.pi\agent\`，macOS/Linux 分别在 `/Users/<用户名>/`、`/home/<用户名>/` 下。

| 文件 | 用途 |
| --- | --- |
| `settings.json` | 必填的 `defaultProvider`、`defaultModel`，以及思考强度等设置 |
| `auth.json` | `/login` 管理的认证；也可按供应商要求使用环境变量 |
| `models.json` | 可选的自定义供应商地址、协议和模型定义 |

worker 模型在 pi 设置中选择，不在任务参数或 Codex 主模型设置中选择。已有配置只合并所需字段，不要用示例覆盖整个文件。

安装后，在项目目录运行 `./node_modules/.bin/pi`；已有全局 CLI 时可运行 `pi`。PowerShell 7 对应命令为 `& .\node_modules\.bin\pi.cmd`。

| 操作 | 在 pi 中执行 |
| --- | --- |
| 认证 | `/login`，按供应商要求登录或输入 API key |
| 保存模型 | `/model` 选择模型，按 Ctrl+S 保存启动默认值 |
| 保存强度 | `/thinking` 选择强度，按 Ctrl+S 保存默认值 |
| 按模型设置强度 | `/settings` → Default thinking level per model |
| 确认配置 | 重开 pi，检查模型和强度，再发一个简单请求 |

只切换当前会话模型不能替代保存默认值。项目不会把 Codex 登录状态转换成 pi 认证。可选的全局 CLI 安装命令为 `npm install -g @earendil-works/pi-coding-agent@0.86.1`，worker 仍使用本地锁定的 SDK。

自定义 `--agent-dir` 时，安装器、MCP 和 pi CLI 必须指向同一目录：

```bash
PI_CODING_AGENT_DIR='/实际/pi/agent' ./node_modules/.bin/pi
```

新 worker 启动时加载设置，正在运行的 worker 不会切换模型。请在批次结束后改配置。worker 不合并项目级 `.pi/settings.json`；更改 MCP 参数或环境变量后需重连。

[模型字段、强度优先级和自定义 API 完整示例](.agents/skills/co-pi/references/technical-reference.md#模型配置)见技术参考。上游说明：[pi 设置](https://pi.dev/docs/latest/settings)、[供应商认证](https://pi.dev/docs/latest/providers)。

## 接入 Codex 与 monitor

### MCP 配置

将安装器输出合并到 `~/.codex/config.toml`；设置 `CODEX_HOME` 时使用该目录，也可放在受信项目的 `.codex/config.toml`。已有同名表时修改它，保留其他配置。

```toml
[mcp_servers.co-pi]
command = "node"
args = ["C:/Users/alice/.codex/plugins/co-pi/dist/cli.js"]
startup_timeout_sec = 20
tool_timeout_sec = 3900
```

优先采用安装器输出的 Node 和 JS 绝对路径。macOS/Linux 的 JS 路径通常分别为 `/Users/<用户名>/.codex/plugins/co-pi/dist/cli.js`、`/home/<用户名>/.codex/plugins/co-pi/dist/cli.js`。TOML 不会展开 `$HOME` 或 `~`。

| 服务参数，追加到 `args` | 默认值 / 用途 |
| --- | --- |
| `--agent-dir <目录>` | `~/.pi/agent`，与 pi 配置位置保持一致 |
| `--state-dir <目录>` | 有线程 ID 时为 `~/.cpi/state/<线程ID>`，否则为 `~/.cpi/state` |
| `--thread-id <ID>` | 固定主线程，默认读取服务端 `CODEX_THREAD_ID` |
| `--parallelism <1–4>` | 默认 3，同时运行的 worker 数 |
| `--task-timeout-ms <毫秒>` | 默认 1800000；合法范围 100–86400000 |

`tool_timeout_sec = 3900` 覆盖默认四任务、并发三的两轮执行。减少并发或提高单任务超时时，也要增加整批工具调用的时间预算。

使用环境变量认证时，在同一个 MCP 表中添加对应的 `env_vars`，如 `env_vars = ["PI_SUBAGENTS_API_KEY"]`。变量必须存在于启动 Codex 的环境中。修改后重启 Codex，用 `/mcp` 检查连接。

技能默认安装到 `~/.codex/skills/co-pi/`，包含 `SKILL.md` 与 `references/`。项目内 `.agents/skills/co-pi/` 是开发源文件。已有非安装器管理的同名技能时，先移到技能发现目录之外备份，避免重复加载。

首次验证任务见[极速上手](#极速上手三步跑通)。`/mcp` 检查连接，pi 中的简单请求检查模型认证，首个委派检查整条流程。源码配置示例见 [examples/codex-mcp.toml](examples/codex-mcp.toml)，接入规则见 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。

### 监控常用命令

主 agent 首次向某个状态目录派发任务前，会按[技能规则](.agents/skills/co-pi/SKILL.md)自动开窗。用户选择不打开时跳过；关闭后不反复重开。开窗失败时展示原因和手动命令，继续任务。

下面的目录必须替换成 MCP 初始化说明给出的实际绝对路径：

```bash
# 自动打开可见终端
cpi-monitor --open --state-dir '/实际状态目录'

# 在当前终端查看
cpi-monitor --state-dir '/实际状态目录'

# 无 TTY 时打印一次
cpi-monitor --once --state-dir '/实际状态目录'
```

| 平台 | 自动开窗方式 |
| --- | --- |
| Windows | 优先 Windows Terminal；找不到或无法创建进程时尝试 Git Bash Mintty |
| macOS | 系统 Terminal；SSH 会话回退手动启动 |
| Linux | 需要 `DISPLAY` 或 `WAYLAND_DISPLAY`，尝试 GNOME Terminal、Konsole、Xfce Terminal、`x-terminal-emulator`、xterm |

`--open` 使用当前 Node 与 monitor 的绝对路径，最多等待约 15 秒确认就绪。相同状态目录不重复开窗，也不更改已有窗口的筛选条件。失败退出码为 1，并返回 Bash/zsh 手动命令。它不能与 `--once` 合用。

没有注册快捷命令时，可用 `node /实际安装目录/dist/monitor-cli.js` 加相同参数。退出监控不影响 worker。

| 参数 | 用途 |
| --- | --- |
| `--state-dir <目录>` | 与 MCP 使用相同目录 |
| `--session <ID>` | 筛选 MCP 会话，不是 Codex 线程 ID |
| `--thread-id <ID>` | 显式指定主线程，必须与目录绑定一致 |
| `--codex-thread <ID>` | `--thread-id` 的兼容别名 |
| `--codex-home <目录>` | Codex 数据根目录，默认 `CODEX_HOME` 或 `~/.codex`，不是其 `sessions` 子目录 |
| `--workspace <目录>` | 兼容旧参数，不再按工作区猜测线程 |
| `--no-color` / `NO_COLOR` | 关闭颜色 |
| `--help` | 显示帮助 |

### 快捷键与用量

| 操作 | 主按键 | 兼容按键 |
| --- | --- | --- |
| 选择 / 逐行滚动 | ↑ / ↓ | k / j |
| 上一页 / 下一页 | w / s | PgUp / PgDn、u/d、Ctrl+U/D；空格下一页 |
| 回顶 / 跟随最新 | Home / End | g / f 或 G；部分键盘用 fn+↑/↓ |
| 进入任务 / 返回列表 | Enter / Esc | b 返回 |
| 切换全部、阶段、工具、输出、交接 | ← / → | Tab / Shift+Tab；数字键不再切换 |
| 展开 / 折叠工具和 SDK 思考文本 | t | 默认折叠，分类间共享状态 |
| 帮助 / 退出 | ? / q | Ctrl+C 退出 |

`fn+↑/↓` 的行为取决于终端发送的是 Home/End 还是 PageUp/PageDown。帮助页支持滚动；时间线按事件保留阅读位置，旧事件淘汰不会带走仍缓存的当前内容。

时间线展示工具调用、Markdown 公开输出和交接证据。仅展示 SDK 提供的非屏蔽思考文本，不读取签名；没有正文时显示提示，不补造旧记录。

主 agent cache-hit 来自固定 Codex 线程的最近一次用量记录，首次立即读取，此后每 10 秒刷新。worker 用量单独显示，任务快照每 500ms 刷新。

- `—` 表示无记录、数据无效、线程不明确或读取失败；真正零命中显示 `0.0%`。
- 用量更新时间来自日志事件。无有效时间时显示“记录时间未知”，无记录时显示“尚无用量记录”。
- 线程按状态目录绑定，不按最近活动或项目猜选；旧目录的绑定方法见[技术参考](.agents/skills/co-pi/references/technical-reference.md#监控与线程绑定)。
- 费用按模型配置估算，零费用也可能表示没有配置价格。压缩后尚无新用量时，上下文占用显示“未知”。

## 任务、通信与权限

主 agent 派发完整任务、文件范围、验收条件和已有授权，同时保留自己的独立工作。worker 返回交接后，主 agent 核实改动、补齐剩余项并验证。

worker 进入 `failed` 终态后，由主 agent 用自己的当前上下文接管。先检查已有改动，不自动重新派发失败任务或切换 worker 模型。`partial`、`blocked`、`failed`、`cancelled` 都不算成功。用户取消或暂停时遵循用户要求。

| 接口 | 使用方式 |
| --- | --- |
| `delegate_batch` | 每批 1–4 项任务，等待整批终态后返回交接 |
| `send_message` | 给活跃 worker 补充要求；`steer` 在工具边界处理，`followUp` 等当前轮结束 |
| `read_handoff` | 重读当前连接已完成批次，不用于轮询状态 |

主 agent 需收集原始委派调用的最终结果。进度通知和消息回执不能替代交接。一个 MCP 连接同时运行一批，多个编码 worker 共用工作区，应明确文件归属。

每个 worker 使用独立进程和内存会话。默认超时 30 分钟；取消不会撤销文件改动。当前不支持完整会话持久化、跨连接恢复或自动创建 Git worktree。[参数、交接字段、消息幂等和生命周期契约](.agents/skills/co-pi/references/technical-reference.md#任务与通信)见技术参考。

### 权限边界

worker 以宿主用户权限执行，代码及工具结果会发送到配置的模型服务。工作区路径检查和 `read-only` 工具列表不是操作系统沙箱。

- 确认在工作区内的普通文件工具和已识别的简单 shell 操作可直接执行。
- 外部路径访问、Git、Python/Node、脚本和未知范围操作交给 Codex 自动审批。
- 拒绝后不执行本次调用，worker 可尝试已有授权范围内的安全替代方案；不得绕过拒绝。
- 敏感文件、删除、共享或生产系统、敏感 Git 操作仍须遵循用户授权边界。
- 扩展代码和获批脚本以宿主权限运行。需要强隔离时使用容器、受限用户或系统沙箱。

已验证的 Codex CLI 0.155.1 可用 `codex --approve-for-me`，或合并以下 TOML 顶层设置，放在所有 `[表名]` 之前：

```toml
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
```

安装器不修改这些设置。其他宿主需核对版本和组织策略。普通 MCP 表单的 accept 不能代替自动审批凭据。[路径策略、MCP 元数据和响应校验](.agents/skills/co-pi/references/technical-reference.md#工作区权限与-codex-自动审批)完整保留在技术参考。

monitor 不调用模型、不读取认证配置、不向 worker 发指令。快照不保存任务指令或主任务上下文，但会保存有界的执行事件、SDK 思考文本和完整交接。脱敏不能识别所有秘密，状态目录应按用户私有数据管理。

## 排障指南

不调用模型的检查命令：

```bash
bash scripts/install.sh --check
node dist/cli.js --help
node dist/monitor-cli.js --help
```

### 安装阶段

| 现象 / 错误码 | 检查与处理 |
| --- | --- |
| Node 版本不足，或 `node` / `npm` 找不到 | 在启动 Codex 的同一环境检查版本和 PATH，激活版本管理器后重启应用 |
| `windows_git_bash_required` | 确认 `C:\Git\bin\bash.exe` 和 Git 可用 |
| `runtime_assets_invalid` | 重新解压完整运行包，不删除 WASM 来绕过校验 |
| 运行包没有 `npm run build` | 使用安装器；开发时改用源码路线 |
| 网络或包下载错误 | 检查 npm 源、代理和 GitHub 连通性，不输出认证信息 |
| `monitor_directory_unwritable` | 用 `--bin-dir` 选择用户可写目录，并加入 PATH |
| `monitor_command_conflict` | 保留已有入口，使用完整 JS 路径或其他目录；检查是否由 `npm link` 管理 |
| `global_install_conflict` / `global_install_overlap` | 同名目标必须由本安装器管理，不能是链接或与源码、技能目录互相包含；备份原目录或改用独立目标 |
| `settings_invalid_json` / `settings_not_regular_file` | 修复 JSON；配置目录可为链接，`settings.json` 自身必须是普通文件 |

### 配置与启动阶段

| 现象 / 错误码 | 检查与处理 |
| --- | --- |
| `cpi-monitor` 找不到或指向旧版本 | 检查安装输出和 PATH；更换 Node 或安装位置后重装，重新打开终端 |
| MCP 无法启动 | 检查 Node 版本、`command`、JS 绝对路径和构建产物；单独运行 stdio 服务会等待协议输入 |
| `$co-pi` 未被识别 | 技能目录需含 `SKILL.md` 与 `references/`；确认 MCP 已注册并重启 Codex |
| `pi_settings_unreadable` | 检查 `--agent-dir` 和合法 JSON，不支持注释或尾随逗号 |
| `pi_default_model_required` | `/model` 中按 Ctrl+S，保存 `defaultProvider` 和 `defaultModel` |
| `pi_configured_model_unavailable` | 核对供应商和模型 ID；自定义定义应在正确目录的 `models.json` 中 |
| `pi_thinking_invalid` / 强度不生效 | 检查档位、模型专属映射和模型能力；项目级设置不生效，已运行的 worker 不会重载 |
| `windows_shell_path_required` | 重跑安装器合并正确 `shellPath`，不要覆盖整个配置文件 |
| `pi_extension_load_failed` / `pi_extension_start_failed` | 在 pi 中排查扩展加载、注册和 `session_start` |
| `--open` 失败 | 检查桌面环境及终端，使用返回的手动命令；无 TTY 时使用 `--once` |

### 执行与审批阶段

| 现象 / 错误码 | 检查与处理 |
| --- | --- |
| `permission_approval_unsupported` / 未获批准 | 核对宿主版本、自动审批能力和策略；本次操作不执行，worker 可尝试安全替代方案 |
| `model_request_failed` | 在同一 pi 配置下检查认证、环境变量、服务和协议；MCP 不回传供应商原始错误正文 |
| `pi_extension_runtime_failed` / `pi_reserved_tool_conflict` | 排查扩展运行错误，以及是否覆盖内置工具或两项通信保留名 |
| monitor 没有任务 | 核对实际 `--state-dir` 和 `--session`；未委派时“等待第一项委派”正常 |
| cache-hit 为 `—` / `state_thread_conflict` | 核对固定线程与日志目录；旧目录按明确 ID 绑定，不猜最新线程。无用量记录不影响 worker |

## 附录

- [附录 A：旧名称迁移](.agents/skills/co-pi/references/maintenance-guide.md#附录-a旧名称迁移)
- [附录 B：安装行为、目录与运行包构建](.agents/skills/co-pi/references/maintenance-guide.md#附录-b安装行为目录与运行包)
- [附录 C：开发与测试](.agents/skills/co-pi/references/maintenance-guide.md#附录-c开发与测试)
- [技术参考：模型配置、任务契约、审批协议与监控实现](.agents/skills/co-pi/references/technical-reference.md)

Windows 已完成本机安装、运行包和监控开窗验证；macOS/Linux 有平台分支测试，尚未完成各系统桌面实测。本地模拟模型测试覆盖协议和 SDK，真实供应商及主 agent 行为仍需接入后验证。
