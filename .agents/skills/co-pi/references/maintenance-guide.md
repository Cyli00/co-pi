# 维护与开发

[返回使用指南](../../../../README.md)

- [附录 A：旧名称迁移](#附录-a旧名称迁移)
- [附录 B：安装行为、目录与运行包](#附录-b安装行为目录与运行包)
- [附录 C：开发与测试](#附录-c开发与测试)

## 附录 A：旧名称迁移

项目、npm 包和 skill 统一使用 `co-pi`，版本仍为 `0.1.2`。名称对应关系如下：

| 入口 | 当前名称 | 兼容与迁移 |
| --- | --- | --- |
| npm 包 / 运行归档 | `co-pi` / `co-pi-0.1.2.tgz` | 原名 `codex-pi-subagents`；重新生成的归档使用新名 |
| MCP 服务及配置表 | `co-pi` / `[mcp_servers.co-pi]` | 原配置键为 `pi_subagents`，按安装器输出迁移同一个表，保留已有参数及环境变量 |
| skill | `$co-pi`，目录 `.agents/skills/co-pi/` | 更新项目或用户目录中原来的 `pi-subagents` 技能副本，并包含 `references/` |
| CLI | `co-pi` | npm `bin` 同时保留 `pi-subagents` 别名，两者指向 `dist/cli.js` |
| monitor / 状态数据 | `cpi-monitor` / `~/.cpi/state/` | 命令与数据路径保持兼容；旧安装器创建的启动脚本可正常更新 |

升级前先结束任务并关闭原 MCP 连接。重跑安装器后，将 Codex 中旧表名改为 `co-pi`，不要同时注册两个指向同一服务的表。旧表名只是宿主标签，保留它仍可启动原 JS 入口，但工具前缀会继续使用旧标签。安装器只输出配置，不会擅自修改用户的 Codex 配置。

技能名称没有自动别名：将已安装的旧技能目录备份到技能发现目录之外，再复制新的 `co-pi/`，重启 Codex 并使用 `$co-pi`。不要只改调用文字而保留旧的 `SKILL.md`。仓库内技能已改名，外部项目或用户目录中的副本需要自行同步。

GitHub 仓库地址和本地仓库目录尚未改名，因此文档中的 `codex-subagents` 克隆地址与路径仍有效。

服务名称不要求安装目录也叫 `co-pi`。

## 附录 B：安装行为、目录与运行包

### 安装器的执行顺序

安装依次完成：

1. 预检 Node/npm、UV、pi 设置格式、目录权限和命令冲突。Windows 额外检查指定 Git Bash 和 Git。
2. 源码安装依赖并编译，运行包校验资源后安装生产依赖。成功后复制全局插件和完整技能，包括 `references/`。
3. 备份并合并 pi 设置。Windows 合并 `shellPath`，macOS/Linux 保留原 shell。
4. 注册 `cpi-monitor`。Windows 生成 Bash 脚本和 `.cmd`，macOS/Linux 生成可执行脚本。入口绑定当前 Node 和 JS 的绝对路径。
5. 输出全局副本的 MCP 配置、技能路径和监控命令。用户合并 MCP 配置，并在 pi 中配置模型与认证。

配置目录可以是链接，`settings.json` 本身必须是普通文件。合并时只移除旧安装器注册的本项目完整权限扩展引用，保留独立包及规则。原设置备份为 `settings.json.cpi-backup-<随机ID>`。

源码路线保留重装所需源码和构建配置，运行包路线保留运行包布局。构建失败不发布全局副本，也不修改 pi 设置。安装器不覆盖其他工具管理的同名快捷入口。

目标已有非本安装器管理的同名目录或目录链接时停止，不覆盖原内容。重装会将原插件和技能移入对应父级用户目录的 `co-pi-backups/`，然后切换完整副本。

默认备份目录为 `~/.codex/co-pi-backups/`。备份和失败时留下的临时副本均保留，不自动删除。`--check` 同样检查全局目标冲突且不写文件。全局插件附带 `.codex-plugin/plugin.json` 与 `.mcp.json`。

当前安装器采用直接 MCP 接入，不注册插件市场、不写入 Codex 管理的 `plugins/cache/`。若另行通过插件市场启用，应先处理重复的 MCP 与独立 skill。插件格式依据：[OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)。

macOS/Linux 首次安装可能不会创建 `settings.json`，应按[pi 配置步骤](../../../../README.md#配置-pi)保存默认模型。

源码路线的 `npm ci` 会重装安装目录中的依赖，执行前请结束活动 worker 和 monitor。若后续快捷命令注册失败，前面已经完成的构建和配置不会自动撤销，可排查后重跑。

### 目录用途与运行包构建

| 位置 | 用途 |
| --- | --- |
| `src/` | TypeScript 源码，仅源码安装包含 |
| `dist/` | MCP、worker、monitor 实际运行的 JS 和资源，不能在运行安装中整体删除 |
| `dist/vendor/pi-permission-system/` | 已整合的解析器缓存、路径规范化、Bash WASM 和许可证；保留来源名称，不是完整旧扩展 |
| `.agents/skills/co-pi/` | 主 agent 委派、等待、消息及恢复约定；复制时需包含 `references/` |
| `scripts/` | 安装和快捷命令管理；源码目录额外包含构建/打包脚本 |
| `.agents/skills/co-pi/references/` | 技术参考与维护附录；随技能和运行包分发 |
| `tests/`、`examples/` | 开发测试与配置示例，仅源码安装包含 |
| `~/.pi/agent/` | pi 设置、模型及认证；可用 `--agent-dir` 替换 |
| `~/.cpi/state/` | MCP 状态快照；monitor 需使用相同 `--state-dir` |

源码构建会生成 `.js`、类型声明 `.d.ts` 和调试 `.js.map`。

后两者不是运行必需文件。普通 `tsc` 不自动清理旧 JS，所以源码删改后本地 `dist/` 可能留有旧产物。运行包每次在全新目录编译，包含运行 JS、资源、安装脚本、技能、README、文档附录和锁文件，不带测试、源码、架构数据或调试文件。

维护者可从源码生成预编译包：

```bash
npm ci
npm run package:runtime -- --out-dir "$HOME/cpi-releases"
```

命令只本地打包，不发布。

输出归档位置、大小、文件数和保留的临时构建目录。普通 `npm pack` 不等同于这条运行包构建路线。

`tree-sitter-bash@0.25.1` 仅用于构建：检查固定版本和 SHA-256 后，将 WASM、MIT 许可证与版本元数据随包复制。

运行版不再安装其 C 源码、原生绑定和多平台预编译二进制，继续使用 `web-tree-sitter` 与原有 AST 权限策略。共享 handoff 约束、阶段枚举和静止判断减少重复维护，两端校验仍保留。

Windows 本机一次对比中，`node_modules` 从约 188 MB 降至 141 MB，计入移入运行包的 WASM 后净减少约 45 MB。该数字比较源码开发安装与生产运行安装，随平台和依赖版本变化，不代表下载体积、内存或推理 token 的同比降低。pi SDK 仍保留自身运行依赖。

当前未绕过其锁文件强制去重，也未切换到私有轻量入口。

## 附录 C：开发与测试

### 运行测试

```bash
npm run check
npm test
```

开发验证在源码安装中执行，运行包不含测试与 TypeScript。测试使用本地模拟 worker、MCP 客户端，以及真实 pi SDK 对接的本地 HTTP 模拟模型。

| 范围 | 覆盖内容 |
| --- | --- |
| 安装 | 三平台分支、统一和兼容入口、UV 有无、Windows 配置合并/备份/重复执行、失败保护原配置 |
| 运行包 | 文件集合、附录文档、生产锁文件、WASM 版本与哈希 |
| 契约 | 共享交接约束、阶段枚举、静止判定、模型请求中的完整安全指令 |
| SDK 运行时 | 配置继承、扩展供应商与启动钩子、工具选择、流式文本与结果、消息顺序与回执、重试与压缩、用量 |
| 调度与交付 | 取消队列、handoff、幂等、并发、异常、超时 |
| monitor | 交互、开窗与重复请求、Codex 用量增量读取、cache-hit 展示 |
| 审批 | 执行前等待、命令前缀、逐次批准、拒绝后继续、无审批能力、普通 accept、非法响应、超时、传输错误、取消和迟到批准 |

测试数据位于系统临时目录的 `co-pi-tests/run-*`，不读取正式凭据，不访问真实模型服务。原生平台、真实供应商和宿主行为的验证范围见 [README](../../../../README.md#附录)。本地模拟测试不证明真实模型遵循度或 Codex UI 通知展示。

上游依据：[pi SDK](https://pi.dev/docs/latest/sdk)、[pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui)、[Codex MCP 配置](https://developers.openai.com/codex/mcp)。实际调用接口以锁定 npm 包的类型与实现为准。

### 为什么使用 SDK

| 模式 | 对当前需求的适用性 |
| --- | --- |
| SDK（当前实现） | TypeScript 中直接注册进展与交接工具、订阅会话事件、管理消息队列和配置；每个 worker 仍放在独立进程，便于取消和故障隔离 |
| RPC | 适合外部程序通过 JSONL 协议控制 pi CLI，尤其是跨语言宿主；当前 TS 实现改用 RPC 还需额外维护协议和扩展安装，不增加已有事件能力 |
| JSON | 适合单次非交互执行并消费事件流；不适合需要在执行中发送纠正和后续任务的双向通信 |

当前已接入 services/扩展生命周期、设置与工具继承、steer/followUp、流式事件、队列状态、压缩/重试、用量统计和 settled 判定。会话持久化、恢复、fork、完整 pi 聊天界面与交互扩展 UI 暂不实现。

monitor 保持只读。模式说明见 [SDK](https://pi.dev/docs/latest/sdk)、[RPC](https://pi.dev/docs/latest/rpc)、[JSON](https://pi.dev/docs/latest/json)。
