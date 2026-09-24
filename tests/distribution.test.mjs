import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';
import { copyRuntimeAssets, verifyGrammar, grammar } from '../scripts/runtime-assets.mjs';
import { runtimeManifest, runtimeLock, stageRuntime } from '../scripts/package-runtime.mjs';
import { distributionMode, installationCommands, validateRuntimeDistribution } from '../scripts/install.mjs';

test('运行包使用生产依赖与可分发锁文件，不携带构建入口或开发依赖', async () => {
  const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const manifest = runtimeManifest(source);
  const production = runtimeLock(lock, manifest);
  assert.equal(manifest.name, 'co-pi');
  assert.equal(production.name, manifest.name);
  assert.equal(production.packages[''].name, manifest.name);
  assert.equal(manifest.bin['co-pi'], 'dist/cli.js');
  assert.equal(manifest.bin['pi-subagents'], manifest.bin['co-pi']);
  assert.equal(manifest.cpiDistribution, 'runtime');
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts.build, undefined);
  assert.equal(manifest.dependencies['tree-sitter-bash'], undefined);
  assert.equal(production.packages[''].devDependencies, undefined);
  assert.equal(production.packages['node_modules/tree-sitter-bash'], undefined);
  assert.equal(production.packages['node_modules/typescript'], undefined);
  assert.ok(production.packages['node_modules/web-tree-sitter']);
  assert.deepEqual(production.packages[''].dependencies, source.dependencies);
  assert.ok(manifest.files.includes('npm-shrinkwrap.json'));
  for (const path of ['src', 'tests', '.birdview']) assert.ok(!manifest.files.includes(path));
  // 派生运行锁文件不能改变源码安装的锁定记录。
  assert.ok(lock.packages['node_modules/tree-sitter-bash']);
});

test('三平台运行包只安装生产依赖，源码安装保留编译步骤', async t => {
  const root = temporary(t);
  await writeFile(join(root, 'package.json'), '{}');
  assert.equal(await distributionMode(root), 'source');
  await writeFile(join(root, 'package.json'), JSON.stringify({ cpiDistribution: 'runtime' }));
  assert.equal(await distributionMode(root), 'runtime');
  await writeFile(join(root, 'package.json'), JSON.stringify({ cpiDistribution: 'unknown' }));
  await assert.rejects(distributionMode(root), /distribution_invalid/);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const runtime = JSON.stringify(installationCommands(platform, 'runtime'));
    const source = JSON.stringify(installationCommands(platform, 'source'));
    assert.match(runtime, /--omit=dev/);
    assert.doesNotMatch(runtime, /build/);
    assert.match(source, /build/);
    assert.doesNotMatch(source, /--omit=dev/);
  }
});

test('WASM 固定版本及哈希，损坏或缺失的运行包在安装前失败', async t => {
  const root = temporary(t), dist = join(root, 'dist');
  await copyRuntimeAssets(dist);
  const vendor = join(dist, 'vendor/pi-permission-system');
  const bytes = await readFile(join(vendor, 'tree-sitter-bash.wasm'));
  verifyGrammar(bytes, grammar.version);
  assert.throws(() => verifyGrammar(bytes, '0.0.0'), /version_or_hash_mismatch/);
  assert.throws(() => verifyGrammar(Buffer.from('corrupt'), grammar.version), /version_or_hash_mismatch/);
  assert.match(await readFile(join(vendor, 'tree-sitter-bash.LICENSE'), 'utf8'), /Max Brunsfeld/);
  assert.ok((await readFile(join(vendor, 'LICENSE'))).length);
  await assert.rejects(validateRuntimeDistribution(root), /runtime_assets_invalid/);
  await mkdir(dist, { recursive: true });
  for (const name of ['cli.js', 'worker.js', 'monitor-cli.js']) await writeFile(join(dist, name), '// fixture');
  await writeFile(join(root, 'npm-shrinkwrap.json'), '{}');
  await validateRuntimeDistribution(root);
  await writeFile(join(vendor, 'tree-sitter-bash.wasm'), 'corrupt');
  await assert.rejects(validateRuntimeDistribution(root), /runtime_assets_invalid/);
});

test('实际运行包构建不带源码、调试文件或旧产物，包含技能和许可证', async t => {
  const root = temporary(t);
  await stageRuntime(root);
  await validateRuntimeDistribution(root);
  const files = await readdir(root, { recursive: true });
  assert.ok(files.includes('npm-shrinkwrap.json'));
  assert.ok(files.some(file => file.replaceAll('\\', '/') === 'scripts/global-install.mjs'));
  for (const required of ['scripts/install.sh', '.agents/skills/co-pi/references/technical-reference.md',
    '.agents/skills/co-pi/references/maintenance-guide.md']) {
    assert.ok(files.some(file => file.replaceAll('\\', '/') === required), required);
  }
  assert.ok(files.some(file => file.replaceAll('\\', '/') === '.agents/skills/co-pi/SKILL.md'));
  assert.ok(!files.some(file => file.replaceAll('\\', '/').startsWith('.agents/skills/pi-subagents')));
  assert.ok(!files.some(file => /\.(?:map|ts)$/.test(file)));
  for (const name of ['src', 'tests', '.birdview', 'node_modules']) assert.ok(!files.includes(name));
  // 重复构建必须使用新目录，防止残留文件进入发布包。
  await assert.rejects(stageRuntime(root), /runtime_staging_not_empty/);
});
