import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { temporary } from './helpers.mjs';
import { WINDOWS_SHELL } from '../dist/platform.js';
import { canonicalStateDirectory, acquireMonitorInstance, findMonitorInstance } from '../dist/monitor-instance.js';
import { monitorScript, terminalCandidates, openMonitor, launchTerminal, describeMonitorError } from '../dist/monitor-open.js';

test('平台分支选用独立终端，并保留带空格的脚本路径', () => {
  const script = '/tmp/space dir/monitor.command';
  const windows = terminalCandidates('win32', {}, script);
  assert.equal(windows[0].command, 'wt.exe');
  assert.ok(windows[0].args.includes('new'));
  assert.ok(windows[0].args.includes(WINDOWS_SHELL));
  assert.match(windows[1].command, /mintty\.exe$/);
  assert.deepEqual(terminalCandidates('darwin', {}, script), [{ command: '/usr/bin/open', args: ['-a', '/System/Applications/Utilities/Terminal.app', script] }]);
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

test('文件锁跨调用互斥、发布就绪状态，退出后释放', async t => {
  const root = await canonicalStateDirectory(join(temporary(t), 'not-created', 'state'));
  const first = await acquireMonitorInstance(root, 'monitor');
  t.after(() => first.close());
  assert.ok(first);
  assert.equal((await findMonitorInstance(root)).ready, false);
  assert.equal(await acquireMonitorInstance(root, 'monitor'), undefined);
  await first.markReady();
  assert.equal((await findMonitorInstance(root)).ready, true);
  await first.close();
  assert.equal(await findMonitorInstance(root), undefined);
  const next = await acquireMonitorInstance(root, 'monitor');
  assert.ok(next);
  await next.close();
});

test('同时打开同一状态目录只启动一次，等 monitor 就绪后返回', async t => {
  let launches = 0, monitor;
  const root = temporary(t, () => monitor?.close());
  const stateDir = join(root, 'state');
  const launch = async commands => {
    launches++;
    const script = commands[0].args.at(-1);
    const text = await readFile(script, 'utf8');
    assert.ok(text.includes('--open-token'));
    assert.ok(!text.includes("'--open'"));
    await delay(100);
    monitor = await acquireMonitorInstance(stateDir, 'monitor');
    assert.ok(monitor);
    await monitor.markReady();
  };
  const options = { stateDir, entry: join(root, 'monitor.js'), platform: 'linux', env: { DISPLAY: ':0' }, tempRoot: root, launch, timeoutMs: 5000 };
  const results = await Promise.all([openMonitor(options), openMonitor(options)]);
  assert.equal(launches, 1);
  assert.deepEqual(results.sort(), ['already-open', 'opened']);
  assert.equal(await openMonitor(options), 'already-open');
  assert.equal(launches, 1);
  assert.deepEqual(await readdir(root), ['state']);
  assert.deepEqual((await readdir(stateDir)).sort(), ['.cpi-monitor.json', '.cpi-monitor.json.lock']);
});

test('已有手动 monitor 时复用实例，无桌面不创建脚本', async t => {
  const root = temporary(t);
  const monitor = await acquireMonitorInstance(root, 'monitor');
  t.after(() => monitor.close());
  await monitor.markReady();
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


test('真实子进程持锁互斥，异常退出的过期锁可恢复且不会继承旧 ready', async t => {
  let child;
  const root = temporary(t, async () => {
    if (child?.exitCode === null && child?.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  });
  const entry = new URL('../dist/monitor-instance.js', import.meta.url).href;
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireMonitorInstance } from ${JSON.stringify(entry)};
    const lease = await acquireMonitorInstance(${JSON.stringify(root)}, 'monitor');
    await lease.markReady();
    process.send('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  await once(child, 'message');
  assert.equal((await findMonitorInstance(root)).ready, true);
  assert.equal(await acquireMonitorInstance(root, 'monitor'), undefined);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const old = new Date(Date.now() - 60_000);
  await utimes(join(root, '.cpi-monitor.json.lock'), old, old);
  assert.equal(await findMonitorInstance(root), undefined);
  const next = await acquireMonitorInstance(root, 'monitor');
  try {
    assert.equal((await findMonitorInstance(root)).ready, false);
    await next.markReady();
    assert.equal((await findMonitorInstance(root)).ready, true);
  } finally { await next.close(); }
});

test('启动错误显示失败阶段和系统错误码，不回显底层任意正文', async t => {
  const root = temporary(t);
  await assert.rejects(openMonitor({ stateDir: root, entry: 'unused', platform: 'linux', env: { DISPLAY: ':0' }, tempRoot: root,
    launch: async () => { throw Object.assign(new Error('private diagnostic body'), { code: 'EPERM', syscall: 'spawn' }); },
  }), error => {
    const text = describeMonitorError(error);
    assert.match(text, /阶段：终端启动/);
    assert.match(text, /EPERM/);
    assert.match(text, /--once/);
    assert.ok(!text.includes('private diagnostic body'));
    return true;
  });
  await assert.rejects(openMonitor({ stateDir: root, entry: 'unused', platform: 'linux', env: { DISPLAY: ':0' }, tempRoot: root,
    launch: async () => Object.assign(new EventEmitter(), { exitCode: 7 }),
  }), error => {
    assert.match(describeMonitorError(error), /终端退出：7/);
    return true;
  });
});


test('终端真实子进程失败保留简短 stderr 并脱敏', async t => {
  const root = temporary(t);
  await assert.rejects(openMonitor({ stateDir: root, entry: 'unused', platform: 'linux', env: { DISPLAY: ':0' }, tempRoot: root,
    launch: () => launchTerminal([{ command: process.execPath, args: ['-e', 'console.error("terminal diagnostic api_key=sk-test1234567890123456789"); process.exit(7)'] }]),
  }), error => {
    const text = describeMonitorError(error);
    assert.match(text, /terminal diagnostic/);
    assert.match(text, /终端退出：7/);
    assert.ok(!text.includes('sk-test1234567890123456789'));
    return true;
  });
});
