#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const errors = {
  connection_failed: '无法连接正在运行的 Codex App Server。请确认 Codex 支持 app-server proxy，且未使用 --no-daemon；远程连接需指定对应的 --sock。',
  connection_closed: 'App Server 连接提前关闭。若已发送重载请求，结果可能尚未确认，请先检查原线程。',
  timeout: '等待 App Server 超时。若已发送重载请求，结果可能尚未确认，请先检查原线程，不要自动重试。',
  unsupported: '当前 App Server 不支持所需接口，请检查 Codex 版本。',
  rpc_failed: 'App Server 拒绝了请求，未确认重载成功。错误正文未回显。',
  invalid_response: 'App Server 返回了无法识别的响应。',
  thread_missing: '目标线程未加载在这个 App Server 中。请检查 --thread-id、CODEX_HOME 或 --sock；未提交重载。',
  no_threads: '这个 App Server 没有已加载线程，未提交重载。',
  invalid_arguments: '参数无效，请运行 node scripts/reload-mcp.mjs --help。',
};

// proxy 转发 WebSocket 原始字节。临时回环端口供 Node 内置 WebSocket 完成握手。
export function connectAppServer({ codex = process.platform === 'win32' ? 'codex.exe' : 'codex', sock, timeoutMs = 15000 } = {}) {
  let child, peer, ws, closed = false, sequence = 0;
  let readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const relay = createServer(socket => {
    if (peer || closed) { socket.destroy(); return; }
    peer = socket;
    child = spawn(codex, ['app-server', 'proxy', ...(sock ? ['--sock', sock] : [])], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    child.on('error', () => close(new Error('connection_failed')));
    child.on('exit', () => close(new Error('connection_closed')));
    peer.on('error', () => close(new Error('connection_failed')));
    child.stdin.on('error', () => close(new Error('connection_closed')));
    peer.pipe(child.stdin);
    child.stdout.pipe(peer);
  });
  const timer = setTimeout(() => close(new Error('timeout')), timeoutMs);
  function close(error = new Error('connection_closed')) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    readyReject(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    ws?.close();
    peer?.destroy();
    child?.kill();
    relay.close();
  }
  relay.on('error', () => close(new Error('connection_failed')));
  relay.listen(0, '127.0.0.1', () => {
    if (closed) { relay.close(); return; }
    ws = new WebSocket(`ws://127.0.0.1:${relay.address().port}`);
    ws.onopen = () => { clearTimeout(timer); readyResolve(); };
    ws.onerror = () => close(new Error('connection_failed'));
    ws.onclose = () => close(new Error('connection_closed'));
    ws.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { close(new Error('invalid_response')); return; }
      if (!message || typeof message !== 'object') { close(new Error('invalid_response')); return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.code === -32601 ? 'unsupported' : 'rpc_failed'));
      else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else entry.reject(new Error('invalid_response'));
    };
  });
  const send = message => {
    if (closed || ws?.readyState !== WebSocket.OPEN) throw new Error('connection_closed');
    ws.send(JSON.stringify(message));
  };
  return {
    ready, close,
    notify: (method, params) => send({ method, ...(params === undefined ? {} : { params }) }),
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const requestTimer = setTimeout(() => close(new Error('timeout')), timeoutMs);
        pending.set(id, { resolve, reject, timer: requestTimer });
        try { send({ id, method, ...(params === undefined ? {} : { params }) }); }
        catch (error) {
          pending.delete(id);
          clearTimeout(requestTimer);
          reject(error);
          close(error);
        }
      });
    },
  };
}

export async function reloadMcp(options = {}, { connect = connectAppServer, log = console.log } = {}) {
  const client = connect(options);
  try {
    await client.ready;
    await client.request('initialize', { clientInfo: { name: 'co-pi-mcp-reload', version: '1.0.0' } });
    client.notify('initialized', {});
    const threads = new Set(), cursors = new Set();
    let cursor;
    do {
      const page = await client.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data) || !page.data.every(id => typeof id === 'string')
        || (page.nextCursor != null && typeof page.nextCursor !== 'string')) throw new Error('invalid_response');
      for (const id of page.data) threads.add(id);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('invalid_response');
      cursors.add(cursor);
    } while (cursor);
    if (options.threadId && !threads.has(options.threadId)) throw new Error('thread_missing');
    if (!threads.size) throw new Error('no_threads');
    log(`已连接 App Server，已加载 ${threads.size} 个线程。${options.threadId ? '目标线程已确认。' : '未指定线程 ID，未核对当前 CLI 所属线程。'}`);
    log('刷新范围：此 App Server 下已加载线程的全部 MCP，不能仅指定 co-pi。');
    if (options.check) {
      log('只读检查完成，未提交重载；未验证重载接口或 co-pi 启动结果。');
      return { queued: false, threads: threads.size };
    }
    log('请在 co-pi worker 及其他受影响的 MCP 任务结束后使用此命令。');
    // 此接口的参数类型为 Option<()>，必须省略 params，不能发送空对象。
    const result = await client.request('config/mcpServer/reload');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_response');
    log('MCP 重载已排队。请在原线程发送下一条消息以应用刷新，再用 /mcp verbose 检查 co-pi。');
    log('Codex CLI 和线程历史保留；排队成功不代表新服务已启动。');
    return { queued: true, threads: threads.size };
  } finally { client.close(); }
}

export async function main(args = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      check: { type: 'boolean' }, help: { type: 'boolean' },
      'thread-id': { type: 'string' }, sock: { type: 'string' }, codex: { type: 'string' },
      'timeout-ms': { type: 'string', default: '15000' },
    } }));
  } catch { throw new Error('invalid_arguments'); }
  if (values.help) {
    console.log(`用法：node scripts/reload-mcp.mjs [--check] [--thread-id <ID>] [--sock <路径>]
保留 Codex CLI 和线程，通过现有 App Server 重载全部已加载线程的 MCP。
请先结束受影响的 MCP 任务。不能仅重启 co-pi；下一轮执行时才应用刷新。
--check          只检查控制连接和已加载线程，不发送重载
--thread-id      核对目标线程是否属于该服务，默认 CODEX_THREAD_ID
--sock           指定现有 App Server 控制 socket，默认由 Codex 定位
--codex          Codex 可执行文件路径，默认从 PATH 查找
--timeout-ms     每次连接或请求的超时，默认 15000 毫秒
不启动或重启 App Server，不修改配置。--no-daemon 或无可访问控制 socket 的会话不适用。`);
    return;
  }
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('invalid_arguments');
  await reloadMcp({ check: values.check, threadId: values['thread-id'] ?? process.env.CODEX_THREAD_ID,
    sock: values.sock, codex: values.codex, timeoutMs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(errors[error.message] ?? 'MCP 重载失败，未确认结果。错误正文未回显。');
    process.exitCode = 1;
  });
}
