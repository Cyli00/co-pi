import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { CpiError, type MessageCommand, type MessageReceipt, type WorkerEvent } from "./protocol.js";

export class Mailbox {
  private session?: AgentSession;
  private closed = false;
  private pending = new Map<string, MessageCommand>();
  private receipts = new Map<string, MessageReceipt>();
  private submissions = new Set<Promise<void>>();
  private preflight = Promise.resolve();
  private activeTools: string[] = [];
  revision = 0;
  get busy() { return this.submissions.size > 0; }
  constructor(private send: (event: WorkerEvent) => unknown, private invalidate: () => void) {}
  private receipt(command: MessageCommand, status: MessageReceipt["status"], error?: string) {
    const previous = this.receipts.get(command.id);
    if (previous && ["delivered", "cancelled", "rejected"].includes(previous.status)) return;
    const receipt = { id: command.id, mode: command.mode, status, at: new Date().toISOString(), error };
    this.receipts.set(command.id, receipt);
    this.send({ type: "receipt", receipt });
  }
  receive(command: MessageCommand) {
    if (this.receipts.has(command.id)) { this.send({ type: "receipt", receipt: this.receipts.get(command.id)! }); return; }
    if (this.closed) { this.receipt(command, "rejected", "worker_closing"); return; }
    this.receipt(command, "received");
    this.pending.set(command.id, command);
    this.revision++;
    this.invalidate();
    if (this.session) this.submit(command);
  }
  attach(session: AgentSession) {
    this.session = session;
    this.activeTools = session.getActiveToolNames();
    for (const command of this.pending.values()) this.submit(command);
  }
  private submit(command: MessageCommand) {
    const session = this.session!;
    const previous = this.preflight;
    let release!: () => void;
    this.preflight = new Promise<void>(resolve => { release = resolve; });
    let queued = false;
    let onQueue = () => {};
    const work = previous.then(async () => {
      if (this.closed) return;
      session.setActiveToolsByName(this.activeTools);
      onQueue = session.subscribe(event => {
        if (event.type === "queue_update" && [...event.steering, ...event.followUp].some(text => text.includes(`[cpi-message:${command.id}]`))) queued = true;
      });
      await session.prompt(`[cpi-message:${command.id}]\n${command.text}\nSubmit a fresh handoff after addressing this update.`, {
      expandPromptTemplates: false, source: "rpc", streamingBehavior: command.mode,
      preflightResult: accepted => {
        release();
        if (this.closed) {
          session.clearQueue();
          // 输入扩展可能异步返回；取消后阻止 prompt 越过预处理再启动一次运行。
          throw new CpiError("cancelled");
        }
        this.receipt(command, accepted ? (queued ? "queued" : "accepted") : "rejected", accepted ? undefined : "input_rejected");
      },
      });
    }).catch(() => this.receipt(command, "rejected", "message_delivery_failed")).finally(() => {
      release();
      onQueue(); this.submissions.delete(work);
      if (this.closed) session.clearQueue();
    });
    this.submissions.add(work);
  }
  event(event: AgentSessionEvent) {
    if (event.type !== "message_start" || event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter(c => c.type === "text").map(c => c.text).join("\n");
    for (const command of this.pending.values()) {
      if (text.includes(`[cpi-message:${command.id}]`)) {
        this.receipt(command, "delivered"); this.pending.delete(command.id);
      }
    }
  }
  async drain() {
    while (this.submissions.size) await Promise.all([...this.submissions]);
    await this.session?.waitForIdle();
    // SDK input 扩展可能消费或改写消息；没有对应 message_start 就不能声称已进入会话。
    for (const command of this.pending.values()) {
      const status = this.receipts.get(command.id)?.status;
      if (status !== "rejected") this.receipt(command, "unknown", "input_not_observed_in_session");
      this.pending.delete(command.id);
    }
  }
  async close(cancel = false) {
    this.closed = true;
    if (cancel) {
      for (const command of this.pending.values()) this.receipt(command, "cancelled");
      this.pending.clear();
      this.session?.clearQueue();
      await this.session?.abort();
    } else if (this.submissions.size || !this.session?.isIdle) throw new CpiError("worker_not_settled");
  }
}
