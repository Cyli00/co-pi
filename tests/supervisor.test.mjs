import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../dist/supervisor.js';
import { readSnapshots } from '../dist/store.js';
import { temporary, task, waitFor } from './helpers.mjs';

function setup(t, options = {}) {
  let supervisor;
  const root = temporary(t, () => supervisor?.close());
  supervisor = new Supervisor({ stateDir: join(root, 'state'), agentDir: join(root, 'agent'), workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)), ...options });
  return { root, supervisor, batch: (tasks, requestId = 'batch') => ({ requestId, workspace: root, context: '', tasks }) };
}

test('并发上限、幂等请求、终态保护与监控详情分离', async t => {
  const { root, supervisor, batch } = setup(t, { parallelism: 2 });
  let maxActive = 0;
  let starts = 0;
  const seen = new Set();
  supervisor.on('progress', snapshot => {
    maxActive = Math.max(maxActive, snapshot.tasks.filter(s => ['starting', 'running', 'summarizing'].includes(s.phase)).length);
    for (const state of snapshot.tasks) if (state.model && !seen.has(state.task.id)) { starts++; seen.add(state.task.id); }
  });
  const request = batch([task('one', 'late'), task('two'), task('three'), task('four')]);
  const [first, repeated] = await Promise.all([supervisor.delegate(request), supervisor.delegate(request)]);
  assert.deepEqual(first, repeated);
  assert.equal(starts, 4);
  assert.equal(maxActive, 2);
  assert.ok(first.tasks.every(task => task.status === 'completed'));
  assert.ok(!JSON.stringify(first).includes('此执行详情'));
  assert.deepEqual(await supervisor.delegate(request), first);
  await assert.rejects(supervisor.delegate({ ...request, context: '不同上下文' }), /request_id_conflict/);
  const [snapshot] = readSnapshots(join(root, 'state'));
  assert.equal(snapshot.closed, true);
  assert.ok(snapshot.tasks[0].events.some(e => e.text.includes('此执行详情')));
  assert.ok(!snapshot.tasks[0].events.some(e => e.text.includes('迟到事件')));
  assert.equal(snapshot.tasks[0].task.instruction, '');
});

test('单个 worker 崩溃、部分完成和非法交接不会丢失其他任务', async t => {
  const { supervisor, batch } = setup(t);
  const result = await supervisor.delegate(batch([task('crash', 'crash'), task('partial', 'partial'), task('bad', 'invalid'), task('ok')]));
  assert.deepEqual(result.tasks.map(t => t.status), ['failed', 'partial', 'failed', 'completed']);
  assert.equal(result.tasks[0].origin, 'runtime');
  assert.equal(result.tasks[0].error, 'worker_exit_error');
  assert.equal(result.tasks[2].error, 'worker_protocol_invalid');
});

test('取消活跃与排队任务，并拒绝执行中读取交接和开启第二批', async t => {
  const { supervisor, batch } = setup(t, { parallelism: 1 });
  const controller = new AbortController();
  const ready = waitFor(supervisor, 'progress', s => s.tasks[0].phase === 'running');
  const running = supervisor.delegate(batch([task('one', 'wait'), task('two')]), controller.signal);
  await ready;
  assert.throws(() => supervisor.readHandoff('batch'), /handoff_not_ready/);
  await assert.rejects(supervisor.delegate(batch([task('other')], 'other')), /batch_already_active/);
  controller.abort();
  const result = await running;
  assert.deepEqual(result.tasks.map(t => t.status), ['cancelled', 'cancelled']);
});

test('消息发送到活跃 worker，完成后拒绝消息', async t => {
  const { supervisor, batch } = setup(t);
  const ready = waitFor(supervisor, 'progress', s => s.tasks[0].phase === 'running');
  const running = supervisor.delegate(batch([task('one', 'wait')]));
  await ready;
  await supervisor.message('batch', 'one', '补充验收要求');
  assert.equal((await running).tasks[0].handoff.summary, '补充验收要求');
  await assert.rejects(supervisor.message('batch', 'one', '迟到消息'), /task_already_finished/);
});

test('超时强制回收不响应取消的 worker', async t => {
  const { supervisor, batch } = setup(t, { taskTimeoutMs: 300, shutdownMs: 100 });
  const result = await supervisor.delegate(batch([task('one', 'ignore-cancel')]));
  assert.equal(result.tasks[0].status, 'failed');
  assert.equal(result.tasks[0].error, 'task_timeout');
});

test('重复任务 ID 与相对路径在启动前拒绝', async t => {
  const { supervisor, batch } = setup(t);
  await assert.rejects(supervisor.delegate(batch([task('one'), task('one')])));
  await assert.rejects(supervisor.delegate({ ...batch([task('one')]), workspace: '.' }), /workspace_must_be_absolute/);
});

test('状态写入失败取消任务并阻止新一批，不能静默报成功', async t => {
  const { supervisor, batch } = setup(t);
  supervisor.store.write = () => { throw new Error('模拟磁盘错误'); };
  const result = await supervisor.delegate(batch([task('one', 'wait')]));
  assert.equal(result.storageError, 'state_write_failed');
  assert.equal(result.tasks[0].status, 'cancelled');
  await assert.rejects(supervisor.delegate(batch([task('new')], 'new')), /state_write_failed/);
});

test('丢失回执报告未知，不把 IPC 发送成功当成 SDK 已接收', async t => {
  const { supervisor, batch } = setup(t);
  const ready = waitFor(supervisor, 'progress', s => s.tasks[0].phase === 'running');
  const running = supervisor.delegate(batch([task('one', 'lost-ack')]));
  await ready;
  const receipt = await supervisor.message('batch', 'one', '补充要求', 'followUp', 'lost-id');
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.error, 'worker_finished_before_delivery');
  assert.equal((await running).tasks[0].status, 'failed');
});

test('有 handoff 但没有 settled 的 worker 不算完成', async t => {
  const { supervisor, batch } = setup(t);
  const result = await supervisor.delegate(batch([task('one', 'unsettled')]));
  assert.equal(result.tasks[0].error, 'worker_not_settled');
});
