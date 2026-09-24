import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { temporary } from './helpers.mjs';
import { WINDOWS_SHELL } from '../dist/platform.js';
import { canonicalStateDirectory, acquireMonitorInstance, findMonitorInstance } from '../dist/monitor-instance.js';
import { monitorScript, terminalCandidates, openMonitor, launchTerminal } from '../dist/monitor-open.js';

test('平台分支选用独立终端，并保留带空格的脚本路径', () => {
  const script = '/tmp/space dir/monitor.command';
  const windows = terminalCandidates('win32', {}, script);
  assert.equal(windows[0].command, 'wt.exe');
  assert.ok(windows[0].args.includes('new'));
  assert.ok(windows[0].args.includes(WINDOWS_SHELL));
  assert.match(windows[1].command, /mintty\.exe$/);
  assert.deepEqual(terminalCandidates('darwin', {}, script), [{ command: '/usr/bin/open', args: ['-a', 'Terminal', script] }]);
  const linux = terminalCandidates('linux', { DISPLAY: ':0' }, script);
  assert.deepEqual(linux.map(x => x.command), ['gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm']);
  assert.equal(terminalCandidates('linux', { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' }, script)[0].command, 'konsole');
  for (const candidate of [...windows, ...linux]) assert.equal(candidate.args.at(-1), script);
  assert.throws(() => terminalCandidates('linux', {}, script), /desktop_unavailable/);
  assert.throws(() => terminalCandidates('darwin', { SSH_CONNECTION: 'local-test' }, script), /desktop_unavailable/);
  assert.throws(() => terminalCandidates('freebsd', {}, script), /platform_unsupported/);
});

test('启动脚本将引号、换行和 shell 元字符原样传递，不执行路径中的命令', async t => {
  const root = temporary(t);
  const entry = join(root, "fixture ' 中文.mjs");
  const output = join(root, 'arguments.json');
  await writeFile(entry, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n");
  const args = ['空 格', "single'quote", 'double"quote', '$(exit 71)', '`exit 72`', '; exit 73', 'line\nbreak', '%PATH%', '!literal!', 'back\\slash'];
  for (const platform of ['win32', 'darwin', 'linux']) {
    const script = join(root, `${platform}.command`);
    await writeFile(script, monitorScript(process.execPath, entry, [output, ...args], platform));
    const run = spawnSync(process.platform === 'win32' ? WINDOWS_SHELL : '/bin/sh', ['--', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), args);
  }
});

test('实例互斥、就绪状态和退出后释放使用真实本机连接', async t => {
  const root = await canonicalStateDirectory(join(temporary(t), 'not-created', 'state'));
  const first = await acquireMonitorInstance(root, 'monitor');
  t.after(() => first.close());
  assert.ok(first);
  assert.equal((await findMonitorInstance(root)).ready, false);
  assert.equal(await acquireMonitorInstance(root, 'monitor'), undefined);
  first.status.ready = true;
  assert.equal((await findMonitorInstance(root)).ready, true);
  await first.close();
  assert.equal(await findMonitorInstance(root), undefined);
  const next = await acquireMonitorInstance(root, 'monitor');
  assert.ok(next);
  await next.close();
});

test('同时打开同一状态目录只启动一次，等 monitor 就绪后返回', async t => {
  const root = temporary(t);
  const stateDir = join(root, 'state');
  let launches = 0, monitor;
  t.after(() => monitor?.close());
  const launch = async commands => {
    launches++;
    const script = commands[0].args.at(-1);
    const text = await readFile(script, 'utf8');
    assert.ok(text.includes('--open-token'));
    assert.ok(!text.includes("'--open'"));
    await delay(100);
    monitor = await acquireMonitorInstance(stateDir, 'monitor');
    assert.ok(monitor);
    monitor.status.ready = true;
  };
  const options = { stateDir, entry: join(root, 'monitor.js'), platform: 'linux', env: { DISPLAY: ':0' }, tempRoot: root, launch, timeoutMs: 5000 };
  const results = await Promise.all([openMonitor(options), openMonitor(options)]);
  assert.equal(launches, 1);
  assert.deepEqual(results.sort(), ['already-open', 'opened']);
  assert.equal(await openMonitor(options), 'already-open');
  assert.equal(launches, 1);
  assert.deepEqual(await readdir(root), []);
});

test('已有手动 monitor 时复用实例，无桌面不创建脚本', async t => {
  const root = temporary(t);
  const monitor = await acquireMonitorInstance(root, 'monitor');
  t.after(() => monitor.close());
  monitor.status.ready = true;
  const options = { stateDir: root, entry: 'unused', platform: 'linux', env: {}, tempRoot: root,
    launch: async () => assert.fail('不应打开终端') };
  assert.equal(await openMonitor(options), 'already-open');
  await monitor.close();
  await assert.rejects(openMonitor(options), /desktop_unavailable/);
  assert.deepEqual(await readdir(root), []);
  assert.equal(await findMonitorInstance(root, 'launcher'), undefined);
});

test('终端退出成功不代表 monitor 就绪，超时清理后允许重新打开', async t => {
  const root = temporary(t);
  const options = { stateDir: root, entry: 'unused', platform: 'linux', env: { DISPLAY: ':0' }, tempRoot: root, timeoutMs: 250,
    launch: async () => { const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child; } };
  await assert.rejects(openMonitor(options), /open_timeout/);
  assert.equal(await findMonitorInstance(root, 'launcher'), undefined);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(openMonitor({ ...options, launch: async () => { throw new Error('monitor_terminal_unavailable'); } }), /terminal_unavailable/);
  assert.equal(await findMonitorInstance(root, 'launcher'), undefined);
});

test('终端非零退出返回失败，并清理启动占用', async t => {
  const root = temporary(t);
  await assert.rejects(openMonitor({ stateDir: root, entry: 'unused', platform: 'linux', env: { DISPLAY: ':0' }, tempRoot: root, timeoutMs: 3000,
    launch: async () => { const child = new EventEmitter(); setImmediate(() => child.emit('exit', 2)); return child; } }), /terminal_failed/);
  assert.equal(await findMonitorInstance(root, 'launcher'), undefined);
});

test('终端检测跳过缺失程序，并以参数数组启动可用程序', async t => {
  const root = temporary(t);
  const output = join(root, 'spawned.json');
  const child = await launchTerminal([
    { command: join(root, 'missing-terminal'), args: [] },
    { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', output, 'a b', '$(not-a-command)'] },
  ]);
  child.ref();
  await new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), ['a b', '$(not-a-command)']);
  await assert.rejects(launchTerminal([{ command: join(root, 'still-missing'), args: [] }]), /terminal_unavailable/);
});

test('CLI 拒绝冲突参数，非 TTY 的子启动不误报就绪', t => {
  const root = temporary(t);
  const run = extra => spawnSync(process.execPath, ['dist/monitor-cli.js', '--state-dir', root, '--codex-home', join(root, 'empty-codex'), ...extra], {
    encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: '' }, windowsHide: true,
  });
  const conflict = run(['--open', '--once']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /不能与 --once/);
  const nonTty = run(['--open-token', 'expired']);
  assert.equal(nonTty.status, 1);
  assert.match(nonTty.stderr, /TTY/);
});
