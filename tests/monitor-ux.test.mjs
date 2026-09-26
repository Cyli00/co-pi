import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { visibleWidth } from '@earendil-works/pi-tui';
import { MonitorRouter } from '../dist/monitor.js';
import { handoff, task } from './helpers.mjs';

const at = '2026-09-25T10:00:00Z';
function fixture(count = 1) {
  return { version: 1, sessionId: 'session', batchId: 'batch', pid: 1, closed: false,
    heartbeatAt: new Date().toISOString(), workspace: '测试目录',
    tasks: Array.from({ length: count }, (_, i) => ({ task: task(`task-${i}`), phase: 'running',
      updatedAt: at, summary: '检查中', omittedEvents: 0,
      events: Array.from({ length: 60 }, (_, j) => ({ id: `${i}-${j}`, at, kind: 'progress', text: `TASK_${i}_EVENT_${j}` })) })) };
}
function monitor(state, rows = 24, width = 80) {
  const router = new MonitorRouter(() => rows, () => {}, () => {}, { color: false });
  router.update([state]);
  const render = () => router.render(width).join('\n');
  render();
  return { router, render, press(key) { router.handleInput(key); return render(); } };
}

test('长交接首次从结论开始，分类往返保留各自阅读位置', () => {
  const state = fixture();
  state.tasks[0].phase = 'completed';
  state.tasks[0].handoff = { ...handoff('HANDOFF_CONCLUSION'),
    evidence: Array.from({ length: 30 }, (_, i) => ({ path: `file-${i}.ts`, note: `证据 ${i}` })) };
  const { press, render } = monitor(state);
  assert.match(press('\r'), /HANDOFF_CONCLUSION/);
  assert.match(render(), /\[交接\]/);
  press('s'); const handoffPage = render();
  press('\x1b[C'); press('g'); press('j'); const feedPage = render();
  assert.equal(press('\x1b[D'), handoffPage);
  assert.equal(press('\x1b[C'), feedPage);
});

test('矮窗口末尾向下保留跟随，向上浏览显示暂停与恢复键', () => {
  for (const rows of [4, 5, 8, 11, 12, 24]) {
    const state = fixture(); const { router, press, render } = monitor(state, rows);
    press('\r');
    assert.match(press('\x1b[B'), /● 跟随/);
    state.tasks[0].events.push({ id: 'new', at, kind: 'progress', text: 'NEW_TAIL' }); router.update([state]);
    assert.match(render(), /NEW_TAIL/);
    assert.match(press('g'), /○ 浏览.*f 跟随/);
    state.tasks[0].events.push({ id: 'newer', at, kind: 'progress', text: 'NEWER_TAIL' }); router.update([state]);
    assert.doesNotMatch(render(), /NEWER_TAIL/);
    assert.match(press('f'), /NEWER_TAIL/);
  }
});

test('增加列表高度不减少可见任务，紧凑列表保留不同任务的编号', () => {
  for (const total of [1, 10, 100]) {
    const state = fixture(total);
    state.tasks.forEach(t => { t.task.title = '相同且很长的任务标题'.repeat(5); });
    let previous = 0;
    for (let rows = 4; rows <= 40; rows++) {
      const { router, render } = monitor(state, rows, 40);
      const output = render();
      const count = output.split('\n').filter(line => line.includes('[执行中]')).length;
      assert.ok(count >= previous, `${total} 项、${rows} 行：${count} < ${previous}`);
      previous = count;
      const ids = output.match(/#\d+/g) ?? [];
      assert.equal(new Set(ids).size, count);
      assert.ok(router.render(40).every(line => visibleWidth(line) <= 40));
    }
  }
});

test('活跃筛选保持选择身份；任务结束后详情仍可读，返回列表可恢复全部', () => {
  const state = fixture(3); state.tasks[0].phase = 'completed';
  const { router, press, render } = monitor(state);
  press('j'); assert.match(press('a'), /仅活跃/);
  press('\r'); assert.equal(router.route.taskId, 'task-1');
  const next = structuredClone(state); next.tasks[1].phase = 'completed'; next.tasks[2].phase = 'completed';
  router.update([next]); assert.match(render(), /TASK_1_EVENT_59/);
  assert.match(press('b'), /暂无活跃任务/);
  assert.match(press('a'), /Task task-0/);
  press('\r'); assert.equal(router.route.taskId, 'task-0');
});

test('相邻任务切换保留分类与每项任务的阅读位置，返回列表定位当前任务', () => {
  const state = fixture(2); const { router, press, render } = monitor(state);
  press('\r'); press('\x1b[C'); press('g'); press('j');
  const first = render();
  assert.match(press(']'), /\[阶段\]/); assert.equal(router.route.taskId, 'task-1');
  press('g'); press('s'); const second = render();
  assert.equal(press('['), first);
  assert.equal(press(']'), second);
  press('b'); press('\r'); assert.equal(router.route.taskId, 'task-1'); assert.equal(render(), second);
});

test('同一时刻的事件与用量按本地时区显示，事件包含日期与时间说明', () => {
  for (const [zone, expected] of [['Asia/Shanghai', '18:00:00'], ['UTC', '10:00:00'], ['America/New_York', '06:00:00']]) {
    const script = `import { MonitorRouter } from './dist/monitor.js';
      import { renderFeed, MonitorStyle } from './dist/monitor-view.js';
      const state = ${JSON.stringify(fixture())};
      const router = new MonitorRouter(() => 24, () => {}, () => {}, {color:false});
      router.update([state]); router.updateCodexUsage({state:'ready',automatic:false,inputTokens:1,cachedInputTokens:0,updatedAt:${JSON.stringify(at)}});
      console.log(JSON.stringify({event:renderFeed(state.tasks[0],160,'stages',false,new MonitorStyle(false))[0],footer:router.render(160).at(-2)}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: zone } });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.ok(data.event.includes(expected), data.event); assert.match(data.event, /09-25.*本地/);
    assert.ok(data.footer.includes(expected), data.footer);
  }
});

test('失联与失败在无颜色列表和详情中都有告警标记', () => {
  for (const phase of ['running', 'failed']) {
    const state = fixture(); state.heartbeatAt = '2000-01-01T00:00:00Z'; state.tasks[0].phase = phase;
    const { press, render } = monitor(state);
    assert.match(render(), /!.*(?:状态未知|失败)/);
    assert.match(press('\r'), /!.*(?:状态未知|失败)/);
  }
});
