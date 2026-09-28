## 一键安装脚本更新要求
更新时需要适配 windows 的 ps 脚本，以及适配 macOS 和 linux 的 sh 脚本。

## 在当前 Codex 线程测试 co-pi 更新

测试 MCP 服务更新时，优先保留当前 Codex CLI 和线程，使用 `scripts/reload-mcp.mjs` 重载连接，无须新建 Codex 会话。脚本要求当前会话使用可访问控制 socket 的共享 App Server，且 Codex 支持 `app-server proxy` 和 `config/mcpServer/reload`。
