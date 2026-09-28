import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, resolveConfigPath, validateConfig, serializeConfig, resolveModelConfig } from '../dist/config.js';
import { inheritedSettings } from '../dist/settings.js';
import { Supervisor } from '../dist/supervisor.js';
import { terminalCandidates } from '../dist/monitor-open.js';
import { migrateConfig, configPath } from '../scripts/config-install.mjs';
import { temporary, task, platformSettings, waitFor } from './helpers.mjs';

test('TOML 支持注释与普通语法，错误不回显原文；路径优先级一致', async t => {
  const root = temporary(t), path = join(root, 'custom config.toml');
  const env = { CPI_CONFIG_FILE: path };
  assert.equal(resolveConfigPath(undefined, env, root), path);
  assert.equal(configPath(undefined, env, root), path);
  assert.equal(resolveConfigPath(path, { CPI_CONFIG_FILE: 'ignored' }, root), path);
  assert.equal(resolveConfigPath(undefined, {}, root), join(root, '.cpi/config.toml'));
  await writeFile(path, `# 保留注释\n[model]\nprovider = 'local'\nid = "test"\nthinking = 'max'\n[runtime]\nparallelism = 2\n[monitor]\nterminal = 'ghostty'\n`);
  const config = await readConfig(path);
  assert.equal(config.model.thinking, 'max');
  assert.equal(config.model.enabled, true);
  assert.equal(config.runtime.parallelism, 2);
  assert.equal(config.monitor.terminal, 'ghostty');
  assert.equal(config.retry.max_retries, 3);
  for (const value of ['password = "DO_NOT_PRINT"', '[runtime]\nparallelism = 0', '[runtime]\nparallelism = 5',
    '[model]\nthinking = "invalid"', '[retry]\nmax_retries = -1', '[compaction]\nreserve_tokens = 1.5',
    '[monitor]\nterminal = "shell command"', '[retry]\nenabled = "false"', '[model]\nenabled = "off"', 'model = "DO_NOT_PRINT', 'version = 2']) {
    await writeFile(path, value);
    await assert.rejects(readConfig(path), error => error.message === 'cpi_config_invalid');
  }
  await assert.rejects(readConfig(join(root, 'missing')), /cpi_config_missing/);
  assert.equal((await readConfig(join(root, 'missing'), true)).monitor.terminal, 'auto');
});

test('关闭模型覆盖时沿用 pi 默认值、模型专属思考强度；批次快照不随 pi 修改而变化', async t => {
  const root = temporary(t), path = join(root, 'settings.json');
  const original = JSON.stringify({ ...platformSettings, defaultProvider: 'pi-provider', defaultModel: 'pi-model',
    defaultThinkingLevel: 'low', modelThinkingLevels: { 'pi-provider/pi-model': 'high' },
    retry: { enabled: false, maxRetries: 99 }, compaction: { enabled: false }, defaultTools: ['read'] });
  await writeFile(path, original);
  const config = validateConfig({ model: { enabled: false, provider: 'ignored', id: 'ignored', thinking: 'off' } });
  const snapshot = await resolveModelConfig(config, root);
  assert.equal(config.model.enabled, false);
  assert.equal(snapshot.model.provider, 'pi-provider');
  assert.equal(snapshot.model.id, 'pi-model');
  assert.equal(snapshot.model.thinking, 'high');
  const manager = await inheritedSettings(root, config);
  assert.equal(manager.getDefaultProvider(), 'pi-provider');
  assert.equal(manager.getDefaultModel(), 'pi-model');
  assert.equal(manager.getDefaultThinkingLevel(), 'high');
  assert.deepEqual(manager.getAllModelThinkingLevels(), {});
  assert.equal(manager.getRetrySettings().maxRetries, 3);
  assert.equal(manager.getCompactionSettings().enabled, true);
  assert.deepEqual(manager.getDefaultTools(), ['read']);
  manager.setDefaultModel('memory-only');
  await manager.flush();
  assert.equal(await readFile(path, 'utf8'), original);
  await writeFile(path, JSON.stringify({ ...platformSettings, defaultProvider: 'new-provider', defaultModel: 'new-model', defaultThinkingLevel: 'low' }));
  assert.equal((await inheritedSettings(root, snapshot)).getDefaultModel(), 'pi-model');
  assert.equal((await inheritedSettings(root, snapshot)).getDefaultThinkingLevel(), 'high');
  const next = await resolveModelConfig(config, root);
  assert.equal(next.model.id, 'new-model');
  assert.equal(next.model.thinking, 'low');
  assert.equal((await resolveModelConfig(validateConfig({ model: { enabled: false } }), root)).model.id, 'new-model');
  const configPath = join(root, 'config.toml');
  await writeFile(configPath, serializeConfig(config));
  assert.equal((await readConfig(configPath)).model.enabled, false);
});

test('继承模式拒绝缺失默认模型或无效思考强度；显式模型仍可独立使用', async t => {
  const root = temporary(t), path = join(root, 'settings.json');
  const config = validateConfig({ model: { enabled: false } });
  await assert.rejects(resolveModelConfig(config, root), /pi_settings_unreadable/);
  await writeFile(path, '{}');
  await assert.rejects(resolveModelConfig(config, root), /pi_default_model_required/);
  await writeFile(path, JSON.stringify({ defaultProvider: 'pi', defaultModel: 'model', defaultThinkingLevel: 'invalid' }));
  await assert.rejects(resolveModelConfig(config, root), /pi_thinking_invalid/);
  await writeFile(path, JSON.stringify({ defaultProvider: 'pi', defaultModel: 'model', defaultThinkingLevel: 'high', modelThinkingLevels: { 'pi/model': 'invalid' } }));
  await assert.rejects(resolveModelConfig(config, root), /pi_thinking_invalid/);
  await writeFile(path, JSON.stringify({ defaultProvider: 'pi', defaultModel: 'model' }));
  assert.equal((await resolveModelConfig(config, root)).model.thinking, 'medium');
  const explicit = validateConfig({ model: { provider: 'local', id: 'test', thinking: 'off' } });
  assert.equal(await resolveModelConfig(explicit, join(root, 'missing')), explicit);
});

test('安装只迁移白名单及当前模型有效值，升级逐字保留用户配置', async t => {
  const root = temporary(t), path = join(root, 'config.toml');
  const settings = {
    defaultProvider: 'local', defaultModel: 'test', defaultThinkingLevel: 'low',
    modelThinkingLevels: { 'local/test': 'high' },
    retry: { enabled: false, maxRetries: 2, baseDelayMs: 13, maxAgentDelayMs: 45,
      provider: { timeoutMs: 123, maxRetries: 0, maxRetryDelayMs: 456 } },
    compaction: { enabled: false, reserveTokens: 4000, keepRecentTokens: 2000,
      modelOverrides: { 'local/test': { reserveTokens: 8000 } } },
    apiKey: 'DO_NOT_COPY', custom: 'DO_NOT_COPY',
  };
  assert.equal((await migrateConfig({ configPath: path, settings })).created, true);
  const config = await readConfig(path);
  assert.equal(config.model.thinking, 'high');
  assert.equal(config.retry.enabled, false);
  assert.equal(config.retry.provider.max_retries, 0);
  assert.equal(config.compaction.reserve_tokens, 8000);
  assert.equal(config.compaction.keep_recent_tokens, 2000);
  await writeFile(join(root, 'settings.json'), JSON.stringify(platformSettings));
  const manager = await inheritedSettings(root, config);
  assert.equal(manager.getRetrySettings().baseDelayMs, 13);
  assert.equal(manager.getProviderRetrySettings().timeoutMs, 123);
  assert.equal(manager.getCompactionSettings().reserveTokens, 8000);
  assert.ok(!(await readFile(path, 'utf8')).includes('DO_NOT_COPY'));
  const edited = '# user comment\n' + serializeConfig({ ...config, model: { ...config.model, id: 'different' } });
  await writeFile(path, edited);
  assert.equal((await migrateConfig({ configPath: path, settings: {} })).created, false);
  assert.equal(await readFile(path, 'utf8'), edited);
  const races = await Promise.all([1, 2].map(() => migrateConfig({ configPath: join(root, 'race.toml'), settings })));
  assert.equal(races.filter(r => r.created).length, 1);
});

test('SDK 内存配置隔离 pi 的模型、思考、重试和压缩；保留非迁移设置', async t => {
  const root = temporary(t);
  const original = JSON.stringify({ ...platformSettings, defaultProvider: 'wrong', defaultModel: 'wrong',
    defaultThinkingLevel: 'off', modelThinkingLevels: { 'local/test': 'off' },
    retry: { enabled: false, maxRetries: 77, provider: { maxRetries: 66 } },
    compaction: { enabled: false, modelOverrides: { 'local/test': { reserveTokens: 999 } } },
    extensions: ['custom.ts'], defaultTools: ['read'] });
  await writeFile(join(root, 'settings.json'), original);
  const config = validateConfig({ model: { provider: 'local', id: 'test', thinking: 'high' } });
  const manager = await inheritedSettings(root, config);
  assert.equal(manager.getDefaultProvider(), 'local');
  assert.equal(manager.getDefaultModel(), 'test');
  assert.equal(manager.getDefaultThinkingLevel(), 'high');
  assert.deepEqual(manager.getAllModelThinkingLevels(), {});
  assert.equal(manager.getRetrySettings().enabled, true);
  assert.equal(manager.getRetrySettings().maxRetries, 3);
  assert.equal(manager.getProviderRetrySettings().maxRetries, undefined);
  assert.equal(manager.getCompactionSettings({ provider: 'local', id: 'test' }).reserveTokens, 16384);
  assert.deepEqual(manager.getDefaultTools(), ['read']);
  assert.deepEqual(manager.getGlobalSettings().extensions, ['custom.ts']);
  manager.setDefaultModel('memory-only');
  await manager.flush();
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), original);
});

test('配置并发数逐批加载，运行中编辑不改变当前批次，显式参数优先', async t => {
  let supervisor;
  const root = temporary(t, () => supervisor?.close()), path = join(root, 'config.toml');
  const save = parallelism => writeFile(path, serializeConfig(validateConfig({ runtime: { parallelism } })));
  await save(1);
  supervisor = new Supervisor({ stateDir: join(root, 'state'), agentDir: root, configPath: path,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  let max = 0;
  supervisor.on('progress', snapshot => {
    max = Math.max(max, snapshot.tasks.filter(task => ['starting', 'running'].includes(task.phase)).length);
  });
  const started = waitFor(supervisor, 'progress', snapshot => snapshot.tasks.some(t => t.phase === 'running'));
  const first = supervisor.delegate({ requestId: 'first', workspace: root, tasks: [task('one', 'slow'), task('two')] });
  await started;
  await save(2);
  await first;
  assert.equal(max, 1);
  max = 0;
  await supervisor.delegate({ requestId: 'second', workspace: root, tasks: [task('one'), task('two')] });
  assert.equal(max, 2);
  await supervisor.close();
  supervisor = new Supervisor({ stateDir: join(root, 'override'), agentDir: root, configPath: path, parallelism: 1,
    workerPath: fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url)) });
  max = 0;
  supervisor.on('progress', snapshot => { max = Math.max(max, snapshot.tasks.filter(t => ['starting', 'running'].includes(t.phase)).length); });
  await supervisor.delegate({ requestId: 'override', workspace: root, tasks: [task('one'), task('two')] });
  assert.equal(max, 1);
});

test('Ghostty 使用独立实例与分离参数，指定终端不静默换用其他终端', () => {
  const script = "/tmp/user's dir/$(literal)/monitor.command";
  assert.deepEqual(terminalCandidates('darwin', {}, script, 'ghostty'), [
    { command: '/usr/bin/open', args: ['-n', '-a', 'Ghostty', '--args', '-e', '/bin/sh', script] },
  ]);
  assert.deepEqual(terminalCandidates('linux', { DISPLAY: ':0' }, script, 'ghostty'), [
    { command: 'ghostty', args: ['-e', '/bin/sh', script] },
  ]);
  assert.equal(terminalCandidates('win32', {}, script, 'mintty').length, 1);
  assert.throws(() => terminalCandidates('win32', {}, script, 'ghostty'), /platform_mismatch/);
  assert.throws(() => terminalCandidates('darwin', {}, script, 'konsole'), /platform_mismatch/);
});
