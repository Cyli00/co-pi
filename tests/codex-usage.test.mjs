import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CodexUsageReader, parseCodexUsage } from '../dist/codex-usage.js';
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
  const make = ({ id = randomUUID(), cwd = workspace, source = 'cli', content = '', padding = '' } = {}) => {
    const path = join(directory, `rollout-2026-09-22T12-00-00-${id}.jsonl`);
    const header = JSON.stringify({ type: 'session_meta', payload: { id, cwd, source, padding } }) + '\n';
    writeFileSync(path, header + content);
    return { id, path, header };
  };
  const reader = (options = {}) => new CodexUsageReader({ home, workspace, threadId: '', ...options });
  return { home, workspace, directory, make, reader };
}

test('仅接受有效 last_token_usage；零输入与真正零命中不同', () => {
  assert.equal(parseCodexUsage(event()).cachedInputTokens, 75);
  assert.equal(parseCodexUsage(event(0, 0)).inputTokens, 0);
  assert.equal(parseCodexUsage(event(100, 0)).cachedInputTokens, 0);
  for (const line of ['{', 'null', event(-1, 0), event(1, 2), event(1.5, 0), event(1, '1'), event(Number.MAX_SAFE_INTEGER + 1, 0), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } })]) assert.equal(parseCodexUsage(line), undefined);
});

test('匹配项目最新主线程，排除子线程与其他项目，并固定所选身份', async t => {
  const f = fixture(t);
  const old = f.make({ content: event(100, 10) });
  utimesSync(old.path, new Date(1), new Date(1));
  const main = f.make({ content: event(), padding: 'x'.repeat(30000) });
  f.make({ source: { subagent: { thread_spawn: {} } }, content: event(100, 99) });
  f.make({ cwd: join(f.home, 'other'), content: event(100, 98) });
  const reader = f.reader();
  assert.deepEqual(await reader.read(), { state: 'ready', automatic: true, threadId: main.id, inputTokens: 100, cachedInputTokens: 75, updatedAt: '2026-09-22T15:00:00.000Z' });
  const later = f.make({ content: event(100, 95) });
  utimesSync(later.path, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
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
  appendFileSync(log.path, '{broken}\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n');
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
  let value;
  for (let i = 0; i < 5; i++) value = await reader.read();
  assert.equal(value.cachedInputTokens, 90);
  assert.ok(reader.pending.length <= 256 * 1024);
  assert.ok(!JSON.stringify(value).includes('PRIVATE_SENTINEL'));
});

test('尾部没有用量时按块回查历史；新用量优先于历史', async t => {
  const f = fixture(t);
  const huge = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(4 * 1024 * 1024) } }) + '\n';
  const log = f.make({ content: event(100, 40) + huge });
  const reader = f.reader();
  assert.equal((await reader.read()).state, 'waiting');
  let value;
  for (let i = 0; i < 5; i++) value = await reader.read();
  assert.equal(value.cachedInputTokens, 40);
  const other = f.reader();
  await other.read();
  appendFileSync(log.path, event(100, 99));
  assert.equal((await other.read()).cachedInputTokens, 99);
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
  assert.equal((await f.reader().read()).state, 'searching');
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
