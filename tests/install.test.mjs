import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, symlink, copyFile } from 'node:fs/promises';
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

test('macOS/Linux 不注册完整权限扩展，保留原 shell', async t => {
  for (const platform of ['darwin', 'linux']) {
    const root = temporary(t);
    const agentDir = join(root, 'not-created');
    await configurePi(await preflight({ platform, agentDir, runProbe: available }));
    await assert.rejects(readFile(join(agentDir, 'settings.json')), { code: 'ENOENT' });
    const raw = '{ "shellPath": "/bin/zsh", "defaultModel": "kept" }\n';
    await writeFile(join(root, 'settings.json'), raw);
    await configurePi(await preflight({ platform, agentDir: root, runProbe: available }));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')), { ...JSON.parse(raw) });
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

test('迁移只移除旧安装器的包引用，保留独立扩展及原配置', async t => {
  const agentDir = temporary(t);
  const legacy = fileURLToPath(new URL('../node_modules/@gotgenes/pi-permission-system', import.meta.url));
  const independent = 'npm:@gotgenes/pi-permission-system@30.0.0';
  const settings = { packages: ['npm:unrelated', legacy, { source: legacy }, independent], defaultModel: 'kept' };
  const raw = JSON.stringify(settings);
  await writeFile(join(agentDir, 'settings.json'), raw);
  const configDir = join(agentDir, 'extensions', 'pi-permission-system');
  await mkdir(configDir, { recursive: true });
  const config = '{ "permission": {"*":"deny"}, "yoloMode":true }\n';
  await writeFile(join(configDir, 'config.json'), config);
  const result = await configurePi(await preflight({ platform: 'linux', agentDir, runProbe: available }));
  assert.equal(await readFile(result.backup, 'utf8'), raw);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')),
    { ...settings, packages: ['npm:unrelated', independent] });
  assert.equal(await readFile(join(configDir, 'config.json'), 'utf8'), config);
  assert.deepEqual(await configurePi(await preflight({ platform: 'linux', agentDir, runProbe: available })), {});
});

test('配置目录链接支持预检、合并与备份，不替换链接目录', async t => {
  const root = temporary(t), actual = join(root, 'real-agent'), agentDir = join(root, 'linked-agent');
  await mkdir(actual);
  await symlink(actual, agentDir, process.platform === 'win32' ? 'junction' : 'dir');
  const raw = '{ "defaultModel": "kept", "shellPath": "old" }\n';
  await writeFile(join(actual, 'settings.json'), raw);
  for (const platform of ['linux', 'darwin', 'win32']) {
    const plan = await preflight({ platform, agentDir, runProbe: available });
    assert.equal(plan.raw, raw);
  }
  const result = await configurePi(await preflight({ platform: 'win32', agentDir, runProbe: available }));
  assert.equal(await readFile(result.backup, 'utf8'), raw);
  assert.deepEqual(JSON.parse(await readFile(join(actual, 'settings.json'), 'utf8')),
    { defaultModel: 'kept', shellPath: WINDOWS_SHELL });
  assert.deepEqual(await configurePi(await preflight({ platform: 'win32', agentDir, runProbe: available })), {});
  const { lstat } = await import('node:fs/promises');
  assert.ok((await lstat(agentDir)).isSymbolicLink());
});

test('配置文件自身不是普通文件时仍拒绝安装', async t => {
  const agentDir = temporary(t);
  await mkdir(join(agentDir, 'settings.json'));
  await assert.rejects(preflight({ platform: 'linux', agentDir, runProbe: available }), /settings_not_regular_file/);
});

test('真实安装及统一 Bash 入口 --check 可从其他目录调用，不写入含空格的临时配置路径', async t => {
  const root = temporary(t);
  const agentDir = join(root, "pi user's settings");
  const commands = [
    [process.execPath, [fileURLToPath(new URL('../scripts/install.mjs', import.meta.url))]],
    [process.platform === 'win32' ? WINDOWS_SHELL : '/bin/bash', ['--noprofile', '--norc', fileURLToPath(new URL('../scripts/install.sh', import.meta.url)).replaceAll('\\', '/')]],
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, [...args, '--check', '--agent-dir', agentDir, '--bin-dir', join(root, 'commands')], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: join(root, 'codex') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /预检查完成，未修改文件/);
    assert.deepEqual(await readdir(root), []);
  }
  const config = mcpConfig('C:\\Test User\\pi', 'C:\\Project Folder', 'C:\\Program Files\\node.exe');
  assert.ok(config.startsWith('[mcp_servers.co-pi]\n'));
  assert.ok(config.includes(JSON.stringify('C:\\Test User\\pi')));
  assert.ok(config.includes('tool_timeout_sec = 3900'));
});

test('统一 Bash 入口拒绝无效参数并返回失败退出码', t => {
  const root = temporary(t);
  const shell = process.platform === 'win32' ? WINDOWS_SHELL : '/bin/bash';
  const common = fileURLToPath(new URL('../scripts/install.sh', import.meta.url)).replaceAll('\\', '/');
  const invalid = spawnSync(shell, ['--noprofile', '--norc', common, '--invalid-option'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1);
});

test('统一 Bash 入口原样转发参数和退出码，安装路径可含空格及单引号', async t => {
  const root = temporary(t), scripts = join(root, "user's installation", 'scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(new URL('../scripts/install.sh', import.meta.url), join(scripts, 'install.sh'));
  await writeFile(join(scripts, 'install.mjs'), 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;');
  const args = ['--agent-dir', "pi user's settings", '--bin-dir', '$(not-a-command)', '--check'];
  const run = spawnSync(process.platform === 'win32' ? WINDOWS_SHELL : '/bin/bash',
    ['--noprofile', '--norc', join(scripts, 'install.sh').replaceAll('\\', '/'), ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 23, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), args);
});

test('pwsh 统一入口保留含空格及单引号的参数，预检不写文件并传回失败退出码', { skip: process.platform !== 'win32' }, async t => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') { t.skip('此环境未安装 PowerShell 7'); return; }
  assert.equal(probe.status, 0, probe.stderr);
  const root = temporary(t);
  const agentDir = join(root, "pi user's settings");
  const entry = fileURLToPath(new URL('../scripts/install.ps1', import.meta.url));
  const args = ['-NoProfile', '-File', entry, '--check', '--agent-dir', agentDir, '--bin-dir', join(root, 'command folder')];
  const checked = spawnSync('pwsh', args, { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: join(root, 'codex') } });
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(checked.stdout.includes(agentDir), checked.stdout);
  assert.match(checked.stdout, /预检查完成，未修改文件/);
  assert.deepEqual(await readdir(root), []);
  const failed = spawnSync('pwsh', [...args, '--invalid-option'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: join(root, 'codex') } });
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(await readdir(root), []);
});
