import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CpiError } from "./protocol.js";

const BINDING_FILE = "codex-thread.json";

export function normalizeThreadId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new CpiError("codex_thread_id_invalid");
  return value.toLowerCase();
}

export function readStateThread(root: string): string | undefined {
  const file = join(root, BINDING_FILE);
  try {
    if (statSync(file).size > 1024) throw new Error();
    const binding = JSON.parse(readFileSync(file, "utf8"));
    if (binding?.version !== 1 || typeof binding.threadId !== "string" || !binding.threadId) throw new Error();
    return normalizeThreadId(binding.threadId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CpiError("state_thread_binding_invalid");
  }
}

export function resolveStateThread(root: string, requested?: string): string | undefined {
  const threadId = normalizeThreadId(requested);
  const bound = readStateThread(root);
  if (threadId && bound && threadId !== bound) throw new CpiError("state_thread_conflict");
  return bound ?? threadId;
}

export function bindStateThread(root: string, requested?: string): string | undefined {
  const threadId = resolveStateThread(root, requested);
  if (!threadId) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    // 绑定只创建一次；其他线程不能用同一目录覆盖原来的身份。
    writeFileSync(join(root, BINDING_FILE), JSON.stringify({ version: 1, threadId }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readStateThread(root) !== threadId) throw new CpiError("state_thread_conflict");
  }
  return threadId;
}
