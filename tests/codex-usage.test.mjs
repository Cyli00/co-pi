import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync, utimesSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CodexUsageReader, MonitorUsageReader, parseCodexUsage } from '../dist/codex-usage.js';
import { bindStateThread } from '../dist/state-thread.js';
import { temporary } from './helpers.mjs';

const event = (input = 100, cached = 75, timestamp = '2026-09-22T15:00:00Z') => JSON.stringify({
  timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: input, cached_input_tokens: cached },
    total_token_usage: { input_tokens: 999999, cached_input_tokens: 888888 },
  } },
}) + '\n';
function fixture(t) {
  const home = temporary(t);
  const workspace = join(home, 'project');
  const directory = join(home, 'sessions', '2026', '09', '22');
  mkdirSync(directory, { recursive: true });
  let selectedId;
  const make = ({ id = randomUUID(), cwd = workspace, source = 'cli', content = '', padding = '' } = {}) => {
    const path = join(directory, `rollout-2026-09-22T12-00-00-${id}.jsonl`);
    const header = JSON.stringify({ type: 'session_meta', payload: { id, cwd, source, padding } }) + '\n';
    writeFileSync(path, header + content);
    selectedId ??= id;
    return { id, path, header };
  };
  const reader = (options = {}) => new CodexUsageReader({ home, workspace, threadId: selectedId ?? '', ...options });
  return { home, workspace, directory, make, reader };
}

test('仅接受有效 last_token_usage；零输入与真正零命中不同', () => {
  assert.equal(parseCodexUsage(event()).cachedInputTokens, 75);
  assert.equal(parseCodexUsage(event(0, 0)).inputTokens, 0);
  assert.equal(parseCodexUsage(event(100, 0)).cachedInputTokens, 0);
  for (const line of ['{', 'null', event(-1, 0), event(1, 2), event(1.5, 0), event(1, '1'), event(Number.MAX_SAFE_INTEGER + 1, 0), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } })]) assert.equal(parseCodexUsage(line), undefined);
});

test('固定线程不受同项目更新会话、子线程或其他项目影响', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const old = f.make({ content: event(100, 10) });
  utimesSync(old.path, new Date(1), new Date(1));
  const main = f.make({ content: event(), padding: 'x'.repeat(30000) });
  f.make({ source: { subagent: { thread_spawn: {} } }, content: event(100, 99) });
  f.make({ cwd: join(f.home, 'other'), content: event(100, 98) });
  const reader = f.reader({ threadId: main.id });
  assert.deepEqual(await reader.read(), { state: 'ready', automatic: false, threadId: main.id, inputTokens: 100, cachedInputTokens: 75, updatedAt: '2026-09-22T15:00:00.000Z' });
  const later = f.make({ content: event(100, 95) });
  utimesSync(later.path, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  now += 20_000;
  assert.equal((await reader.read()).threadId, main.id);
});

test('显式线程优先于项目；不存在时不借用其他线程的用量', async t => {
  const f = fixture(t);
  const selected = f.make({ cwd: join(f.home, 'other'), content: event() });
  f.make({ content: event(100, 90) });
  assert.equal((await f.reader({ threadId: selected.id }).read()).threadId, selected.id);
  const absent = await f.reader({ threadId: randomUUID() }).read();
  assert.equal(absent.state, 'searching');
  assert.equal(absent.inputTokens, undefined);
  assert.throws(() => f.reader({ threadId: '../outside' }), /codex_thread_id_invalid/);
});

test('追加与半行写入只在记录完整后更新；未变化读取保持结果', async t => {
  const f = fixture(t);
  const log = f.make({ content: event() });
  const reader = f.reader();
  const initial = await reader.read();
  const next = event(200, 180, '2026-09-22T15:01:00Z');
  appendFileSync(log.path, next.slice(0, -5));
  assert.deepEqual(await reader.read(), initial);
  appendFileSync(log.path, next.slice(-5));
  const updated = await reader.read();
  assert.equal(updated.cachedInputTokens, 180);
  assert.equal(updated.inputTokens, 200);
  assert.deepEqual(await reader.read(), updated);
});

test('日志截断后丢弃旧用量；恢复写入后重新显示', async t => {
  const f = fixture(t);
  const log = f.make({ content: event() });
  const reader = f.reader();
  await reader.read();
  writeFileSync(log.path, log.header);
  const waiting = await reader.read();
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.inputTokens, undefined);
  appendFileSync(log.path, event(100, 0));
  assert.equal((await reader.read()).cachedInputTokens, 0);
});

test('大日志从末尾找最近用量，超长正文不会被保留或阻塞后续用量', async t => {
  const f = fixture(t);
  const huge = JSON.stringify({ type: 'response_item', payload: { text: 'PRIVATE_SENTINEL'.repeat(220000) } }) + '\n';
  const log = f.make({ content: event(100, 10) + huge + event(100, 80) });
  const reader = f.reader();
  assert.equal((await reader.read()).cachedInputTokens, 80);
  appendFileSync(log.path, huge + event(100, 90));
  const value = await reader.read();
  assert.equal(value.cachedInputTokens, 90);
  assert.ok(!JSON.stringify(value).includes('PRIVATE_SENTINEL'));
});

test('尾部没有用量时单次查询完成回查；新用量优先于历史', async t => {
  const f = fixture(t);
  const huge = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(4 * 1024 * 1024) } }) + '\n';
  const log = f.make({ content: event(100, 40) + huge });
  const reader = f.reader();
  const value = await reader.read();
  assert.equal(value.cachedInputTokens, 40);
  const other = f.reader();
  await other.read();
  appendFileSync(log.path, event(100, 99));
  assert.equal((await other.read()).cachedInputTokens, 99);
});

test('最新 token_count 无效或为零时不借用旧比例', async t => {
  for (const latest of [event(0, 0), event(100, 101), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n']) {
    const f = fixture(t);
    const log = f.make({ content: event(100, 99) });
    const reader = f.reader();
    assert.equal((await reader.read()).cachedInputTokens, 99);
    appendFileSync(log.path, latest);
    const value = await reader.read();
    assert.notEqual(value.cachedInputTokens, 99);
    if (latest === event(0, 0)) assert.equal(value.inputTokens, 0);
    else { assert.equal(value.state, 'unavailable'); assert.equal(value.inputTokens, undefined); }
    assert.deepEqual(await f.reader().read(), value, '初次查询与刷新使用相同最新记录语义');
    appendFileSync(log.path, event(100, 80));
    assert.equal((await reader.read()).cachedInputTokens, 80);
  }
});

test('最新完整记录损坏时不显示旧值；未提交尾行仍忽略', async t => {
  const f = fixture(t);
  const log = f.make({ content: event(100, 99) });
  const reader = f.reader();
  const initial = await reader.read();
  appendFileSync(log.path, 'invalid-private-record');
  assert.deepEqual(await reader.read(), initial);
  appendFileSync(log.path, '\n');
  const invalid = await reader.read();
  assert.equal(invalid.state, 'unavailable');
  assert.equal(invalid.inputTokens, undefined);
  assert.doesNotMatch(JSON.stringify(invalid), /invalid-private-record/);
  appendFileSync(log.path, event(100, 50));
  assert.equal((await reader.read()).cachedInputTokens, 50);
});

test('指定线程可查归档；同 ID 多份文件不猜测', async t => {
  const f = fixture(t);
  const log = f.make({ content: event() });
  const archive = join(f.home, 'archived_sessions');
  mkdirSync(archive);
  const archived = join(archive, `rollout-archived-${log.id}.jsonl`);
  renameSync(log.path, archived);
  assert.equal((await f.reader({ threadId: log.id }).read()).cachedInputTokens, 75);
  f.make({ id: log.id, content: event(100, 99) });
  const ambiguous = await f.reader({ threadId: log.id }).read();
  assert.equal(ambiguous.state, 'unavailable');
  assert.equal(ambiguous.inputTokens, undefined);
});

test('已选文件替换为其他线程后不能继续采用其用量', async t => {
  const f = fixture(t);
  const log = f.make({ content: event() });
  const reader = f.reader({ threadId: log.id });
  await reader.read();
  writeFileSync(log.path, log.header.replace(log.id, randomUUID()) + event(100, 98));
  const value = await reader.read();
  assert.equal(value.state, 'unavailable');
  assert.equal(value.inputTokens, undefined);
});

test('monitor 首次立即查询，此后 10 秒一次，任务刷新不触发重复读取', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const log = f.make({ content: event(100, 50) });
  const read = t.mock.method(CodexUsageReader.prototype, 'read');
  const reader = new MonitorUsageReader({ home: f.home, workspace: f.workspace, threadId: log.id });
  assert.equal((await reader.read([])).cachedInputTokens, 50);
  appendFileSync(log.path, event(100, 90));
  for (let i = 0; i < 19; i++) {
    now += 500;
    assert.equal((await reader.read([])).cachedInputTokens, 50);
  }
  assert.equal(read.mock.callCount(), 1);
  now += 500;
  assert.equal((await reader.read([])).cachedInputTokens, 90);
  assert.equal(read.mock.callCount(), 2);
});

test('记录不存在、元数据损坏、无用量均正常降级；并发读取合并', async t => {
  const f = fixture(t);
  assert.equal((await f.reader({ home: join(f.home, 'missing') }).read()).state, 'searching');
  const log = f.make();
  const reader = f.reader();
  const first = reader.read();
  assert.equal(first, reader.read());
  assert.equal((await first).state, 'waiting');
  writeFileSync(log.path, '{broken}\n');
  assert.equal((await f.reader().read()).state, 'unavailable');
});

test('--once 使用指定 Codex 数据目录，打印主线程用量而不输出日志正文', t => {
  const f = fixture(t);
  const log = f.make({ content: event() });
  const result = spawnSync(process.execPath, ['dist/monitor-cli.js', '--once', '--no-color', '--state-dir', join(f.home, 'state'), '--codex-home', f.home, '--codex-thread', log.id], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /75\.0%/);
  assert.match(result.stdout, /75 \/ 100 tokens/);
  assert.doesNotMatch(result.stdout, /\x1b|last_token_usage|total_token_usage/);
});

test('monitor 使用状态目录绑定，启动目录与任务工作区不改变线程', async t => {
  const f = fixture(t);
  const homeThread = f.make({ cwd: process.cwd(), content: event(100, 92) });
  const taskThread = f.make({ content: event(100, 98) });
  const stateDir = join(f.home, 'state');
  bindStateThread(stateDir, taskThread.id);
  const reader = new MonitorUsageReader({ home: f.home, stateDir });
  const usage = await reader.read([{ workspace: f.workspace }]);
  assert.equal(usage.threadId, taskThread.id);
  assert.notEqual(usage.threadId, homeThread.id);
  assert.equal(usage.cachedInputTokens, 98);
  assert.equal(usage.automatic, false);
});

test('monitor 缺少绑定和显式 ID 时不按项目猜测；之后可等待固定绑定', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.make({ cwd: process.cwd(), content: event(100, 92) });
  const taskThread = f.make({ content: event(100, 98) });
  const stateDir = join(f.home, 'state');
  const reader = new MonitorUsageReader({ home: f.home, stateDir, threadId: '' });
  const missing = await reader.read([{ workspace: f.workspace }]);
  assert.equal(missing.threadId, undefined);
  assert.equal(missing.inputTokens, undefined);
  bindStateThread(stateDir, taskThread.id);
  now += 10_000;
  assert.equal((await reader.read([])).cachedInputTokens, 98);
  assert.equal((await reader.read([])).threadId, taskThread.id, '状态快照暂时消失时不切回启动目录');
});

test('显式线程须与状态目录一致；workspace 不再选择线程', async t => {
  const f = fixture(t);
  const chosen = f.make({ cwd: process.cwd(), content: event(100, 92) });
  f.make({ content: event(100, 98) });
  const byWorkspace = await new MonitorUsageReader({ home: f.home, workspace: process.cwd(), threadId: '' }).read([{ workspace: f.workspace }]);
  assert.equal(byWorkspace.threadId, undefined);
  const byThread = await new MonitorUsageReader({ home: f.home, threadId: chosen.id }).read([{ workspace: f.workspace }]);
  assert.equal(byThread.threadId, chosen.id);
  assert.equal(byThread.automatic, false);
  const stateDir = join(f.home, 'state');
  bindStateThread(stateDir, chosen.id);
  assert.throws(() => new MonitorUsageReader({ home: f.home, stateDir, threadId: randomUUID() }), /state_thread_conflict/);
});

test('--once 目录绑定优先于环境，--thread-id 冲突时拒绝而不显示另一线程', t => {
  const f = fixture(t);
  const old = f.make({ cwd: f.home, content: event(100, 92) });
  const current = f.make({ content: event(100, 98) });
  const stateDir = join(f.home, 'state');
  const sessionId = randomUUID();
  mkdirSync(join(stateDir, sessionId), { recursive: true });
  bindStateThread(stateDir, current.id);
  const at = new Date().toISOString();
  writeFileSync(join(stateDir, sessionId, 'batch.json'), JSON.stringify({
    version: 1, sessionId, batchId: 'batch', pid: 1, closed: false, heartbeatAt: at, workspace: f.workspace,
    tasks: [{ task: { id: 'one', title: '测试任务', instruction: '', acceptance: '', mode: 'read-only' }, phase: 'running', updatedAt: at, summary: '', events: [], omittedEvents: 0 }],
  }));
  const cli = join(process.cwd(), 'dist', 'monitor-cli.js');
  for (const flag of [undefined, '--thread-id', '--codex-thread']) {
    const args = [cli, '--once', '--state-dir', stateDir, '--codex-home', f.home];
    if (flag) args.push(flag, current.id);
    const result = spawnSync(process.execPath, args, { cwd: f.home, encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: old.id } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(current.id));
    assert.match(result.stdout, /98\.0%/);
    assert.doesNotMatch(result.stdout, /92\.0%/);
  }
  const conflict = spawnSync(process.execPath, [cli, '--once', '--state-dir', stateDir, '--codex-home', f.home, '--thread-id', old.id], { encoding: 'utf8' });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /state_thread_conflict/);
});

test('刷新后仍固定目录线程，不受其他项目或更活跃线程影响', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const selected = f.make({ content: event(100, 98) });
  const otherWorkspace = join(f.home, 'other');
  f.make({ cwd: otherWorkspace, content: event(100, 20) });
  const stateDir = join(f.home, 'state');
  bindStateThread(stateDir, selected.id);
  const reader = new MonitorUsageReader({ home: f.home, stateDir });
  await reader.read([{ workspace: f.workspace }, { workspace: otherWorkspace }]);
  f.make({ content: event(100, 5) });
  now += 10_000;
  const usage = await reader.read([{ workspace: otherWorkspace }, { workspace: f.workspace }]);
  assert.equal(usage.threadId, selected.id);
  assert.equal(usage.cachedInputTokens, 98);
  writeFileSync(join(stateDir, 'codex-thread.json'), JSON.stringify({ version: 1, threadId: randomUUID() }));
  now += 10_000;
  const replaced = await reader.read([]);
  assert.equal(replaced.state, 'unavailable');
  assert.equal(replaced.threadId, selected.id);
  assert.equal(replaced.inputTokens, undefined);
});
