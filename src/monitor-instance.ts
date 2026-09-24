import { createHash } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export type InstanceStatus = { key: string; ready: boolean; token?: string };

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

function address(root: string, kind: "monitor" | "launcher") {
  const identity = `${homedir()}\0${root}\0${kind}`;
  const key = createHash("sha256").update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex");
  const first = 20_000 + Number.parseInt(key.slice(0, 8), 16) % 40_000;
  return { key, ports: Array.from({ length: 16 }, (_, i) => 20_000 + (first - 20_000 + i) % 40_000) };
}

async function probe(port: number, key: string): Promise<InstanceStatus | undefined> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let text = "";
    const finish = (status?: InstanceStatus) => { socket.destroy(); resolve(status); };
    socket.setTimeout(200, () => finish());
    socket.on("error", () => finish());
    socket.on("data", chunk => {
      text += chunk.toString();
      if (text.length > 1024) return finish();
      if (!text.includes("\n")) return;
      try {
        const value = JSON.parse(text.split("\n")[0]!);
        finish(value.key === key && typeof value.ready === "boolean" ? value : undefined);
      } catch { finish(); }
    });
    socket.on("end", () => finish());
  });
}

export async function findMonitorInstance(root: string, kind: "monitor" | "launcher" = "monitor"): Promise<InstanceStatus | undefined> {
  const { key, ports } = address(root, kind);
  const statuses = await Promise.all(ports.map(port => probe(port, key)));
  return statuses.find(Boolean);
}

export type InstanceLease = { status: InstanceStatus; close(): Promise<void> };

export async function acquireMonitorInstance(root: string, kind: "monitor" | "launcher", token?: string): Promise<InstanceLease | undefined> {
  const { key, ports } = address(root, kind);
  const status: InstanceStatus = { key, ready: false, token };
  for (const port of ports) {
    const server: Server = createServer(socket => {
      socket.on("error", () => socket.destroy());
      socket.setTimeout(1000, () => socket.destroy());
      socket.end(JSON.stringify(status) + "\n");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      server.on("error", () => {});
      return { status, close: () => new Promise(resolve => server.close(() => resolve())) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (await probe(port, key)) return undefined;
      // 端口散列碰撞时避开其他服务；连接只返回实例身份和就绪状态，不传任务数据。
    }
  }
  throw new Error("monitor_instance_ports_unavailable");
}
