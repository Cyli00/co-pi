import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { CpiError, safeText } from "./protocol.js";
import type { PermissionPolicy } from "./permission-policy.js";

export const permissionActionSchema = z.union([z.object({
  command: z.string().min(1).max(32_000),
  cwd: z.string().min(1).max(32_768),
  shell: z.string().min(1).max(32_768),
  shellArgs: z.array(z.string().max(200)).max(10),
  timeout: z.number().finite().positive().optional(),
  reasons: z.array(z.unknown()).optional(),
}).strict(), z.object({
  toolName: z.string().min(1).max(200),
  input: z.record(z.unknown()),
  cwd: z.string().min(1).max(32_768),
  reasons: z.array(z.unknown()),
}).strict()]);
export type PermissionAction = z.infer<typeof permissionActionSchema>;
export const permissionDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().max(2_000).optional(),
}).strict();
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export type PermissionReviewer = (action: PermissionAction, taskId: string, signal: AbortSignal) => Promise<PermissionDecision>;
export const PERMISSION_APPROVAL_TIMEOUT_MS = 120_000;

export class PermissionDeniedError extends Error {
  constructor(reason: string) {
    super(`Tool invocation was not executed: ${safeText(reason, 2_000)}.\ncontinue, try another safer way.\nThe denial applies to this invocation, not the whole task. Do not bypass the decision or repeat the denied action through another tool. Continue with a materially safer action within existing authorization.`);
  }
}

export class PermissionApprovalGate {
  private readonly pending = new Map<string, (decision: PermissionDecision) => void>();
  private closed = false;

  constructor(
    private readonly send: (id: string, action: PermissionAction) => Promise<void>,
    private readonly timeoutMs = PERMISSION_APPROVAL_TIMEOUT_MS,
  ) {}

  async request(action: PermissionAction, signal?: AbortSignal): Promise<void> {
    permissionActionSchema.parse(action);
    if (this.closed || signal?.aborted) throw new CpiError("permission_approval_cancelled");
    const id = randomUUID();
    const decision = await new Promise<PermissionDecision>(resolve => {
      const finish = (decision: PermissionDecision) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        resolve(decision);
      };
      const cancel = () => finish({ approved: false, reason: "permission_approval_cancelled" });
      const timer = setTimeout(() => finish({ approved: false, reason: "permission_approval_timeout" }), this.timeoutMs);
      this.pending.set(id, finish);
      signal?.addEventListener("abort", cancel, { once: true });
      void this.send(id, action).catch(() => finish({ approved: false, reason: "permission_approval_transport_failed" }));
    });
    if (this.closed || signal?.aborted) throw new CpiError("permission_approval_cancelled");
    if (!decision.approved) throw new PermissionDeniedError(decision.reason ?? "permission_approval_denied");
  }

  receive(id: string, decision: unknown): void {
    const parsed = permissionDecisionSchema.safeParse(decision);
    this.pending.get(id)?.(parsed.success ? parsed.data : { approved: false, reason: "permission_approval_invalid" });
  }

  close(): void {
    this.closed = true;
    for (const finish of this.pending.values()) finish({ approved: false, reason: "permission_approval_cancelled" });
  }
}

export function approvedShellOperations(
  local: BashOperations,
  gate: PermissionApprovalGate,
  shell: string,
  shellArgs: string[],
  policy?: PermissionPolicy,
): BashOperations {
  return {
    async exec(command, cwd, options) {
      // 审查前缀和 spawnHook 处理后的实际命令，避免模型参数与执行命令不一致。
      const reasons = policy ? await policy("bash", { command, workdir: cwd }) : undefined;
      if (!reasons || reasons.length) await gate.request({ command, cwd, shell, shellArgs, timeout: options.timeout, ...(reasons ? { reasons } : {}) }, options.signal);
      if (options.signal?.aborted) throw new CpiError("permission_approval_cancelled");
      return local.exec(command, cwd, options);
    },
  };
}
