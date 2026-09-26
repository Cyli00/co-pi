import { join } from "node:path";
import { homedir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { CpiError } from "./protocol.js";
import { validateShell } from "./platform.js";
import { readPiSettings } from "./pi-settings.js";

export const defaultAgentDir = () => join(homedir(), ".pi", "agent");
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export async function inheritedSettings(agentDir: string): Promise<SettingsManager> {
  const settings = await readPiSettings(agentDir) as Settings;
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (settings.defaultThinkingLevel !== undefined && !levels.includes(settings.defaultThinkingLevel)) {
    throw new CpiError("pi_thinking_invalid");
  }
  if (settings.modelThinkingLevels !== undefined && (typeof settings.modelThinkingLevels !== "object"
    || settings.modelThinkingLevels === null || Array.isArray(settings.modelThinkingLevels)
    || Object.values(settings.modelThinkingLevels).some(level => !levels.includes(level)))) {
    throw new CpiError("pi_thinking_invalid");
  }
  // 内存副本避免 SDK 保存状态时反向修改用户设置，也避免项目设置覆盖统一模型。
  await validateShell(settings);
  return SettingsManager.inMemory(settings);
}
