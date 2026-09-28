import { CpiError } from "./protocol.js";
import { normalizeThreadId } from "./state-thread.js";
import { resolveStateDirectory } from "./state-directory.js";
import { Supervisor, type SupervisorOptions } from "./supervisor.js";

type SessionOptions = Omit<SupervisorOptions, "stateDir"> & { stateDir?: string };

export function requestThreadId(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !value) throw new CpiError("codex_thread_id_invalid");
  return normalizeThreadId(value);
}

export class McpSessions {
  private readonly sessions = new Map<string, Supervisor>();
  private closing = false;

  constructor(readonly options: SessionOptions,
    private readonly directoryForThread = (threadId: string) => resolveStateDirectory(options.stateDir, threadId)) {
    options.threadId = normalizeThreadId(options.threadId);
    if (options.threadId) this.forThread(options.threadId);
  }

  forThread(metadata?: unknown): Supervisor {
    if (this.closing) throw new CpiError("cancelled");
    const requested = requestThreadId(metadata);
    if (requested && this.options.threadId && requested !== this.options.threadId) throw new CpiError("state_thread_conflict");
    const threadId = requested ?? this.options.threadId;
    if (!threadId) throw new CpiError("codex_thread_id_required");
    let supervisor = this.sessions.get(threadId);
    if (!supervisor) {
      // 共享 MCP 进程中的批次、消息和交接都按调用方线程隔离。
      supervisor = new Supervisor({ ...this.options, threadId, stateDir: this.directoryForThread(threadId) });
      this.sessions.set(threadId, supervisor);
    }
    return supervisor;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.sessions.values()].map(supervisor => supervisor.close()));
  }
}
