import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function configPath(explicit, env = process.env, home = homedir()) {
  return resolve(explicit ?? env.CPI_CONFIG_FILE ?? join(home, '.cpi', 'config.toml'));
}

export async function checkConfigTarget(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('cpi_config_not_regular_file');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function migrateConfig(plan) {
  // 构建完成后才加载 TOML 依赖，保持源码和运行包的引导安装可用。
  const { configFromPi, readConfig, serializeConfig } = await import('../dist/config.js');
  if (await checkConfigTarget(plan.configPath)) {
    await readConfig(plan.configPath);
    return { path: plan.configPath, created: false };
  }
  const output = serializeConfig(configFromPi(plan.settings));
  await mkdir(dirname(plan.configPath), { recursive: true });
  try { await writeFile(plan.configPath, output, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await checkConfigTarget(plan.configPath);
    await readConfig(plan.configPath);
    return { path: plan.configPath, created: false };
  }
  return { path: plan.configPath, created: true };
}
