import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { check, lock } from "proper-lockfile";

export type InstanceStatus = { key: string; ready: boolean; token?: string };
const STALE_MS = 10_000;

export async function canonicalStateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalStateDirectory(parent), basename(absolute));
  }
}

async function address(root: string, kind: "monitor" | "launcher") {
  root = await canonicalStateDirectory(root);
  const identity = `${homedir()}\0${root}\0${kind}`;
  const key = createHash("sha256").update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex");
  const file = join(root, `.cpi-${kind}.json`);
  return { root, key, file, options: { realpath: false, stale: STALE_MS, lockfilePath: `${file}.lock` } };
}

async function lockIdentity(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return `${info.dev}/${info.ino}/${info.birthtimeNs}`;
}

export async function findMonitorInstance(root: string, kind: "monitor" | "launcher" = "monitor"): Promise<InstanceStatus | undefined> {
  const { key, file, options } = await address(root, kind);
  try {
    if (!await check(file, options)) return;
    const identity = await lockIdentity(options.lockfilePath);
    const value = JSON.parse(await readFile(file, "utf8"));
    // 状态必须属于这一次加锁，不能把崩溃进程遗留的 ready 当作新实例。
    if (!value || value.key !== key || typeof value.ready !== "boolean" || value.lockIdentity !== identity
      || (value.token !== undefined && typeof value.token !== "string")) return { key, ready: false };
    if (await lockIdentity(options.lockfilePath) !== identity || !await check(file, options)) return;
    return { key, ready: value.ready, token: value.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return await check(file, options) ? { key, ready: false } : undefined;
    }
    throw error;
  }
}

export type InstanceLease = { readonly status: Readonly<InstanceStatus>; markReady(): Promise<void>; close(): Promise<void> };

export async function acquireMonitorInstance(root: string, kind: "monitor" | "launcher", token?: string): Promise<InstanceLease | undefined> {
  const { key, file, options, root: canonicalRoot } = await address(root, kind);
  await mkdir(canonicalRoot, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try { release = await lock(file, { ...options, update: 2_000 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return;
    throw error;
  }
  const status: InstanceStatus = { key, ready: false, token };
  let closing: Promise<void> | undefined;
  let pending = Promise.resolve();
  try {
    const identity = await lockIdentity(options.lockfilePath);
    const publish = async () => {
      const staging = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(staging, JSON.stringify({ ...status, lockIdentity: identity }), { flag: "wx", mode: 0o600 });
        await rename(staging, file);
      } finally { await unlink(staging).catch(() => {}); }
    };
    await publish();
    return {
      status,
      markReady() {
        if (closing) return Promise.reject(new Error("monitor_instance_closed"));
        status.ready = true;
        return pending = pending.then(publish);
      },
      close() {
        return closing ??= (async () => {
          try {
            await pending;
            if (await lockIdentity(options.lockfilePath) === identity) await unlink(file).catch(error => {
              if (error.code !== "ENOENT") throw error;
            });
          } finally { await release(); }
        })();
      },
    };
  } catch (error) { await release(); throw error; }
}
