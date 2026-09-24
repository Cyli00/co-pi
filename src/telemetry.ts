import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { safeText, type RuntimeState, type WorkerEvent } from "./protocol.js";

export class Telemetry {
  readonly state: RuntimeState = { settled: true, compacting: false, queue: { steering: 0, followUp: 0 } };
  private sequence = 0;
  private assistantId = "";
  private thinkingId?: string;
  private thinkingText = "";
  private pending = new Map<string, Extract<WorkerEvent, { type: "activity" }>>();
  private timer?: NodeJS.Timeout;
  constructor(private session: AgentSession, private send: (event: WorkerEvent) => unknown) {}

  private activity(id: string, kind: string, text: string, final = false) {
    // 使用累计文本覆盖，避免重复输出和跨分片脱敏失效。
    this.pending.set(id, { type: "activity", id, kind, text: safeText(text), final });
    if (final) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 100);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const event of this.pending.values()) this.send(event);
    this.pending.clear();
  }
  metrics() {
    const stats = this.session.getSessionStats();
    const context = this.session.getContextUsage();
    this.send({ type: "metrics", metrics: {
      ...stats.tokens, cost: stats.cost, toolCalls: stats.toolCalls,
      contextTokens: context?.tokens ?? null, contextWindow: context?.contextWindow ?? null, contextPercent: context?.percent ?? null,
    } });
  }
  private captureThinking(message: Extract<AgentSessionEvent, { type: "message_update" }>["message"]) {
    if (message.role !== "assistant") return;
    const blocks = message.content.filter(c => c.type === "thinking");
    if (!blocks.length) return;
    // 只使用 SDK 提供的可见文本，不读取签名或已屏蔽内容。
    const text = safeText(blocks.filter(c => !c.redacted).map(c => c.thinking).join("\n"), 4_001);
    this.thinkingText = text.length > 4_000 ? text.slice(0, 3_970) + "\n… 思考内容已截断" : text;
    this.thinkingId = `thinking-${this.assistantId}`;
    this.activity(this.thinkingId, "thinking_text", this.thinkingText);
  }
  private finishThinking() {
    if (!this.thinkingId) return;
    this.activity(this.thinkingId, "thinking_text", this.thinkingText, true);
    this.thinkingId = undefined;
  }
  event(event: AgentSessionEvent) {
    let changed = true;
    switch (event.type) {
      case "agent_start": this.state.settled = false; break;
      case "agent_settled": this.finishThinking(); this.state.settled = true; this.metrics(); this.flush(); break;
      case "queue_update": this.state.queue = { steering: event.steering.length, followUp: event.followUp.length }; break;
      case "compaction_start":
        this.state.compacting = true; this.state.compactionReason = event.reason;
        this.send({ type: "activity", kind: "compaction", text: `开始压缩：${event.reason}` }); break;
      case "compaction_end":
        this.state.compacting = false;
        this.send({ type: "activity", kind: "compaction", text: event.aborted ? "压缩已中止" : event.errorMessage ? "压缩失败" : "压缩结束" });
        this.metrics(); break;
      case "auto_retry_start": case "summarization_retry_scheduled":
        this.state.retry = { scope: event.type === "auto_retry_start" ? "model" : "summary", attempt: event.attempt, maxAttempts: event.maxAttempts, until: new Date(Date.now() + event.delayMs).toISOString() };
        this.send({ type: "activity", kind: "retry", text: `${this.state.retry.scope} 重试 ${event.attempt}/${event.maxAttempts}，等待 ${event.delayMs}ms` }); break;
      case "auto_retry_end": case "summarization_retry_finished":
        this.state.retry = undefined;
        this.send({ type: "activity", kind: "retry", text: event.type === "auto_retry_end" && !event.success ? "模型重试失败" : "重试阶段结束" }); break;
      case "message_start":
        if (event.message.role === "assistant") { this.finishThinking(); this.assistantId = `assistant-${++this.sequence}`; this.thinkingText = ""; }
        changed = false; break;
      case "message_update":
        if (["thinking_start", "thinking_delta", "thinking_end"].includes(event.assistantMessageEvent.type)) this.captureThinking(event.message);
        if (event.assistantMessageEvent.type === "thinking_end") this.finishThinking();
        if (event.assistantMessageEvent.type === "text_delta" && event.message.role === "assistant") {
          this.finishThinking();
          this.activity(this.assistantId, "assistant", event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
        }
        changed = false; break;
      case "message_end":
        this.captureThinking(event.message);
        this.finishThinking();
        if (event.message.role === "assistant") {
          const output = event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          if (output) this.activity(this.assistantId, "assistant", output, true);
        }
        this.metrics(); changed = false; break;
      case "tool_execution_start":
        this.finishThinking();
        this.activity(`tool-${event.toolCallId}`, "tool_start", `${event.toolName} ${JSON.stringify(event.args)}`, true);
        changed = false; break;
      case "tool_execution_update": case "tool_execution_end": {
        const body = (event.type === "tool_execution_update" ? event.partialResult : event.result) as { content?: { type: string; text?: string }[]; details?: { permissionDenied?: boolean } };
        const output = body.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("\n") ?? "";
        const final = event.type === "tool_execution_end";
        this.activity(`output-${event.toolCallId}`, final ? (event.isError ? "tool_error" : body.details?.permissionDenied ? "tool_denied" : "tool_end") : "tool_update", `${event.toolName}\n${output}`, final);
        changed = false; break;
      }
      default: changed = false;
    }
    if (changed) this.send({ type: "runtime", state: structuredClone(this.state) });
  }
}
