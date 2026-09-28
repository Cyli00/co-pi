import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Supervisor } from '../dist/supervisor.js';
import { createMcpServer } from '../dist/mcp.js';
import { MonitorRouter } from '../dist/monitor.js';
import { requestTaskTermination } from '../dist/monitor-control.js';
import { readSnapshots } from '../dist/store.js';
import { temporary, task } from './helpers.mjs';

async function persisted(root, predicate) {
  const deadline = Date.now() + 5000;
  do {
    const snapshots = readSnapshots(root);
    if (snapshots.some(predicate)) return snapshots.find(predicate);
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('状态未按时落盘');
}

test('monitor 用户终止经过文件通道传到 MCP 最终交接，仅停止所选任务', async t => {
  let supervisor, server, client;
  const root = temporary(t, async () => { await supervisor?.close(); await client?.close(); await server?.close(); });
  const stateDir = join(root, 'state'), threadId = randomUUID();
  supervisor = new Supervisor({ stateDir, threadId, agentDir: root, parallelism: 2,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  server = createMcpServer(supervisor);
  client = new Client({ name: 'monitor-control', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const originalCall = client.callTool({ name: 'delegate_batch', arguments: {
    requestId: 'batch', workspace: root, tasks: [task('stop-me', 'wait'), task('keep-running', 'slow')],
  } });
  await persisted(stateDir, s => s.tasks[0].phase === 'running');
  const target = { threadId, sessionId: supervisor.store.sessionId, batchId: 'batch', taskId: 'stop-me' };
  await requestTaskTermination(stateDir, target);
  await requestTaskTermination(stateDir, target);
  const response = await originalCall;
  const output = JSON.parse(response.content[0].text);
  assert.equal(response.isError, true);
  assert.equal(output.tasks[0].status, 'cancelled');
  assert.equal(output.tasks[0].error, 'terminated_by_user');
  assert.equal(output.tasks[0].guidance, 'terminated by user');
  assert.equal(output.tasks[0].origin, 'runtime');
  assert.equal(output.tasks[1].status, 'completed');
  assert.equal(readSnapshots(stateDir)[0].tasks[0].summary, 'terminated by user');
  await assert.rejects(requestTaskTermination(stateDir, target), /task_already_finished/);
});

test('排队任务终止后不启动 worker，不响应取消的运行任务仍按时结束', async t => {
  let supervisor;
  const root = temporary(t, () => supervisor?.close()), threadId = randomUUID(), stateDir = join(root, 'state');
  supervisor = new Supervisor({ stateDir, threadId, agentDir: root, parallelism: 1, shutdownMs: 100,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  const originalCall = supervisor.delegate({ requestId: 'batch', workspace: root,
    tasks: [task('running', 'ignore-cancel'), task('queued'), task('continue')] });
  await persisted(stateDir, s => s.tasks[0].phase === 'running' && s.tasks[1].phase === 'queued');
  const target = taskId => ({ threadId, sessionId: supervisor.store.sessionId, batchId: 'batch', taskId });
  await requestTaskTermination(stateDir, target('queued'));
  await persisted(stateDir, s => s.tasks[1].phase === 'cancelled');
  await requestTaskTermination(stateDir, target('running'));
  const result = await originalCall;
  assert.deepEqual(result.tasks.map(t => t.status), ['cancelled', 'cancelled', 'completed']);
  assert.equal(result.tasks[0].guidance, 'terminated by user');
  const snapshot = readSnapshots(stateDir)[0];
  assert.equal(snapshot.tasks[1].model, undefined);
  assert.equal(snapshot.tasks[1].summary, 'terminated by user');
});

test('终止请求拒绝跨线程、错误实例及路径穿越', async t => {
  let supervisor;
  const root = temporary(t, () => supervisor?.close()), threadId = randomUUID(), stateDir = join(root, 'state');
  supervisor = new Supervisor({ stateDir, threadId, agentDir: root,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  const originalCall = supervisor.delegate({ requestId: 'batch', workspace: root, tasks: [task('one', 'wait')] });
  await persisted(stateDir, s => s.tasks[0].phase === 'running');
  const target = { threadId, sessionId: supervisor.store.sessionId, batchId: 'batch', taskId: 'one' };
  await assert.rejects(requestTaskTermination(stateDir, { ...target, threadId: randomUUID() }), /state_thread_conflict/);
  await assert.rejects(requestTaskTermination(stateDir, { ...target, sessionId: randomUUID() }), /state_thread_conflict/);
  await assert.rejects(requestTaskTermination(stateDir, { ...target, taskId: '../one' }), /termination_target_invalid/);
  assert.equal(readSnapshots(stateDir)[0].tasks[0].phase, 'running');
  await requestTaskTermination(stateDir, target);
  assert.equal((await originalCall).tasks[0].error, 'terminated_by_user');
});

function uiSnapshot() {
  const at = new Date().toISOString();
  return { version: 1, sessionId: randomUUID(), batchId: 'batch', pid: 1, closed: false, heartbeatAt: at, workspace: 'test',
    tasks: ['first', 'second'].map(id => ({ task: task(id), phase: 'running', summary: '', updatedAt: at, events: [], omittedEvents: 0 })) };
}

test('终止确认固定任务身份、支持取消，发送后等待服务确认，退出不终止', async () => {
  const calls = [];
  let quit = false;
  const router = new MonitorRouter(() => 12, () => {}, () => { quit = true; },
    { color: true, terminateTask: async target => { calls.push(target); } });
  const snapshot = uiSnapshot();
  router.update([snapshot]);
  router.handleInput('x');
  assert.match(router.render(60).join('\n'), /终止所选任务/);
  assert.ok(router.render(22).every(line => visibleWidth(line) <= 22));
  router.handleInput('n');
  assert.equal(calls.length, 0);
  router.handleInput('x'); router.handleInput('\x1b[B'); router.handleInput('y');
  await delay(0);
  assert.deepEqual(calls, [{ sessionId: snapshot.sessionId, batchId: 'batch', taskId: 'first' }]);
  assert.match(router.render(100).join('\n'), /等待任务停止/);
  router.handleInput('x'); router.handleInput('y');
  assert.equal(calls.length, 1);
  snapshot.tasks[0].phase = 'cancelled'; snapshot.tasks[0].error = 'terminated_by_user';
  router.update([snapshot]);
  assert.match(router.render(100).join('\n'), /terminated by user/);
  router.handleInput('q');
  assert.equal(quit, true);
  assert.equal(calls.length, 1);
});

test('确认期间任务结束时不发送；写入失败和确认超时明确提示且不自动重试', async () => {
  let calls = 0;
  const snapshot = uiSnapshot();
  const router = new MonitorRouter(() => 14, () => {}, () => {}, { color: false,
    terminateTask: async () => { calls++; throw new Error('denied'); } });
  router.update([snapshot]); router.handleInput('x');
  snapshot.tasks[0].phase = 'completed'; router.update([snapshot]); router.handleInput('y');
  assert.equal(calls, 0);
  router.handleInput('\x1b[B'); router.handleInput('x'); router.handleInput('y');
  await delay(0);
  assert.equal(calls, 1);
  assert.match(router.render(100).join('\n'), /终止请求未确认/);
  const pending = new MonitorRouter(() => 14, () => {}, () => {}, { color: false, terminateTask: async () => {} });
  const live = uiSnapshot();
  pending.update([live]); pending.handleInput('x'); pending.handleInput('y'); await delay(0);
  live.heartbeatAt = new Date(Date.now() - 30000).toISOString(); pending.update([live]);
  assert.match(pending.render(100).join('\n'), /尚未确认终止/);
});
