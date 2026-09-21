import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { safeText, snapshotSchema, type Snapshot } from "./protocol.js";

export const defaultStateDir = () => join(homedir(), ".cpi", "state");

export class StateStore {
  readonly sessionId = randomUUID();
  readonly directory: string;
  constructor(root: string) {
    this.directory = join(root, this.sessionId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  write(snapshot: Snapshot): void {
    const path = join(this.directory, `${snapshot.batchId}.json`);
    const temp = `${path}.tmp`;
    const publicSnapshot = { ...snapshot, tasks: snapshot.tasks.map(state => ({
      ...state, task: { ...state.task, title: safeText(state.task.title, 160), instruction: "", acceptance: "" },
    })) };
    writeFileSync(temp, JSON.stringify(publicSnapshot), { mode: 0o600 });
    renameSync(temp, path);
  }
}

export function readSnapshots(root: string, sessionId?: string): Snapshot[] {
  const snapshots: Snapshot[] = [];
  let directories: string[];
  try { directories = readdirSync(root); } catch { return snapshots; }
  for (const name of directories) {
    if (!/^[a-f0-9-]{36}$/.test(name) || (sessionId && name !== sessionId)) continue;
    const directory = join(root, name);
    let files: string[];
    try { files = readdirSync(directory); } catch { continue; }
    for (const file of files) {
      if (!/^[a-zA-Z0-9_-]{1,80}\.json$/.test(file)) continue;
      try {
        const path = join(directory, file);
        if (statSync(path).size > 8_000_000) continue;
        const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        if (parsed.success && parsed.data.sessionId === name) snapshots.push(parsed.data);
      } catch { /* 原子替换期间或损坏的快照不会阻塞其他任务。 */ }
    }
  }
  return snapshots.sort((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt));
}
