import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { acquireMonitorInstance, canonicalStateDirectory, findMonitorInstance } from "./monitor-instance.js";
import { WINDOWS_SHELL } from "./platform.js";

export const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export type TerminalCommand = { command: string; args: string[] };

export function terminalCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, script: string): TerminalCommand[] {
  if (platform === "win32") return [
    { command: "wt.exe", args: ["-w", "new", "new-tab", "--title", "co-pi monitor", WINDOWS_SHELL, "--noprofile", "--norc", script] },
    { command: "C:\\Git\\usr\\bin\\mintty.exe", args: ["--title", "co-pi monitor", WINDOWS_SHELL, "--noprofile", "--norc", script] },
  ];
  if (platform === "darwin") {
    if (env.SSH_CONNECTION || env.SSH_TTY) throw new Error("monitor_desktop_unavailable");
    return [{ command: "/usr/bin/open", args: ["-a", "Terminal", script] }];
  }
  if (platform !== "linux") throw new Error("monitor_platform_unsupported");
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error("monitor_desktop_unavailable");
  const command = ["/bin/sh", script];
  const gnome = { command: "gnome-terminal", args: ["--window", "--", ...command] };
  const kde = { command: "konsole", args: ["--separate", "-e", ...command] };
  return [
    ...(env.XDG_CURRENT_DESKTOP?.toLowerCase().includes("kde") ? [kde, gnome] : [gnome, kde]),
    { command: "xfce4-terminal", args: ["--disable-server", "--execute", ...command] },
    { command: "x-terminal-emulator", args: ["-e", ...command] },
    { command: "xterm", args: ["-e", ...command] },
  ];
}

export function monitorScript(node: string, entry: string, args: string[], platform = process.platform): string {
  const paths = platform === "win32" ? [node.replaceAll("\\", "/"), entry.replaceAll("\\", "/")] : [node, entry];
  return `#!/bin/sh\nexec ${[...paths, ...args].map(quoteShell).join(" ")}\n`;
}

async function executable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = /[\\/]/.test(command) ? [command] : (env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const path of candidates) {
    try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return path; }
    catch { /* 继续检查下一个 PATH 目录。 */ }
  }
}

export async function launchTerminal(candidates: TerminalCommand[], env = process.env): Promise<ChildProcess> {
  for (const candidate of candidates) {
    const command = await executable(candidate.command, env);
    if (!command) continue;
    try {
      const child = spawn(command, candidate.args, { env, detached: true, stdio: "ignore", windowsHide: false });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      return child;
    } catch { /* 尚未成功启动终端进程时，可尝试下一种已安装终端。 */ }
  }
  throw new Error("monitor_terminal_unavailable");
}

export type OpenMonitorOptions = {
  stateDir: string; entry: string; args?: string[]; node?: string; platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv; timeoutMs?: number; tempRoot?: string;
  launch?: (commands: TerminalCommand[]) => Promise<ChildProcess | undefined>;
};

export async function openMonitor(options: OpenMonitorOptions): Promise<"opened" | "already-open"> {
  const root = await canonicalStateDirectory(options.stateDir);
  if ((await findMonitorInstance(root))?.ready) return "already-open";
  const token = randomUUID();
  const lease = await acquireMonitorInstance(root, "launcher", token);
  const until = Date.now() + (options.timeoutMs ?? 15_000);
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  let failed = false;
  try {
    if (lease) {
      if ((await findMonitorInstance(root))?.ready) return "already-open";
      const platform = options.platform ?? process.platform;
      const env = options.env ?? process.env;
      // 先检查桌面环境，避免在无桌面的 SSH/CI 中创建启动脚本。
      terminalCandidates(platform, env, "");
      directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "cpi-monitor-"));
      const script = join(directory, "monitor.command");
      await writeFile(script, monitorScript(options.node ?? process.execPath, options.entry,
        ["--state-dir", root, ...options.args ?? [], "--open-token", token], platform), { mode: 0o700 });
      await chmod(script, 0o700);
      const candidates = terminalCandidates(platform, env, script);
      child = await (options.launch ? options.launch(candidates) : launchTerminal(candidates, env));
      child?.on("error", () => { failed = true; });
      child?.on("exit", code => { if (code !== 0) failed = true; });
    }
    while (Date.now() < until) {
      if ((await findMonitorInstance(root))?.ready) return lease ? "opened" : "already-open";
      if (failed) throw new Error("monitor_terminal_failed");
      if (!lease && !await findMonitorInstance(root, "launcher")) {
        if ((await findMonitorInstance(root))?.ready) return "already-open";
        throw new Error("monitor_open_failed");
      }
      await delay(100);
    }
    throw new Error("monitor_open_timeout");
  } finally {
    await lease?.close();
    // 仅清理本次创建的随机临时目录；已运行的 monitor 不依赖脚本文件。
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
