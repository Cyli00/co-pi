import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { Supervisor } from '../dist/supervisor.js';
import { temporary, task, waitFor } from './helpers.mjs';
import { serializeConfig, validateConfig } from '../dist/config.js';
import { MAX_BATCH_TASKS } from '../dist/limits.js';

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
  assert.ok(instructions.includes('cpi-monitor --open --state-dir'));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['get_capabilities', 'delegate_batch', 'send_message', 'read_handoff']);
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

test('MCP 能力查询读取最新配置和 CLI 覆盖，返回并发与单批上限且不启动任务', async t => {
  for (const override of [undefined, 1]) await t.test(`CLI override: ${override ?? 'none'}`, async t => {
    let supervisor, server, client;
    const root = temporary(t, async () => { await supervisor?.close(); await client?.close(); await server?.close(); });
    const path = join(root, 'config.toml');
    const save = n => writeFile(path, serializeConfig(validateConfig({ runtime: { parallelism: n } })));
    await save(2);
    supervisor = new Supervisor({ agentDir: root, stateDir: join(root, 'state'), configPath: path, parallelism: override,
      workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
    server = createMcpServer(supervisor);
    client = new Client({ name: 'capabilities-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    let progressCount = 0, maxRunning = 0;
    supervisor.on('progress', s => {
      progressCount++;
      maxRunning = Math.max(maxRunning, s.tasks.filter(t => ['starting', 'running'].includes(t.phase)).length);
    });
    const query = async () => {
      const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
      assert.equal(result.isError, false);
      return JSON.parse(result.content[0].text);
    };
    const expected = n => ({ parallelism: override ?? n, parallelism_source: override === undefined ? 'config' : 'cli', max_batch_size: MAX_BATCH_TASKS });
    const before = await readFile(path, 'utf8');
    const files = await readdir(root);
    assert.deepEqual(await query(), expected(2));
    assert.equal(progressCount, 0);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await readdir(root), files);
    await save(3);
    assert.deepEqual(await query(), expected(3));
    const { tools } = await client.listTools();
    const capabilityTool = tools.find(t => t.name === 'get_capabilities');
    assert.equal(capabilityTool.annotations.readOnlyHint, true);
    assert.equal(capabilityTool.annotations.openWorldHint, false);
    const delegateTool = tools.find(t => t.name === 'delegate_batch');
    assert.equal(delegateTool.inputSchema.properties.tasks.maxItems, MAX_BATCH_TASKS);
    assert.match(delegateTool.description, /get_capabilities/);
    assert.match(client.getInstructions(), /get_capabilities/);
    const output = await client.callTool({ name: 'delegate_batch', arguments: {
      requestId: 'capacity', workspace: root, tasks: Array.from({ length: MAX_BATCH_TASKS }, (_, i) => task(`task-${i}`)),
    } });
    assert.equal(output.isError, false);
    assert.equal(maxRunning, override ?? 3);
    assert.equal(JSON.parse(output.content[0].text).tasks.length, MAX_BATCH_TASKS);
  });
});

test('MCP 能力查询与派发对缺失、损坏配置报同一错误，失败不回退或泄露原文', async t => {
  let supervisor, server, client;
  const root = temporary(t, async () => { await supervisor?.close(); await client?.close(); await server?.close(); });
  const path = join(root, 'config.toml');
  supervisor = new Supervisor({ agentDir: root, stateDir: join(root, 'state'), configPath: path });
  server = createMcpServer(supervisor);
  client = new Client({ name: 'invalid-capabilities', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  for (const [id, code, text] of [
    ['missing', 'cpi_config_missing', undefined],
    ['invalid', 'cpi_config_invalid', 'password = "DO_NOT_DISCLOSE"'],
  ]) {
    if (text) await writeFile(path, text);
    const response = await client.callTool({ name: 'get_capabilities', arguments: {} });
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).error, code);
    assert.ok(!JSON.stringify(response).includes('DO_NOT_DISCLOSE'));
    const batch = await client.callTool({ name: 'delegate_batch', arguments: { requestId: id, workspace: root, tasks: [task('one')] } });
    assert.equal(JSON.parse(batch.content[0].text).tasks[0].error, code);
  }
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
