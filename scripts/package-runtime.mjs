#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { copyRuntimeAssets } from './runtime-assets.mjs';
import { WINDOWS_SHELL } from './install.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeFiles = ['dist', 'scripts', '.agents/skills/co-pi', 'README.md', 'npm-shrinkwrap.json'];

export function runtimeManifest(source) {
  return {
    name: source.name, version: source.version, private: true, type: 'module',
    description: source.description, engines: source.engines, bin: source.bin,
    cpiDistribution: 'runtime', files: runtimeFiles,
    scripts: { start: 'node dist/cli.js', monitor: 'node dist/monitor-cli.js' },
    dependencies: source.dependencies,
  };
}

export function runtimeLock(source, manifest) {
  // 保留所有运行依赖及平台可选项的锁定信息，不带只用于构建的依赖。
  const lock = structuredClone(source);
  lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([, value]) => !value.dev));
  lock.packages[''] = { name: manifest.name, version: manifest.version,
    dependencies: manifest.dependencies, bin: manifest.bin, engines: manifest.engines };
  return lock;
}

export async function stageRuntime(directory) {
  if ((await readdir(directory)).length) throw new Error('runtime_staging_not_empty');
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = runtimeManifest(source);
  const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '-p', join(root, 'tsconfig.json'), '--outDir', join(directory, 'dist'), '--declaration', 'false', '--sourceMap', 'false'],
  { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('runtime_build_failed');
  await copyRuntimeAssets(join(directory, 'dist'));
  await mkdir(join(directory, 'scripts'), { recursive: true });
  for (const file of ['install.mjs', 'install.sh', 'monitor-command.mjs', 'install-windows.sh', 'install-windows.ps1', 'install-linux.sh', 'install-macos.sh']) {
    await cp(join(root, 'scripts', file), join(directory, 'scripts', file));
  }
  await cp(join(root, '.agents/skills/co-pi'), join(directory, '.agents/skills/co-pi'), { recursive: true });
  await cp(join(root, 'README.md'), join(directory, 'README.md'));
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const lock = runtimeLock(JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')), manifest);
  // npm pack 不包含 package-lock；shrinkwrap 可随包分发并供 npm ci 使用。
  await writeFile(join(directory, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
}

export async function packageRuntime(outDir) {
  await mkdir(outDir, { recursive: true });
  const base = process.platform === 'win32' ? join(homedir(), 'AppData/Local/Temp') : tmpdir();
  const directory = await mkdtemp(join(base, 'cpi-runtime-'));
  await stageRuntime(directory);
  const command = process.platform === 'win32' ? WINDOWS_SHELL : 'npm';
  const args = process.platform === 'win32'
    ? ['--noprofile', '--norc', '-c', 'npm pack --ignore-scripts --json --pack-destination "$1"', 'cpi-pack', outDir]
    : ['pack', '--ignore-scripts', '--json', '--pack-destination', outDir];
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('runtime_pack_failed');
  const [packed] = JSON.parse(result.stdout);
  return { archive: join(outDir, packed.filename), staging: directory,
    size: packed.size, unpackedSize: packed.unpackedSize, files: packed.entryCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'out-dir': { type: 'string' } } });
  const output = resolve(values['out-dir'] ?? join(homedir(), 'appdata/local/temp/cpi-releases'));
  console.log(JSON.stringify(await packageRuntime(output), null, 2));
}
