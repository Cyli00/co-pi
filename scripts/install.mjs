#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { monitorCommandPlan, checkMonitorCommand, installMonitorCommand } from './monitor-command.mjs';

// 引导脚本不依赖 node_modules 或 dist；运行时的对应常量由测试校验一致。
export const WINDOWS_SHELL = 'C:\\Git\\bin\\bash.exe';
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const legacyPermissionPackage = join(projectDir, 'node_modules', '@gotgenes', 'pi-permission-system');

function failure(code) { return new Error(code); }
export function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export function probe(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export async function readSettings(agentDir, name = 'settings.json') {
  const path = join(agentDir, name);
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return { path, raw: undefined, settings: {} }; throw failure('settings_unreadable'); }
  if (!info.isFile() || info.isSymbolicLink()) throw failure('settings_not_regular_file');
  let raw, settings;
  try { raw = await readFile(path, 'utf8'); settings = JSON.parse(raw); }
  catch { throw failure('settings_invalid_json'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw failure('settings_invalid_json');
  return { path, raw, settings, mode: info.mode & 0o777 };
}

export async function preflight({ platform = process.platform, agentDir, binDir, runProbe = probe, nodeVersion = process.versions.node }) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw failure('platform_unsupported');
  if (!supportedNode(nodeVersion)) throw failure('node_version_required');
  if (platform === 'win32') {
    const bash = runProbe(WINDOWS_SHELL, ['--noprofile', '--norc', '-c', 'printf \'%s\\n\' "$BASH_VERSION"; git --version']);
    if (!bash || !/^\d+\.\d+[^\r\n]*\r?\ngit version /m.test(bash)) throw failure('windows_git_bash_required');
  }
  const npm = platform === 'win32'
    ? runProbe(WINDOWS_SHELL, ['--noprofile', '--norc', '-c', 'npm --version'])
    : runProbe('npm', ['--version']);
  if (!npm) throw failure('npm_required');
  const prefix = binDir ?? (platform === 'win32'
    ? runProbe(WINDOWS_SHELL, ['--noprofile', '--norc', '-c', 'npm prefix --global'])
    : runProbe('npm', ['prefix', '--global']));
  if (!prefix) throw failure('npm_prefix_unavailable');
  const monitor = monitorCommandPlan({ platform, prefix, binDir, root: projectDir });
  await checkMonitorCommand(monitor);
  const uv = runProbe('uv', ['--version']);
  return { platform, agentDir, monitor, uvAvailable: /^uv\s+\d+\./.test(uv ?? ''),
    ...await readSettings(agentDir) };
}

export async function configurePi(plan) {
  const packages = plan.settings.packages ?? [];
  if (!Array.isArray(packages)) throw failure('settings_invalid_json');
  // 只迁移旧安装器注册的本项目路径，保留用户独立安装的扩展和配置。
  const retained = packages.filter(entry => (typeof entry === 'string' ? entry : entry?.source) !== legacyPermissionPackage);
  const settings = { ...plan.settings,
    ...(retained.length !== packages.length ? { packages: retained } : {}),
    ...(plan.platform === 'win32' ? { shellPath: WINDOWS_SHELL } : {}) };
  if ((await readSettings(plan.agentDir)).raw !== plan.raw) throw failure('settings_changed_retry');
  return saveSettings(plan.agentDir, 'settings.json', plan, settings);
}

async function saveSettings(agentDir, name, plan, settings) {
  if (JSON.stringify(settings) === JSON.stringify(plan.settings)) return {};
  // 避免检查与写入之间覆盖用户新保存的设置；原文件备份不删除。
  const current = await readSettings(agentDir, name);
  if (current.raw !== plan.raw) throw failure('settings_changed_retry');
  await mkdir(dirname(plan.path), { recursive: true });
  const suffix = randomUUID();
  const backup = plan.raw === undefined ? undefined : `${plan.path}.cpi-backup-${suffix}`;
  if (backup) await writeFile(backup, plan.raw, { flag: 'wx', mode: 0o600 });
  const output = `${JSON.stringify(settings, null, 2)}\n`;
  if (plan.raw === undefined) {
    await writeFile(plan.path, output, { flag: 'wx', mode: 0o600 });
  } else {
    const staging = `${plan.path}.cpi-new-${suffix}`;
    await writeFile(staging, output, { flag: 'wx', mode: plan.mode ?? 0o600 });
    const latest = await readSettings(agentDir, name);
    if (latest.raw !== plan.raw) throw failure('settings_changed_retry');
    await rename(staging, plan.path);
  }
  return { changed: true, backup };
}

export function mcpConfig(agentDir, root = projectDir, node = process.execPath) {
  return `[mcp_servers.co-pi]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([join(root, 'dist', 'cli.js'), '--agent-dir', agentDir])}\nstartup_timeout_sec = 20\ntool_timeout_sec = 3900`;
}

export async function install(plan, { build = buildProject, configure = configurePi, register = installMonitorCommand } = {}) {
  await build(plan.platform);
  const result = await configure(plan);
  return { ...result, monitor: await register(plan.monitor) };
}

export async function distributionMode(root = projectDir) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.cpiDistribution === undefined) return 'source';
  if (manifest.cpiDistribution !== 'runtime') throw failure('distribution_invalid');
  return 'runtime';
}

export async function validateRuntimeDistribution(root = projectDir) {
  const vendor = join(root, 'dist/vendor/pi-permission-system');
  try {
    for (const file of ['dist/cli.js', 'dist/worker.js', 'dist/monitor-cli.js', 'npm-shrinkwrap.json',
      'dist/vendor/pi-permission-system/LICENSE', 'dist/vendor/pi-permission-system/tree-sitter-bash.LICENSE']) {
      if (!(await lstat(join(root, file))).isFile()) throw failure('runtime_assets_invalid');
    }
    const metadata = JSON.parse(await readFile(join(vendor, 'tree-sitter-bash.version.json'), 'utf8'));
    const bytes = await readFile(join(vendor, 'tree-sitter-bash.wasm'));
    if (metadata.package !== 'tree-sitter-bash' || !/^\d+\.\d+\.\d+$/.test(metadata.version)
      || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw failure('runtime_assets_invalid');
  } catch { throw failure('runtime_assets_invalid'); }
}

export function installationCommands(platform, mode) {
  if (!['source', 'runtime'].includes(mode)) throw failure('distribution_invalid');
  return platform === 'win32'
    ? [[WINDOWS_SHELL, ['--noprofile', '--norc', '-c', mode === 'runtime' ? 'npm ci --omit=dev' : 'npm ci && npm run build']]]
    : mode === 'runtime' ? [['npm', ['ci', '--omit=dev']]] : [['npm', ['ci']], ['npm', ['run', 'build']]];
}

async function buildProject(platform) {
  const mode = await distributionMode();
  if (mode === 'runtime') await validateRuntimeDistribution();
  const commands = installationCommands(platform, mode);
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { cwd: projectDir, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw failure('build_failed');
  }
}

const errors = {
  platform_unsupported: '仅支持 Windows、macOS 和 Linux。',
  platform_mismatch: '安装入口与当前操作系统不匹配，请选择对应平台的脚本。',
  node_version_required: '需要 Node.js ≥ 22.19.0，请安装后重新运行。',
  windows_git_bash_required: '需要可运行的 Git for Windows，Git Bash 必须位于 C:\\Git\\bin\\bash.exe。请将 Git 安装到 C:\\Git 后重试。',
  npm_required: '未找到可运行的 npm，请检查 Node.js 安装和 PATH。',
  settings_unreadable: '无法读取 pi settings.json，请检查访问权限。',
  settings_not_regular_file: 'settings.json 必须是普通文件；请勿使用符号链接，改用 --agent-dir 指向实际配置目录。',
  settings_invalid_json: 'pi settings.json 必须是合法 JSON 对象；原文件未覆盖。',
  settings_changed_retry: '检查期间 pi 设置已变化，请关闭配置编辑器后重试；原文件未覆盖。',
  build_failed: '依赖安装或编译失败，pi 设置尚未修改。修复以上构建错误后重试。',
  distribution_invalid: '无法识别安装包类型，请重新取得源码或运行包。',
  runtime_assets_invalid: '运行包缺失文件或 WASM 校验失败，请重新解压完整运行包；pi 设置尚未修改。',
  npm_prefix_unavailable: '无法确定 npm 全局命令目录；请用 --bin-dir 指定 PATH 中可写的目录。',
  monitor_command_conflict: '快捷命令目录已有非本安装器管理的 cpi-monitor，已停止，原命令未覆盖。请用 --bin-dir 选择其他 PATH 目录。',
  monitor_directory_unwritable: '快捷命令目录不可写。请用 --bin-dir 指定用户可写且在 PATH 中的目录，无需 sudo。',
};

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    platform: { type: 'string' }, 'agent-dir': { type: 'string' }, 'bin-dir': { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('用法：node scripts/install.mjs [--check] [--agent-dir <目录>] [--bin-dir <目录>]\n--check  仅检查，不安装或修改文件。\n--bin-dir  cpi-monitor 快捷命令目录，默认 npm 全局命令目录。');
    return;
  }
  if (values.platform && values.platform !== process.platform) throw failure('platform_mismatch');
  const plan = await preflight({ agentDir: resolve(values['agent-dir'] ?? join(homedir(), '.pi', 'agent')), binDir: values['bin-dir'] });
  const mode = await distributionMode();
  if (mode === 'runtime') await validateRuntimeDistribution();
  console.log(mode === 'runtime' ? '安装类型：预编译运行包（仅安装运行依赖，无需 TypeScript 编译）。' : '安装类型：源码（安装开发依赖并编译）。');
  console.log(`平台：${plan.platform}\npi 设置：${plan.path}\nUV：${plan.uvAvailable ? '可用，将加入 uv run 指令' : '不可用，不加入 Python 执行指令'}`);
  if (plan.platform === 'win32') console.log(`Git Bash：已验证；${plan.settings.shellPath === WINDOWS_SHELL ? 'shellPath 已配置' : '安装时将合并 shellPath 并备份已有设置'}。`);
  if (!plan.settings.defaultProvider || !plan.settings.defaultModel) console.log('尚未配置 pi 默认模型：安装后请通过 pi /model 保存模型与 /thinking 保存思考强度。');
  console.log(`快捷命令目录：${plan.monitor.directory}${plan.monitor.inPath ? '（已在 PATH）' : '（当前 PATH 未包含；使用前请将该目录加入终端 PATH）'}`);
  if (values.check) { console.log('预检查完成，未修改文件。'); return; }
  const result = await install(plan);
  if (result.backup) console.log(`pi 设置备份：${result.backup}`);
  console.log('内置权限模块已就绪：工作区内可确认的操作免审，外部路径和未知范围交给 Codex 自动审批；不安装或注册完整 pi-permission-system 扩展。');
  console.log(`已注册 cpi-monitor 快捷命令：${result.monitor.directory}。参数会原样传递，例如 cpi-monitor --state-dir <目录>。`);
  console.log(`项目安装与平台配置完成。安全指令将在每个 worker 启动时自动注入。\n首次接入时，将以下内容合并到 Codex config.toml；已有同名配置时更新该表：\n\n${mcpConfig(plan.agentDir)}\n\n技能位置：${join(projectDir, '.agents', 'skills', 'co-pi')}\n在其他项目使用时，将该目录复制到目标项目的 .agents/skills/。\n监控命令：cpi-monitor
完整路径备用：node ${JSON.stringify(join(projectDir, 'dist', 'monitor-cli.js'))}\n模型、认证与思考强度的配置步骤见 README.md。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(errors[error.message] ?? '安装失败。请检查参数、目录权限和依赖环境；错误正文未回显。');
    process.exitCode = 1;
  });
}
