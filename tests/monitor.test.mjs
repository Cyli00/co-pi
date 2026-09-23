import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth, TuiAltScreen, stripTerminalSequences } from '@earendil-works/pi-tui';
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
  router.handleInput('4'); assert.ok(router.render(100).join('\n').includes('暂无此类事件'));
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

test('思考事件只保留阶段，工具开始与正文生成均结束思考状态', () => {
  const events = [];
  const session = { getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, toolCalls: 0 }), getContextUsage: () => undefined };
  const telemetry = new Telemetry(session, event => events.push(event));
  const message = { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_SENTINEL' }] };
  telemetry.event({ type: 'message_start', message });
  telemetry.event({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_SENTINEL' } });
  telemetry.flush();
  assert.ok(events.some(event => event.kind === 'thinking' && event.final === false));
  telemetry.event({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'test.txt' } });
  telemetry.flush();
  assert.ok(events.some(event => event.kind === 'thinking' && event.final === true));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SENTINEL'));
});

test('主 agent 缓存条固定在快捷键上方，随用量变化且不混用 worker 指标', () => {
  const router = new MonitorRouter(() => 24, () => {}, () => {}, { color: false });
  router.update([snapshot()]);
  const usage = { state: 'ready', automatic: false, threadId: '12345678-abcd-1234-abcd-123456789abc', inputTokens: 1000, cachedInputTokens: 800, updatedAt: new Date().toISOString() };
  router.updateCodexUsage(usage);
  for (const detail of [false, true]) {
    if (detail) router.handleInput('\r');
    const lines = router.render(120);
    assert.match(lines.at(-3), /主 agent cache-hit.*80\.0%/);
    assert.match(lines.at(-2), /800 \/ 1,000 tokens.*12345678.*更新/);
    assert.match(lines.at(-1), /帮助/);
  }
  router.updateCodexUsage({ ...usage, cachedInputTokens: 0 });
  assert.match(router.render(120).at(-3), /0\.0%/);
  router.updateCodexUsage({ ...usage, inputTokens: 0, cachedInputTokens: 0 });
  assert.match(router.render(120).at(-3), /—.*本次输入为 0/);
  router.updateCodexUsage({ ...usage, state: 'unavailable' });
  assert.match(router.render(120).at(-3), /—.*记录暂不可读/);
  for (const width of [1, 12, 40, 80]) assert.ok(router.render(width).every(line => visibleWidth(line) <= width));
});
