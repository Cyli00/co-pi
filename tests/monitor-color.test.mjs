import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { resolveMonitorColor } from '../dist/monitor-color.js';
import { MonitorStyle, renderFeed } from '../dist/monitor-view.js';
import { MonitorRouter } from '../dist/monitor.js';
import { monitorScript } from '../dist/monitor-open.js';
import { StateStore } from '../dist/store.js';
import { bindStateThread } from '../dist/state-thread.js';
import { WINDOWS_SHELL } from '../dist/platform.js';
import { temporary, task, handoff } from './helpers.mjs';

test('独立终端不会被 agent 的 NO_COLOR 变成单色，显式用户开关优先', () => {
  const env = { NO_COLOR: '1', TERM: 'dumb' };
  assert.equal(resolveMonitorColor({ open: true }, env), true);
  assert.equal(resolveMonitorColor({ open: true, 'no-color': true }, env), false);
  assert.equal(resolveMonitorColor({ color: true }, env), true);
  assert.equal(resolveMonitorColor({}, env), false);
  assert.equal(resolveMonitorColor({}, { NO_COLOR: '' }), true);
  assert.equal(resolveMonitorColor({ once: true }, {}), false);
  assert.equal(resolveMonitorColor({ once: true, color: true }, env), true);
  assert.throws(() => resolveMonitorColor({ color: true, 'no-color': true }, env), /不能/);
});

test('原有六色主题在时间线、列表和详情中保留，无色模式只移除样式', () => {
  const at = new Date().toISOString();
  const state = { task: task('colored'), phase: 'failed', error: 'model_network_failed', updatedAt: at,
    summary: '配色回归', omittedEvents: 0, handoff: handoff('交接摘要'), events: [
      { at, kind: 'progress', text: '阶段内容' },
      { at, kind: 'assistant', text: '**公开输出**' },
      { at, id: 'tool-one', kind: 'tool_start', text: 'read {"path":"README.md"}' },
      { at, id: 'output-one', kind: 'tool_end', text: 'read\n工具结果' },
      { at, kind: 'runtime', text: 'model_network_failed' },
    ] };
  const rich = renderFeed(state, 100, 'all', true, new MonitorStyle(true)).join('\n');
  const plain = renderFeed(state, 100, 'all', true, new MonitorStyle(false)).join('\n');
  for (const rgb of ['125;180;232', '133;199;175', '216;178;110', '198;160;213', '140;150;166', '239;143;143']) {
    assert.ok(rich.includes(`38;2;${rgb}m`), rgb);
  }
  assert.equal(stripTerminalSequences(rich), plain);
  assert.doesNotMatch(plain, /\x1b\[/);
  const snapshot = { version: 1, sessionId: randomUUID(), batchId: 'colors', pid: 1, workspace: 'test', heartbeatAt: at, closed: true, tasks: [state] };
  const router = new MonitorRouter(() => 40, () => {}, () => {}, { color: true });
  router.update([snapshot]);
  assert.match(router.render(100).join('\n'), /38;2;239;143;143m/);
  router.handleInput('\r');
  assert.match(router.render(100).join('\n'), /38;2;198;160;213m/);
});

test('实际启动脚本传递彩色选项后，NO_COLOR 环境中的 CLI 仍输出颜色；纯文本及显式关闭保持有效', async t => {
  const root = temporary(t), threadId = randomUUID();
  bindStateThread(root, threadId);
  const store = new StateStore(root, threadId);
  const at = new Date().toISOString();
  await store.write({ version: 1, sessionId: store.sessionId, batchId: 'color', pid: 1, workspace: root, heartbeatAt: at, closed: true,
    tasks: [{ task: task('color'), phase: 'completed', updatedAt: at, summary: '颜色测试', events: [], omittedEvents: 0 }] });
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb', CODEX_THREAD_ID: '' };
  const cli = join(process.cwd(), 'dist/monitor-cli.js');
  const base = ['--once', '--state-dir', root, '--codex-home', join(root, 'empty-codex')];
  const launch = (options, name) => {
    const flag = resolveMonitorColor(options, env) ? '--color' : '--no-color';
    const script = join(root, name);
    writeFileSync(script, monitorScript(process.execPath, cli, [...base, flag]));
    return spawnSync(process.platform === 'win32' ? WINDOWS_SHELL : '/bin/bash',
      ['--noprofile', '--norc', script], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  };
  const color = launch({ open: true }, 'color.sh');
  assert.equal(color.status, 0, color.stderr);
  assert.match(color.stdout, /\x1b\[(?:1;)?38;2;/);
  const noColor = launch({ open: true, 'no-color': true }, 'plain.sh');
  assert.equal(noColor.status, 0, noColor.stderr);
  assert.doesNotMatch(noColor.stdout, /\x1b\[/);
  assert.equal(stripTerminalSequences(color.stdout), noColor.stdout);
  const once = spawnSync(process.execPath, [cli, ...base], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(once.status, 0, once.stderr);
  assert.doesNotMatch(once.stdout, /\x1b\[/);
  const conflict = spawnSync(process.execPath, [cli, '--color', '--no-color'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /不能/);
});
