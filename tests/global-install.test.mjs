import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporary } from './helpers.mjs';
import { globalInstallPlan, checkGlobalInstall, installGlobal } from '../scripts/global-install.mjs';
import { install, preflight } from '../scripts/install.mjs';

async function fixture(t) {
  const root = temporary(t), source = join(root, 'source');
  await mkdir(join(source, '.agents/skills/co-pi/references'), { recursive: true });
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'co-pi', version: '0.1.2', description: '测试插件' }));
  await writeFile(join(source, 'dist/cli.js'), 'console.log("global-runtime-ok");');
  await writeFile(join(source, '.agents/skills/co-pi/SKILL.md'), '技能');
  await writeFile(join(source, '.agents/skills/co-pi/references/recovery.md'), '恢复流程');
  const plan = globalInstallPlan({ home: root, codexHome: '', source });
  return { root, source, plan };
}

test('默认使用用户 .codex/plugins 与 skills，支持 CODEX_HOME 和显式覆盖', () => {
  const home = join(process.cwd(), 'fake-home'), source = join(process.cwd(), 'source');
  const plan = globalInstallPlan({ home, source, codexHome: '' });
  assert.equal(plan.pluginDir, join(home, '.codex/plugins/co-pi'));
  assert.equal(plan.skillDir, join(home, '.codex/skills/co-pi'));
  const custom = globalInstallPlan({ home, source, codexHome: join(home, 'custom') });
  assert.equal(custom.pluginDir, join(home, 'custom/plugins/co-pi'));
  const override = globalInstallPlan({ home, source, pluginDir: join(home, 'plugin'), skillsDir: join(home, 'skills') });
  assert.equal(override.pluginDir, join(home, 'plugin'));
  assert.equal(override.skillDir, join(home, 'skills/co-pi'));
});

test('安装完整技能和独立运行文件，重复安装将原版本移出技能发现目录保存', async t => {
  const { root, source, plan } = await fixture(t);
  await checkGlobalInstall(plan);
  assert.deepEqual(await readdir(root), ['source']);
  const result = await installGlobal(plan, { agentDir: join(root, 'pi') });
  assert.deepEqual(result.backups, []);
  assert.equal(await readFile(join(plan.skillDir, 'references/recovery.md'), 'utf8'), '恢复流程');
  await writeFile(join(plan.skillDir, 'SKILL.md'), '用户修改');
  const again = await installGlobal(plan, { agentDir: join(root, 'pi') });
  assert.equal(again.backups.length, 2);
  assert.equal(await readFile(join(again.backups[1], 'SKILL.md'), 'utf8'), '用户修改');
  assert.equal(await readFile(join(plan.skillDir, 'SKILL.md'), 'utf8'), '技能');
  await rename(source, join(root, 'moved-source'));
  const mcp = JSON.parse(await readFile(join(plan.pluginDir, '.mcp.json'), 'utf8')).mcpServers['co-pi'];
  assert.equal(mcp.args[0], join(plan.pluginDir, 'dist/cli.js'));
  const run = spawnSync(mcp.command, mcp.args, { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /global-runtime-ok/);
});

test('已有非安装器管理的技能不被覆盖；拒绝重叠目录', async t => {
  const { plan } = await fixture(t);
  await mkdir(plan.skillDir, { recursive: true });
  await writeFile(join(plan.skillDir, 'SKILL.md'), '已有技能');
  await assert.rejects(checkGlobalInstall(plan), /global_install_conflict/);
  assert.equal(await readFile(join(plan.skillDir, 'SKILL.md'), 'utf8'), '已有技能');
  await assert.rejects(checkGlobalInstall({ ...plan, pluginDir: join(plan.source, 'nested') }), /global_install_overlap/);
});

test('真实 --check 展示全局目标且不写文件', async t => {
  const root = temporary(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/install.mjs', import.meta.url)),
    '--check', '--agent-dir', join(root, 'pi'), '--bin-dir', join(root, 'bin')], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: join(root, 'codex home') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(join(root, 'codex home/plugins/co-pi')), result.stdout);
  assert.ok(result.stdout.includes(join(root, 'codex home/skills/co-pi')), result.stdout);
  assert.deepEqual(await readdir(root), []);
});

test('安装流程将 monitor 和 MCP 绑定到全局副本，构建失败不发布', async t => {
  const { root, plan: global } = await fixture(t);
  const plan = await preflight({ platform: 'linux', global, agentDir: join(root, 'pi'), binDir: join(root, 'bin'), runProbe: () => '10.0.0' });
  await assert.rejects(install(plan, { build: () => { throw new Error('build_failed'); } }), /build_failed/);
  assert.deepEqual(await readdir(root), ['source']);
  await install(plan, { build: () => {} });
  const launcher = await readFile(join(root, 'bin/cpi-monitor'), 'utf8');
  assert.ok(launcher.includes(join(global.pluginDir, 'dist/monitor-cli.js').replaceAll('\\', '/')));
  const inPlace = { ...global, source: global.pluginDir };
  await installGlobal(inPlace, { agentDir: join(root, 'changed-pi') });
  const mcp = JSON.parse(await readFile(join(global.pluginDir, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['co-pi'].args.at(-1), join(root, 'changed-pi'));
});

test('链接指向源目录时拒绝重叠，依赖链接被复制为独立内容', async t => {
  const { root, source, plan } = await fixture(t);
  const alias = join(root, 'alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkGlobalInstall({ ...plan, pluginDir: join(alias, 'nested') }), /global_install_overlap/);
  await mkdir(join(source, 'node_modules'), { recursive: true });
  const dependency = join(root, 'dependency');
  await mkdir(dependency);
  await writeFile(join(dependency, 'index.js'), '依赖');
  await symlink(dependency, join(source, 'node_modules/example'), process.platform === 'win32' ? 'junction' : 'dir');
  await installGlobal(plan, { agentDir: join(root, 'pi') });
  await rename(dependency, join(root, 'moved-dependency'));
  assert.equal(await readFile(join(plan.pluginDir, 'node_modules/example/index.js'), 'utf8'), '依赖');
});
