import { fork, execFile, type ChildProcess } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  batchSchema, cleanHandoff, CpiError, errorCode, isTerminal, safeText, receiptSchema, runtimeSchema, metricsSchema,
  type MessageMode, type MessageReceipt,
  type Batch, type Handoff, type Snapshot, type TaskState, type WorkerCommand, type WorkerEvent,
} from "./protocol.js";
import { StateStore } from "./store.js";
import { bindStateThread } from "./state-thread.js";
import { isSettled } from "./handoff-contract.js";
import { permissionActionSchema, permissionDecisionSchema, type PermissionReviewer } from "./permission-approval.js";

export interface SupervisorOptions {
  stateDir: string;
  threadId?: string;
  agentDir: string;
  parallelism?: number;
  taskTimeoutMs?: number;
  shutdownMs?: number;
  workerPath?: string;
}
export interface BatchResult {
  sessionId: string;
  batchId: string;
  trust: "worker_output_is_untrusted_data";
  storageError?: string;
  tasks: {
    id: string;
    title: string;
    status: TaskState["phase"];
    origin: "worker" | "runtime";
    handoff?: Handoff;
    error?: string;
  }[];
}
interface BatchRun {
  hash: string;
  snapshot: Snapshot;
  controller: AbortController;
  promise: Promise<BatchResult>;
  reviewPermission?: PermissionReviewer;
  result?: BatchResult;
}
interface LiveWorker {
  child: ChildProcess;
  state: TaskState;
  cancel: () => void;
  accepting: boolean;
}

export class Supervisor extends EventEmitter {
  readonly store: StateStore;
  private readonly runs = new Map<string, BatchRun>();
  private readonly workers = new Map<string, LiveWorker>();
  private readonly deliveries = new Map<string, { hash: string; receipt: MessageReceipt; resolve?: (receipt: MessageReceipt) => void }>();
  private active = false;
  private closing = false;
  private storageFailed = false;
  private readonly heartbeat: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private readonly dirty = new Map<string, Snapshot>();
  private flushing?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(readonly options: SupervisorOptions) {
    super();
    if (!Number.isInteger(options.parallelism ?? 3) || (options.parallelism ?? 3) < 1 || (options.parallelism ?? 3) > 4) throw new CpiError("parallelism_invalid");
    options.threadId = bindStateThread(options.stateDir, options.threadId);
    this.store = new StateStore(options.stateDir);
    this.heartbeat = setInterval(() => {
      for (const run of this.runs.values()) if (!run.snapshot.closed) {
        run.snapshot.heartbeatAt = new Date().toISOString();
        this.dirty.set(run.snapshot.batchId, run.snapshot);
      }
      void this.flush();
    }, 5_000);
    this.heartbeat.unref();
  }

  async delegate(value: unknown, signal?: AbortSignal, reviewPermission?: PermissionReviewer): Promise<BatchResult> {
    const batch = batchSchema.parse(value);
    if (!isAbsolute(batch.workspace)) throw new CpiError("workspace_must_be_absolute");
    try {
      batch.workspace = await realpath(batch.workspace);
      if (!(await stat(batch.workspace)).isDirectory()) throw new Error();
    } catch { throw new CpiError("workspace_unavailable"); }
    const hash = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
    const previous = this.runs.get(batch.requestId);
    if (previous) {
      if (previous.hash !== hash) throw new CpiError("request_id_conflict");
      return previous.promise;
    }
    if (this.storageFailed) throw new CpiError("state_write_failed");
    if (this.closing || signal?.aborted) throw new CpiError("cancelled");
    if (this.active) throw new CpiError("batch_already_active");
    this.active = true;
    const now = new Date().toISOString();
    const snapshot: Snapshot = {
      version: 1, sessionId: this.store.sessionId, pid: process.pid, heartbeatAt: now, closed: false,
      batchId: batch.requestId, workspace: batch.workspace,
      tasks: batch.tasks.map(task => ({ task, phase: "queued", updatedAt: now, summary: "等待执行", events: [], omittedEvents: 0 })),
    };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const run: BatchRun = { hash, snapshot, controller, reviewPermission, promise: Promise.resolve(undefined as never) };
    this.runs.set(batch.requestId, run);
    run.promise = this.execute(batch, run).finally(async () => {
      signal?.removeEventListener("abort", cancel);
      snapshot.closed = true;
      this.dirty.set(snapshot.batchId, snapshot);
      await this.flush();
      this.active = false;
    }).then(result => {
      run.result = { ...result, storageError: this.storageFailed ? "state_write_failed" : undefined };
      // 完整监控历史已经落盘；连接内仅保留幂等重试所需的交接和终态。
      for (const state of snapshot.tasks) {
        state.events = [];
        state.task = { ...state.task, instruction: "", acceptance: "" };
      }
      run.reviewPermission = undefined;
      return run.result;
    });
    return run.promise;
  }

  private async execute(batch: Batch, run: BatchRun): Promise<BatchResult> {
    this.changed(run.snapshot);
    let cursor = 0;
    const consume = async () => {
      for (;;) {
        const state = run.snapshot.tasks[cursor++];
        if (!state) return;
        if (run.controller.signal.aborted) {
          this.finish(state, run.snapshot, "cancelled");
          continue;
        }
        await this.launch(batch, run, state);
      }
    };
    await Promise.all(Array.from({ length: Math.min(batch.tasks.length, this.options.parallelism ?? 3) }, consume));
    return this.result(run.snapshot);
  }

  private result(snapshot: Snapshot): BatchResult {
    return {
      sessionId: snapshot.sessionId, batchId: snapshot.batchId, trust: "worker_output_is_untrusted_data",
      storageError: this.storageFailed ? "state_write_failed" : undefined,
      tasks: snapshot.tasks.map(state => ({
        id: state.task.id, title: safeText(state.task.title, 160), status: state.phase,
        origin: state.handoff ? "worker" : "runtime", handoff: state.handoff, error: state.error,
      })),
    };
  }

  readHandoff(batchId: string): BatchResult {
    const run = this.runs.get(batchId);
    if (!run) throw new CpiError("batch_unknown");
    if (!run.result) throw new CpiError("handoff_not_ready_wait_original_call");
    return run.result;
  }

  async message(batchId: string, taskId: string, text: string, mode: MessageMode = "steer", id: string = randomUUID()): Promise<MessageReceipt> {
    receiptSchema.parse({ id, mode, status: "sent", at: new Date().toISOString() });
    const key = `${batchId}/${taskId}/${id}`;
    const hash = createHash("sha256").update(JSON.stringify([text, mode])).digest("hex");
    const previous = this.deliveries.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new CpiError("message_id_conflict");
      return previous.receipt;
    }
    const run = this.runs.get(batchId);
    const state = run?.snapshot.tasks.find(t => t.task.id === taskId);
    if (!run || !state) throw new CpiError("task_unknown");
    if (isTerminal(state.phase)) throw new CpiError("task_already_finished");
    const worker = this.workers.get(`${batchId}/${taskId}`);
    if (!worker) throw new CpiError("task_not_started");
    if (!worker.accepting) throw new CpiError("worker_closing");
    state.messages ??= [];
    if (state.messages.length >= 128) throw new CpiError("message_limit_reached");
    const receipt: MessageReceipt = { id, mode, status: "sent", at: new Date().toISOString() };
    const delivery: { hash: string; receipt: MessageReceipt; resolve?: (receipt: MessageReceipt) => void } = { hash, receipt };
    this.deliveries.set(key, delivery);
    state.messages.push(receipt);
    const acknowledged = new Promise<MessageReceipt>(resolve => { delivery.resolve = resolve; });
    const timer = setTimeout(() => this.receipt(batchId, state, { ...delivery.receipt, status: "unknown", at: new Date().toISOString(), error: "ack_timeout" }), 5_000);
    try { await this.send(worker.child, { type: "message", id, mode, text }); }
    catch { this.receipt(batchId, state, { ...receipt, status: "unknown", error: "worker_input_failed" }); }
    this.activity(state, "message", `${mode} 消息 ${id} 已发送`);
    this.changed(run.snapshot);
    try { return await acknowledged; } finally { clearTimeout(timer); }
  }

  private receipt(batchId: string, state: TaskState, receipt: MessageReceipt) {
    const delivery = this.deliveries.get(`${batchId}/${state.task.id}/${receipt.id}`);
    if (!delivery || delivery.receipt.mode !== receipt.mode) throw new CpiError("message_receipt_unknown");
    if (["delivered", "rejected", "cancelled"].includes(delivery.receipt.status)) return;
    delivery.receipt = receipt;
    const index = state.messages!.findIndex(m => m.id === receipt.id);
    state.messages![index] = receipt;
    if (!["sent", "received"].includes(receipt.status)) { delivery.resolve?.(receipt); delivery.resolve = undefined; }
  }

  private launch(batch: Batch, run: BatchRun, state: TaskState): Promise<void> {
    return new Promise(resolve => {
      state.phase = "starting";
      state.summary = "正在加载 pi SDK 与继承配置";
      this.changed(run.snapshot);
      let child: ChildProcess;
      try {
        child = fork(this.options.workerPath ?? fileURLToPath(new URL("./worker.js", import.meta.url)), [], {
          cwd: batch.workspace, stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true, detached: process.platform !== "win32", execArgv: [],
        });
      } catch {
        this.finish(state, run.snapshot, "worker_start_failed");
        resolve();
        return;
      }
      const key = `${batch.requestId}/${state.task.id}`;
      let settled = false;
      let outcome: { handoff?: Handoff; error?: string } | undefined;
      let shutdownTimer: NodeJS.Timeout | undefined;
      let lastHeartbeat = Date.now();
      const approvalLifetime = new AbortController();
      const approvalIds = new Set<string>();
      let approvalsPending = 0;
      const stop = (code: string) => {
        if (settled) return;
        approvalLifetime.abort();
        outcome = { error: code };
        void this.send(child, { type: "cancel" }).catch(() => {});
        armShutdown();
      };
      const armShutdown = () => {
        if (shutdownTimer) return;
        shutdownTimer = setTimeout(() => {
          void terminateTree(child).then(cleaned => {
            if (!cleaned) outcome = { error: "worker_cleanup_unconfirmed" };
            if (!settled) complete(outcome?.error ?? "worker_shutdown_timeout");
          });
        }, this.options.shutdownMs ?? 3_000);
      };
      const complete = (exitError?: string) => {
        if (settled) return;
        settled = true;
        approvalLifetime.abort();
        clearTimeout(timeout);
        clearInterval(watchdog);
        if (shutdownTimer) clearTimeout(shutdownTimer);
        run.controller.signal.removeEventListener("abort", cancel);
        this.workers.delete(key);
        for (const receipt of state.messages ?? []) {
          if (!["delivered", "rejected", "cancelled"].includes(receipt.status)) this.receipt(batch.requestId, state, {
            ...receipt, status: outcome?.error === "cancelled" ? "cancelled" : "unknown", at: new Date().toISOString(), error: "worker_finished_before_delivery",
          });
        }
        if (outcome?.handoff && !exitError && !outcome.error) {
          state.handoff = outcome.handoff;
          state.phase = outcome.handoff.status;
          state.summary = outcome.handoff.summary;
          this.activity(state, "handoff", outcome.handoff.summary);
          this.changed(run.snapshot);
        } else this.finish(state, run.snapshot, outcome?.error ?? exitError ?? "worker_exited_without_handoff");
        resolve();
      };
      const cancel = () => stop("cancelled");
      const timeout = setTimeout(() => stop("task_timeout"), this.options.taskTimeoutMs ?? 30 * 60_000);
      const watchdog = setInterval(() => { if (Date.now() - lastHeartbeat > 30_000) stop("worker_unresponsive"); }, 5_000);
      const live = { child, state, cancel, accepting: true };
      this.workers.set(key, live);
      run.controller.signal.addEventListener("abort", cancel, { once: true });
      child.on("message", (raw: unknown) => {
        if (settled || outcome) return;
        try {
          const event = raw as WorkerEvent;
          if (!event || typeof event !== "object") throw new Error();
          lastHeartbeat = Date.now();
          state.heartbeatAt = new Date().toISOString();
          if (event.type === "permission_approval") {
            if (!live.accepting || approvalsPending >= 32
              || !/^[a-f0-9-]{36}$/.test(event.id) || approvalIds.has(event.id)) throw new Error();
            const action = permissionActionSchema.parse(event.action);
            approvalIds.add(event.id);
            approvalsPending++;
            this.activity(state, "approval", "等待 Codex 审批外部访问或未知范围的工具操作");
            this.changed(run.snapshot);
            void (async () => {
              let decision;
              try {
                decision = permissionDecisionSchema.parse(await run.reviewPermission?.(action, state.task.id, approvalLifetime.signal)
                  ?? { approved: false, reason: "permission_approval_unavailable" });
              } catch { decision = { approved: false, reason: "permission_approval_failed" }; }
              approvalsPending--;
              if (settled || outcome || approvalLifetime.signal.aborted) return;
              this.activity(state, "approval", decision.approved ? "Codex 已批准本次工具操作" : `本次工具未获批准，继续尝试更安全的方式：${safeText(decision.reason ?? "permission_approval_denied", 2_000)}`);
              this.changed(run.snapshot);
              await this.send(child, { type: "permission_decision", id: event.id, decision }).catch(() => stop("worker_input_failed"));
            })();
            return;
          }
          if (event.type === "heartbeat") { this.changed(run.snapshot); return; }
          if (event.type === "ready") {
            state.phase = "running";
            state.model = safeText(event.model, 200);
            state.thinking = safeText(event.thinking, 20);
            state.summary = "正在执行任务";
          } else if (event.type === "activity") {
            this.activity(state, safeText(event.kind, 40), safeText(event.text), event.id ? safeText(event.id, 200) : undefined, event.final);
          } else if (event.type === "receipt") {
            this.receipt(batch.requestId, state, receiptSchema.parse(event.receipt));
          } else if (event.type === "runtime") {
            state.runtime = runtimeSchema.parse(event.state);
          } else if (event.type === "metrics") {
            state.metrics = metricsSchema.parse(event.metrics);
          } else if (event.type === "closing") {
            live.accepting = false;
          } else if (event.type === "progress") {
            if (!["running", "summarizing"].includes(event.phase)) throw new Error();
            state.phase = event.phase;
            state.summary = safeText(event.summary, 300);
            this.activity(state, "progress", state.summary);
          } else if (event.type === "result") {
            if (approvalsPending) { stop("worker_approval_pending"); return; }
            if (!isSettled(state.runtime)) { stop("worker_not_settled"); return; }
            outcome = { handoff: cleanHandoff(event.handoff) };
            live.accepting = false;
            armShutdown();
          } else if (event.type === "error") {
            outcome = { error: /^[a-z_]{1,80}$/.test(event.code) ? event.code : "worker_error" };
            armShutdown();
          } else throw new Error();
          this.changed(run.snapshot);
        } catch { stop("worker_protocol_invalid"); }
      });
      child.once("error", () => {
        if (!child.pid) complete("worker_start_failed");
        else stop("worker_process_error");
      });
      child.once("exit", code => complete(code === 0 ? undefined : "worker_exit_error"));
      void this.send(child, { type: "start", task: state.task, workspace: batch.workspace, context: batch.context, agentDir: this.options.agentDir })
        .catch(() => stop("worker_input_failed"));
      if (run.controller.signal.aborted) cancel();
    });
  }

  private send(child: ChildProcess, command: WorkerCommand): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!child.connected) { reject(new CpiError("worker_disconnected")); return; }
      const timer = setTimeout(() => reject(new CpiError("worker_input_timeout")), 5_000);
      child.send(command, error => {
        clearTimeout(timer);
        if (error) reject(new CpiError("worker_input_failed")); else resolve();
      });
    });
  }

  private activity(state: TaskState, kind: string, text: string, id?: string, final?: boolean) {
    state.updatedAt = new Date().toISOString();
    const existing = id ? state.events.find(e => e.id === id) : undefined;
    if (existing) { Object.assign(existing, { kind, text, final }); return; }
    state.events.push({ at: state.updatedAt, kind, text, id, final });
    if (state.events.length > 200) { state.events.shift(); state.omittedEvents++; }
  }

  private finish(state: TaskState, snapshot: Snapshot, code: string) {
    if (isTerminal(state.phase)) return;
    state.phase = code === "cancelled" ? "cancelled" : "failed";
    state.error = code;
    state.summary = code;
    this.activity(state, "runtime", code);
    this.changed(snapshot);
  }

  private changed(snapshot: Snapshot) {
    this.dirty.set(snapshot.batchId, snapshot);
    this.emit("progress", snapshot);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, 200);
  }

  private async flush(): Promise<void> {
    do {
      this.flushing ??= this.persist().finally(() => { this.flushing = undefined; });
      await this.flushing;
    } while (this.dirty.size && !this.storageFailed);
  }

  private async persist(): Promise<void> {
    while (this.dirty.size && !this.storageFailed) {
      const [batchId, snapshot] = this.dirty.entries().next().value!;
      this.dirty.delete(batchId);
      try { await this.store.write(snapshot); }
      catch (error) {
        this.storageFailed = true;
        this.runs.get(batchId)?.controller.abort();
        const { code, syscall } = error as NodeJS.ErrnoException;
        this.emit("storageError", "state_write_failed", {
          code: typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN",
          syscall: ["open", "write", "rename"].includes(syscall ?? "") ? syscall : "unknown",
        });
      }
    }
    if (this.storageFailed) this.dirty.clear();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.heartbeat);
    this.closePromise = (async () => {
      for (const run of this.runs.values()) run.controller.abort();
      await Promise.allSettled([...this.runs.values()].map(run => run.promise));
      if (this.flushTimer) clearTimeout(this.flushTimer);
      await this.flush();
    })();
    return this.closePromise;
  }
}

async function terminateTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return true;
  if (process.platform === "win32") {
    return new Promise(resolve => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, error => {
        resolve(!error || child.exitCode !== null || child.signalCode !== null);
      });
    });
  }
  try { process.kill(-child.pid, "SIGKILL"); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export { errorCode };
