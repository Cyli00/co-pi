#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { Supervisor } from "./supervisor.js";
import { defaultStateDir } from "./store.js";
import { normalizeThreadId } from "./state-thread.js";

const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, "agent-dir": { type: "string" },
  "thread-id": { type: "string" },
  parallelism: { type: "string", default: "3" }, "task-timeout-ms": { type: "string", default: "1800000" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("co-pi：Codex MCP stdio 服务\n--state-dir <目录>  固定线程的状态目录（有线程 ID 时默认 ~/.cpi/state/<线程ID>）\n--thread-id <ID>  绑定的主 agent 线程（默认 CODEX_THREAD_ID）\n--agent-dir <目录>  pi 配置目录（默认 ~/.pi/agent）\n--parallelism <1–4>  并发 worker 数\n--task-timeout-ms <毫秒>  单任务上限（默认 30 分钟）");
} else {
  const timeout = Number(values["task-timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 86_400_000) throw new Error("task_timeout_invalid");
  const threadId = normalizeThreadId(values["thread-id"] ?? process.env.CODEX_THREAD_ID);
  const supervisor = new Supervisor({
    stateDir: resolve(values["state-dir"] ?? (threadId ? join(defaultStateDir(), threadId) : defaultStateDir())),
    threadId,
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
