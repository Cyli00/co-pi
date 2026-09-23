import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readSnapshots } from '../dist/store.js';
import { temporary, task, handoff, platformSettings } from './helpers.mjs';

for (const mode of ['accept', 'deny', 'unverified', 'invalid-content', 'unsupported', 'cancel', 'deny-linked-parent', 'deny-continuation']) {
  test(`真实 pi shell → IPC → MCP 审批 → 执行：${mode}`, { timeout: 45_000 }, async t => {
    let client, model;
    const root = temporary(t, async () => {
      await client?.close();
      if (model?.listening) await new Promise(resolve => { model.closeAllConnections(); model.close(resolve); });
    });
    const workspace = join(root, 'workspace'), agent = join(root, 'agent');
    mkdirSync(workspace); mkdirSync(agent);
    writeFileSync(join(workspace, 'safe.txt'), '安全替代方案的结果');
    const prefix = mode.startsWith('deny-') ? undefined : 'export CPI_TEST_PREFIX=reviewed';
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({
      ...platformSettings, defaultProvider: 'local', defaultModel: 'test', defaultThinkingLevel: 'off',
      packages: [], extensions: [], skills: [], retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false,
      shellCommandPrefix: prefix,
    }));
    writeFileSync(join(agent, 'auth.json'), '{}');
    const marker = join(root, 'outside-marker.txt');
    let command = 'printf "%s" "$CPI_TEST_PREFIX" >> ../outside-marker.txt';
    if (mode === 'deny-linked-parent') {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      command = 'printf marker > linked/../outside-marker.txt';
    } else if (mode === 'deny-continuation') {
      command = 'printf marker > .' + String.fromCharCode(92, 10) + './outside-marker.txt';
    }
    let modelCalls = 0;
    const toolOutputs = [];
    model = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      toolOutputs.push(...body.messages.filter(m => m.role === 'tool'));
      const step = modelCalls++;
      const shellCount = mode === 'accept' ? 2 : 1;
      const result = mode === 'accept' ? handoff('两次获批的 shell 已执行') : handoff('审批拒绝后使用安全替代方案完成');
      const handoffStep = mode === 'accept' ? shellCount : shellCount + 1;
      const call = step < shellCount ? { name: 'bash', arguments: JSON.stringify({ command }) }
        : step < handoffStep ? { name: 'read', arguments: JSON.stringify({ path: 'safe.txt' }) }
        : step === handoffStep ? { name: 'submit_handoff', arguments: JSON.stringify(result) } : undefined;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test',
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      chunk(call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: call }] }
        : { role: 'assistant', content: '完成' });
      chunk({}, call ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
    });
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { local: {
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'local-placeholder',
      models: [{ id: 'test', contextWindow: 32000, maxTokens: 2000 }],
    } } }));
    client = new Client({ name: 'shell-approval-test', version: '1' }, {
      capabilities: mode === 'unsupported' ? {} : { elicitation: { form: {} } },
    });
    const approvals = [];
    let pendingApproval;
    const reached = new Promise(resolve => { pendingApproval = resolve; });
    if (mode !== 'unsupported') client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      approvals.push({ ...request, id: extra.requestId });
      assert.equal(existsSync(marker), approvals.length > 1);
      const meta = request.params._meta;
      assert.equal(meta.codex_strict_auto_review, true);
      assert.equal(meta.codex_sensitive_action, true);
      assert.equal(meta.codex_request_type, 'approval_request');
      assert.equal(meta.codex_approval_kind, 'mcp_tool_call');
      assert.equal(meta.callId, 'host-call-123');
      assert.equal(meta.tool_params.command, prefix ? `${prefix}\n${command}` : command);
      assert.equal(meta.tool_params.cwd, workspace);
      assert.deepEqual(meta.tool_params.shellArgs, ['-c']);
      if (mode === 'cancel') {
        pendingApproval();
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (mode.startsWith('deny')) return { action: 'decline', _meta: { approvals_reviewer: 'auto_review', message: 'LOCAL_DENIED' } };
      return { action: 'accept', content: mode === 'invalid-content' ? { unrelated: true } : {},
        ...(mode === 'unverified' ? {} : { _meta: { approvals_reviewer: 'auto_review' } }) };
    });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--agent-dir', agent, '--state-dir', join(root, 'state'), '--task-timeout-ms', '30000'],
      stderr: 'pipe',
    });
    transport.stderr?.resume();
    await client.connect(transport);
    const controller = new AbortController();
    const running = client.callTool({ name: 'delegate_batch', arguments: { requestId: 'shell', workspace, tasks: [task('one')] },
      _meta: { callId: 'host-call-123' },
    }, undefined, { signal: controller.signal, timeout: 35000 });
    if (mode === 'cancel') {
      const rejected = assert.rejects(running);
      await reached; controller.abort(); await rejected;
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(existsSync(marker), false);
      return;
    }
    const response = await running;
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.tasks[0].error, undefined);
    assert.equal(response.isError, false);
    assert.equal(result.tasks[0].status, 'completed');
    assert.equal(existsSync(marker), mode === 'accept');
    assert.equal(approvals.length, mode === 'unsupported' ? 0 : mode === 'accept' ? 2 : 1);
    if (mode === 'accept') {
      assert.equal(readFileSync(marker, 'utf8'), 'reviewedreviewed');
      assert.notEqual(approvals[0].id, approvals[1].id);
    } else {
      assert.match(JSON.stringify(toolOutputs), /not executed/);
      assert.match(JSON.stringify(toolOutputs), /continue, try another safer way\./);
      assert.match(JSON.stringify(toolOutputs), /安全替代方案的结果/);
      const snapshot = readSnapshots(join(root, 'state'))[0];
      assert.ok(snapshot.tasks[0].events.some(e => e.kind === 'tool_denied'));
      assert.ok(!snapshot.tasks[0].events.some(e => e.kind === 'tool_error'));
    }
  });
}
