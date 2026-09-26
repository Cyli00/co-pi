import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { acquireMonitorInstance, canonicalStateDirectory, findMonitorInstance, type InstanceLease } from "./monitor-instance.js";
import { safeText } from "./protocol.js";
import { WINDOWS_SHELL } from "./platform.js";
import type { MonitorTerminal } from "./config.js";

export const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export type TerminalCommand = { command: string; args: string[] };

export function terminalCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, script: string, terminal: MonitorTerminal = "auto"): TerminalCommand[] {
  if (terminal !== "auto") {
    if (platform === "darwin") {
      if (env.SSH_CONNECTION || env.SSH_TTY) throw new Error("monitor_desktop_unavailable");
      if (terminal === "ghostty") return [{ command: "/usr/bin/open", args: ["-n", "-a", "Ghostty", "--args", "-e", "/bin/sh", script] }];
      if (terminal !== "terminal") throw new Error("monitor_terminal_platform_mismatch");
    } else if (platform === "win32") {
      if (!["windows-terminal", "mintty"].includes(terminal)) throw new Error("monitor_terminal_platform_mismatch");
      return terminalCandidates(platform, env, script).filter(candidate => terminal === "mintty" ? candidate.command.endsWith("mintty.exe") : candidate.command === "wt.exe");
    } else if (platform === "linux") {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error("monitor_desktop_unavailable");
      if (terminal === "ghostty") return [{ command: "ghostty", args: ["-e", "/bin/sh", script] }];
      const selected = terminalCandidates(platform, env, script).filter(candidate => candidate.command === terminal);
      if (!selected.length) throw new Error("monitor_terminal_platform_mismatch");
      return selected;
    } else throw new Error("monitor_platform_unsupported");
  }
  if (platform === "win32") return [
    { command: "wt.exe", args: ["-w", "new", "new-tab", "--title", "co-pi monitor", WINDOWS_SHELL, "--noprofile", "--norc", script] },
    { command: "C:\\Git\\usr\\bin\\mintty.exe", args: ["--title", "co-pi monitor", WINDOWS_SHELL, "--noprofile", "--norc", script] },
  ];
  if (platform === "darwin") {
    if (env.SSH_CONNECTION || env.SSH_TTY) throw new Error("monitor_desktop_unavailable");
    return [{ command: "/usr/bin/open", args: ["-a", "/System/Applications/Utilities/Terminal.app", script] }];
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

const terminalDiagnostics = new WeakMap<ChildProcess, string>();

export async function launchTerminal(candidates: TerminalCommand[], env = process.env): Promise<ChildProcess> {
  let lastError: unknown;
  for (const candidate of candidates) {
    const command = await executable(candidate.command, env);
    if (!command) continue;
    try {
      const child = spawn(command, candidate.args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: false });
      child.stderr?.on("data", chunk => {
        terminalDiagnostics.set(child, safeText((terminalDiagnostics.get(child) ?? "") + chunk.toString(), 2_000));
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      return child;
    } catch (error) { lastError = error; }
  }
  throw new Error("monitor_terminal_unavailable", { cause: lastError });
}

export type OpenMonitorOptions = {
  stateDir: string; entry: string; args?: string[]; node?: string; platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv; timeoutMs?: number; tempRoot?: string;
  terminal?: MonitorTerminal;
  launch?: (commands: TerminalCommand[]) => Promise<ChildProcess | undefined>;
};

export async function openMonitor(options: OpenMonitorOptions): Promise<"opened" | "already-open"> {
  let stage = "状态目录检查";
  let lease: InstanceLease | undefined;
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  let failed: number | string | undefined;
  try {
    const root = await canonicalStateDirectory(options.stateDir);
    stage = "实例文件锁";
    if ((await findMonitorInstance(root))?.ready) return "already-open";
    const token = randomUUID();
    lease = await acquireMonitorInstance(root, "launcher", token);
    const until = Date.now() + (options.timeoutMs ?? 15_000);
    if (lease) {
      if ((await findMonitorInstance(root))?.ready) return "already-open";
      const platform = options.platform ?? process.platform;
      const env = options.env ?? process.env;
      // 先检查桌面环境，避免在无桌面的 SSH/CI 中创建启动脚本。
      stage = "桌面环境检查";
      terminalCandidates(platform, env, "", options.terminal);
      stage = "启动脚本写入";
      directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "cpi-monitor-"));
      const script = join(directory, "monitor.command");
      await writeFile(script, monitorScript(options.node ?? process.execPath, options.entry,
        ["--state-dir", root, ...options.args ?? [], "--open-token", token], platform), { mode: 0o700 });
      await chmod(script, 0o700);
      const candidates = terminalCandidates(platform, env, script, options.terminal);
      stage = "终端启动";
      child = await (options.launch ? options.launch(candidates) : launchTerminal(candidates, env));
      child?.on("error", () => { failed = "spawn_error"; });
      child?.on("exit", (code, signal) => { if (code !== 0) failed = code ?? signal ?? "unknown"; });
      if (child?.exitCode !== undefined && child.exitCode !== null && child.exitCode !== 0) failed = child.exitCode;
      if (child?.signalCode) failed = child.signalCode;
    }
    stage = "等待监控就绪";
    while (Date.now() < until) {
      if ((await findMonitorInstance(root))?.ready) return lease ? "opened" : "already-open";
      if (failed !== undefined) {
        stage = "终端启动";
        throw Object.assign(new Error("monitor_terminal_failed"), { exitCode: failed, terminalDiagnostic: child && terminalDiagnostics.get(child) });
      }
      if (!lease && !await findMonitorInstance(root, "launcher")) {
        if ((await findMonitorInstance(root))?.ready) return "already-open";
        throw new Error("monitor_open_failed");
      }
      await delay(100);
    }
    throw new Error("monitor_open_timeout");
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : "monitor_open_failed", { cause: error }), { stage });
  } finally {
    child?.stderr?.destroy();
    await lease?.close();
    // 仅清理本次创建的随机临时目录；已运行的 monitor 不依赖脚本文件。
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export function describeMonitorError(error: unknown): string {
  const reasons: Record<string, string> = {
    monitor_desktop_unavailable: "当前环境没有可用桌面会话。",
    monitor_platform_unsupported: "当前平台不支持自动打开终端。",
    monitor_terminal_unavailable: "未找到可启动的终端。",
    monitor_terminal_platform_mismatch: "config.toml 中的终端不适用于当前平台。",
    monitor_terminal_failed: "终端启动失败。",
    monitor_open_timeout: "等待监控就绪超时，未确认启动成功。",
    monitor_open_failed: "另一个监控启动请求未成功。",
  };
  const current = error as Error & { stage?: string };
  const details: string[] = [];
  if (current?.stage) details.push(`阶段：${current.stage}`);
  if (current?.message in reasons) details.push(current.message);
  for (let cause: any = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
    if (typeof cause.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code)) details.push(cause.code);
    if (["open", "mkdir", "stat", "rename", "unlink", "spawn", "listen"].includes(cause.syscall)) details.push(cause.syscall);
    if (typeof cause.terminalDiagnostic === "string" && cause.terminalDiagnostic.trim()) details.push(safeText(cause.terminalDiagnostic, 800).replace(/\s+/g, " ").trim());
    if (typeof cause.exitCode === "number" || typeof cause.exitCode === "string" && /^[A-Za-z_]+$/.test(cause.exitCode)) details.push(`终端退出：${cause.exitCode}`);
  }
  const permission = details.some(value => ["EPERM", "EACCES", "EROFS"].includes(value))
    ? "请确认状态目录可写且允许启动桌面应用；沙盒中可在已有 TTY 运行，或用 --once 读取状态。" : "";
  return `${reasons[current?.message] ?? "无法启动监控。"}${details.length ? `（${[...new Set(details)].join("；")}）` : ""}${permission}`;
}
