import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { WINDOWS_SHELL } from '../dist/platform.js';
import { monitorCommandPlan, checkMonitorCommand, installMonitorCommand } from '../scripts/monitor-command.mjs';
import { preflight, install } from '../scripts/install.mjs';

test('三平台快捷入口注册、重复安装与包含空格/单引号路径的参数传递', async t => {
  for (const platform of ['win32', 'darwin', 'linux']) await t.test(platform, async t => {
    const root = temporary(t);
    const project = join(root, "project's folder");
    const prefix = join(root, 'npm prefix');
    await mkdir(join(project, 'dist'), { recursive: true });
    await writeFile(join(project, 'dist', 'monitor-cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
    const directory = platform === 'win32' ? prefix : join(prefix, 'bin');
    const plan = monitorCommandPlan({ platform, prefix, root: project, pathValue: [root, directory].join(delimiter) });
    assert.equal(plan.inPath, true);
    await checkMonitorCommand(plan);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
    await installMonitorCommand(plan);
    const before = await stat(join(directory, 'cpi-monitor'));
    await installMonitorCommand(plan);
    assert.equal((await stat(join(directory, 'cpi-monitor'))).mtimeMs, before.mtimeMs);
    const launcher = join(directory, 'cpi-monitor').replaceAll('\\', '/');
    const result = spawnSync(process.platform === 'win32' ? WINDOWS_SHELL : '/bin/bash', ['--noprofile', '--norc', launcher, '--state-dir', 'state with spaces', "literal's path", '$(not-a-command)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['--state-dir', 'state with spaces', "literal's path", '$(not-a-command)']);
    if (platform === 'win32') {
      const batch = await readFile(join(directory, 'cpi-monitor.cmd'), 'utf8');
      assert.ok(batch.includes('DisableDelayedExpansion') && batch.includes('%*'));
    }
  });
});

test('预检保护其他同名命令，Windows PowerShell 优先文件冲突也不覆盖', async t => {
  for (const name of ['cpi-monitor', 'cpi-monitor.cmd', 'cpi-monitor.ps1', 'cpi-monitor.exe']) {
    const root = temporary(t);
    await writeFile(join(root, name), 'other application');
    const plan = monitorCommandPlan({ platform: 'win32', prefix: root, root, pathValue: root });
    await assert.rejects(installMonitorCommand(plan), /monitor_command_conflict/);
    assert.equal(await readFile(join(root, name), 'utf8'), 'other application');
    if (name !== 'cpi-monitor') await assert.rejects(stat(join(root, 'cpi-monitor')), { code: 'ENOENT' });
  }
});

test('安装完成才注册命令；构建失败不触发注册，PATH 缺失可检测', async t => {
  const root = temporary(t);
  const calls = [];
  const plan = { platform: 'linux', monitor: monitorCommandPlan({ platform: 'linux', prefix: root, root, pathValue: '' }) };
  assert.equal(plan.monitor.inPath, false);
  const hooks = {
    build: async () => calls.push('build'), configure: async () => { calls.push('configure'); return {}; },
    register: async monitor => { calls.push('register'); return installMonitorCommand(monitor); },
  };
  const result = await install(plan, hooks);
  assert.deepEqual(calls, ['build', 'configure', 'register']);
  assert.equal(result.monitor.directory, join(root, 'bin'));
  calls.length = 0;
  await assert.rejects(install(plan, { ...hooks, build: async () => { throw new Error('build_failed'); } }), /build_failed/);
  assert.deepEqual(calls, []);
});

test('默认使用 npm 全局命令目录，预检不创建命令或修改配置', async t => {
  const root = temporary(t);
  const prefix = join(root, 'npm');
  const probes = [];
  const plan = await preflight({ platform: 'linux', agentDir: join(root, 'agent'), runProbe: (command, args) => {
    probes.push([command, args]);
    return command === 'uv' ? undefined : args[0] === 'prefix' ? prefix : '10.9.0';
  } });
  assert.equal(plan.monitor.directory, join(prefix, 'bin'));
  assert.ok(probes.some(([command, args]) => command === 'npm' && args.join(' ') === 'prefix --global'));
  await assert.rejects(stat(prefix), { code: 'ENOENT' });
});
