import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Supervisor } from '../dist/supervisor.js';
import { inheritedSettings } from '../dist/settings.js';
import { temporary, task, handoff, waitFor, platformSettings } from './helpers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function stream(res, { text, calls, input = 100, output = 20 }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`);
  if (calls) chunk({ role: 'assistant', tool_calls: calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
  else chunk({ role: 'assistant', content: text ?? '交接完成' });
  chunk({}, calls ? 'tool_calls' : 'stop', { prompt_tokens: input, completion_tokens: output, total_tokens: input + output });
  res.end('data: [DONE]\n\n');
}
async function setup(t, handler, { extension = '', settings: overrides = {} } = {}) {
  let supervisor, server;
  const root = temporary(t, async () => {
    await supervisor?.close();
    if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  });
  const agentDir = join(root, 'agent'); mkdirSync(agentDir);
  const requests = [];
  server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part;
      const request = JSON.parse(body); requests.push(request);
      await handler(request, res, requests);
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const provider = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-placeholder',
    models: [{ id: 'test-model', name: '隔离模型', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 4000,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.1 }, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } }],
  };
  const settings = { ...platformSettings, defaultProvider: 'cpi-test', defaultModel: 'test-model', defaultThinkingLevel: 'max', packages: [], skills: [],
    enableInstallTelemetry: false, enableAnalytics: false, retry: { enabled: false }, compaction: { enabled: false }, ...overrides };
  if (extension) {
    const path = join(agentDir, 'custom.ts');
    writeFileSync(path, `export default function(pi) { pi.registerProvider('cpi-test', ${JSON.stringify(provider)}); ${extension} }`);
    settings.extensions = [path];
  } else writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'cpi-test': provider } }));
  writeFileSync(join(agentDir, 'auth.json'), '{}');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings));
  supervisor = new Supervisor({ agentDir, stateDir: join(root, 'state'), taskTimeoutMs: 30_000 });
  const snapshots = [];
  supervisor.on('progress', snapshot => snapshots.push(structuredClone(snapshot)));
  const approvals = [];
  // 此组用临时数据验证队列和流式输出；真实审批协议另有集成测试覆盖。
  return { root, agentDir, requests, snapshots, supervisor, approvals, run: (mode = 'coding', signal) => supervisor.delegate({ requestId: 'runtime', workspace: root, tasks: [{ ...task('one'), mode }] }, signal,
    async action => { approvals.push(action); return { approved: true }; }) };
}
const finalCalls = (summary = '已完成') => [{ id: `handoff-${summary}`, name: 'submit_handoff', args: handoff(summary) }];

test('交接缺少必填字段时退回具体错误，worker 补齐后重新提交', { timeout: 45_000 }, async t => {
  const invalid = handoff();
  delete invalid.verification;
  const env = await setup(t, (_req, res, requests) => {
    if (requests.length === 1) return stream(res, { calls: [{ id: 'invalid-handoff', name: 'submit_handoff', args: invalid }] });
    stream(res, requests.length === 2 ? { calls: finalCalls('补齐 verification 后完成') } : {});
  });
  const result = await env.run('read-only');
  assert.equal(result.tasks[0].status, 'completed');
  assert.equal(result.tasks[0].handoff.summary, '补齐 verification 后完成');
  const feedback = env.requests[1].messages.find(m => m.role === 'tool' && m.tool_call_id === 'invalid-handoff');
  assert.match(JSON.stringify(feedback.content), /handoff_validation_failed/);
  assert.match(JSON.stringify(feedback.content), /verification/);
  assert.match(JSON.stringify(feedback.content), /required/);
  assert.match(JSON.stringify(feedback.content), /submit_handoff/);
});

test('最新交接无效时旧交接失效，模型停止后仍要求重新生成', { timeout: 45_000 }, async t => {
  const invalid = handoff();
  delete invalid.evidence;
  const env = await setup(t, (_req, res, requests) => {
    if (requests.length === 1) return stream(res, { calls: finalCalls('旧交接不能交付') });
    if (requests.length === 2) return stream(res, { calls: [{ id: 'replacement-invalid', name: 'submit_handoff', args: invalid }] });
    if (requests.length === 4) return stream(res, { calls: finalCalls('重新生成后的交接') });
    stream(res, {});
  });
  const result = await env.run('read-only');
  assert.equal(result.tasks[0].status, 'completed');
  assert.equal(result.tasks[0].handoff.summary, '重新生成后的交接');
  assert.ok(env.requests[3].tools.every(t => t.function.name === 'submit_handoff'));
});

test('始终缺少必填结构时不会交付伪造 handoff，也不会无限追加总结轮次', { timeout: 45_000 }, async t => {
  const env = await setup(t, (_req, res, requests) => stream(res, requests.length % 2
    ? { calls: [{ id: `bad-${requests.length}`, name: 'submit_handoff', args: { status: 'completed', summary: '结构不完整' } }] }
    : {}));
  const result = await env.run('read-only');
  assert.equal(result.tasks[0].status, 'failed');
  assert.equal(result.tasks[0].error, 'handoff_missing');
  assert.equal(result.tasks[0].handoff, undefined);
  assert.equal(env.requests.length, 4);
});

test('同一模型回复内多次交接按顺序处理，最后一次无效就必须重交', { timeout: 45_000 }, async t => {
  const invalid = handoff();
  delete invalid.nextSteps;
  const env = await setup(t, (_req, res, requests) => {
    if (requests.length === 1) return stream(res, { calls: [...finalCalls('较早提交'),
      { id: 'latest-invalid', name: 'submit_handoff', args: invalid }] });
    if (requests.length === 3) return stream(res, { calls: finalCalls('顺序校验后重新提交') });
    stream(res, {});
  });
  const result = await env.run('read-only');
  assert.equal(result.tasks[0].status, 'completed');
  assert.equal(result.tasks[0].handoff.summary, '顺序校验后重新提交');
});

test('扩展供应商先注册、session_start 生效，继承 defaultTools 并保留通信工具', { timeout: 45_000 }, async t => {
  const env = await setup(t, (req, res) => stream(res, req.messages.some(m => m.role === 'tool') ? {} : { calls: finalCalls() }), {
    settings: { defaultTools: ['read'] },
    extension: `pi.on('session_start', async () => { await import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify('session-started.txt')}, 'started')); });
    pi.registerTool({ name: 'probe', label: 'probe', description: 'probe', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }) });`,
  });
  const result = await env.run();
  assert.equal(result.tasks[0].error, undefined);
  const names = env.requests[0].tools.map(t => t.function.name);
  assert.ok(names.includes('read') && names.includes('probe') && names.includes('submit_handoff') && names.includes('report_progress'));
  assert.ok(!names.includes('write') && !names.includes('bash'));
  assert.equal(readFileSync(join(env.root, 'session-started.txt'), 'utf8'), 'started');
  const state = env.snapshots.at(-1).tasks[0];
  assert.equal(state.runtime.settled, true);
  assert.ok(state.metrics.total > 0 && state.metrics.cost > 0);
  assert.equal(existsSync(join(env.agentDir, 'models-cache.json')), false);
});

test('只读任务限制扩展工具，扩展启动错误明确失败', { timeout: 45_000 }, async t => {
  for (const fails of [false, true]) await t.test(String(fails), async t => {
    const env = await setup(t, (req, res) => stream(res, req.messages.some(m => m.role === 'tool') ? {} : { calls: finalCalls() }), {
      extension: fails ? `pi.on('session_start', () => { throw new Error('sensitive-provider-body'); });` : `pi.registerTool({ name: 'mutating_probe', label: 'probe', description: 'probe', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) });`,
    });
    const result = await env.run('read-only');
    if (fails) { assert.equal(result.tasks[0].error, 'pi_extension_start_failed'); assert.equal(env.requests.length, 0); }
    else { assert.equal(result.tasks[0].status, 'completed'); assert.ok(!env.requests[0].tools.some(t => ['write', 'bash', 'mutating_probe'].includes(t.function.name))); }
    assert.ok(!JSON.stringify(env.snapshots).includes('sensitive-provider-body'));
  });
});

test('真实工具增量、steer/followUp 队列与回执，最终交接等待队列清空', { timeout: 45_000 }, async t => {
  const env = await setup(t, async (req, res, requests) => {
    if (requests.length === 1) return stream(res, { calls: [{ id: 'slow', name: 'slow_probe', args: {} }] });
    const lastUser = req.messages.findLastIndex(m => m.role === 'user');
    const after = req.messages.slice(lastUser + 1);
    const summary = JSON.stringify(req.messages[lastUser]).includes('follow-marker') ? 'follow-up 已完成' : 'steer 已完成';
    stream(res, after.some(m => m.role === 'tool' && m.tool_call_id.startsWith('handoff-')) ? {} : { calls: finalCalls(summary) });
  }, { extension: String.raw`pi.on('input', event => event.text.includes('consume-marker') ? { action: 'handled' } : { action: 'continue' });
    pi.registerTool({ name: 'slow_probe', label: 'probe', description: 'probe', parameters: { type: 'object', properties: {} },
    execute: async (_id, _params, _signal, update) => { update({ content: [{ type: 'text', text: '第一段公开输出' }], details: {} }); await new Promise(r => setTimeout(r, 900)); update({ content: [{ type: 'text', text: '第一段公开输出\n第二段公开输出' }], details: {} }); await new Promise(r => setTimeout(r, 400)); return { content: [{ type: 'text', text: '最终工具结果' }], details: {} }; } });` });
  const started = waitFor(env.supervisor, 'progress', s => s.tasks[0].events.some(e => e.kind === 'tool_update'));
  const running = env.run(); await started;
  const consumed = await env.supervisor.message('runtime', 'one', 'consume-marker', 'steer', 'consume-id');
  assert.equal(consumed.status, 'accepted');
  const first = await env.supervisor.message('runtime', 'one', 'follow-marker', 'followUp', 'follow-id');
  const second = await env.supervisor.message('runtime', 'one', 'steer-marker', 'steer', 'steer-id');
  assert.equal(first.status, 'queued'); assert.equal(second.status, 'queued');
  assert.equal((await env.supervisor.message('runtime', 'one', 'follow-marker', 'followUp', 'follow-id')).id, first.id);
  await assert.rejects(env.supervisor.message('runtime', 'one', 'changed', 'followUp', 'follow-id'), /message_id_conflict/);
  const result = await running;
  assert.equal(result.tasks[0].error, undefined);
  assert.equal(result.tasks[0].handoff.summary, 'follow-up 已完成');
  const final = env.snapshots.at(-1).tasks[0];
  assert.ok(final.messages.filter(m => m.id !== 'consume-id').every(m => m.status === 'delivered'));
  assert.equal(final.messages.find(m => m.id === 'consume-id').status, 'unknown');
  assert.ok(!JSON.stringify(env.requests).includes('consume-marker'));
  assert.deepEqual(final.runtime.queue, { steering: 0, followUp: 0 });
  const events = final.events.filter(e => e.id === 'output-slow');
  assert.equal(events.length, 1); assert.equal(events[0].text, 'slow_probe\n最终工具结果');
  assert.ok(env.snapshots.some(s => s.tasks[0].runtime?.queue.followUp === 1));
  const users = env.requests.at(-1).messages.filter(m => m.role === 'user').map(m => JSON.stringify(m));
  assert.ok(users.findIndex(m => m.includes('steer-marker')) < users.findIndex(m => m.includes('follow-marker')));
});

test('真实 SDK 自动重试与压缩可观察，agent_end 不会提前交付', { timeout: 45_000 }, async t => {
  let failures = 0, summaries = 0;
  const env = await setup(t, (req, res) => {
    if (failures++ === 0) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'temporary local failure' } })); return; }
    if (!req.tools?.length) { summaries++; return stream(res, { text: '压缩摘要：已完成临时任务。' }); }
    const hasResult = req.messages.some(m => m.role === 'tool');
    stream(res, hasResult ? { text: '交接完成', input: 31000 } : { calls: finalCalls(), input: 31000 });
  }, { settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 200, provider: { maxRetries: 0 } }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1 } } });
  const result = await env.run();
  assert.equal(result.tasks[0].error, undefined);
  assert.ok(env.snapshots.some(s => s.tasks[0].runtime?.retry?.scope === 'model'));
  assert.ok(env.snapshots.some(s => s.tasks[0].runtime?.compacting), JSON.stringify({ metrics: env.snapshots.at(-1).tasks[0].metrics, requests: env.requests.length, summaries }));
  assert.ok(summaries > 0);
  const final = env.snapshots.at(-1).tasks[0];
  assert.equal(final.runtime.settled, true); assert.equal(final.runtime.compacting, false);
  assert.equal(final.metrics.contextTokens, null);
});

test('配置接受 max，同时拒绝非法模型专属强度', async t => {
  const root = temporary(t);
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ ...platformSettings, defaultProvider: 'test', defaultModel: 'test', defaultThinkingLevel: 'max', modelThinkingLevels: { 'test/test': 'max' } }));
  assert.equal((await inheritedSettings(root)).getDefaultThinkingLevel(), 'max');
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'test', defaultModel: 'test', modelThinkingLevels: { 'test/test': 'invalid' } }));
  await assert.rejects(inheritedSettings(root), /pi_thinking_invalid/);
});

test('流式公开文本在完成前显示，私有思考不进入监控和 handoff', { timeout: 45_000 }, async t => {
  const env = await setup(t, async (req, res, requests) => {
    if (requests.length > 1) return stream(res, {});
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'stream', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', reasoning_content: 'PRIVATE_REASONING_SENTINEL', content: '公开文本第一段' });
    await sleep(400);
    chunk({ content: '，第二段。' });
    await sleep(200);
    chunk({ tool_calls: [{ index: 0, id: 'handoff-stream', type: 'function', function: { name: 'submit_handoff', arguments: JSON.stringify(handoff()) } }] });
    chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  const interim = waitFor(env.supervisor, 'progress', s => s.tasks[0].events.some(e => e.kind === 'assistant' && e.final === false && e.text === '公开文本第一段'));
  const running = env.run(); await interim;
  const result = await running;
  assert.equal(result.tasks[0].error, undefined);
  const events = env.snapshots.at(-1).tasks[0].events;
  assert.equal(events.filter(e => e.text.startsWith('公开文本第一段')).length, 1);
  assert.ok(events.some(e => e.final && e.text === '公开文本第一段，第二段。'));
  assert.ok(!JSON.stringify([env.snapshots, result]).includes('PRIVATE_REASONING_SENTINEL'));
});

test('取消真实 SDK 会清空已排队 followUp，不再发起后续模型请求', { timeout: 45_000 }, async t => {
  const env = await setup(t, (_req, res) => stream(res, { calls: [{ id: 'cancel-slow', name: 'wait_probe', args: {} }] }), {
    extension: `pi.on('input', async event => { if (event.text.includes('delayed-input')) await new Promise(resolve => setTimeout(resolve, 500)); return { action: 'continue' }; });
      pi.registerTool({ name: 'wait_probe', label: 'probe', description: 'probe', parameters: { type: 'object', properties: {} },
      execute: async (_id, _params, signal, update) => { update({ content: [{ type: 'text', text: '等待取消' }], details: {} }); await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); return { content: [], details: {} }; } });`,
  });
  const controller = new AbortController();
  const started = waitFor(env.supervisor, 'progress', s => s.tasks[0].events.some(e => e.kind === 'tool_update'));
  const running = env.run('coding', controller.signal); await started;
  const receipt = await env.supervisor.message('runtime', 'one', '取消后不能执行', 'followUp', 'cancel-id');
  assert.equal(receipt.status, 'queued');
  const received = waitFor(env.supervisor, 'progress', s => s.tasks[0].messages?.some(m => m.id === 'delayed-id' && m.status === 'received'));
  const delayed = env.supervisor.message('runtime', 'one', 'delayed-input', 'followUp', 'delayed-id');
  await received;
  controller.abort();
  assert.equal((await running).tasks[0].status, 'cancelled');
  assert.equal((await delayed).status, 'cancelled');
  assert.equal(env.requests.length, 1);
  assert.equal(env.snapshots.at(-1).tasks[0].messages[0].status, 'cancelled');
});
