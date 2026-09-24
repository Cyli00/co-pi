import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { bindStateThread, readStateThread, resolveStateThread } from '../dist/state-thread.js';
import { Supervisor } from '../dist/supervisor.js';
import { temporary } from './helpers.mjs';

test('状态目录一次绑定固定线程，同线程重启复用，其他线程不能覆盖', async t => {
  const root = temporary(t), threadId = randomUUID();
  const options = { stateDir: join(root, 'state'), agentDir: root, threadId };
  const first = new Supervisor(options);
  assert.equal(readStateThread(options.stateDir), threadId);
  await first.close();
  const second = new Supervisor({ ...options, threadId: undefined });
  assert.equal(second.options.threadId, threadId);
  await second.close();
  const original = readFileSync(join(options.stateDir, 'codex-thread.json'), 'utf8');
  assert.throws(() => new Supervisor({ ...options, threadId: randomUUID() }), /state_thread_conflict/);
  assert.equal(readFileSync(join(options.stateDir, 'codex-thread.json'), 'utf8'), original);
});

test('缺少绑定不猜测，损坏绑定或非法 ID 明确失败', t => {
  const root = temporary(t), id = randomUUID();
  assert.equal(readStateThread(root), undefined);
  assert.equal(bindStateThread(root), undefined);
  assert.equal(resolveStateThread(root, id), id);
  assert.throws(() => bindStateThread(root, '../invalid'), /codex_thread_id_invalid/);
  bindStateThread(root, id.toUpperCase());
  assert.equal(readStateThread(root), id);
  writeFileSync(join(root, 'codex-thread.json'), '{broken}');
  assert.throws(() => readStateThread(root), /state_thread_binding_invalid/);
  assert.throws(() => bindStateThread(root, id), /state_thread_binding_invalid/);
});

test('MCP CLI 显式线程优先于环境并持久绑定，冲突启动失败', t => {
  const root = temporary(t), threadId = randomUUID(), other = randomUUID();
  const state = join(root, 'state');
  const run = id => spawnSync(process.execPath, ['dist/cli.js', '--state-dir', state, '--thread-id', id], {
    encoding: 'utf8', input: '', timeout: 10_000, env: { ...process.env, CODEX_THREAD_ID: other },
  });
  assert.equal(run(threadId).status, 0);
  assert.equal(readStateThread(state), threadId);
  const conflict = run(other);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /state_thread_conflict/);
  assert.equal(readStateThread(state), threadId);
});
