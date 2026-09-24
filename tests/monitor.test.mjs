import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth, TuiAltScreen, stripTerminalSequences, Markdown } from '@earendil-works/pi-tui';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MonitorRouter } from '../dist/monitor.js';
import { safeText, cleanHandoff } from '../dist/protocol.js';
import { readSnapshots } from '../dist/store.js';
import { handoff, task, temporary } from './helpers.mjs';
import { MonitorStyle, renderFeed } from '../dist/monitor-view.js';
import { Telemetry } from '../dist/telemetry.js';

function snapshot() {
  return { version: 1, sessionId: 'session', batchId: 'batch', pid: 1, closed: false, heartbeatAt: new Date().toISOString(), workspace: '测试目录', tasks: [{ task: task('one'), phase: 'running', updatedAt: new Date().toISOString(), summary: '正在测试', events: Array.from({ length: 30 }, (_, i) => ({ at: '2026-09-21T10:00:00Z', kind: 'tool', text: `事件 ${i} 中文内容` })), omittedEvents: 0 }] };
}
test('pi-tui 路由选择、滚动、跟随、窄屏和只读退出', () => {
  let quit = false;
  const router = new MonitorRouter(() => 14, () => {}, () => { quit = true; });
  const state = snapshot();
  router.update([state]);
  assert.ok(router.render(70).join('\n').includes('Task one'));
  router.handleInput('\r');
  assert.equal(router.route.page, 'task');
  assert.ok(router.render(70).join('\n').includes('事件 29'));
  router.handleInput('\x1b[5~');
  assert.ok(!router.render(70).join('\n').includes('事件 29'));
  router.handleInput('\x1b[F');
  assert.ok(router.render(70).join('\n').includes('事件 29'));
  for (const width of [1, 12, 40, 80]) assert.ok(router.render(width).every(line => visibleWidth(line) <= width));
  router.handleInput('\x1b');
  assert.equal(router.route.page, 'tasks');
  router.handleInput('q');
  assert.equal(quit, true);
  assert.equal(state.tasks[0].phase, 'running');
});
test('失联状态明确显示未知，终态不受旧心跳影响', () => {
  const router = new MonitorRouter(() => 20, () => {}, () => {});
  const state = snapshot();
  state.heartbeatAt = '2000-01-01T00:00:00Z';
  router.update([state]);
  assert.ok(router.render(100).join('\n').includes('状态未知'));
  state.tasks[0].phase = 'completed';
  assert.ok(router.render(100).join('\n').includes('已完成'));
});

test('监控显示重试、压缩、用量、未知上下文和消息队列', () => {
  const router = new MonitorRouter(() => 20, () => {}, () => {});
  const state = snapshot();
  const item = state.tasks[0];
  item.events = [];
  item.runtime = { settled: false, compacting: false, queue: { steering: 1, followUp: 2 }, retry: { scope: 'model', attempt: 1, maxAttempts: 3, until: new Date(Date.now() + 5000).toISOString() } };
  item.metrics = { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, total: 130, cost: 0.001, toolCalls: 2, contextTokens: null, contextWindow: 32000, contextPercent: null };
  item.messages = [{ id: 'message-1', mode: 'followUp', status: 'queued', at: new Date().toISOString() }];
  router.update([state]); router.handleInput('\r');
  const output = router.render(180).join('\n');
  for (const text of ['模型重试 1/3', 'Tokens 130', '估算 $0.00100', '上下文 未知/32000', 'followUp 2', 'message-1', 'queued']) assert.ok(output.includes(text), text);
  item.runtime.retry = undefined; item.runtime.compacting = true; item.runtime.compactionReason = 'threshold';
  assert.ok(router.render(100).join('\n').includes('压缩中·threshold'));
});
test('终端控制序列与常见令牌脱敏，非法完成交接拒绝', () => {
  assert.equal(safeText('\x1b]52;c;ZXhhbXBsZQ==\x07你好\x1b[31m'), '你好');
  assert.ok(!safeText('api_key=local-secret-value').includes('local-secret-value'));
  assert.throws(() => cleanHandoff({ ...handoff(), unresolved: ['未执行验证'] }));
});

test('审批拒绝显示未获批准，不误标为工具或任务失败', () => {
  const state = snapshot().tasks[0];
  state.events = [
    { at: '2026-09-22T10:00:00Z', id: 'tool-denied', kind: 'tool_start', text: 'bash {}' },
    { at: '2026-09-22T10:00:01Z', id: 'output-denied', kind: 'tool_denied', text: 'bash\ncontinue, try another safer way.' },
  ];
  const output = renderFeed(state, 100, 'tools', false, new MonitorStyle(false)).join('\n');
  assert.match(output, /未获批准/);
  assert.doesNotMatch(output, /失败|执行中/);
});

test('单个损坏状态文件不影响其他任务', t => {
  const root = temporary(t);
  const sessionId = randomUUID();
  const directory = join(root, sessionId);
  mkdirSync(directory);
  const state = { ...snapshot(), sessionId };
  writeFileSync(join(directory, 'good.json'), JSON.stringify(state));
  writeFileSync(join(directory, 'bad.json'), JSON.stringify({ ...state, tasks: [{}] }));
  writeFileSync(join(directory, 'broken.json'), '{');
  assert.equal(readSnapshots(root).length, 1);
});

test('真实 pi-tui 渲染器可启动、分发按键、重绘与恢复终端', async () => {
  const terminal = {
    columns: 90, rows: 20, kittyProtocolActive: false, output: '', stopped: false,
    start(onInput, onResize) { this.input = onInput; this.resize = onResize; },
    stop() { this.stopped = true; },
    async drainInput() {}, write(text) { this.output += text; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = new TuiAltScreen(terminal);
  const router = new MonitorRouter(() => terminal.rows, () => tui.requestRender(), () => tui.stop());
  tui.addChild(router);
  tui.setFocus(router);
  router.update([snapshot()]);
  try {
    tui.start();
    await delay(40);
    assert.ok(terminal.output.includes('CO-PI MONITOR'));
    terminal.input('\r');
    await delay(40);
    assert.equal(router.route.page, 'task');
    terminal.columns = 40;
    terminal.resize();
    await delay(40);
  } finally { tui.stop(); }
  assert.equal(terminal.stopped, true);
  assert.ok(terminal.output.includes('\x1b[?1049h'));
  assert.ok(terminal.output.includes('\x1b[?1049l'));
});

test('分类时间线合并工具调用、展开结果、Markdown 文本与结构化交接', () => {
  const state = snapshot().tasks[0];
  const at = '2026-09-21T10:00:00Z';
  state.events = [
    { at, id: 'thinking-assistant-1', kind: 'thinking', text: '思考阶段结束', final: true },
    { at, id: 'tool-read-1', kind: 'tool_start', text: 'read {"path":"src/worker.ts"}' },
    { at, id: 'output-read-1', kind: 'tool_end', text: 'read\n' + Array.from({ length: 8 }, (_, i) => `结果第 ${i} 行`).join('\n') },
    { at, id: 'tool-handoff', kind: 'tool_start', text: 'submit_handoff {"summary":"原始协议噪声"}' },
    { at, kind: 'assistant', text: '## 检查结果\n\n**公开结论**与 `代码`', final: true },
  ];
  state.handoff = handoff('任务已完成');
  const style = new MonitorStyle(false);
  const tools = renderFeed(state, 90, 'tools', false, style).join('\n');
  assert.equal(tools.match(/工具 · read/g).length, 1);
  assert.ok(tools.includes('path: src/worker.ts') && tools.includes('完成'));
  assert.ok(tools.includes('另有 5 行结果') && !tools.includes('结果第 7 行'));
  assert.ok(!tools.includes('公开结论') && !tools.includes('思考阶段') && !tools.includes('原始协议噪声'));
  assert.ok(renderFeed(state, 90, 'tools', true, style).join('\n').includes('结果第 7 行'));
  const output = renderFeed(state, 90, 'text', false, style).join('\n');
  assert.ok(output.includes('公开结论') && !output.includes('**公开结论**') && !output.includes('src/worker.ts'));
  const final = renderFeed(state, 90, 'handoff', false, style).join('\n');
  for (const value of ['最终交接', '任务已完成', '验证', '通过', 'result.txt:1']) assert.ok(final.includes(value), value);
  assert.ok(!final.includes('"verification"'));
});

test('macOS 字母键导航、分类和帮助；跟随后向下不会跳回开头', () => {
  const router = new MonitorRouter(() => 14, () => {}, () => {}, { color: false });
  router.update([snapshot()]); router.handleInput('\r');
  const tail = router.render(100).filter(line => line.includes('事件 '));
  for (const key of ['j', 'd', '\x1b[6~']) {
    router.handleInput('f'); router.render(100); router.handleInput(key);
    assert.deepEqual(router.render(100).filter(line => line.includes('事件 ')), tail);
  }
  router.handleInput('u'); assert.ok(!router.render(100).join('\n').includes('事件 29'));
  router.handleInput('g'); assert.ok(router.render(100).join('\n').includes('事件 0 '));
  router.handleInput('G'); assert.ok(router.render(100).join('\n').includes('事件 29'));
  router.handleInput('[C'); router.handleInput('[C'); router.handleInput('[C'); assert.ok(router.render(100).join('\n').includes('暂无此类事件'));
  router.handleInput('\t'); assert.ok(router.render(100).join('\n').includes('交接尚未生成'));
  router.handleInput('?'); assert.ok(router.render(100).join('\n').includes('macOS'));
  router.handleInput('?'); router.handleInput('b'); assert.equal(router.route.page, 'tasks');
});

test('窄屏、低高度与元数据换行保持逐行边界；颜色可关闭', () => {
  for (const rows of [1, 5, 8, 14, 24]) for (const width of [1, 12, 40, 100]) {
    const state = snapshot();
    state.tasks[0].task.title = '标题\n不应另起一行\x1b]52;c;unsafe\x07';
    const router = new MonitorRouter(() => rows, () => {}, () => {}, { color: false });
    router.update([state]);
    for (const detail of [false, true]) {
      if (detail) router.handleInput('\r');
      const rendered = router.render(width);
      assert.ok(rendered.length <= rows);
      assert.ok(rendered.every(line => !line.includes('\n') && !line.includes('\x1b') && visibleWidth(line) <= width));
    }
  }
  const state = snapshot();
  const router = new MonitorRouter(() => 20, () => {}, () => {});
  router.update([state]);
  assert.ok(router.render(90).join('\n').includes('\x1b['));
  assert.ok(stripTerminalSequences(router.render(90).join('\n')).includes('CO-PI MONITOR'));
});

test('SDK 思考累计文本脱敏后采集，工具开始结束思考，签名与屏蔽内容不采集', () => {
  const events = [];
  const session = { getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, toolCalls: 0 }), getContextUsage: () => undefined };
  const telemetry = new Telemetry(session, event => events.push(event));
  const message = { role: 'assistant', content: [{ type: 'thinking', thinking: 'SDK_VISIBLE api_key=local-secret-value', thinkingSignature: 'SIGNATURE_SENTINEL' }, { type: 'thinking', thinking: 'REDACTED_SENTINEL', redacted: true }] };
  telemetry.event({ type: 'message_start', message });
  telemetry.event({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_SENTINEL' } });
  telemetry.flush();
  assert.ok(events.some(event => event.kind === 'thinking_text' && event.final === false));
  telemetry.event({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'test.txt' } });
  telemetry.flush();
  assert.ok(events.some(event => event.kind === 'thinking_text' && event.final === true));
  assert.ok(JSON.stringify(events).includes('SDK_VISIBLE'));
  for (const hidden of ['local-secret-value', 'SIGNATURE_SENTINEL', 'REDACTED_SENTINEL']) assert.ok(!JSON.stringify(events).includes(hidden));
});

test('主 agent 缓存条固定在快捷键上方，随用量变化且不混用 worker 指标', () => {
  const router = new MonitorRouter(() => 24, () => {}, () => {}, { color: false });
  router.update([snapshot()]);
  const usage = { state: 'ready', automatic: false, threadId: '12345678-abcd-1234-abcd-123456789abc', inputTokens: 1000, cachedInputTokens: 800, updatedAt: new Date().toISOString() };
  router.updateCodexUsage(usage);
  for (const detail of [false, true]) {
    if (detail) router.handleInput('\r');
    const lines = router.render(120);
    assert.match(lines.at(-4), /主 agent cache-hit.*80\.0%.*800 \/ 1,000 tokens/);
    assert.match(lines.at(-3), /监控线程 12345678-abcd-1234-abcd-123456789abc · 指定线程/);
    assert.match(lines.at(-2), /用量更新 .*UTC[+-]\d\d:\d\d.*前/);
    assert.match(lines.at(-1), /帮助/);
  }
  router.updateCodexUsage({ ...usage, cachedInputTokens: 0 });
  assert.match(router.render(120).at(-4), /0\.0%/);
  router.updateCodexUsage({ ...usage, inputTokens: 0, cachedInputTokens: 0 });
  assert.match(router.render(120).at(-4), /—.*本次输入为 0/);
  router.updateCodexUsage({ ...usage, state: 'unavailable' });
  assert.match(router.render(120).at(-4), /—.*记录暂不可读/);
  for (const width of [1, 12, 40, 80]) assert.ok(router.render(width).every(line => visibleWidth(line) <= width));
});

test('缓存来源在窄屏和低高度仍可辨认，重绘只增长记录年龄', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-23T10:35:00Z') });
  const updatedAt = '2026-09-23T10:33:53Z';
  const date = new Date(updatedAt);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
  for (const rows of [8, 24]) {
    const router = new MonitorRouter(() => rows, () => {}, () => {}, { color: false });
    router.update([snapshot()]);
    router.updateCodexUsage({ state: 'ready', automatic: true, threadId: '12345678-abcd-1234-abcd-123456789abc', inputTokens: 1000, cachedInputTokens: 990, updatedAt });
    for (const detail of [false, true]) {
      if (detail) router.handleInput('\r');
      for (const width of [40, 80, 120]) {
        const lines = router.render(width);
        assert.match(lines.at(-3), /监控线程 12345678.*自动匹配/);
        assert.ok(lines.at(-2).includes(time), lines.at(-2));
        assert.match(lines.at(-2), /前/);
        assert.ok(lines.every(line => visibleWidth(line) <= width));
      }
    }
    t.mock.timers.tick(60_000);
    assert.ok(router.render(80).at(-2).includes(time));
    assert.match(router.render(80).at(-2), rows === 8 ? /2m 前/ : /3m 前/);
  }
});

test('无记录、时间缺失与读取失败不伪造更新时间，并保留线程来源', () => {
  const router = new MonitorRouter(() => 12, () => {}, () => {}, { color: false });
  assert.match(router.render(80).at(-3), /监控线程 未找到/);
  assert.match(router.render(80).at(-2), /尚无用量记录/);
  const usage = { state: 'ready', automatic: false, threadId: '12345678-abcd-1234-abcd-123456789abc', inputTokens: 1000, cachedInputTokens: 990 };
  for (const updatedAt of [undefined, 'invalid']) {
    router.updateCodexUsage({ ...usage, updatedAt });
    assert.match(router.render(80).at(-2), /记录时间未知/);
  }
  router.updateCodexUsage({ ...usage, state: 'unavailable', updatedAt: '2026-09-23T10:33:53Z' });
  assert.match(router.render(80).at(-4), /记录暂不可读/);
  assert.match(router.render(80).at(-3), /监控线程 12345678/);
  assert.match(router.render(80).at(-2), /2026-09-23/);
});

test('左右键循环切换分类，左键不返回列表，数字键不再切换', () => {
  const router = new MonitorRouter(() => 24, () => {}, () => {}, { color: false });
  router.update([snapshot()]); router.render(100); router.handleInput('\r');
  router.handleInput('\x1b[D');
  assert.equal(router.route.page, 'task');
  assert.match(router.render(100).join('\n'), /\[交接\]/);
  router.handleInput('\x1b[C');
  assert.match(router.render(100).join('\n'), /\[全部\]/);
  router.handleInput('4');
  assert.match(router.render(100).join('\n'), /\[全部\]/);
  router.handleInput('\x1b[C');
  assert.match(router.render(100).join('\n'), /\[阶段\]/);
  router.handleInput('b'); assert.equal(router.route.page, 'tasks');
});

test('小窗口优先保留事件正文及返回提示，长任务标题不遮住失败状态', () => {
  for (const rows of [5, 8, 9, 12]) {
    const router = new MonitorRouter(() => rows, () => {}, () => {}, { color: false });
    const state = snapshot(); state.tasks[0].phase = 'failed'; state.tasks[0].task.title = '很长的标题'.repeat(30);
    router.update([state]);
    assert.match(router.render(80).join('\n'), /失败/);
    router.handleInput('\r');
    const lines = router.render(80);
    assert.ok(lines.some(line => line.includes('事件 29')), `${rows} 行窗口应可读正文`);
    assert.match(lines.at(-1), /返回/);
    assert.ok(lines.length <= rows);
  }
});

test('浏览锚点在前部事件淘汰和上方内容增长后保持稳定', () => {
  const router = new MonitorRouter(() => 24, () => {}, () => {}, { color: false });
  const state = snapshot(); const item = state.tasks[0];
  item.omittedEvents = 1;
  item.events = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, at: '2026-09-21T10:00:00Z', kind: 'progress', text: `EVENT_${i}` }));
  router.update([state]); router.render(80); router.handleInput('\r'); router.render(80); router.handleInput('g');
  for (let i = 0; i < 10; i++) router.handleInput('j');
  const first = router.render(80).find(line => line.includes('EVENT_'));
  item.events.shift(); item.events.push({ id: 'e200', at: '2026-09-21T10:00:00Z', kind: 'progress', text: 'EVENT_200' }); item.omittedEvents++;
  router.update([structuredClone(state)]);
  assert.equal(router.render(80).find(line => line.includes('EVENT_')), first);
  item.events[0].text = '增长的上方内容'.repeat(100);
  router.update([structuredClone(state)]);
  assert.equal(router.render(80).find(line => line.includes('EVENT_')), first);
});

test('终态无交接给出终止原因，不再承诺稍后生成', () => {
  for (const phase of ['failed', 'cancelled', 'completed']) {
    const state = snapshot().tasks[0]; state.events = []; state.phase = phase;
    const output = renderFeed(state, 80, 'handoff', false, new MonitorStyle(false)).join('\n');
    assert.doesNotMatch(output, /任务结束后会/);
    assert.match(output, /未生成交接/);
  }
});

test('SDK 思考文本默认折叠，t 可展开收起，旧阶段记录仍可显示', () => {
  const router = new MonitorRouter(() => 24, () => {}, () => {}, { color: false });
  const state = snapshot();
  state.tasks[0].events = [{ id: 'thinking-a', at: '2026-09-21T10:00:00Z', kind: 'thinking_text', text: 'SDK_THINKING_TEXT', final: true }];
  router.update([state]); router.render(100); router.handleInput('\r');
  assert.doesNotMatch(router.render(100).join('\n'), /SDK_THINKING_TEXT/);
  router.handleInput('t'); assert.match(router.render(100).join('\n'), /SDK_THINKING_TEXT/);
  router.handleInput('t'); assert.doesNotMatch(router.render(100).join('\n'), /SDK_THINKING_TEXT/);
  state.tasks[0].events = [{ at: '2026-09-21T10:00:00Z', kind: 'thinking', text: '历史思考阶段', final: true }];
  router.update([state]); assert.match(router.render(100).join('\n'), /历史思考阶段/);
});

test('思考结束与非流式消息保留累计正文，并提示有界截断', () => {
  const events = [];
  const session = { getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, toolCalls: 0 }), getContextUsage: () => undefined };
  const telemetry = new Telemetry(session, event => events.push(event));
  let message = { role: 'assistant', content: [{ type: 'thinking', thinking: '第一段' }] };
  telemetry.event({ type: 'message_start', message });
  telemetry.event({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', delta: '第一段' } }); telemetry.flush();
  message = { role: 'assistant', content: [{ type: 'thinking', thinking: '第一段和第二段' }] };
  telemetry.event({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_end', content: '第一段和第二段' } });
  let final = events.filter(e => e.kind === 'thinking_text').at(-1);
  assert.equal(final.text, '第一段和第二段'); assert.equal(final.final, true);
  const firstId = final.id;
  const long = { role: 'assistant', content: [{ type: 'thinking', thinking: '长'.repeat(5000) }] };
  telemetry.event({ type: 'message_start', message: long });
  telemetry.event({ type: 'message_end', message: long });
  final = events.filter(e => e.kind === 'thinking_text').at(-1);
  assert.notEqual(final.id, firstId); assert.equal(final.final, true);
  assert.ok(final.text.length <= 4000); assert.match(final.text, /已截断/);
});

test('浏览思考与工具展开时不重置到顶部，帮助在小窗口可翻到底部', () => {
  const router = new MonitorRouter(() => 12, () => {}, () => {}, { color: false });
  router.update([snapshot()]); router.render(100); router.handleInput('\r'); router.render(100);
  router.handleInput('w'); const before = router.render(100).filter(line => line.includes('事件 '));
  router.handleInput('t'); assert.deepEqual(router.render(100).filter(line => line.includes('事件 ')), before);
  router.handleInput('t'); assert.deepEqual(router.render(100).filter(line => line.includes('事件 ')), before);
  router.handleInput('?'); router.handleInput('s');
  assert.match(router.render(100).join('\n'), /SDK/);
  assert.match(router.render(100).at(-1), /关闭帮助/);
});

test('不变时间线复用渲染结果，变化的内容和宽度仍及时更新', t => {
  const render = Markdown.prototype.render;
  let calls = 0;
  t.mock.method(Markdown.prototype, 'render', function (...args) { calls++; return render.apply(this, args); });
  const state = snapshot();
  state.tasks[0].events = [
    { id: 'a1', at: '2026-09-21T10:00:00Z', kind: 'assistant', text: '第一条内容' },
    { id: 'a2', at: '2026-09-21T10:00:01Z', kind: 'assistant', text: '第二条内容' },
  ];
  const router = new MonitorRouter(() => 24, () => {}, () => {}, { color: false });
  router.update([state]); router.render(80); router.handleInput('\r'); router.render(80);
  const initial = calls;
  router.update([structuredClone(state)]); router.render(80);
  assert.equal(calls, initial);
  state.tasks[0].events[1].text = '内容已经更新'; router.update([state]);
  assert.match(router.render(80).join('\n'), /内容已经更新/);
  assert.equal(calls, initial + 1);
  router.render(40); assert.ok(calls > initial + 1);
});

test('w/s 与 PgUp/PgDn 翻页一致，End 恢复跟随', () => {
  const make = () => {
    const router = new MonitorRouter(() => 14, () => {}, () => {}, { color: false });
    router.update([snapshot()]); router.render(160); router.handleInput('\r'); router.render(160);
    return router;
  };
  const letters = make(), pages = make();
  letters.handleInput('w'); pages.handleInput('\x1b[5~');
  assert.deepEqual(letters.render(160), pages.render(160));
  assert.doesNotMatch(letters.render(160).join('\n'), /事件 29/);
  letters.handleInput('s'); pages.handleInput('\x1b[6~');
  assert.deepEqual(letters.render(160), pages.render(160));
  letters.handleInput('\x1b[F');
  assert.match(letters.render(160).join('\n'), /● 跟随/);
  assert.match(letters.render(160).at(-1), /←\/→ 分类.*↑\/↓ 滚动.*w\/s\/PgUp\/PgDn 翻页.*fn\+↓\/End 跟随.*t 展开\/折叠.*Esc 返回.*\? 帮助/);
});

test('t 同时展开和折叠工具与思考，切换分类共享同一展开状态', () => {
  const state = snapshot(); const at = '2026-09-21T10:00:00Z';
  state.tasks[0].events = [
    { at, id: 'thinking-a', kind: 'thinking_text', text: 'THINKING_BODY', final: true },
    { at, id: 'tool-a', kind: 'tool_start', text: 'read {}' },
    { at, id: 'output-a', kind: 'tool_end', text: 'read\n' + Array.from({ length: 8 }, (_, i) => `TOOL_LINE_${i}`).join('\n') },
  ];
  const router = new MonitorRouter(() => 50, () => {}, () => {}, { color: false });
  router.update([state]); router.render(160); router.handleInput('\r');
  assert.doesNotMatch(router.render(160).join('\n'), /THINKING_BODY|TOOL_LINE_7/);
  router.handleInput('t');
  for (const text of ['THINKING_BODY', 'TOOL_LINE_7']) assert.ok(router.render(160).join('\n').includes(text));
  router.handleInput('\x1b[C'); router.handleInput('\x1b[C');
  assert.match(router.render(160).join('\n'), /TOOL_LINE_7/);
  router.handleInput('\x1b[D'); router.handleInput('\x1b[D');
  router.handleInput('t');
  assert.doesNotMatch(router.render(160).join('\n'), /THINKING_BODY|TOOL_LINE_7/);
  assert.doesNotMatch(router.render(160).join('\n'), /e 展开/);
  router.handleInput('e');
  assert.doesNotMatch(router.render(160).join('\n'), /THINKING_BODY|TOOL_LINE_7/);
});
