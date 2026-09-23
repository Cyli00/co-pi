import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CHUNK = 1024 * 1024;
const MAX_LINE = 256 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export interface CodexUsage {
  state: "searching" | "waiting" | "ready" | "unavailable";
  automatic: boolean;
  threadId?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  updatedAt?: string;
}

export function parseCodexUsage(line: string): Pick<CodexUsage, "inputTokens" | "cachedInputTokens" | "updatedAt"> | undefined {
  try {
    const event = JSON.parse(line);
    if (event?.type !== "event_msg" || event.payload?.type !== "token_count") return;
    const usage = event.payload.info?.last_token_usage;
    if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0
      || !Number.isSafeInteger(usage.cached_input_tokens) || usage.cached_input_tokens < 0
      || usage.cached_input_tokens > usage.input_tokens) return;
    return { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens,
      updatedAt: typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : undefined };
  } catch { return; }
}

const workspaceKey = (path: string) => {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

// 只保留用量和线程身份；日志正文不进入快照、MCP 返回值或监控时间线。
export class CodexUsageReader {
  private value: CodexUsage;
  private file?: string;
  private nextSearch = 0;
  private position = 0;
  private historyEnd = 0;
  private pending = Buffer.alloc(0);
  private skipping = false;
  private identity?: string;
  private signature?: string;
  private busy?: Promise<CodexUsage>;
  private readonly home: string;
  private readonly workspace: string;
  private readonly threadId?: string;

  constructor(options: { home?: string; workspace?: string; threadId?: string } = {}) {
    this.home = options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.workspace = workspaceKey(options.workspace ?? process.cwd());
    this.threadId = options.threadId ?? process.env.CODEX_THREAD_ID;
    if (this.threadId && !UUID.test(this.threadId)) throw new Error("codex_thread_id_invalid");
    this.value = { state: "searching", automatic: !this.threadId, threadId: this.threadId };
  }

  read(): Promise<CodexUsage> {
    return this.busy ??= this.refresh().finally(() => { this.busy = undefined; });
  }

  private async discover(): Promise<void> {
    const candidates: { path: string; mtime: number }[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) await walk(path, depth + 1);
        if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        if (this.threadId && !entry.name.endsWith(`-${this.threadId}.jsonl`)) continue;
        try { candidates.push({ path, mtime: (await stat(path)).mtimeMs }); } catch { /* 文件可能正在移走。 */ }
      }
    };
    await walk(join(this.home, "sessions"), 0);
    candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    for (const candidate of candidates) {
      const handle = await open(candidate.path, "r").catch(() => undefined);
      if (!handle) continue;
      try {
        const buffer = Buffer.alloc(MAX_LINE);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const end = buffer.subarray(0, bytesRead).indexOf(10);
        if (end < 0) continue;
        const event = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        const meta = event?.payload;
        if (event?.type !== "session_meta" || typeof meta?.id !== "string" || !UUID.test(meta.id)) continue;
        if (this.threadId ? meta.id !== this.threadId : typeof meta.cwd !== "string" || workspaceKey(meta.cwd) !== this.workspace) continue;
        // Codex 子线程的 source 为对象，不能把它当作主线程。
        if (!["cli", "vscode", "exec"].includes(meta.source)) continue;
        this.file = candidate.path;
        this.value = { state: "waiting", automatic: !this.threadId, threadId: meta.id };
        return;
      } catch { /* 不支持或损坏的元数据不影响任务监控。 */ }
      finally { await handle.close(); }
    }
  }

  private consume(buffer: Buffer, skipFirst: boolean, preserveTail: boolean): boolean {
    let start = 0;
    let found = false;
    let skip = skipFirst;
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
      if (!skip && end - start <= MAX_LINE) {
        const usage = parseCodexUsage(buffer.subarray(start, end).toString("utf8"));
        if (usage) { this.value = { ...this.value, ...usage, state: "ready" }; found = true; }
      }
      skip = false;
      start = end + 1;
    }
    if (preserveTail) {
      this.skipping = skip || buffer.length - start > MAX_LINE;
      this.pending = this.skipping ? Buffer.alloc(0) : Buffer.from(buffer.subarray(start));
    }
    return found;
  }

  private async refresh(): Promise<CodexUsage> {
    try {
      if (!this.file && Date.now() >= this.nextSearch) {
        this.nextSearch = Date.now() + 5_000;
        await this.discover();
      }
      if (!this.file) return { ...this.value };
      const handle = await open(this.file, "r");
      try {
        const info = await handle.stat({ bigint: true });
        const size = Number(info.size);
        const identity = `${info.dev}/${info.ino}/${info.birthtimeNs}`;
        const signature = `${info.mtimeNs}/${info.ctimeNs}`;
        if (identity !== this.identity || size < this.position || (size === this.position && signature !== this.signature)) {
          this.position = Math.max(0, size - CHUNK);
          this.historyEnd = this.position;
          this.pending = Buffer.alloc(0);
          this.skipping = this.position > 0;
          this.value = { state: "waiting", automatic: this.value.automatic, threadId: this.value.threadId };
        }
        this.identity = identity;
        this.signature = signature;
        const buffer = Buffer.alloc(Math.min(CHUNK, size - this.position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.position);
        this.position += bytesRead;
        if (bytesRead) this.consume(Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]), this.skipping, true);
        // 首次从尾部读取；若尾部全是长工具输出，每轮再向前查找一块，不阻塞 TUI。
        if (this.value.inputTokens === undefined && this.historyEnd > 0) {
          const start = Math.max(0, this.historyEnd - CHUNK);
          const older = Buffer.alloc(this.historyEnd - start + Math.min(MAX_LINE, size - this.historyEnd));
          const { bytesRead: count } = await handle.read(older, 0, older.length, start);
          this.consume(older.subarray(0, count), start > 0, false);
          this.historyEnd = start;
        }
        if (this.value.state === "unavailable") this.value.state = this.value.inputTokens === undefined ? "waiting" : "ready";
      } finally { await handle.close(); }
    } catch { this.value = { ...this.value, state: "unavailable" }; }
    return { ...this.value };
  }
}
