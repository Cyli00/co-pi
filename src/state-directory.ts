import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { normalizeThreadId } from "./state-thread.js";
import { CpiError } from "./protocol.js";

export function defaultStateDir({ platform = process.platform, home = homedir(), temp = tmpdir(), uid = userInfo().uid } = {}): string {
  // macOS 宿主 MCP 与 seatbelt 内 monitor 共用可写目录，不能按各自权限分流。
  return platform === "darwin"
    ? join(temp, `co-pi-${uid}`, "state")
    : join(home, ".cpi", "state");
}

export function resolveStateDirectory(explicit: string | undefined, threadId?: string, env = process.env): string {
  const override = explicit ?? env.CPI_STATE_DIR;
  if (override !== undefined) {
    if (!override.trim()) throw new Error("state_directory_empty");
    return resolve(override);
  }
  const id = normalizeThreadId(threadId);
  if (!id) throw new CpiError("codex_thread_id_required");
  return join(defaultStateDir(), id);
}
