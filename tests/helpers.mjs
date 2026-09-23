import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { WINDOWS_SHELL } from '../dist/platform.js';

export const platformSettings = process.platform === 'win32' ? { shellPath: WINDOWS_SHELL } : {};

export function temporary(t, dispose = async () => {}) {
  const base = process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Temp', 'co-pi-tests') : join(tmpdir(), 'co-pi-tests');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'run-'));
  t.after(async () => {
    await dispose();
    const target = realpathSync(directory);
    if (!target.startsWith(realpathSync(base) + sep) || !resolve(target).includes('run-')) throw new Error('临时清理路径越界');
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

export const handoff = (summary = '已完成任务') => ({
  status: 'completed', summary, changes: ['添加临时测试文件'],
  verification: [{ action: '本地验证', result: 'passed', detail: '仅使用隔离临时目录' }],
  evidence: [{ path: 'result.txt', line: 1, note: '测试产物' }], unresolved: [], nextSteps: [],
});
export const task = (id, instruction = 'success') => ({ id, title: `Task ${id}`, instruction, acceptance: 'Provide a verifiable handoff' });

export function waitFor(emitter, name, predicate = () => true, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(name, listener); reject(new Error(`等待 ${name} 超时`)); }, timeout);
    const listener = value => {
      if (predicate(value)) { clearTimeout(timer); emitter.off(name, listener); resolve(value); }
    };
    emitter.on(name, listener);
  });
}
