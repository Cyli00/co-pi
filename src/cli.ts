#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { McpSessions } from "./mcp-sessions.js";
import { resolveConfigPath } from "./config.js";
import { normalizeThreadId } from "./state-thread.js";

const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, "agent-dir": { type: "string" },
  "thread-id": { type: "string" },
  config: { type: "string" },
  parallelism: { type: "string" }, "task-timeout-ms": { type: "string", default: "1800000" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("co-pi：Codex MCP stdio 服务\n--state-dir <目录>  固定线程的状态目录（未传参数时先读取 CPI_STATE_DIR；macOS 默认使用用户临时目录）\n--thread-id <ID>  固定主 agent 线程（默认 CODEX_THREAD_ID；未设置时按调用元数据 threadId 隔离）\n--agent-dir <目录>  pi 配置目录（默认 ~/.pi/agent）\n--config <文件>  co-pi TOML 配置（默认 ~/.cpi/config.toml；支持 CPI_CONFIG_FILE）\n--parallelism <1–4>  临时覆盖配置中的并发数\n--task-timeout-ms <毫秒>  单任务上限（默认 30 分钟）");
} else {
  await main().catch(error => {
    const code = error?.code;
    console.error(["EPERM", "EACCES", "EROFS"].includes(code)
      ? `state_directory_unwritable (${code})：请用 --state-dir 或 CPI_STATE_DIR 指定允许写入的状态目录，monitor 必须使用同一路径。`
      : error instanceof Error ? error.message : "mcp_start_failed");
    process.exitCode = 1;
  });
}

async function main() {
  const timeout = Number(values["task-timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 86_400_000) throw new Error("task_timeout_invalid");
  const threadId = normalizeThreadId(values["thread-id"] ?? process.env.CODEX_THREAD_ID);
  const sessions = new McpSessions({
    stateDir: values["state-dir"] ?? process.env.CPI_STATE_DIR,
    configPath: resolveConfigPath(values.config),
    threadId,
    agentDir: resolve(values["agent-dir"] ?? join(homedir(), ".pi", "agent")),
    parallelism: values.parallelism === undefined ? undefined : Number(values.parallelism), taskTimeoutMs: timeout,
  });
  const server = createMcpServer(sessions);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= sessions.close().then(() => server.close());
  server.server.onclose = () => { void stop(); };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
  process.stdin.on("end", () => { void stop(); });
  await server.connect(new StdioServerTransport());
}
