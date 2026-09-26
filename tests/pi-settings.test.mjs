import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Supervisor } from '../dist/supervisor.js';
import { createMcpServer } from '../dist/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readSnapshots } from '../dist/store.js';
import { MonitorStyle, renderFeed } from '../dist/monitor-view.js';
import { readPiSettings } from '../dist/pi-settings.js';
import { piSetupGuidance } from '../scripts/install.mjs';
import { temporary, task } from './helpers.mjs';

test('缺省模型在 MCP 派发时预检失败，无 worker 启动，交接和时间线提供保存指引', async t => {
  let supervisor, server, client;
  const root = temporary(t, async () => { await supervisor?.close(); await client?.close(); await server?.close(); });
  await writeFile(join(root, 'settings.json'), '{}');
  // 若加载 SDK 认证，此目录会触发错误；预检应在这之前结束。
  await mkdir(join(root, 'auth.json'));
  supervisor = new Supervisor({ agentDir: root, stateDir: join(root, 'state') });
  server = createMcpServer(supervisor);
  client = new Client({ name: 'settings-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const phases = [];
  supervisor.on('progress', s => phases.push(...s.tasks.map(t => t.phase)));
  const response = await client.callTool({ name: 'delegate_batch', arguments: { requestId: 'no-defaults', workspace: root, tasks: [task('one'), task('two')] } });
  assert.equal(response.isError, true);
  const output = JSON.parse(response.content[0].text);
  assert.ok(!phases.includes('starting') && !phases.includes('running'));
  for (const item of output.tasks) {
    assert.equal(item.error, 'pi_default_model_required');
    assert.equal(item.status, 'failed');
    assert.match(item.guidance, /\/model.*Ctrl\+S.*\/thinking.*Ctrl\+S/);
  }
  const [snapshot] = readSnapshots(join(root, 'state'));
  assert.equal(snapshot.closed, true);
  assert.match(renderFeed(snapshot.tasks[0], 100, 'stages', false, new MonitorStyle(false)).join('\n'), /Ctrl\+S/);
  const historical = { ...snapshot.tasks[0], events: [{ at: new Date().toISOString(), kind: 'runtime', text: 'pi_default_model_required' }] };
  assert.match(renderFeed(historical, 100, 'stages', false, new MonitorStyle(false)).join('\n'), /\/model/);
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), '{}');
});

test('模型预检拒绝缺失、非字符串和空白值，只读保留已有配置', async t => {
  const root = temporary(t);
  await assert.rejects(readPiSettings(root), /pi_settings_unreadable/);
  for (const settings of [{}, [], null, { defaultProvider: 'p', defaultModel: ' ' }, { defaultProvider: 1, defaultModel: 'm' }]) {
    await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
    await assert.rejects(readPiSettings(root), /pi_default_model_required|pi_settings_unreadable/);
  }
  const raw = '{"defaultProvider":"p","defaultModel":"m","defaultThinkingLevel":"high"}';
  await writeFile(join(root, 'settings.json'), raw);
  assert.equal((await readPiSettings(root)).defaultModel, 'm');
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), raw);
  assert.match(piSetupGuidance({}), /worker 暂不可用/);
  assert.match(piSetupGuidance(JSON.parse(raw)), /已检测到/);
  assert.match(piSetupGuidance({}), /\/model.*Ctrl\+S.*\/thinking.*Ctrl\+S/);
});
