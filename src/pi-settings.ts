import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CpiError } from "./protocol.js";

// 预检只读设置，不初始化 SDK、扩展或认证。
export async function readPiSettings(agentDir: string): Promise<Record<string, unknown>> {
  let settings;
  try { settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")); }
  catch { throw new CpiError("pi_settings_unreadable"); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)
    || typeof settings.defaultProvider !== "string" || !settings.defaultProvider.trim()
    || typeof settings.defaultModel !== "string" || !settings.defaultModel.trim()) {
    throw new CpiError("pi_default_model_required");
  }
  return settings;
}
