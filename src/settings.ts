import { join } from "node:path";
import { homedir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { validateShell } from "./platform.js";
import { modelSettings, readConfig, resolveModelConfig, type CpiConfig } from "./config.js";
import { readPiSettings } from "./pi-settings.js";

export const defaultAgentDir = () => join(homedir(), ".pi", "agent");
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export async function inheritedSettings(agentDir: string, config?: CpiConfig): Promise<SettingsManager> {
  const selected = await resolveModelConfig(config ?? await readConfig(), agentDir);
  const base = await readPiSettings(agentDir, false) as Settings;
  // 用整段替换隔离 pi 的默认值与模型专属覆盖；资源加载仍沿用 pi 设置。
  const settings = { ...base, ...modelSettings(selected) };
  await validateShell(settings);
  return SettingsManager.inMemory(settings);
}
