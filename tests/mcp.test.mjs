import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { Supervisor } from '../dist/supervisor.js';
import { temporary, task, waitFor } from './helpers.mjs';

test('MCP 订阅进展与最终交接分层，未订阅也能交付', async t => {
  let supervisor, server, client;
  const root = temporary(t, async () => { await supervisor?.close(); await client?.close(); await server?.close(); });
  supervisor = new Supervisor({ stateDir: join(root, 'state'), agentDir: root, workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  server = createMcpServer(supervisor);
  client = new Client({ name: 'local-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  assert.equal(client.getServerVersion().name, 'co-pi');
  const instructions = client.getInstructions();
  assert.ok(instructions.includes(JSON.stringify(join(root, 'state'))));
  assert.ok(instructions.includes('cpi-monitor --state-dir'));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['delegate_batch', 'send_message', 'read_handoff']);
  assert.ok(!/\p{Script=Han}/u.test(instructions));
  assert.ok(tools.every(tool => !/\p{Script=Han}/u.test(JSON.stringify(tool))));
  const progress = [];
  const response = await client.callTool({ name: 'delegate_batch', arguments: { requestId: 'first', workspace: root, tasks: [task('one', 'slow')] } }, undefined, { onprogress: p => progress.push(p) });
  assert.equal(response.isError, false);
  const output = JSON.parse(response.content[0].text);
  assert.equal(output.tasks[0].handoff.status, 'completed');
  assert.ok(progress.length > 0);
  assert.ok(progress.every(p => !p.message.includes('此执行详情')));
  assert.ok(progress.every((p, i) => p.progress === i + 1));
  assert.ok(!JSON.stringify(response).includes('此执行详情'));
  const repeat = await client.callTool({ name: 'read_handoff', arguments: { batchId: 'first' } });
  assert.deepEqual(JSON.parse(repeat.content[0].text), output);
  const noSubscription = await client.callTool({ name: 'delegate_batch', arguments: { requestId: 'second', workspace: root, tasks: [task('two', 'error')] } });
  assert.equal(noSubscription.isError, true);
  assert.equal(JSON.parse(noSubscription.content[0].text).tasks[0].error, 'model_request_failed');
  const controller = new AbortController();
  const ready = waitFor(supervisor, 'progress', s => s.batchId === 'cancel' && s.tasks[0].phase === 'running');
  const cancelled = waitFor(supervisor, 'progress', s => s.batchId === 'cancel' && s.tasks[0].phase === 'cancelled');
  const running = client.callTool({ name: 'delegate_batch', arguments: { requestId: 'cancel', workspace: root, tasks: [task('wait', 'wait')] } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(running);
  await ready;
  controller.abort();
  await rejected;
  await cancelled;
});

test('原委派调用在全部 worker 结束后一次返回完整 handoff，无需查询状态', async t => {
  let supervisor, server, client;
  const root = temporary(t, async () => { await supervisor?.close(); await client?.close(); await server?.close(); });
  supervisor = new Supervisor({ stateDir: join(root, 'state'), agentDir: root,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  server = createMcpServer(supervisor);
  client = new Client({ name: 'wait-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const firstFinished = waitFor(supervisor, 'progress', s => s.tasks[0].phase === 'completed');
  let returned = false;
  const original = client.callTool({ name: 'delegate_batch', arguments: {
    requestId: 'wait-all', workspace: root, tasks: [task('fast'), task('slow', 'slow')],
  } }).then(result => { returned = true; return result; });
  await firstFinished;
  assert.equal(returned, false);
  const response = await original;
  const output = JSON.parse(response.content[0].text);
  assert.equal(response.isError, false);
  assert.equal(output.tasks.length, 2);
  for (const result of output.tasks) {
    assert.equal(result.status, 'completed');
    assert.ok(result.handoff.summary);
    assert.ok(Array.isArray(result.handoff.verification));
    assert.ok(Array.isArray(result.handoff.evidence));
    assert.ok(Array.isArray(result.handoff.unresolved));
  }
});

test('心跳和工具流不重复发送同一阶段，仍交付最终通知与完整交接', async t => {
  let supervisor, server, client;
  const root = temporary(t, async () => { await supervisor?.close(); await client?.close(); await server?.close(); });
  supervisor = new Supervisor({ stateDir: join(root, 'state'), agentDir: root,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  server = createMcpServer(supervisor);
  client = new Client({ name: 'dedup-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const progress = [];
  const ready = waitFor(supervisor, 'progress', s => s.tasks[0].phase === 'running');
  const running = client.callTool({ name: 'delegate_batch', arguments: {
    requestId: 'dedup', workspace: root, tasks: [task('one', 'wait')],
  } }, undefined, { onprogress: p => progress.push(JSON.parse(p.message)) });
  await ready;
  await delay(2300);
  await supervisor.message('dedup', 'one', '完成');
  const response = await running;
  assert.equal(response.isError, false);
  assert.equal(progress.filter(p => p.tasks[0].phase === 'running').length, 1);
  assert.equal(progress.at(-1).tasks[0].phase, 'completed');
  assert.equal(JSON.parse(response.content[0].text).tasks[0].handoff.summary, '完成');
});
