import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CpiError, safeText, snapshotSchema, type Snapshot } from "./protocol.js";

export const defaultStateDir = () => join(homedir(), ".cpi", "state");

// 合法快照的字节上限：snapshotSchema 里每个字符串 .max() 以 UTF-16 码元计，
// 而 JSON 文本最坏会把一个码元转义成 \uXXXX（6 字节），据此推导读取端接受的最大文件。
// 读写共用该契约，避免写入端产出、读取端却因体积阈值静默跳过的整批丢失。
const JSON_UNIT_BYTES = 6;
// 单任务非 events/handoff/messages 字段的码元上限，逐项对齐 snapshotSchema。
const TASK_FIELD_UNITS = 64 /* id */ + 160 /* title */ + 24_000 /* instruction */
  + 4_000 /* acceptance */ + 9 /* mode */ + 11 /* phase */ + 40 /* updatedAt */
  + 40 /* heartbeatAt */ + 200 /* model */ + 20 /* thinking */ + 2_000 /* summary */
  + 80 /* error */ + 40 /* runtime.compactionReason */;
// 最多 200 条事件：id(200) + at(40) + kind(40) + text(4000)。
const TASK_EVENT_UNITS = 200 * (200 + 40 + 40 + 4_000);
// handoffSchema 上限：status(9) + summary(2000) + changes 20×2000 +
// verification 20×(2000+2000) + evidence 20×(500+2000) + unresolved 20×2000 + nextSteps 10×2000。
const TASK_HANDOFF_UNITS = 9 + 2_000 + 20 * 2_000 + 20 * 4_000 + 20 * 2_500 + 20 * 2_000 + 10 * 2_000;
// 最多 128 条回执：id(80) + mode(8) + status(9) + at(40) + error(80)。
const TASK_MESSAGE_UNITS = 128 * (80 + 8 + 9 + 40 + 80);
// 顶层 sessionId(36) + batchId(80) + workspace(32768) + heartbeatAt(40)。
const TOP_LEVEL_UNITS = 36 + 80 + 32_768 + 40;
// 键名、引号、逗号等 JSON 结构开销的宽裕余量，取上界不影响合法快照。
const STRUCTURE_BYTES = 256 * 1_024;
// 最多 4 个任务；读写共用同一上限，写入端不会产出读取端会跳过的文件。
export const SNAPSHOT_MAX_BYTES = JSON_UNIT_BYTES
  * (4 * (TASK_FIELD_UNITS + TASK_EVENT_UNITS + TASK_HANDOFF_UNITS + TASK_MESSAGE_UNITS) + TOP_LEVEL_UNITS)
  + STRUCTURE_BYTES;
const SNAPSHOT_MAX_BYTES_BIGINT = BigInt(SNAPSHOT_MAX_BYTES);
// safeText 会剥离 ANSI/控制序列；纯控制字符标题会被清成空串并触发 taskSchema 的 min(1)，
// 使读取端整批校验失败，因此用非空安全占位标题兜底。
const UNTITLED_TITLE = "未命名任务";

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
      ...state, task: { ...state.task, title: safeText(state.task.title, 160) || UNTITLED_TITLE, instruction: "", acceptance: "" },
    })) };
    // 在排队前固定本次内容；同一个临时文件只允许一个写入者。
    const content = JSON.stringify(publicSnapshot);
    // 超过上限的内容不可能通过 snapshotSchema；明确拒绝写入，而不是落盘后被读取端静默跳过。
    if (Buffer.byteLength(content) > SNAPSHOT_MAX_BYTES) return Promise.reject(new CpiError("snapshot_too_large"));
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
          if (stat.size > SNAPSHOT_MAX_BYTES_BIGINT) continue;
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
