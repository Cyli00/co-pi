import { open, readdir, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeThreadId, resolveStateThread } from "./state-thread.js";

const CHUNK = 64 * 1024;
const MAX_META = 256 * 1024;
const REFRESH_MS = 10_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export interface CodexUsage {
  state: "searching" | "waiting" | "ready" | "unavailable";
  automatic: boolean;
  threadId?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  updatedAt?: string;
  workspace?: string;
  workspaceSource?: "tasks" | "argument" | "cwd";
}

export function parseCodexUsage(line: string): Pick<CodexUsage, "inputTokens" | "cachedInputTokens" | "updatedAt"> | undefined {
  try {
    return usageFromEvent(JSON.parse(line));
  } catch { return; }
}

function usageFromEvent(event: any): Pick<CodexUsage, "inputTokens" | "cachedInputTokens" | "updatedAt"> | undefined {
  if (event?.type !== "event_msg" || event.payload?.type !== "token_count") return;
  const usage = event.payload.info?.last_token_usage;
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0
    || !Number.isSafeInteger(usage.cached_input_tokens) || usage.cached_input_tokens < 0
    || usage.cached_input_tokens > usage.input_tokens) return;
  return { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens,
    updatedAt: typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : undefined };
}

async function readMeta(handle: FileHandle) {
  const parts: Buffer[] = [];
  for (let position = 0; position < MAX_META; position += CHUNK) {
    const buffer = Buffer.alloc(CHUNK);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    parts.push(buffer.subarray(0, end < 0 ? bytesRead : end));
    if (end >= 0) {
      const event = JSON.parse(decoder.decode(Buffer.concat(parts)));
      if (event?.type !== "session_meta" || typeof event.payload?.id !== "string" || !UUID.test(event.payload.id)) break;
      return event.payload as { id: string; cwd?: string; source?: unknown };
    }
    if (bytesRead < CHUNK) break;
  }
  throw new Error("invalid_session");
}

async function* reverseLines(handle: FileHandle, size: number): AsyncGenerator<Buffer> {
  let position = size;
  let tail = true;
  let parts: Buffer[] = [];
  let length = 0;
  while (position > 0) {
    const count = Math.min(CHUNK, position);
    position -= count;
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, position);
    if (bytesRead !== count) throw new Error("session_changed");
    let end = count;
    for (let newline = buffer.lastIndexOf(10, end - 1); newline >= 0; newline = end > 0 ? buffer.lastIndexOf(10, end - 1) : -1) {
      if (tail) tail = false;
      else {
        const fragment = buffer.subarray(newline + 1, end);
        yield parts.length ? Buffer.concat([fragment, ...parts.reverse()], fragment.length + length) : fragment;
      }
      parts = []; length = 0; end = newline;
    }
    // 未换行的尾部尚未提交；长记录按块暂存，避免反复拼接整段正文。
    if (!tail && end > 0) { parts.push(buffer.subarray(0, end)); length += end; }
  }
  if (!tail && parts.length) yield Buffer.concat(parts.reverse(), length);
}

// 只保留用量和线程身份；日志正文不进入快照、MCP 返回值或监控时间线。
export class CodexUsageReader {
  private value: CodexUsage;
  private file?: string;
  private nextSearch = 0;
  private signature?: string;
  private busy?: Promise<CodexUsage>;
  private readonly home: string;
  private readonly threadId?: string;

  constructor(options: { home?: string; workspace?: string; threadId?: string } = {}) {
    this.home = options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.threadId = normalizeThreadId(options.threadId ?? process.env.CODEX_THREAD_ID);
    this.value = { state: "searching", automatic: false, threadId: this.threadId };
  }

  read(): Promise<CodexUsage> {
    return this.busy ??= this.refresh().finally(() => { this.busy = undefined; });
  }

  private async discover(): Promise<void> {
    if (!this.threadId) return;
    const candidates: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        if (entry.name.toLowerCase().endsWith(`-${this.threadId}.jsonl`)) candidates.push(path);
      }
    };
    await walk(join(this.home, "sessions"));
    await walk(join(this.home, "archived_sessions"));
    if (candidates.length === 1) { this.select(candidates[0]!, this.threadId); return; }
    this.file = undefined;
    this.signature = undefined;
    this.value = { state: candidates.length ? "unavailable" : "searching", automatic: false, threadId: this.threadId };
  }

  private select(file: string, threadId: string) {
    if (file === this.file && threadId === this.value.threadId) return;
    this.file = file;
    this.signature = undefined;
    this.value = { state: "waiting", automatic: false, threadId };
  }

  private async refresh(): Promise<CodexUsage> {
    try {
      if (Date.now() >= this.nextSearch) {
        this.nextSearch = Date.now() + REFRESH_MS;
        await this.discover();
      }
      if (!this.file) return { ...this.value };
      const handle = await open(this.file, "r");
      try {
        const info = await handle.stat({ bigint: true });
        const size = Number(info.size);
        const signature = `${info.dev}/${info.ino}/${info.birthtimeNs}/${size}/${info.mtimeNs}/${info.ctimeNs}`;
        if (signature === this.signature) return { ...this.value };
        this.signature = undefined;
        const meta = await readMeta(handle);
        if (meta.id.toLowerCase() !== this.value.threadId) throw new Error("thread_mismatch");
        this.value = { state: "waiting", automatic: false, threadId: meta.id.toLowerCase() };
        // 固定本次文件长度，从尾部找最新完整事件；无效的最新用量不能被旧值掩盖。
        for await (const line of reverseLines(handle, size)) {
          const text = decoder.decode(line).trim();
          if (!text) continue;
          const event = JSON.parse(text);
          if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("invalid_record");
          if (event.type !== "event_msg" || event.payload?.type !== "token_count") continue;
          const usage = usageFromEvent(event);
          this.value = usage ? { ...this.value, ...usage, state: "ready" } : { ...this.value, state: "unavailable" };
          break;
        }
        this.signature = signature;
      } finally { await handle.close(); }
    } catch {
      this.signature = undefined;
      this.value = { state: "unavailable", automatic: false, threadId: this.value.threadId };
    }
    return { ...this.value };
  }
}

export class MonitorUsageReader {
  private threadId: string | undefined;
  private reader: CodexUsageReader;
  private value?: CodexUsage;
  private nextRefresh = 0;

  constructor(private readonly options: { home?: string; workspace?: string; threadId?: string; stateDir?: string } = {}) {
    this.threadId = this.resolveThread();
    this.reader = this.createReader();
  }

  private createReader() {
    return new CodexUsageReader({ home: this.options.home, threadId: this.threadId ?? "" });
  }

  private resolveThread() {
    const bound = this.options.stateDir ? resolveStateThread(this.options.stateDir, this.options.threadId) : normalizeThreadId(this.options.threadId);
    return bound ?? normalizeThreadId(this.options.threadId ?? process.env.CODEX_THREAD_ID);
  }

  async read(_snapshots: readonly { workspace: string }[] = []): Promise<CodexUsage> {
    if (this.value && Date.now() < this.nextRefresh) return { ...this.value };
    try {
      const threadId = this.resolveThread();
      // 允许先打开 monitor 等服务建立绑定；一旦选定，目录变化不能悄悄换线程。
      if (threadId !== this.threadId) {
        if (this.threadId) throw new Error("state_thread_conflict");
        this.threadId = threadId;
        this.reader = this.createReader();
      }
      this.value = await this.reader.read();
    } catch {
      this.value = { state: "unavailable", automatic: false, threadId: this.threadId };
    }
    this.nextRefresh = Date.now() + REFRESH_MS;
    return { ...this.value };
  }
}
