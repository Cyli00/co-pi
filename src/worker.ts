import {
  createAgentSessionServices, createAgentSessionFromServices, defineTool, SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inheritedSettings } from "./settings.js";
import { workerInstructions } from "./instructions.js";
import { hasUv } from "./platform.js";
import { Mailbox } from "./mailbox.js";
import { Telemetry } from "./telemetry.js";
import { cleanHandoff, CpiError, errorCode, safeText, type Handoff, type WorkerCommand, type WorkerEvent, type WorkerStart } from "./protocol.js";

let session: AgentSession | undefined;
let cancelled = false;
let started = false;
let candidate: Handoff | undefined;
const mailbox = new Mailbox(event => send(event), () => { candidate = undefined; });
function send(event: WorkerEvent): Promise<void> {
  return new Promise(resolve => {
    if (!process.connected || !process.send) return resolve();
    process.send(event, error => { if (error) cancelled = true; resolve(); });
  });
}

const text = Type.String({ minLength: 1, maxLength: 2_000 });
const handoffParameters = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("blocked")]),
  summary: text,
  changes: Type.Array(text, { maxItems: 20 }),
  verification: Type.Array(Type.Object({
    action: text,
    result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
    detail: text,
  }), { maxItems: 20 }),
  evidence: Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), line: Type.Optional(Type.Integer({ minimum: 1 })), note: text }), { maxItems: 20 }),
  unresolved: Type.Array(text, { maxItems: 20 }),
  nextSteps: Type.Array(text, { maxItems: 10 }),
});

export async function runWorker(start: WorkerStart): Promise<void> {
  const settingsManager = await inheritedSettings(start.agentDir);
  const systemInstructions = workerInstructions(process.platform, await hasUv());
  const services = await createAgentSessionServices({
    cwd: start.workspace, agentDir: start.agentDir, settingsManager,
    resourceLoaderOptions: { appendSystemPrompt: [systemInstructions] },
  });
  if (services.diagnostics.some(d => d.type === "error") || services.resourceLoader.getExtensions().errors.length) throw new CpiError("pi_extension_load_failed");
  if (services.diagnostics.length) await send({ type: "activity", kind: "diagnostic", text: `pi 初始化提示 ${services.diagnostics.length} 项（错误正文不写入监控）` });
  for (const extension of services.resourceLoader.getExtensions().extensions) {
    if (["report_progress", "submit_handoff"].some(name => extension.tools.has(name))) throw new CpiError("pi_reserved_tool_conflict");
  }
  const provider = settingsManager.getDefaultProvider()!;
  const modelId = settingsManager.getDefaultModel()!;
  const model = services.modelRuntime.getModel(provider, modelId);
  if (!model) throw new CpiError("pi_configured_model_unavailable");
  if (cancelled) throw new CpiError("cancelled");
  const result = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.inMemory(start.workspace),
    tools: start.task.mode === "read-only" ? ["read", "grep", "find", "ls", "report_progress", "submit_handoff"] : undefined,
    customTools: [
      defineTool({
        name: "report_progress", label: "Report progress", description: "Report a short public summary of a meaningful phase change or blocker.",
        parameters: Type.Object({ phase: Type.Union([Type.Literal("running"), Type.Literal("summarizing")]), summary: Type.String({ minLength: 1, maxLength: 300 }) }),
        execute: async (_id, params) => {
          await send({ type: "progress", phase: params.phase, summary: safeText(params.summary, 300) });
          return { content: [{ type: "text", text: "Progress recorded." }], details: {} };
        },
      }),
      defineTool({
        name: "submit_handoff", label: "Submit handoff", description: "Finish the assigned task with an evidence-based handoff against its acceptance criteria. Report verification and remaining work accurately.",
        parameters: handoffParameters,
        execute: async (_id, params) => {
          candidate = cleanHandoff(params);
          return { content: [{ type: "text", text: "Handoff recorded. End this task." }], details: {} };
        },
      }),
    ],
  });
  session = result.session;
  let modelFailed = false;
  let extensionFailed = false;
  let attached = false;
  const telemetry = new Telemetry(session, event => send(event));
  const unsubscribe = session.subscribe(event => {
    telemetry.event(event);
    mailbox.event(event);
    if (event.type === "agent_start" && !attached) {
      attached = true;
      mailbox.attach(session!);
    }
    if (event.type === "message_start" && event.message.role === "user") candidate = undefined;
    if (event.type === "tool_execution_start" && !["submit_handoff", "report_progress"].includes(event.toolName)) candidate = undefined;
    if (event.type === "message_end" && event.message.role === "assistant") modelFailed = ["error", "aborted"].includes(event.message.stopReason);
  });
  try {
    await session.bindExtensions({
      mode: "rpc", onError: () => { extensionFailed = true; },
      abortHandler: () => { void cancel(); }, shutdownHandler: async () => { await cancel(); },
    });
    if (extensionFailed) throw new CpiError("pi_extension_start_failed");
    if (start.task.mode === "read-only") session.setActiveToolsByName(["read", "grep", "find", "ls", "report_progress", "submit_handoff"]);
    await send({ type: "ready", model: `${provider}/${modelId}`, thinking: session.thinkingLevel });
    if (cancelled) throw new CpiError("cancelled");
    const prompt = `Task ${start.task.id}: ${start.task.title}
Mode: ${start.task.mode}

Objective:
${start.task.instruction}

Acceptance criteria:
${start.task.acceptance}

Context and existing authorization:
${start.context || "No additional authorization."}`;
    await session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
    let summarizedRevision = -1;
    for (;;) {
      await mailbox.drain();
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!session.isIdle || mailbox.busy) continue;
      if (cancelled) throw new CpiError("cancelled");
      if (extensionFailed) throw new CpiError("pi_extension_runtime_failed");
      if (modelFailed) throw new CpiError("model_request_failed");
      if (candidate) break;
      if (summarizedRevision === mailbox.revision) throw new CpiError("handoff_missing");
      summarizedRevision = mailbox.revision;
      await send({ type: "progress", phase: "summarizing", summary: "正在生成最终任务交接" });
      session.setActiveToolsByName(["submit_handoff"]);
      await session.prompt("Call submit_handoff for the original task using the work already done. Report unmet acceptance criteria and missing verification accurately.", { expandPromptTemplates: false, source: "rpc" });
    }
    await mailbox.close();
    if (!telemetry.state.settled || telemetry.state.compacting || telemetry.state.retry || telemetry.state.queue.steering || telemetry.state.queue.followUp) throw new CpiError("worker_not_settled");
    await send({ type: "closing" });
    telemetry.flush(); telemetry.metrics();
    await send({ type: "result", handoff: candidate! });
  } finally {
    await mailbox.close(true);
    telemetry.flush();
    unsubscribe();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    session = undefined;
  }
}

async function cancel() {
  cancelled = true;
  await mailbox.close(true);
  session?.clearQueue();
  await session?.abort();
}

process.on("message", (message: WorkerCommand) => {
  if (message.type === "cancel") void cancel();
  if (message.type === "message") mailbox.receive(message);
  if (message.type === "start" && !started) {
    started = true;
    const heartbeat = setInterval(() => { void send({ type: "heartbeat" }); }, 5_000);
    void runWorker(message).catch(error => send({ type: "error", code: errorCode(error) })).finally(() => {
      clearInterval(heartbeat);
      process.disconnect?.();
      process.exit(0);
    });
  }
});
process.on("disconnect", () => {
  void cancel().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 3_000).unref();
});
process.on("SIGTERM", () => { void cancel(); });
