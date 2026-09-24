import test from 'node:test';
import assert from 'node:assert/strict';
import { getKeybindings } from '@earendil-works/pi-tui';
import { createMonitorTui } from '../dist/monitor-tui.js';
import { MonitorRouter } from '../dist/monitor.js';
import { task } from './helpers.mjs';

function monitor(t) {
  const keybindings = getKeybindings();
  const bindings = keybindings.getUserBindings();
  t.after(() => keybindings.setUserBindings(bindings));
  const terminal = {
    columns: 160, rows: 14, kittyProtocolActive: false,
    start(onInput) { this.input = onInput; },
    stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = createMonitorTui(terminal);
  const router = new MonitorRouter(() => terminal.rows, () => tui.requestRender(), () => tui.stop(), { color: false });
  const state = {
    version: 1, sessionId: 'session', batchId: 'batch', pid: 1, closed: false,
    heartbeatAt: new Date().toISOString(), workspace: '测试目录',
    tasks: Array.from({ length: 20 }, (_, i) => ({
      task: task(String(i)), phase: 'running', updatedAt: new Date().toISOString(), summary: '测试',
      events: Array.from({ length: 40 }, (_, j) => ({
        at: '2026-09-21T10:00:00Z', kind: 'tool', text: `事件 ${j}`,
      })), omittedEvents: 0,
    })),
  };
  tui.addChild(router);
  tui.setFocus(router);
  router.update([state]);
  tui.start();
  t.after(() => tui.stop());
  const render = () => router.render(terminal.columns).join('\n');
  render();
  const press = key => { terminal.input(key); return render(); };
  return { router, state, press, render };
}

for (const [name, up, down, home, end] of [
  ['标准 CSI', '\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F'],
  ['SS3 Home/End', '\x1b[5~', '\x1b[6~', '\x1bOH', '\x1bOF'],
  ['数字 Home/End', '\x1b[5~', '\x1b[6~', '\x1b[1~', '\x1b[4~'],
  ['Kitty', '\x1b[5;1~', '\x1b[6;1~', '\x1b[1;1H', '\x1b[1;1F'],
]) {
  test(`真实终端分发：${name} 翻页、回顶与恢复跟随`, t => {
    const { router, state, press, render } = monitor(t);
    press('\r');
    const tail = render();
    const previous = press('w');
    assert.notEqual(previous, tail);
    press('f');
    assert.equal(press(up), previous, 'PgUp 应到达详情滚动逻辑');
    const next = press('s');
    press('w');
    assert.equal(press(down), next, 'PgDn 应与 s 一致');
    const top = press('g');
    press('f');
    assert.equal(press(home), top, 'Home 应回顶');
    assert.match(top, /○ 浏览\s+1–/);
    assert.equal(press(end), tail, 'End 应恢复跟随');
    state.tasks[0].events.push({ at: '2026-09-21T10:01:00Z', kind: 'tool', text: '新增末尾事件' });
    router.update([state]);
    assert.match(render(), /新增末尾事件/);
    assert.match(render(), /● 跟随/);
  });
}

test('真实终端分发：列表翻页和首尾选择', t => {
  const { press } = monitor(t);
  const next = press('s');
  press('g');
  assert.equal(press('\x1b[6~'), next);
  const top = press('w');
  press('s');
  assert.equal(press('\x1b[5~'), top);
  const bottom = press('f');
  assert.notEqual(bottom, top);
  assert.equal(press('\x1b[H'), top);
  assert.equal(press('\x1b[F'), bottom);
});

test('真实终端分发：帮助页 PgUp/PgDn 与 w/s 一致', t => {
  const { press } = monitor(t);
  const top = press('?');
  const bottom = press('s');
  assert.notEqual(bottom, top);
  assert.equal(press('\x1b[5~'), top);
  assert.equal(press('\x1b[6~'), bottom);
});
