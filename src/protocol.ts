import { z } from "zod";

export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().min(1).max(160),
  instruction: z.string().min(1).max(24_000),
  acceptance: z.string().min(1).max(4_000),
  mode: z.enum(["coding", "read-only"]).default("coding"),
}).strict();
export const batchSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  workspace: z.string().min(1),
  context: z.string().max(24_000).default(""),
  tasks: z.array(taskSchema).min(1).max(4),
}).strict().refine(b => new Set(b.tasks.map(t => t.id)).size === b.tasks.length, "Task IDs must be unique");

const shortText = z.string().min(1).max(2_000);
export const handoffSchema = z.object({
  status: z.enum(["completed", "partial", "blocked"]),
  summary: shortText,
  changes: z.array(shortText).max(20),
  verification: z.array(z.object({
    action: shortText,
    result: z.enum(["passed", "failed", "not_run"]),
    detail: shortText,
  }).strict()).max(20),
  evidence: z.array(z.object({
    path: z.string().min(1).max(500),
    line: z.number().int().positive().optional(),
    note: shortText,
  }).strict()).max(20),
  unresolved: z.array(shortText).max(20),
  nextSteps: z.array(shortText).max(10),
}).strict().refine(h => h.status !== "completed" || h.unresolved.length === 0,
  "Use partial or blocked when unresolved work remains");

export type Task = z.infer<typeof taskSchema>;
export type Batch = z.infer<typeof batchSchema>;
export type Handoff = z.infer<typeof handoffSchema>;
export type Phase = "queued" | "starting" | "running" | "summarizing" | "completed" | "partial" | "blocked" | "failed" | "cancelled";
export const isTerminal = (phase: Phase) => ["completed", "partial", "blocked", "failed", "cancelled"].includes(phase);

export interface Activity {
  id?: string;
  final?: boolean;
  at: string;
  kind: string;
  text: string;
}
export const messageModeSchema = z.enum(["steer", "followUp"]);
export const messageStatusSchema = z.enum(["sent", "received", "accepted", "queued", "delivered", "rejected", "cancelled", "unknown"]);
export const receiptSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), mode: messageModeSchema, status: messageStatusSchema,
  at: z.string().datetime(), error: z.string().max(80).optional(),
});
export type MessageMode = z.infer<typeof messageModeSchema>;
export type MessageReceipt = z.infer<typeof receiptSchema>;
export const runtimeSchema = z.object({
  settled: z.boolean(), compacting: z.boolean(), compactionReason: z.string().max(40).optional(),
  retry: z.object({ scope: z.enum(["model", "summary"]), attempt: z.number().int().nonnegative(), maxAttempts: z.number().int().nonnegative(), until: z.string().datetime() }).optional(),
  queue: z.object({ steering: z.number().int().nonnegative(), followUp: z.number().int().nonnegative() }),
});
export type RuntimeState = z.infer<typeof runtimeSchema>;
export const metricsSchema = z.object({
  input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(),
  total: z.number().nonnegative(), cost: z.number().nonnegative(), toolCalls: z.number().int().nonnegative(),
  contextTokens: z.number().nonnegative().nullable(), contextWindow: z.number().nonnegative().nullable(), contextPercent: z.number().nonnegative().nullable(),
});
export type Metrics = z.infer<typeof metricsSchema>;
export interface TaskState {
  task: Task;
  phase: Phase;
  updatedAt: string;
  heartbeatAt?: string;
  model?: string;
  thinking?: string;
  summary: string;
  events: Activity[];
  omittedEvents: number;
  handoff?: Handoff;
  error?: string;
  runtime?: RuntimeState;
  metrics?: Metrics;
  messages?: MessageReceipt[];
}
export interface Snapshot {
  version: 1;
  sessionId: string;
  pid: number;
  heartbeatAt: string;
  closed: boolean;
  batchId: string;
  workspace: string;
  tasks: TaskState[];
}
export const snapshotSchema = z.object({
  version: z.literal(1), sessionId: z.string().uuid(), pid: z.number().int().positive(),
  heartbeatAt: z.string().datetime(), closed: z.boolean(), batchId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  workspace: z.string().max(32_768),
  tasks: z.array(z.object({
    task: taskSchema.extend({ instruction: z.string().max(24_000), acceptance: z.string().max(4_000) }),
    phase: z.enum(["queued", "starting", "running", "summarizing", "completed", "partial", "blocked", "failed", "cancelled"]),
    updatedAt: z.string().datetime(), heartbeatAt: z.string().datetime().optional(),
    model: z.string().max(200).optional(), thinking: z.string().max(20).optional(), summary: z.string().max(2_000),
    events: z.array(z.object({ id: z.string().max(200).optional(), final: z.boolean().optional(), at: z.string().datetime(), kind: z.string().max(40), text: z.string().max(4_000) })).max(200),
    omittedEvents: z.number().int().nonnegative(), handoff: handoffSchema.optional(), error: z.string().max(80).optional(),
    runtime: runtimeSchema.optional(), metrics: metricsSchema.optional(), messages: z.array(receiptSchema).max(128).optional(),
  })).max(4),
});
export interface WorkerStart {
  type: "start";
  task: Task;
  workspace: string;
  context: string;
  agentDir: string;
}
export type MessageCommand = { type: "message"; id: string; mode: MessageMode; text: string };
export type WorkerCommand = WorkerStart | { type: "cancel" } | MessageCommand;
export type WorkerEvent =
  | { type: "ready"; model: string; thinking: string }
  | { type: "heartbeat" }
  | { type: "activity"; kind: string; text: string; id?: string; final?: boolean }
  | { type: "receipt"; receipt: MessageReceipt }
  | { type: "runtime"; state: RuntimeState }
  | { type: "metrics"; metrics: Metrics }
  | { type: "closing" }
  | { type: "progress"; phase: "running" | "summarizing"; summary: string }
  | { type: "result"; handoff: Handoff }
  | { type: "error"; code: string };

// 错误正文可能包含供应商返回的凭据或请求，不越过进程边界。
export class CpiError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function errorCode(error: unknown): string {
  return error instanceof CpiError ? error.code : "internal_error";
}

export function safeText(value: unknown, limit = 4_000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已脱敏私钥]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/g, "[已脱敏令牌]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, "$1[已脱敏]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[已脱敏]@")
    .slice(0, limit);
}

export function cleanHandoff(value: unknown): Handoff {
  const handoff = handoffSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(handoff)) > 32_000) throw new CpiError("handoff_too_large");
  const clean = (v: unknown): unknown => typeof v === "string" ? safeText(v, 2_000)
    : Array.isArray(v) ? v.map(clean)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, clean(item)])) : v;
  return handoffSchema.parse(clean(handoff));
}
