#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { createMonitorTui } from "./monitor-tui.js";
import { DETAIL_SHORTCUTS, MonitorRouter } from "./monitor.js";
import { readSnapshots, SnapshotReader } from "./store.js";
import { resolveStateDirectory } from "./state-directory.js";
import { MonitorUsageReader } from "./codex-usage.js";
import { normalizeThreadId, resolveStateThread } from "./state-thread.js";
import { fileURLToPath } from "node:url";
import { openMonitor, quoteShell, describeMonitorError } from "./monitor-open.js";
import { readConfig, resolveConfigPath } from "./config.js";
import { acquireMonitorInstance, canonicalStateDirectory, findMonitorInstance } from "./monitor-instance.js";

const { values } = parseArgs({ options: {
  config: { type: "string" },
  "state-dir": { type: "string" }, session: { type: "string" },
  "thread-id": { type: "string" }, "codex-thread": { type: "string" }, "codex-home": { type: "string" }, workspace: { type: "string" },
  once: { type: "boolean" }, help: { type: "boolean" }, "no-color": { type: "boolean" },
  open: { type: "boolean" }, "open-token": { type: "string" },
} });
if (values.help) {
  console.log("cpi-monitor：基于 pi-tui 的跨平台只读监控\n--state-dir <目录>  与 MCP 共用、绑定固定线程的状态目录\n--config <文件>  读取终端偏好，默认 ~/.cpi/config.toml\n--open  在配置的终端打开监控，同一状态目录不重复启动；不能与 --once 合用\n--session <ID>  只显示指定 MCP 会话\n--thread-id <ID>  固定主 agent 线程，必须与目录绑定一致（兼容 --codex-thread）\n--workspace <目录>  兼容旧参数，不再用项目猜测线程\n--codex-home <目录>  Codex 数据目录（默认 CODEX_HOME 或 ~/.codex）\n--once  打印一次任务列表，无需交互终端\n--no-color  关闭颜色，也支持 NO_COLOR\n缓存用量首次立即查询，此后每 10 秒刷新。\n交互：" + DETAIL_SHORTCUTS + " · q 退出");
} else {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : "monitor_start_failed");
    process.exitCode = 1;
  });
}

async function main() {
  if (values.open && values.once) throw new Error("--open 不能与 --once 合用。");
  if (values["open-token"] && (values.open || values.once)) throw new Error("monitor_open_arguments_invalid");
  const threadId = normalizeThreadId(values["thread-id"] ?? values["codex-thread"]);
  if (values["thread-id"] && values["codex-thread"] && threadId !== normalizeThreadId(values["codex-thread"])) throw new Error("state_thread_conflict");
  const defaultThread = values["state-dir"] || process.env.CPI_STATE_DIR !== undefined ? undefined : threadId ?? normalizeThreadId(process.env.CODEX_THREAD_ID);
  const root = await canonicalStateDirectory(resolveStateDirectory(values["state-dir"], defaultThread));
  if (values.open) {
    const configPath = resolveConfigPath(values.config);
    const config = await readConfig(configPath, !values.config && !process.env.CPI_CONFIG_FILE);
    const entry = fileURLToPath(import.meta.url);
    const args: string[] = [];
    const boundThread = resolveStateThread(root, threadId);
    if (boundThread) args.push("--thread-id", boundThread);
    if (values.session) args.push("--session", values.session);
    const codexHome = values["codex-home"] ?? process.env.CODEX_HOME;
    if (codexHome) args.push("--codex-home", resolve(codexHome));
    if (values["no-color"] || process.env.NO_COLOR !== undefined) args.push("--no-color");
    try {
      const status = await openMonitor({ stateDir: root, entry, args, terminal: config.monitor.terminal });
      console.log(status === "opened" ? "监控已在终端中就绪。" : "该状态目录已有监控运行，未重复开窗；沿用已有监控的筛选条件。");
      return;
    } catch (error) {
      console.error(describeMonitorError(error));
      console.error(`请在本机终端手动运行：\n${[process.execPath.replaceAll("\\", "/"), entry.replaceAll("\\", "/"), "--state-dir", root, ...args].map(quoteShell).join(" ")}`);
      console.error("无桌面或无法交互时，在上述命令末尾追加 --once 读取一次状态。");
      if (!process.stdin.isTTY || !process.stdout.isTTY) { process.exitCode = 1; return; }
      console.error("自动开窗不可用，改在当前 TTY 中显示监控；按 q 退出。");
    }
  }
  const usageReader = new MonitorUsageReader({ home: values["codex-home"], stateDir: root, threadId });
  if (values.once) {
    const snapshots = readSnapshots(root, values.session);
    const router = new MonitorRouter(() => 12, () => {}, () => {}, { color: false });
    router.update(snapshots);
    router.updateCodexUsage(await usageReader.read(snapshots));
    console.log(router.render(120, true).join("\n"));
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("交互监控需要 TTY；在用户终端运行，或使用 --once。");
    process.exitCode = 1;
  } else {
    const token = values["open-token"];
    if (token && (await findMonitorInstance(root, "launcher"))?.token !== token) throw new Error("monitor_open_request_expired");
    const instance = await acquireMonitorInstance(root, "monitor");
    if (!instance) { console.log("该状态目录已有监控运行，未重复启动。"); return; }
    const terminal = new ProcessTerminal();
    const tui = createMonitorTui(terminal);
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const quit = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      tui.stop();
      process.stdin.pause();
      void instance.close();
    };
    const router = new MonitorRouter(() => terminal.rows, () => tui.requestRender(), quit, { color: !values["no-color"] && process.env.NO_COLOR === undefined });
    tui.addChild(router);
    tui.setFocus(router);
    const reader = new SnapshotReader(root, values.session);
    const refresh = () => {
      const snapshots = reader.read();
      router.update(snapshots);
      void usageReader.read(snapshots).then(usage => { if (!stopped) router.updateCodexUsage(usage); });
    };
    try {
      router.update(reader.read());
      tui.start();
      refresh();
      await instance.markReady();
    } catch (error) {
      quit();
      throw error;
    }
    if (stopped) return;
    timer = setInterval(refresh, 500);
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    process.once("SIGHUP", quit);
    process.stdin.once("end", quit);
  }
}
