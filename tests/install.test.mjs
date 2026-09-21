import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporary } from './helpers.mjs';
import { WINDOWS_SHELL, validateShell } from '../dist/platform.js';
import { workerInstructions, safetyInstructions } from '../dist/instructions.js';
import { WINDOWS_SHELL as installerShell, supportedNode, preflight as installerPreflight, configurePi, install, mcpConfig } from '../scripts/install.mjs';

const preflight = options => installerPreflight({ ...options, binDir: join(options.agentDir, 'commands') });

const available = (command, args) => command === 'uv' ? 'uv 0.5.9' : args.at(-1)?.includes('BASH_VERSION') ? '5.2.37(1)-release\ngit version 2.49.0.windows.1' : '10.9.0';

test('三平台安装检查和条件提示词：UV 缺失不阻塞，非 Windows 不探测 Git Bash', async t => {
  assert.equal(installerShell, WINDOWS_SHELL);
  for (const platform of ['win32', 'darwin', 'linux']) for (const uv of [true, false]) {
    const agentDir = temporary(t);
    const calls = [];
    const plan = await preflight({ platform, agentDir, runProbe: (command, args) => {
      calls.push(command);
      return command === 'uv' && !uv ? undefined : available(command, args);
    } });
    assert.equal(plan.uvAvailable, uv);
    assert.equal(calls.includes(WINDOWS_SHELL), platform === 'win32');
    assert.deepEqual(await readdir(agentDir), []);
    const prompt = workerInstructions(platform, plan.uvAvailable);
    assert.ok(prompt.includes(safetyInstructions));
    assert.equal(prompt.includes('Bash/POSIX syntax'), platform === 'win32');
    assert.equal(prompt.includes(WINDOWS_SHELL), platform === 'win32');
    assert.equal(prompt.includes('When Python is needed, use `uv run`.'), uv);
    assert.equal(prompt.includes('Python'), uv);
    assert.ok(!/\p{Script=Han}/u.test(prompt));
  }
});

test('Windows 合并 shellPath、逐字备份已有配置，重复执行不新增备份', async t => {
  const agentDir = temporary(t);
  const original = '{\n "defaultProvider": "example", "defaultModel": "model", "defaultThinkingLevel": "high", "shellPath": "old-shell", "extensions": ["custom.ts"]\n}\n';
  await writeFile(join(agentDir, 'settings.json'), original);
  const plan = await preflight({ platform: 'win32', agentDir, runProbe: available });
  const result = await configurePi(plan);
  assert.equal(await readFile(result.backup, 'utf8'), original);
  assert.deepEqual(JSON.parse(await readFile(plan.path, 'utf8')), { ...JSON.parse(original), shellPath: WINDOWS_SHELL });
  const again = await preflight({ platform: 'win32', agentDir, runProbe: available });
  assert.deepEqual(await configurePi(again), {});
  assert.equal((await readdir(agentDir)).length, 2);
});

test('macOS/Linux 保留原 shell 与配置字节，不创建缺失的 pi 目录', async t => {
  for (const platform of ['darwin', 'linux']) {
    const root = temporary(t);
    const agentDir = join(root, 'not-created');
    await configurePi(await preflight({ platform, agentDir, runProbe: available }));
    await assert.rejects(access(agentDir), { code: 'ENOENT' });
    const raw = '{ "shellPath": "/bin/zsh", "defaultModel": "kept" }\n';
    await writeFile(join(root, 'settings.json'), raw);
    await configurePi(await preflight({ platform, agentDir: root, runProbe: available }));
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), raw);
    await validateShell({ shellPath: '/bin/zsh' }, platform);
  }
});

test('缺少 Git Bash、旧 Node、无 npm 或损坏配置时停止，构建失败不修改 pi 设置', async t => {
  const agentDir = temporary(t);
  for (const version of ['20.20.0', '22.18.9']) assert.equal(supportedNode(version), false);
  for (const version of ['22.19.0', '22.23.1', '24.0.0']) assert.equal(supportedNode(version), true);
  await assert.rejects(preflight({ platform: 'win32', agentDir, runProbe: () => undefined }), /windows_git_bash_required/);
  await assert.rejects(preflight({ platform: 'linux', agentDir, runProbe: available, nodeVersion: '20.0.0' }), /node_version_required/);
  await assert.rejects(preflight({ platform: 'darwin', agentDir, runProbe: () => undefined }), /npm_required/);
  await assert.rejects(validateShell({}, 'win32'), /windows_shell_path_required/);
  await assert.rejects(validateShell({ shellPath: '/bin/bash' }, 'win32'), /windows_shell_path_required/);
  await writeFile(join(agentDir, 'settings.json'), '{"broken":');
  await assert.rejects(preflight({ platform: 'win32', agentDir, runProbe: available }), /settings_invalid_json/);
  assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"broken":');
  await writeFile(join(agentDir, 'settings.json'), '{}');
  const plan = await preflight({ platform: 'win32', agentDir, runProbe: available });
  await assert.rejects(install(plan, { build: () => { throw new Error('build_failed'); } }), /build_failed/);
  assert.equal(await readFile(plan.path, 'utf8'), '{}');
  assert.deepEqual(await readdir(agentDir), ['settings.json']);
});

test('Windows 首次创建设置；检查后配置变化时不覆盖新值', async t => {
  const agentDir = join(temporary(t), 'new-agent');
  const initial = await preflight({ platform: 'win32', agentDir, runProbe: available });
  const order = [];
  await install(initial, { build: () => { order.push('build'); }, configure: async plan => { order.push('configure'); return configurePi(plan); } });
  assert.deepEqual(order, ['build', 'configure']);
  assert.deepEqual(JSON.parse(await readFile(initial.path, 'utf8')), { shellPath: WINDOWS_SHELL });
  await writeFile(initial.path, '{}');
  const plan = await preflight({ platform: 'win32', agentDir, runProbe: available });
  await writeFile(plan.path, '{"defaultModel":"new-model"}');
  await assert.rejects(configurePi(plan), /settings_changed_retry/);
  assert.equal(await readFile(plan.path, 'utf8'), '{"defaultModel":"new-model"}');
});

test('真实安装及平台入口 --check 可从其他目录调用，不写入含空格的临时配置路径', async t => {
  const root = temporary(t);
  const agentDir = join(root, 'pi settings');
  const platformName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const commands = [
    [process.execPath, [fileURLToPath(new URL('../scripts/install.mjs', import.meta.url))]],
    [process.platform === 'win32' ? WINDOWS_SHELL : '/bin/bash', ['--noprofile', '--norc', fileURLToPath(new URL(`../scripts/install-${platformName}.sh`, import.meta.url)).replaceAll('\\', '/')]],
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, [...args, '--check', '--agent-dir', agentDir, '--bin-dir', join(root, 'commands')], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /预检查完成，未修改文件/);
    assert.deepEqual(await readdir(root), []);
  }
  const config = mcpConfig('C:\\Test User\\pi', 'C:\\Project Folder', 'C:\\Program Files\\node.exe');
  assert.ok(config.includes(JSON.stringify('C:\\Test User\\pi')));
  assert.ok(config.includes('tool_timeout_sec = 3900'));
});
