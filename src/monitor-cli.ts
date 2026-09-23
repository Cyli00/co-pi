#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { MonitorRouter } from "./monitor.js";
import { defaultStateDir, readSnapshots, SnapshotReader } from "./store.js";
import { CodexUsageReader } from "./codex-usage.js";

const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, session: { type: "string" },
  "codex-thread": { type: "string" }, "codex-home": { type: "string" }, workspace: { type: "string" },
  once: { type: "boolean" }, help: { type: "boolean" }, "no-color": { type: "boolean" },
} });
if (values.help) {
  console.log("cpi-monitor：基于 pi-tui 的跨平台只读监控\n--state-dir <目录>  与 MCP 共用的状态根目录\n--session <ID>  只显示指定 MCP 会话\n--codex-thread <ID>  主 agent 线程（默认 CODEX_THREAD_ID，否则自动匹配项目）\n--workspace <目录>  自动匹配的项目（默认当前目录）\n--codex-home <目录>  Codex 数据目录（默认 CODEX_HOME 或 ~/.codex）\n--once  打印一次任务列表，无需交互终端\n--no-color  关闭颜色，也支持 NO_COLOR\n交互：j/k 滚动 · u/d 翻页 · g 顶部 · f 跟随 · 1–5 分类 · e 展开工具 · ? 帮助 · q 退出");
} else {
  const root = resolve(values["state-dir"] ?? defaultStateDir());
  const usageReader = new CodexUsageReader({ home: values["codex-home"], workspace: values.workspace, threadId: values["codex-thread"] });
  if (values.once) {
    const snapshots = readSnapshots(root, values.session);
    const router = new MonitorRouter(() => Math.max(12, snapshots.reduce((count, snapshot) => count + snapshot.tasks.length * 3, 4)), () => {}, () => {}, { color: false });
    router.update(snapshots);
    router.updateCodexUsage(await usageReader.read());
    console.log(router.render(120).join("\n"));
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("交互监控需要 TTY；在用户终端运行，或使用 --once。");
    process.exitCode = 1;
  } else {
    const terminal = new ProcessTerminal();
    const tui = new TuiAltScreen(terminal);
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const quit = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      tui.stop();
      process.stdin.pause();
    };
    const router = new MonitorRouter(() => terminal.rows, () => tui.requestRender(), quit, { color: !values["no-color"] && process.env.NO_COLOR === undefined });
    tui.addChild(router);
    tui.setFocus(router);
    const reader = new SnapshotReader(root, values.session);
    const refresh = () => {
      router.update(reader.read());
      void usageReader.read().then(usage => { if (!stopped) router.updateCodexUsage(usage); });
    };
    router.update(reader.read());
    tui.start();
    refresh();
    timer = setInterval(refresh, 500);
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
  }
}
