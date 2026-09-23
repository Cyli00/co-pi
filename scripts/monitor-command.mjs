import { access, chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

const marker = 'co-pi monitor launcher v1';
const acceptedMarkers = [marker, 'codex-pi-subagents monitor launcher v1'];
const quoteSh = value => `'${value.replaceAll("'", "'\\''")}'`;
const quoteCmd = value => `"${value.replaceAll('%', '%%')}"`;

export function monitorCommandPlan({ platform, prefix, binDir, root, node = process.execPath, pathValue = process.env.PATH ?? '' }) {
  const directory = resolve(binDir ?? (platform === 'win32' ? prefix : join(prefix, 'bin')));
  const entry = join(root, 'dist', 'monitor-cli.js');
  const shellPath = path => process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
  const files = [{ name: 'cpi-monitor', content: `#!/bin/sh\n# ${marker}\nexec ${quoteSh(shellPath(node))} ${quoteSh(shellPath(entry))} "$@"\n` }];
  if (platform === 'win32') files.push({ name: 'cpi-monitor.cmd', content: `@echo off\r\nrem ${marker}\r\nsetlocal DisableDelayedExpansion\r\n${quoteCmd(node)} ${quoteCmd(entry)} %*\r\nexit /b %errorlevel%\r\n` });
  const normalize = path => {
    const normalized = resolve(path).replaceAll('\\', '/').replace(/\/$/, '');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const inPath = pathValue.split(delimiter).filter(Boolean).some(path => normalize(path) === normalize(directory));
  return { directory, files, inPath, platform };
}

async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function checkMonitorCommand(plan) {
  // 先核对全部目标，避免覆盖其他工具的命令或只安装了一半。
  for (const file of plan.files) {
    const path = join(plan.directory, file.name);
    const info = await existing(path);
    if (info && (!info.isFile() || info.isSymbolicLink()
      || !(await readFile(path, 'utf8')).split(/\r?\n/).slice(0, 2).some(line =>
        acceptedMarkers.some(value => line === `# ${value}` || line === `rem ${value}`)))) {
      throw new Error('monitor_command_conflict');
    }
  }
  if (plan.platform === 'win32' && (await existing(join(plan.directory, 'cpi-monitor.ps1')) || await existing(join(plan.directory, 'cpi-monitor.exe')))) {
    throw new Error('monitor_command_conflict');
  }
  let parent = plan.directory;
  while (!(await existing(parent))) {
    const next = resolve(parent, '..');
    if (next === parent) throw new Error('monitor_directory_unwritable');
    parent = next;
  }
  try { await access(parent, constants.W_OK); }
  catch { throw new Error('monitor_directory_unwritable'); }
}

export async function installMonitorCommand(plan) {
  await checkMonitorCommand(plan);
  await mkdir(plan.directory, { recursive: true });
  for (const file of plan.files) {
    const path = join(plan.directory, file.name);
    const info = await existing(path);
    if (!info) await writeFile(path, file.content, { flag: 'wx', mode: 0o755 });
    else if (await readFile(path, 'utf8') !== file.content) await writeFile(path, file.content);
    if (plan.platform !== 'win32') await chmod(path, 0o755);
  }
  return { directory: plan.directory, inPath: plan.inPath };
}
