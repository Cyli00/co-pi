import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as storage from '../dist/store.js';
import { temporary, task } from './helpers.mjs';
const { StateStore, SnapshotReader } = storage;

function snapshot(store, summary = '初始状态') {
  const now = new Date().toISOString();
  return { version: 1, sessionId: store.sessionId, batchId: 'batch', pid: process.pid,
    closed: false, heartbeatAt: now, workspace: store.directory,
    tasks: [{ task: task('one'), phase: 'running', updatedAt: now, summary, events: [], omittedEvents: 0 }] };
}

test('原子快照替换遇到短暂占用后恢复，等待期间不阻塞事件循环', async t => {
  const root = temporary(t), store = new StateStore(root);
  await store.write(snapshot(store));
  const rename = fsp.rename;
  let attempts = 0, timerRan = false;
  t.mock.method(fsp, 'rename', async (...args) => {
    if (++attempts <= 2) throw Object.assign(new Error('临时占用'), { code: 'EPERM', syscall: 'rename' });
    return rename(...args);
  });
  const timer = setTimeout(() => { timerRan = true; }, 0);
  await store.write(snapshot(store, '重试成功'));
  clearTimeout(timer);
  assert.equal(attempts, 3);
  assert.equal(timerRan, true);
  assert.equal(JSON.parse(fs.readFileSync(join(store.directory, 'batch.json'), 'utf8')).tasks[0].summary, '重试成功');
});

test('Windows 真实读者暂时持有目标文件时，写入等待释放后完成', { skip: process.platform !== 'win32' }, async t => {
  const store = new StateStore(temporary(t));
  await store.write(snapshot(store));
  const reader = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const fd = fs.openSync(workerData, 'r');
    parentPort.postMessage('opened');
    setTimeout(() => { fs.closeSync(fd); }, 120);
  `, { eval: true, workerData: join(store.directory, 'batch.json') });
  try {
    await new Promise((resolve, reject) => { reader.once('message', resolve); reader.once('error', reject); });
    await store.write(snapshot(store, '真实读者释放后写入'));
    assert.equal(JSON.parse(fs.readFileSync(join(store.directory, 'batch.json'), 'utf8')).tasks[0].summary, '真实读者释放后写入');
  } finally { await reader.terminate(); }
});

test('非瞬时磁盘错误不重试，永久占用在有限重试后失败', async t => {
  for (const code of ['ENOSPC', 'EPERM']) await t.test(code, async t => {
    const store = new StateStore(temporary(t));
    let attempts = 0;
    t.mock.method(fsp, 'rename', async () => { attempts++; throw Object.assign(new Error('模拟错误'), { code }); });
    await assert.rejects(store.write(snapshot(store)), { code });
    assert.equal(attempts, code === 'ENOSPC' ? 1 : 7);
  });
});

test('并发快照写入按调用顺序落盘，不共享正在写入的临时文件', async t => {
  const store = new StateStore(temporary(t));
  const writeFile = fsp.writeFile;
  let active = 0, maximum = 0;
  t.mock.method(fsp, 'writeFile', async (...args) => {
    maximum = Math.max(maximum, ++active);
    try { await new Promise(resolve => setTimeout(resolve, 5)); return await writeFile(...args); }
    finally { active--; }
  });
  const state = snapshot(store, '第一版');
  const first = store.write(state);
  state.tasks[0].summary = '第二版';
  const second = store.write(state);
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(JSON.parse(fs.readFileSync(join(store.directory, 'batch.json'), 'utf8')).tasks[0].summary, '第二版');
});

test('监控缓存复用不变快照，并发现替换、损坏与移走的文件', async t => {
  const root = temporary(t), store = new StateStore(root);
  await store.write(snapshot(store));
  const reader = new SnapshotReader(root);
  const readFile = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => { reads++; return readFile(...args); });
  const first = reader.read();
  assert.equal(first.length, 1);
  assert.equal(reader.read()[0], first[0]);
  assert.equal(reads, 1);
  await store.write(snapshot(store, '更新状态'));
  assert.equal(reader.read()[0].tasks[0].summary, '更新状态');
  assert.equal(reads, 2);
  const path = join(store.directory, 'batch.json');
  fs.writeFileSync(path, '{');
  assert.deepEqual(reader.read(), []);
  assert.deepEqual(reader.read(), []);
  assert.equal(reads, 3);
  await store.write(snapshot(store, '恢复状态'));
  assert.equal(reader.read().length, 1);
  fs.renameSync(path, join(root, 'moved.json'));
  assert.deepEqual(reader.read(), []);
});
