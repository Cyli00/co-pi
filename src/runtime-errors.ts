const saveDefaults = "在 pi 中进入 /model，选择模型后按 Ctrl+S 保存默认模型；再进入 /thinking，选择强度后按 Ctrl+S 保存默认思考强度。仅切换当前会话不会保存默认值。";

export function runtimeErrorGuidance(code: string): string | undefined {
  switch (code) {
    case "cpi_config_missing": return "未找到 co-pi config.toml。请运行安装器迁移 pi 设置，或用 --config / CPI_CONFIG_FILE 指定配置文件。";
    case "cpi_config_unreadable": return "无法读取 co-pi config.toml，请检查配置路径和文件权限。";
    case "cpi_config_invalid": return "co-pi config.toml 无效。请检查 TOML 语法、字段拼写、取值类型及范围；不会回退到 pi 默认模型。";
    case "cpi_model_required": return "请在 co-pi config.toml 的 [model] 中填写 provider 和 id。认证及供应商定义仍由 pi 管理。";
    case "model_network_disabled": return "模型连接失败，当前进程声明 CODEX_SANDBOX_NETWORK_DISABLED=1。请通过已配置的 Codex MCP 连接运行，或为本次验证申请所需网络权限；插件不会自行关闭沙盒。";
    case "model_auth_required": return "模型认证不可用。请在与 MCP --agent-dir 相同的 pi 配置目录完成登录，并确认供应商要求的环境变量已传给 MCP；不要把凭据放入任务指令。";
    case "model_auth_rejected": return "模型服务拒绝认证或访问权限。请在 pi 中核对该供应商的登录状态和模型权限。";
    case "model_rate_limited": return "模型服务返回限流，请核对供应商配额并稍后重试。";
    case "model_unavailable": return "模型或接口不可用。请核对 co-pi config.toml 中的模型 ID 与 pi 供应商接口。";
    case "model_network_failed": return "模型连接失败。请检查 MCP 进程的网络、DNS 和代理设置；桌面应用不一定继承交互终端的环境变量。";
    case "model_tls_failed": return "模型连接的 TLS 校验失败。请核对系统时间、证书与代理配置，不要关闭 TLS 校验。";
    case "model_request_failed": return "模型请求失败，尚无可安全公开的错误分类。请核对 pi 供应商配置和运行环境；原始响应正文未记录。";
    case "pi_default_model_required": return `尚未保存 pi 默认供应商和模型。${saveDefaults}使用与 MCP --agent-dir 相同的 pi 配置目录，保存后重新委派。`;
    case "pi_settings_unreadable": return "无法读取 pi settings.json。请核对 MCP --agent-dir、文件权限及 JSON 格式。模型和思考强度在 co-pi config.toml 中配置。";
    case "pi_configured_model_unavailable": return "co-pi config.toml 指定的模型不可用，请核对 provider、id 和 pi 的供应商定义。";
    case "pi_thinking_invalid": return "pi 思考强度配置无效。请进入 /thinking，选择支持的强度后按 Ctrl+S 保存默认值；同时检查模型专属强度设置。";
  }
}

// 只返回固定分类，不将供应商正文、URL、请求头或密钥带入日志。
export function classifyModelError(error: unknown, env = process.env): string {
  const messages: string[] = [];
  for (let current: any = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (typeof current === "string") { messages.push(current); break; }
    if (typeof current.message === "string") messages.push(current.message);
    if (typeof current.code === "string") messages.push(current.code);
    if (typeof current.status === "number") messages.push(`HTTP ${current.status}`);
  }
  const text = messages.join("\n");
  if (/no api key|api key (?:not found|missing|required)|missing.*(?:credential|api.?key)|not logged in/i.test(text)) return "model_auth_required";
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid api.?key|authentication failed/i.test(text)) return "model_auth_rejected";
  if (/\b429\b|rate.?limit/i.test(text)) return "model_rate_limited";
  if (/\b404\b|model.*not found/i.test(text)) return "model_unavailable";
  if (/CERT_|certificate|TLS|SSL/i.test(text)) return "model_tls_failed";
  if (/fetch failed|connection (?:error|failed)|network|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|EPERM|EACCES/i.test(text)) {
    return env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? "model_network_disabled" : "model_network_failed";
  }
  return "model_request_failed";
}

export function runtimeErrorSummary(code: string): string {
  const guidance = runtimeErrorGuidance(code);
  return guidance ? `${code}：${guidance}` : code;
}
