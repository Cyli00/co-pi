import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inheritedSettings } from '../dist/settings.js';
import { readSnapshots } from '../dist/store.js';
import { temporary, task, handoff, platformSettings } from './helpers.mjs';
import { safetyInstructions, workerInstructions } from '../dist/instructions.js';
import { hasUv } from '../dist/platform.js';

test('真实 pi SDK 经 MCP stdio 继承配置、执行工具并交付 handoff（仅本地模拟模型）', { timeout: 60_000 }, async t => {
  let client, server;
  const root = temporary(t, async () => {
    await client?.close();
    if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  });
  const agentDir = join(root, 'agent');
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(agentDir);
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  const settings = {
    ...platformSettings,
    defaultProvider: 'cpi-local-test', defaultModel: 'test-model', defaultThinkingLevel: 'low',
    modelThinkingLevels: { 'cpi-local-test/test-model': 'high' },
    retry: { enabled: false }, packages: [], extensions: [], skills: [],
    enableInstallTelemetry: false, enableAnalytics: false,
  };
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings));
  writeFileSync(join(agentDir, 'auth.json'), '{}');
  writeFileSync(join(workspace, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'wrong', defaultModel: 'wrong', defaultThinkingLevel: 'off' }));
  const requests = [];
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const toolResults = request.messages.filter(m => m.role === 'tool');
    let calls;
    if (toolResults.length === 0) calls = [
      { name: 'report_progress', arguments: JSON.stringify({ phase: 'running', summary: '本地 SDK 正在写入测试文件' }) },
      { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: '本地 SDK 测试成功\n' }) },
    ];
    else if (!toolResults.some(m => m.tool_call_id === 'handoff-call')) calls = [
      { name: 'submit_handoff', arguments: JSON.stringify(handoff('SDK 已完成临时文件任务')) },
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (calls) {
      chunk({ role: 'assistant', tool_calls: calls.map((fn, index) => ({ index, id: fn.name === 'submit_handoff' ? 'handoff-call' : `call-${index}`, type: 'function', function: fn })) });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: '交接已提交。' });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'cpi-local-test': {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-placeholder',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    models: [{ id: 'test-model', reasoning: true, contextWindow: 32000, maxTokens: 4000 }],
  } } }));
  client = new Client({ name: 'sdk-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--agent-dir', agentDir, '--state-dir', stateDir, '--task-timeout-ms', '45000'],
    stderr: 'pipe',
  });
  // 错误正文不回显；失败时仅断言协议中的固定错误码。
  transport.stderr?.resume();
  await client.connect(transport);
  const response = await client.callTool({ name: 'delegate_batch', arguments: {
    requestId: 'sdk-batch', workspace, tasks: [task('sdk', 'Write result.txt in this temporary workspace and submit a handoff')],
  } }, undefined, { timeout: 55_000 });
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.tasks?.[0]?.error, undefined, `SDK 返回错误：${result.tasks?.[0]?.error ?? result.error}`);
  assert.equal(response.isError, false);
  assert.equal(result.tasks[0].handoff.summary, 'SDK 已完成临时文件任务');
  assert.equal(readFileSync(join(workspace, 'result.txt'), 'utf8'), '本地 SDK 测试成功\n');
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(r => r.model === 'test-model'));
  assert.equal(requests[0].reasoning_effort, 'high');
  const system = requests[0].messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => m.content).join('\n');
  assert.ok(system.includes(safetyInstructions));
  assert.ok(system.includes(workerInstructions(process.platform, await hasUv())));
  const initialUser = requests[0].messages.filter(m => m.role === 'user').map(m =>
    typeof m.content === 'string' ? m.content : m.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
  ).join('\n');
  assert.ok(initialUser.includes('Write result.txt') && !/\p{Script=Han}/u.test(initialUser));
  for (const tool of requests[0].tools.filter(t => ['report_progress', 'submit_handoff'].includes(t.function.name))) {
    assert.ok(!/\p{Script=Han}/u.test(tool.function.description));
  }
  assert.ok(requests[0].tools.some(t => t.function.name === 'write'));
  const [snapshot] = readSnapshots(stateDir);
  assert.equal(snapshot.tasks[0].model, 'cpi-local-test/test-model');
  assert.equal(snapshot.tasks[0].thinking, 'high');
  assert.ok(snapshot.tasks[0].events.some(e => e.kind === 'tool_end' && e.text.startsWith('write')));
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')), settings);
});

test('配置缺失拒绝启动，内存设置修改不回写原文件', async t => {
  const root = temporary(t);
  await assert.rejects(inheritedSettings(root), /pi_settings_unreadable/);
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ ...platformSettings, defaultProvider: 'local', defaultModel: 'configured', defaultThinkingLevel: 'high' }));
  const manager = await inheritedSettings(root);
  manager.setDefaultModel('memory-only');
  await manager.flush();
  assert.equal(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).defaultModel, 'configured');
});
