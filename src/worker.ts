import {
  createAgentSessionServices, createAgentSessionFromServices, defineTool, SessionManager,
  createBashToolDefinition, createLocalBashOperations, createPowerShellToolDefinition, getShellConfig,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inheritedSettings } from "./settings.js";
import { workerInstructions } from "./instructions.js";
import { hasUv } from "./platform.js";
import { Mailbox } from "./mailbox.js";
import { Telemetry } from "./telemetry.js";
import { handoffParameters } from "./handoff-parameters.js";
import { isSettled } from "./handoff-contract.js";
import { PermissionApprovalGate, PermissionDeniedError, approvedShellOperations } from "./permission-approval.js";
import { createPermissionPolicy, resolvedToolInput } from "./permission-policy.js";
import { prepareHandoff, CpiError, errorCode, safeText, type Handoff, type WorkerCommand, type WorkerEvent, type WorkerStart } from "./protocol.js";

let session: AgentSession | undefined;
let cancelled = false;
let started = false;
let candidate: Handoff | undefined;
const mailbox = new Mailbox(event => send(event), () => { candidate = undefined; });
const permissionGate = new PermissionApprovalGate((id, action) => send({ type: "permission_approval", id, action }));
function send(event: WorkerEvent): Promise<void> {
  return new Promise(resolve => {
    if (!process.connected || !process.send) return resolve();
    process.send(event, error => { if (error) cancelled = true; resolve(); });
  });
}

// worker 工具名清单单一来源：保留工具、只读启用集合与可切换文件工具语义保持不变。
const HANDOFF_TOOL_NAMES: readonly string[] = ["report_progress", "submit_handoff"];
const SHELL_TOOL_NAMES: readonly string[] = ["bash", "powershell"];
const FILE_TOOL_NAMES: readonly string[] = ["read", "write", "edit", "grep", "find", "ls"];
const RESERVED_TOOL_NAMES: readonly string[] = [...HANDOFF_TOOL_NAMES, ...SHELL_TOOL_NAMES, ...FILE_TOOL_NAMES];
const READ_ONLY_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls", ...HANDOFF_TOOL_NAMES];
const SHELL_AND_FILE_TOOL_NAMES: readonly string[] = ["bash", ...FILE_TOOL_NAMES];

export async function runWorker(start: WorkerStart): Promise<void> {
  const settingsManager = await inheritedSettings(start.agentDir);
  const policy = await createPermissionPolicy(start.workspace);
  function recoverableTool(tool: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
    const execute = tool.execute;
    return { ...tool, execute: async (...args) => {
      try { return await execute(...args); }
      catch (error) {
        // 拒绝是本次调用的控制结果；真正的取消与执行错误仍按原路径处理。
        if (!(error instanceof PermissionDeniedError)) throw error;
        return { content: [{ type: "text", text: error.message }], details: { permissionDenied: true } };
      }
    } };
  }
  function protectedTool(tool: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
    const execute = tool.execute;
    return recoverableTool({ ...tool, execute: async (...args) => {
      const [, rawInput, signal] = args;
      const input = await resolvedToolInput(tool.name, structuredClone(rawInput) as Record<string, unknown>, start.workspace);
      args[1] = input;
      const reasons = await policy(tool.name, input);
      if (reasons.length) await permissionGate.request({ toolName: tool.name, input, cwd: start.workspace, reasons }, signal);
      if (signal?.aborted || cancelled) throw new CpiError("cancelled");
      return execute(...args);
    } });
  }
  const systemInstructions = workerInstructions(process.platform, await hasUv());
  const services = await createAgentSessionServices({
    cwd: start.workspace, agentDir: start.agentDir, settingsManager,
    resourceLoaderOptions: { appendSystemPrompt: [systemInstructions],
      // worker 使用内置权限策略，避免已有标准扩展重复审批或应用可修改的项目规则。
      extensionsOverride: base => ({ ...base, extensions: base.extensions.filter(extension =>
        !extension.resolvedPath.replaceAll("\\", "/").includes("/pi-permission-system/")) }),
    },
  });
  if (services.diagnostics.some(d => d.type === "error") || services.resourceLoader.getExtensions().errors.length) throw new CpiError("pi_extension_load_failed");
  if (services.diagnostics.length) await send({ type: "activity", kind: "diagnostic", text: `pi 初始化提示 ${services.diagnostics.length} 项（错误正文不写入监控）` });
  for (const extension of services.resourceLoader.getExtensions().extensions) {
    if (RESERVED_TOOL_NAMES.some(name => extension.tools.has(name))) throw new CpiError("pi_reserved_tool_conflict");
    for (const registered of extension.tools.values()) registered.definition = protectedTool(registered.definition);
  }
  const provider = settingsManager.getDefaultProvider()!;
  const modelId = settingsManager.getDefaultModel()!;
  const model = services.modelRuntime.getModel(provider, modelId);
  if (!model) throw new CpiError("pi_configured_model_unavailable");
  if (cancelled) throw new CpiError("cancelled");
  const shell = getShellConfig(settingsManager.getShellPath());
  const bash = createBashToolDefinition(start.workspace, {
    shellPath: shell.shell,
    commandPrefix: settingsManager.getShellCommandPrefix(),
    operations: approvedShellOperations(createLocalBashOperations({ shellPath: shell.shell }), permissionGate, shell.shell, shell.args, policy),
  });
  const result = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.inMemory(start.workspace),
    tools: start.task.mode === "read-only" ? [...READ_ONLY_TOOL_NAMES] : undefined,
    customTools: [
      ...[createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
        createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]
        .map(factory => protectedTool(factory(start.workspace))),
      defineTool(recoverableTool(bash)),
      defineTool({ ...createPowerShellToolDefinition(start.workspace), execute: async () => { throw new CpiError("use_approved_bash_tool"); } }),
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
        prepareArguments: prepareHandoff,
        executionMode: "sequential",
        execute: async (_id, params) => {
          candidate = prepareHandoff(params);
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
    // 新交接即使未通过参数校验，也不能回退交付先前的候选结果。
    if (event.type === "tool_execution_start" && event.toolName !== "report_progress") candidate = undefined;
    if (event.type === "message_end" && event.message.role === "assistant") modelFailed = ["error", "aborted"].includes(event.message.stopReason);
  });
  try {
    await session.bindExtensions({
      mode: "rpc", onError: () => { extensionFailed = true; },
      abortHandler: () => { void cancel(); }, shutdownHandler: async () => { await cancel(); },
    });
    if (extensionFailed) throw new CpiError("pi_extension_start_failed");
    if (start.task.mode === "read-only") session.setActiveToolsByName([...READ_ONLY_TOOL_NAMES]);
    else {
      const defaults = settingsManager.getDefaultTools() ?? ["read", "bash", "edit", "write"];
      session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "powershell"
        && (!SHELL_AND_FILE_TOOL_NAMES.includes(name) || !defaults || defaults.includes(name))));
    }
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
      await session.prompt("No valid handoff is recorded. Call submit_handoff for the original task using the work already done. Correct any validation errors and include status, summary, changes, verification, evidence, unresolved, and nextSteps; arrays may be empty, but must not be omitted. Report unmet acceptance criteria and missing verification accurately.", { expandPromptTemplates: false, source: "rpc" });
    }
    await mailbox.close();
    if (!isSettled(telemetry.state)) throw new CpiError("worker_not_settled");
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
  permissionGate.close();
  await mailbox.close(true);
  session?.clearQueue();
  await session?.abort();
}

process.on("message", (message: WorkerCommand) => {
  if (message.type === "permission_decision") permissionGate.receive(message.id, message.decision);
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
