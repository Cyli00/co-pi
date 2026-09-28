import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpSessions } from '../dist/mcp-sessions.js';
import { createMcpServer } from '../dist/mcp.js';
import { bindStateThread, readStateThread } from '../dist/state-thread.js';
import { StateStore, SnapshotReader } from '../dist/store.js';
import { serializeConfig, validateConfig } from '../dist/config.js';
import { temporary, task } from './helpers.mjs';

const monitor = (root, stateDir, args = []) => spawnSync(process.execPath,
  ['dist/monitor-cli.js', '--once', '--state-dir', stateDir, '--codex-home', join(root, 'empty-codex'), ...args],
  { encoding: 'utf8', timeout: 15000, env: { ...process.env, CODEX_THREAD_ID: '', CPI_STATE_DIR: '' }, windowsHide: true });

test('共享 MCP 按请求元数据隔离线程、同名批次及交接，monitor 只显示本线程', async t => {
  let sessions, client, server;
  const root = temporary(t, async () => { await client?.close(); await server?.close(); await sessions?.close(); });
  const base = join(root, 'state'), configPath = join(root, 'config.toml');
  writeFileSync(configPath, serializeConfig(validateConfig({})));
  sessions = new McpSessions({ agentDir: root, configPath,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) }, id => join(base, id));
  server = createMcpServer(sessions);
  client = new Client({ name: 'isolation-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const first = randomUUID(), second = randomUUID();
  const call = (threadId, name, args = {}) => client.callTool({ name, arguments: args, _meta: { threadId } });
  const info = async id => JSON.parse((await call(id, 'get_capabilities')).content[0].text);
  const one = await info(first), two = await info(second);
  assert.equal(one.thread_id, first);
  assert.equal(two.thread_id, second);
  assert.equal(one.state_dir, join(base, first));
  assert.equal(two.state_dir, join(base, second));
  assert.notEqual(one.session_id, two.session_id);
  assert.deepEqual(await info(first), one);
  const submit = (id, title) => call(id, 'delegate_batch', { requestId: 'same-batch', workspace: root,
    tasks: [{ ...task('same-task'), title }] });
  assert.equal((await submit(first, 'ONLY_FIRST_THREAD')).isError, false);
  assert.equal((await call(second, 'read_handoff', { batchId: 'same-batch' })).isError, true);
  assert.equal((await call(second, 'send_message', { batchId: 'same-batch', taskId: 'same-task', message: 'wrong thread' })).isError, true);
  assert.equal((await submit(second, 'ONLY_SECOND_THREAD')).isError, false);
  for (const [id, own, other, details] of [[first, 'ONLY_FIRST_THREAD', 'ONLY_SECOND_THREAD', one], [second, 'ONLY_SECOND_THREAD', 'ONLY_FIRST_THREAD', two]]) {
    assert.equal(readStateThread(details.state_dir), id);
    assert.equal(readStateThread(join(details.state_dir, details.session_id)), id);
    const output = monitor(root, details.state_dir);
    assert.equal(output.status, 0, output.stderr);
    assert.ok(output.stdout.includes(own));
    assert.ok(!output.stdout.includes(other));
    const result = JSON.parse((await call(id, 'read_handoff', { batchId: 'same-batch' })).content[0].text);
    assert.equal(result.sessionId, details.session_id);
  }
  const missing = await client.callTool({ name: 'get_capabilities', arguments: {} });
  assert.equal(JSON.parse(missing.content[0].text).error, 'codex_thread_id_required');
  const invalid = await call('../escape', 'get_capabilities');
  assert.equal(JSON.parse(invalid.content[0].text).error, 'codex_thread_id_invalid');
  assert.deepEqual(readdirSync(base).sort(), [first, second].sort());
  await sessions.close();
  const replacement = new McpSessions({ agentDir: root, configPath }, id => join(base, id));
  try {
    const renewed = replacement.forThread(first);
    assert.equal(renewed.options.stateDir, one.state_dir);
    assert.notEqual(renewed.store.sessionId, one.session_id);
    assert.equal(new SnapshotReader(one.state_dir, undefined, first).read().length, 1);
  } finally { await replacement.close(); }
});

test('固定目录不能被另一线程接管，缺少线程元数据不能沿用上次调用身份', async t => {
  let sessions;
  const root = temporary(t, () => sessions?.close()), first = randomUUID(), second = randomUUID();
  sessions = new McpSessions({ stateDir: join(root, 'state'), agentDir: root });
  const supervisor = sessions.forThread(first);
  assert.throws(() => sessions.forThread(second), /state_thread_conflict/);
  assert.throws(() => sessions.forThread(), /codex_thread_id_required/);
  assert.equal(readStateThread(supervisor.options.stateDir), first);
  assert.equal(readdirSync(supervisor.options.stateDir).filter(name => name !== 'codex-thread.json').length, 1);
});

function snapshot(store, title) {
  const at = new Date().toISOString();
  return { version: 1, sessionId: store.sessionId, batchId: 'batch', pid: process.pid, closed: true,
    workspace: store.directory, heartbeatAt: at,
    tasks: [{ task: { ...task('one'), title }, phase: 'completed', updatedAt: at, summary: '', events: [], omittedEvents: 0 }] };
}

test('monitor 拒绝未绑定目录的聚合；旧状态只能显式指定单个 session', async t => {
  const root = temporary(t), state = join(root, 'legacy');
  const first = new StateStore(state), second = new StateStore(state);
  await first.write(snapshot(first, 'LEGACY_FIRST'));
  await second.write(snapshot(second, 'LEGACY_SECOND'));
  const ambiguous = monitor(root, state);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /state_thread_binding_required/);
  assert.equal(ambiguous.stdout, '');
  const selected = monitor(root, state, ['--session', first.sessionId]);
  assert.equal(selected.status, 0, selected.stderr);
  assert.ok(selected.stdout.includes('LEGACY_FIRST'));
  assert.ok(!selected.stdout.includes('LEGACY_SECOND'));
});

test('线程读取器排除未绑定或错放的 session，根目录绑定变化后清空结果', async t => {
  const root = temporary(t), thread = randomUUID();
  bindStateThread(root, thread);
  const own = new StateStore(root, thread), other = new StateStore(root, randomUUID()), legacy = new StateStore(root);
  await own.write(snapshot(own, 'OWN'));
  await other.write(snapshot(other, 'OTHER'));
  await legacy.write(snapshot(legacy, 'LEGACY'));
  const reader = new SnapshotReader(root, undefined, thread);
  assert.deepEqual(reader.read().map(s => s.sessionId), [own.sessionId]);
  writeFileSync(join(root, 'codex-thread.json'), JSON.stringify({ version: 1, threadId: randomUUID() }));
  assert.deepEqual(reader.read(), []);
});

test('实际 stdio 服务没有启动线程环境时，从工具请求绑定线程并返回 monitor 路径', async t => {
  let client;
  const root = temporary(t, () => client?.close()), state = join(root, 'state'), threadId = randomUUID();
  const config = join(root, 'config.toml');
  writeFileSync(config, serializeConfig(validateConfig({})));
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID; delete env.CPI_STATE_DIR;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['dist/cli.js', '--state-dir', state, '--config', config, '--agent-dir', root], env, stderr: 'pipe' });
  transport.stderr?.resume();
  client = new Client({ name: 'metadata-test', version: '1' });
  await client.connect(transport);
  const missing = await client.callTool({ name: 'get_capabilities', arguments: {} });
  assert.equal(JSON.parse(missing.content[0].text).error, 'codex_thread_id_required');
  const response = await client.callTool({ name: 'get_capabilities', arguments: {}, _meta: { threadId } });
  assert.equal(response.isError, false);
  const details = JSON.parse(response.content[0].text);
  assert.equal(details.thread_id, threadId);
  assert.equal(details.state_dir, state);
  assert.equal(readStateThread(state), threadId);
  assert.equal(readStateThread(join(state, details.session_id)), threadId);
});
