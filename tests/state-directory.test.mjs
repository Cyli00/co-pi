import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { defaultStateDir, resolveStateDirectory } from '../dist/state-directory.js';
import { readStateThread } from '../dist/state-thread.js';
import { temporary } from './helpers.mjs';

test('macOS 宿主与 seatbelt 共用用户临时目录，其他平台保留持久目录', t => {
  const root = temporary(t);
  const options = { home: join(root, 'home'), temp: join(root, 'temp'), uid: 501, env: { CODEX_SANDBOX: 'seatbelt' } };
  assert.equal(defaultStateDir({ ...options, platform: 'darwin' }), join(root, 'temp/co-pi-501/state'));
  for (const platform of ['win32', 'linux']) assert.equal(defaultStateDir({ ...options, platform }), join(root, 'home/.cpi/state'));
  assert.equal(defaultStateDir({ ...options, platform: 'darwin', env: {} }), join(root, 'temp/co-pi-501/state'));
  assert.equal(resolveStateDirectory(join(root, 'explicit'), randomUUID(), { CPI_STATE_DIR: join(root, 'env') }), join(root, 'explicit'));
  assert.equal(resolveStateDirectory(undefined, randomUUID(), { CPI_STATE_DIR: join(root, 'env') }), join(root, 'env'));
  assert.throws(() => resolveStateDirectory('', undefined, {}), /state_directory_empty/);
});

test('macOS seatbelt 不传状态参数即可完成 CLI 启动并按线程绑定', { skip: process.platform !== 'darwin' }, t => {
  const root = temporary(t), thread = randomUUID();
  const env = { ...process.env, TMPDIR: root, CODEX_SANDBOX: 'seatbelt', CODEX_THREAD_ID: thread };
  delete env.CPI_STATE_DIR;
  const result = spawnSync(process.execPath, ['dist/cli.js'], { env, input: '', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const state = join(defaultStateDir({ env, temp: root }), thread);
  assert.equal(readStateThread(state), thread);
});

test('MCP 与 monitor 复用环境指定目录，显式不可写路径不静默回退', t => {
  const root = temporary(t), state = join(root, 'state'), thread = randomUUID();
  const env = { ...process.env, CPI_STATE_DIR: state, CODEX_THREAD_ID: thread };
  const run = (entry, args = []) => spawnSync(process.execPath, [entry, ...args], { env, input: '', encoding: 'utf8', timeout: 10000 });
  assert.equal(run('dist/cli.js').status, 0);
  assert.equal(readStateThread(state), thread);
  const monitor = run('dist/monitor-cli.js', ['--once', '--codex-home', join(root, 'empty')]);
  assert.equal(monitor.status, 0);
  assert.ok(monitor.stdout.includes(thread));
  const file = join(root, 'file'); writeFileSync(file, 'keep');
  const failed = run('dist/cli.js', ['--state-dir', join(file, 'state')]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ENOTDIR/);
});
