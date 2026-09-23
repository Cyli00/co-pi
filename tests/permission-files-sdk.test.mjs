import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { temporary, task, handoff, platformSettings } from './helpers.mjs';

for (const [name, outside, approve] of [
  ['write', false, false], ['edit', false, false], ['bash', false, false],
  ['write', true, true], ['write', true, false], ['edit', true, true], ['edit', true, false],
  ['read', true, true], ['read', true, false],
]) test(`真实 SDK 权限：${name} ${outside ? '外部' : '内部'} ${approve ? '批准' : '拒绝/无需审批'}`, { timeout: 45000 }, async t => {
  let client, model;
  const root = temporary(t, async () => {
    await client?.close();
    if (model?.listening) await new Promise(resolve => { model.closeAllConnections(); model.close(resolve); });
  });
  const workspace = join(root, 'workspace'), agent = join(root, 'agent');
  mkdirSync(workspace); mkdirSync(agent);
  writeFileSync(join(workspace, 'safe.txt'), '安全替代内容');
  const target = join(outside ? root : workspace, 'target.txt');
  writeFileSync(target, 'before');
  const path = outside ? '../target.txt' : 'target.txt';
  const input = name === 'write' ? { path, content: 'after' } : name === 'edit' ? { path, oldText: 'before', newText: 'after' }
    : name === 'bash' ? { command: 'printf after > target.txt' } : { path };
  // 无需注册完整权限扩展，内置权限入口随 worker 启动。
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ ...platformSettings,
    defaultProvider: 'local', defaultModel: 'test', defaultThinkingLevel: 'off',
    packages: [], extensions: [], skills: [], retry: { enabled: false },
    enableAnalytics: false, enableInstallTelemetry: false,
  }));
  writeFileSync(join(agent, 'auth.json'), '{}');
  const requests = [];
  model = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    const step = requests.length;
    const denied = outside && !approve;
    const handoffStep = denied ? 3 : 2;
    const call = step === 1 ? { name, arguments: JSON.stringify(input) }
      : denied && step === 2 ? { name: 'read', arguments: JSON.stringify({ path: 'safe.txt' }) }
      : step === handoffStep ? { name: 'submit_handoff', arguments: JSON.stringify(handoff()) } : undefined;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk(call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: call }] } : { role: 'assistant', content: '完成' });
    chunk({}, call ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { local: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'local-placeholder',
    models: [{ id: 'test', contextWindow: 32000, maxTokens: 2000 }],
  } } }));
  client = new Client({ name: 'permission-files-test', version: '1' }, { capabilities: outside ? { elicitation: { form: {} } } : {} });
  const approvals = [];
  if (outside) client.setRequestHandler(ElicitRequestSchema, async request => {
    const meta = request.params._meta;
    approvals.push(meta);
    assert.equal(readFileSync(target, 'utf8'), 'before');
    assert.equal(meta.tool_name, name);
    assert.equal(meta.tool_params.input.path, target);
    if (name === 'write') assert.equal(meta.tool_params.input.content, 'after');
    if (name === 'edit') assert.deepEqual(meta.tool_params.input.edits, [{ oldText: 'before', newText: 'after' }]);
    return { action: approve ? 'accept' : 'decline', content: {}, _meta: { approvals_reviewer: 'auto_review' } };
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--agent-dir', agent, '--state-dir', join(root, 'state')], stderr: 'pipe' });
  transport.stderr?.resume();
  await client.connect(transport);
  const response = await client.callTool({ name: 'delegate_batch', arguments: { requestId: 'files', workspace,
    tasks: [{ ...task('one'), mode: name === 'read' ? 'read-only' : 'coding' }] } }, undefined, { timeout: 35000 });
  assert.equal(JSON.parse(response.content[0].text).tasks[0].error, undefined);
  assert.equal(response.isError, false);
  assert.equal(JSON.parse(response.content[0].text).tasks[0].status, 'completed');
  assert.equal(approvals.length, outside ? 1 : 0);
  const output = JSON.stringify(requests.at(-1).messages.filter(m => m.role === 'tool' && m.tool_call_id === 'call-1'));
  assert.equal(readFileSync(target, 'utf8'), name !== 'read' && (!outside || approve) ? 'after' : 'before', output);
  if (outside && !approve) {
    assert.match(output, /not executed/);
    assert.match(output, /continue, try another safer way\./);
    assert.match(JSON.stringify(requests.at(-1).messages), /安全替代内容/);
  }
  else if (name === 'read') assert.match(output, /before/);
});
