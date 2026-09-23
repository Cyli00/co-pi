import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionApprovalGate, approvedShellOperations } from '../dist/permission-approval.js';

const action = { command: 'printf test', cwd: '/workspace', shell: '/bin/bash', shellArgs: ['-c'] };

test('审批前不执行，审批只对应当前请求且执行参数保持不变', async () => {
  const requests = [], executions = [];
  const gate = new PermissionApprovalGate(async (id, action) => { requests.push({ id, action }); });
  const local = { exec: async (...args) => { executions.push(args); return { exitCode: 0 }; } };
  const ops = approvedShellOperations(local, gate, action.shell, action.shellArgs);
  const options = { onData() {}, timeout: 7, env: { TEST_ONLY: 'value' } };
  const first = ops.exec(action.command, action.cwd, options);
  assert.equal(executions.length, 0);
  gate.receive('unrelated', { approved: true });
  assert.equal(executions.length, 0);
  gate.receive(requests[0].id, { approved: true });
  assert.deepEqual(await first, { exitCode: 0 });
  assert.deepEqual(executions[0], [action.command, action.cwd, options]);
  assert.deepEqual(requests[0].action, { ...action, timeout: 7 });
  const second = ops.exec(action.command, action.cwd, options);
  gate.receive(requests[0].id, { approved: true });
  assert.equal(executions.length, 1);
  assert.notEqual(requests[0].id, requests[1].id);
  gate.receive(requests[1].id, { approved: false, reason: 'denied' });
  await assert.rejects(second, /not executed.*denied/);
  assert.equal(executions.length, 1);
});

test('拒绝、无效响应、超时、传输失败和取消均不执行', async t => {
  for (const mode of ['deny', 'invalid', 'timeout', 'transport', 'abort', 'close']) await t.test(mode, async () => {
    let requestId, count = 0;
    const gate = new PermissionApprovalGate(async id => {
      requestId = id;
      if (mode === 'transport') throw new Error('transport');
    }, 20);
    const ops = approvedShellOperations({ exec: async () => { count++; return { exitCode: 0 }; } }, gate, action.shell, action.shellArgs);
    const controller = new AbortController();
    const pending = ops.exec(action.command, action.cwd, { onData() {}, signal: controller.signal });
    const rejected = assert.rejects(pending, mode === 'abort' || mode === 'close' ? /cancelled/ : /continue, try another safer way\./);
    if (mode === 'deny') gate.receive(requestId, { approved: false });
    if (mode === 'invalid') gate.receive(requestId, { approved: 'true' });
    if (mode === 'abort') controller.abort();
    if (mode === 'close') gate.close();
    await rejected;
    gate.receive(requestId, { approved: true });
    assert.equal(count, 0);
  });
});

test('收到批准后、真正执行前取消仍阻止命令', async () => {
  let id, count = 0;
  const gate = new PermissionApprovalGate(async value => { id = value; });
  const controller = new AbortController();
  const ops = approvedShellOperations({ exec: async () => { count++; return { exitCode: 0 }; } }, gate, action.shell, action.shellArgs);
  const running = ops.exec(action.command, action.cwd, { onData() {}, signal: controller.signal });
  gate.receive(id, { approved: true });
  controller.abort();
  await assert.rejects(running, /cancelled/);
  assert.equal(count, 0);
});
