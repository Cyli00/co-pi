import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CpiError, isTerminal, snapshotSchema } from "./protocol.js";
import { readStateThread } from "./state-thread.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const terminationTargetSchema = z.object({
  threadId: z.string().uuid(), sessionId: z.string().uuid(), batchId: identifier, taskId: identifier,
}).strict();
export type TerminationTarget = z.infer<typeof terminationTargetSchema>;
const requestSchema = terminationTargetSchema.extend({ version: z.literal(1), action: z.literal("terminate") }).strict();
const requestPath = (sessionDir: string, target: TerminationTarget) => join(sessionDir, "control", target.batchId, `${target.taskId}.json`);

export function initializeMonitorControl(sessionDir: string, threadId: string, sessionId: string): void {
  writeFileSync(join(sessionDir, "monitor-control.json"), JSON.stringify({ version: 1, threadId, sessionId }), { flag: "wx", mode: 0o600 });
}

export async function requestTaskTermination(root: string, value: TerminationTarget): Promise<void> {
  const parsed = terminationTargetSchema.safeParse(value);
  if (!parsed.success) throw new CpiError("termination_target_invalid");
  const target = parsed.data, sessionDir = join(root, target.sessionId);
  if (readStateThread(root) !== target.threadId || readStateThread(sessionDir) !== target.threadId) throw new CpiError("state_thread_conflict");
  try {
    const control = JSON.parse(await readFile(join(sessionDir, "monitor-control.json"), "utf8"));
    if (control.version !== 1 || control.sessionId !== target.sessionId || control.threadId !== target.threadId) throw new Error();
  } catch { throw new CpiError("termination_not_supported"); }
  let snapshot;
  try { snapshot = snapshotSchema.parse(JSON.parse(await readFile(join(sessionDir, `${target.batchId}.json`), "utf8"))); }
  catch { throw new CpiError("termination_target_unavailable"); }
  const task = snapshot.tasks.find(task => task.task.id === target.taskId);
  if (snapshot.sessionId !== target.sessionId || snapshot.batchId !== target.batchId || !task) throw new CpiError("termination_target_unavailable");
  if (snapshot.closed || isTerminal(task.phase)) throw new CpiError("task_already_finished");
  if (Date.now() - Date.parse(snapshot.heartbeatAt) > 20_000) throw new CpiError("termination_service_unavailable");
  await mkdir(join(sessionDir, "control", target.batchId), { recursive: true, mode: 0o700 });
  try { await writeFile(requestPath(sessionDir, target), JSON.stringify({ version: 1, action: "terminate", ...target }), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!await hasTerminationRequest(sessionDir, target)) throw new CpiError("termination_request_invalid");
  }
}

export async function hasTerminationRequest(sessionDir: string, target: TerminationTarget): Promise<boolean> {
  try {
    const path = requestPath(sessionDir, target);
    if ((await stat(path)).size > 1024) return false;
    const request = requestSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return request.success && request.data.threadId === target.threadId && request.data.sessionId === target.sessionId
      && request.data.batchId === target.batchId && request.data.taskId === target.taskId;
  } catch { return false; }
}
