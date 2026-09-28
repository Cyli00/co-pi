import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { CpiError } from "./protocol.js";
import { DEFAULT_PARALLELISM, MAX_PARALLELISM } from "./limits.js";
import { readPiSettings } from "./pi-settings.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const terminalSchema = z.enum(["auto", "terminal", "ghostty", "windows-terminal", "mintty", "gnome-terminal", "konsole", "xfce4-terminal", "x-terminal-emulator", "xterm"]);
export type MonitorTerminal = z.infer<typeof terminalSchema>;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  model: z.object({
    enabled: z.boolean().default(true),
    provider: z.string().trim().default(""),
    id: z.string().trim().default(""),
    thinking: thinking.default("medium"),
  }).strict().default({}),
  retry: z.object({
    enabled: z.boolean().default(true),
    max_retries: integer.default(3),
    base_delay_ms: integer.default(2000),
    max_agent_delay_ms: integer.optional(),
    provider: z.object({
      timeout_ms: integer.optional(),
      max_retries: integer.optional(),
      max_retry_delay_ms: integer.default(60_000),
    }).strict().default({}),
  }).strict().default({}),
  compaction: z.object({
    enabled: z.boolean().default(true),
    reserve_tokens: integer.default(16_384),
    keep_recent_tokens: integer.default(20_000),
  }).strict().default({}),
  runtime: z.object({ parallelism: z.number().int().min(1).max(MAX_PARALLELISM).default(DEFAULT_PARALLELISM) }).strict().default({}),
  monitor: z.object({ terminal: terminalSchema.default("auto") }).strict().default({}),
}).strict();
export type CpiConfig = z.infer<typeof configSchema>;

export function resolveConfigPath(explicit?: string, env = process.env, home = homedir()): string {
  return resolve(explicit ?? env.CPI_CONFIG_FILE ?? join(home, ".cpi", "config.toml"));
}

export function validateConfig(value: unknown): CpiConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new CpiError("cpi_config_invalid");
  return result.data;
}

export async function readConfig(path = resolveConfigPath(), allowMissing = false): Promise<CpiConfig> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (allowMissing) return validateConfig({});
      throw new CpiError("cpi_config_missing");
    }
    throw new CpiError("cpi_config_unreadable");
  }
  let value: unknown;
  try { value = parse(raw); } catch { throw new CpiError("cpi_config_invalid"); }
  return validateConfig(value);
}

export function requireModel(config: CpiConfig): void {
  if (!config.model.provider || !config.model.id) throw new CpiError("cpi_model_required");
}

export async function resolveModelConfig(config: CpiConfig, agentDir: string): Promise<CpiConfig> {
  if (config.model.enabled) {
    requireModel(config);
    return config;
  }
  const settings = await readPiSettings(agentDir);
  const provider = (settings.defaultProvider as string).trim();
  const id = (settings.defaultModel as string).trim();
  const levels = settings.modelThinkingLevels as Record<string, unknown> | undefined;
  const level = thinking.safeParse(levels?.[`${provider}/${id}`] ?? settings.defaultThinkingLevel ?? "medium");
  if (!level.success) throw new CpiError("pi_thinking_invalid");
  // 将 pi 默认值固定到批次快照，worker 不再解析开关或重读模型设置。
  return { ...config, model: { enabled: true, provider, id, thinking: level.data } };
}

export function configFromPi(settings: Record<string, any>): CpiConfig {
  const key = `${settings.defaultProvider}/${settings.defaultModel}`;
  const retry = settings.retry ?? {};
  const provider = retry.provider ?? {};
  const compaction = settings.compaction ?? {};
  const override = compaction.modelOverrides?.[key] ?? {};
  // 只迁移白名单字段，并展开当前模型的有效值；不复制认证或其他 pi 设置。
  return validateConfig({
    model: {
      provider: settings.defaultProvider ?? "", id: settings.defaultModel ?? "",
      thinking: settings.modelThinkingLevels?.[key] ?? settings.defaultThinkingLevel,
    },
    retry: {
      enabled: retry.enabled, max_retries: retry.maxRetries, base_delay_ms: retry.baseDelayMs,
      max_agent_delay_ms: retry.maxAgentDelayMs,
      provider: { timeout_ms: provider.timeoutMs, max_retries: provider.maxRetries, max_retry_delay_ms: provider.maxRetryDelayMs },
    },
    compaction: {
      enabled: compaction.enabled,
      reserve_tokens: override.reserveTokens ?? compaction.reserveTokens,
      keep_recent_tokens: override.keepRecentTokens ?? compaction.keepRecentTokens,
    },
  });
}

export function serializeConfig(config: CpiConfig): string {
  return "# co-pi 配置。首次安装从 pi 迁移，重装不覆盖。\n"
    + "# model.enabled = false 时沿用 pi 默认模型及思考强度；省略或 true 时使用此处的模型设置。\n"
    + "# 重试和压缩由此文件决定；认证及供应商定义仍由 pi 管理。\n"
    + "# 新批次读取最新配置；运行中的批次保持原设置。\n"
    + "# monitor.terminal：auto 或平台终端名。macOS 支持 terminal、ghostty。\n\n"
    + stringify(JSON.parse(JSON.stringify(validateConfig(config)))) + "\n";
}

export function modelSettings(config: CpiConfig) {
  return {
    defaultProvider: config.model.provider,
    defaultModel: config.model.id,
    defaultThinkingLevel: config.model.thinking,
    modelThinkingLevels: {},
    retry: {
      enabled: config.retry.enabled, maxRetries: config.retry.max_retries,
      baseDelayMs: config.retry.base_delay_ms, maxAgentDelayMs: config.retry.max_agent_delay_ms,
      provider: { timeoutMs: config.retry.provider.timeout_ms, maxRetries: config.retry.provider.max_retries,
        maxRetryDelayMs: config.retry.provider.max_retry_delay_ms },
    },
    compaction: { enabled: config.compaction.enabled, reserveTokens: config.compaction.reserve_tokens,
      keepRecentTokens: config.compaction.keep_recent_tokens },
  };
}
