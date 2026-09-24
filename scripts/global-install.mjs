import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const marker = '.co-pi-install.json';
const owner = 'co-pi-global-install-v1';
const files = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'tsconfig.json',
  'src', 'dist', 'node_modules', 'scripts', '.agents/skills/co-pi', 'README.md'];

export function globalInstallPlan({ home = homedir(), codexHome = process.env.CODEX_HOME,
  pluginDir, skillsDir, source }) {
  const base = resolve(codexHome || join(home, '.codex'));
  return { source: resolve(source), pluginDir: resolve(pluginDir ?? join(base, 'plugins', 'co-pi')),
    skillDir: join(resolve(skillsDir ?? join(base, 'skills')), 'co-pi') };
}

async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

async function checkTarget(path, kind) {
  const info = await existing(path);
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('global_install_conflict');
    const stamp = join(path, marker);
    const stampInfo = await existing(stamp);
    if (!stampInfo?.isFile() || stampInfo.isSymbolicLink()) throw new Error('global_install_conflict');
    let saved;
    try { saved = JSON.parse(await readFile(stamp, 'utf8')); } catch { throw new Error('global_install_conflict'); }
    if (saved.owner !== owner || saved.kind !== kind) throw new Error('global_install_conflict');
  }
  let parent = dirname(path);
  while (!(await existing(parent))) parent = dirname(parent);
  try { await access(parent, constants.W_OK); } catch { throw new Error('global_install_unwritable'); }
}

async function canonical(path) {
  if (await existing(path)) return realpath(path);
  return join(await canonical(dirname(path)), relative(dirname(path), path));
}

export async function checkGlobalInstall(plan) {
  const [source, pluginDir, skillDir] = await Promise.all(
    [plan.source, plan.pluginDir, plan.skillDir].map(canonical));
  if (contains(pluginDir, skillDir) || contains(skillDir, pluginDir)
    || (source !== pluginDir && (contains(source, pluginDir) || contains(pluginDir, source)))
    || contains(source, skillDir) || contains(skillDir, source)) throw new Error('global_install_overlap');
  await checkTarget(plan.pluginDir, 'plugin');
  await checkTarget(plan.skillDir, 'skill');
}

async function stage(path, kind, populate) {
  await mkdir(dirname(path), { recursive: true });
  const staging = await mkdtemp(join(dirname(dirname(path)), '.co-pi-staging-'));
  await populate(staging);
  await writeFile(join(staging, marker), JSON.stringify({ owner, kind }) + '\n', { flag: 'wx' });
  return staging;
}

async function activate(path, staging, kind, backupRoot) {
  await checkTarget(path, kind);
  let backup;
  if (await existing(path)) {
    await mkdir(backupRoot, { recursive: true });
    backup = join(backupRoot, `${kind}-${randomUUID()}`);
    await rename(path, backup);
  }
  try { await rename(staging, path); }
  catch (error) { if (backup) await rename(backup, path); throw error; }
  return backup;
}

export async function installGlobal(plan, { agentDir, node = process.execPath } = {}) {
  await checkGlobalInstall(plan);
  const { source, pluginDir, skillDir } = plan;
  // 先准备完整副本，再切换目录；旧版本移至技能发现目录之外，避免重复加载。
  const pluginStage = await stage(pluginDir, 'plugin', async target => {
    for (const file of files) {
      if (await existing(join(source, file))) await cp(join(source, file), join(target, file), { recursive: true, dereference: true });
    }
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    await cp(join(source, '.agents/skills/co-pi'), join(target, 'skills/co-pi'), { recursive: true, dereference: true });
    await mkdir(join(target, '.codex-plugin'), { recursive: true });
    await writeFile(join(target, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'co-pi',
      version: pkg.version, description: pkg.description, skills: './skills/', mcpServers: './.mcp.json',
      author: { name: 'co-pi contributors' }, interface: { displayName: 'co-pi',
        shortDescription: 'pi 子代理与终端监控器', longDescription: pkg.description,
        developerName: 'co-pi contributors', category: 'Productivity', capabilities: ['Write'],
        defaultPrompt: ['使用 co-pi 委派一个边界明确的任务。'] } }, null, 2) + '\n');
    await writeFile(join(target, '.mcp.json'), JSON.stringify({ mcpServers: { 'co-pi': {
      command: node, args: [join(pluginDir, 'dist/cli.js'), '--agent-dir', agentDir],
      startup_timeout_sec: 20, tool_timeout_sec: 3900 } } }, null, 2) + '\n');
  });
  const skillStage = await stage(skillDir, 'skill', target =>
    cp(join(source, '.agents/skills/co-pi'), target, { recursive: true, dereference: true }));
  const backups = [];
  backups.push(await activate(pluginDir, pluginStage, 'plugin', join(dirname(dirname(pluginDir)), 'co-pi-backups')));
  backups.push(await activate(skillDir, skillStage, 'skill', join(dirname(dirname(skillDir)), 'co-pi-backups')));
  return { pluginDir, skillDir, backups: backups.filter(Boolean) };
}
