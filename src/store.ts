import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { safeText, snapshotSchema, type Snapshot } from "./protocol.js";

export const defaultStateDir = () => join(homedir(), ".cpi", "state");

export class StateStore {
  readonly sessionId = randomUUID();
  readonly directory: string;
  private pending = Promise.resolve();
  constructor(root: string) {
    this.directory = join(root, this.sessionId);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  write(snapshot: Snapshot): Promise<void> {
    const path = join(this.directory, `${snapshot.batchId}.json`);
    const temp = `${path}.tmp`;
    const publicSnapshot = { ...snapshot, tasks: snapshot.tasks.map(state => ({
      ...state, task: { ...state.task, title: safeText(state.task.title, 160), instruction: "", acceptance: "" },
    })) };
    // 在排队前固定本次内容；同一个临时文件只允许一个写入者。
    const content = JSON.stringify(publicSnapshot);
    const write = this.pending.then(async () => {
      await retryOccupied(() => fsp.writeFile(temp, content, { mode: 0o600 }));
      await retryOccupied(() => fsp.rename(temp, path));
    });
    this.pending = write.catch(() => {});
    return write;
  }
}

async function retryOccupied(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await operation(); return; }
    catch (error) {
      if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Windows 读者的短暂占用不应取消整批任务；永久失败仍向上传递。
      await delay(20 * 2 ** attempt);
    }
  }
}

export class SnapshotReader {
  private readonly cache = new Map<string, { signature: string; snapshot?: Snapshot }>();
  constructor(private readonly root: string, private readonly sessionId?: string) {}

  read(): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const seen = new Set<string>();
    let directories: string[];
    try { directories = fs.readdirSync(this.root); } catch { this.cache.clear(); return snapshots; }
    for (const name of directories) {
      if (!/^[a-f0-9-]{36}$/.test(name) || (this.sessionId && name !== this.sessionId)) continue;
      const directory = join(this.root, name);
      let files: string[];
      try { files = fs.readdirSync(directory); } catch { continue; }
      for (const file of files) {
        if (!/^[a-zA-Z0-9_-]{1,80}\.json$/.test(file)) continue;
        const path = join(directory, file);
        try {
          const stat = fs.statSync(path, { bigint: true });
          if (stat.size > 8_000_000n) continue;
          seen.add(path);
          const signature = `${stat.ino}/${stat.size}/${stat.mtimeNs}/${stat.ctimeNs}`;
          let cached = this.cache.get(path);
          if (cached?.signature !== signature) {
            const content = fs.readFileSync(path, "utf8");
            let snapshot: Snapshot | undefined;
            try {
              const parsed = snapshotSchema.safeParse(JSON.parse(content));
              if (parsed.success && parsed.data.sessionId === name) snapshot = parsed.data;
            } catch { /* 损坏文件也缓存到下一次变更，避免反复解析。 */ }
            cached = { signature, snapshot };
            this.cache.set(path, cached);
          }
          if (cached.snapshot) snapshots.push(cached.snapshot);
        } catch { /* 短暂访问失败留到下一轮重试，不影响其他任务。 */ }
      }
    }
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    return snapshots.sort((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt));
  }
}

export function readSnapshots(root: string, sessionId?: string): Snapshot[] {
  return new SnapshotReader(root, sessionId).read();
}
