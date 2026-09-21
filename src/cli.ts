#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { Supervisor } from "./supervisor.js";
import { defaultStateDir } from "./store.js";

const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, "agent-dir": { type: "string" },
  parallelism: { type: "string", default: "3" }, "task-timeout-ms": { type: "string", default: "1800000" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("pi-subagents：Codex MCP stdio 服务\n--state-dir <目录>  监控状态目录（默认 ~/.cpi/state）\n--agent-dir <目录>  pi 配置目录（默认 ~/.pi/agent）\n--parallelism <1–4>  并发 worker 数\n--task-timeout-ms <毫秒>  单任务上限（默认 30 分钟）");
} else {
  const timeout = Number(values["task-timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 86_400_000) throw new Error("task_timeout_invalid");
  const supervisor = new Supervisor({
    stateDir: resolve(values["state-dir"] ?? defaultStateDir()),
    agentDir: resolve(values["agent-dir"] ?? join(homedir(), ".pi", "agent")),
    parallelism: Number(values.parallelism), taskTimeoutMs: timeout,
  });
  const server = createMcpServer(supervisor);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= supervisor.close().then(() => server.close());
  server.server.onclose = () => { void stop(); };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
  process.stdin.on("end", () => { void stop(); });
  await server.connect(new StdioServerTransport());
}
