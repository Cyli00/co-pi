import { Markdown, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { safeText, type Activity, type TaskState } from "./protocol.js";

export type FeedFilter = "all" | "stages" | "tools" | "text" | "handoff";
export const filters: { id: FeedFilter; label: string }[] = [
  { id: "all", label: "全部" }, { id: "stages", label: "阶段" }, { id: "tools", label: "工具" },
  { id: "text", label: "输出" }, { id: "handoff", label: "交接" },
];

// 颜色只编码内容类别；保留终端背景，并始终提供可读的文字标签。
const colors = { text: "125;180;232", stages: "133;199;175", tools: "216;178;110", handoff: "198;160;213", muted: "140;150;166", error: "239;143;143" };
export type Tone = keyof typeof colors;
export const plainLine = (value: unknown, limit = 4_000) => safeText(value, limit).replace(/\s+/g, " ").trim();
export class MonitorStyle {
  constructor(readonly color: boolean) {}
  paint(tone: Tone, text: string, bold = false): string {
    return this.color ? `\x1b[${bold ? "1;" : ""}38;2;${colors[tone]}m${text}\x1b[0m` : text;
  }
  markdown(text: string, width: number): string[] {
    const theme: MarkdownTheme = {
      heading: s => this.paint("text", s, true), link: s => this.paint("text", s), linkUrl: s => this.paint("muted", s),
      code: s => this.paint("tools", s), codeBlock: s => this.paint("tools", s), codeBlockBorder: s => this.paint("muted", s),
      quote: s => this.paint("muted", s), quoteBorder: s => this.paint("muted", s), hr: s => this.paint("muted", s),
      listBullet: s => this.paint("text", s), bold: s => this.paint("text", s, true), italic: s => s,
      strikethrough: s => s, underline: s => s,
    };
    return new Markdown(safeText(text, 32_000), 0, 0, theme).render(Math.max(1, width));
  }
}

function toolName(event: Activity) { return event.text.split(/[\s\n]/, 1)[0] || "工具"; }
function communicationTool(event: Activity) { return ["report_progress", "submit_handoff"].includes(toolName(event)); }
function category(event: Activity): FeedFilter {
  if (event.kind.startsWith("tool_") || event.kind === "tool") return communicationTool(event) ? "stages" : "tools";
  if (event.kind === "assistant") return "text";
  if (event.kind === "handoff") return "handoff";
  return "stages";
}
const stageLabels: Record<string, string> = {
  thinking: "思考", progress: "进展", compaction: "上下文压缩", retry: "重试", runtime: "运行状态", diagnostic: "提示", message: "消息",
};

export function renderFeed(state: TaskState, width: number, filter: FeedFilter, expanded: boolean, style: MonitorStyle): string[] {
  const lines: string[] = [];
  const inner = Math.max(1, width - 3);
  const wrap = (text: string) => safeText(text, 32_000).split("\n").flatMap(line => wrapTextWithAnsi(line, inner));
  const card = (tone: Tone, title: string, body: string[], footer?: string) => {
    lines.push(style.paint(tone, `╭─ ${plainLine(title)}`, true));
    for (const line of body) lines.push(style.paint(tone, "│ ") + line);
    if (footer) lines.push(style.paint("muted", `│ ${footer}`));
    lines.push(style.paint(tone, "╰─"), "");
  };
  if (state.omittedEvents) lines.push(style.paint("muted", `更早的 ${state.omittedEvents} 条事件已移出监控缓存`), "");
  const outputs = new Map(state.events.filter(e => e.id?.startsWith("output-")).map(e => [e.id!.slice(7), e]));
  const paired = new Set<string>();
  for (const event of state.events) {
    if (!event.id?.startsWith("tool-")) continue;
    if (outputs.has(event.id.slice(5))) paired.add(event.id.slice(5));
  }
  for (const event of state.events) {
    if (event.id?.startsWith("output-") && paired.has(event.id.slice(7))) continue;
    const kind = category(event);
    if (filter !== "all" && filter !== kind) continue;
    if (event.kind.startsWith("tool_") && communicationTool(event)) continue;
    if (event.kind === "handoff" && state.handoff) continue;
    const time = event.at.slice(11, 19);
    if (kind === "tools" && event.kind !== "tool") {
      const output = event.id?.startsWith("tool-") ? outputs.get(event.id.slice(5)) : event;
      const status = output?.kind === "tool_error" ? "失败" : output?.kind === "tool_end" ? "完成" : "执行中";
      const tone = status === "失败" ? "error" : "tools";
      const name = toolName(event);
      const body: string[] = [];
      if (event.kind === "tool_start") {
        const rawArgs = event.text.slice(name.length).trim();
        let args = rawArgs;
        try {
          const parsed = JSON.parse(rawArgs);
          args = Object.entries(parsed).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n");
        } catch { /* 历史或截断参数仍按原始公开文本显示。 */ }
        const rows = wrap(args);
        body.push(...(expanded ? rows : rows.slice(0, 2)).map(line => style.paint("muted", line)));
        if (!expanded && rows.length > 2) body.push(style.paint("muted", `… 另有 ${rows.length - 2} 行参数 · e 展开`));
      }
      const text = output?.text.includes("\n") ? output.text.slice(output.text.indexOf("\n") + 1) : "";
      const rows = wrap(text);
      if (text) {
        if (body.length) body.push(style.paint("muted", "─ 结果"));
        body.push(...(expanded ? rows : rows.slice(0, 3)));
      } else body.push(style.paint("muted", status === "执行中" ? "等待工具输出…" : "无文本输出"));
      card(tone, `工具 · ${name} · ${status}  ${time}`, body,
        !expanded && rows.length > 3 ? `… 另有 ${rows.length - 3} 行结果 · e 展开` : undefined);
    } else if (kind === "text") {
      card("text", `输出 · ${event.final === false ? "正在生成" : "公开文本"}  ${time}`, style.markdown(event.text, inner));
    } else {
      const tone = event.kind === "runtime" && state.error ? "error" : kind === "tools" ? "tools" : "stages";
      const label = stageLabels[event.kind] ?? (kind === "tools" ? "工具" : "阶段");
      for (const line of wrap(`${label} · ${time}  ${event.text}`)) lines.push(style.paint(tone, `◆ ${line}`));
    }
  }
  if (filter === "all" || filter === "stages") {
    for (const receipt of state.messages ?? []) {
      lines.push(...wrap(`消息 ${receipt.id} · ${receipt.mode} · ${receipt.status}${receipt.error ? ` · ${receipt.error}` : ""}`).map(line => style.paint("muted", line)));
    }
  }
  if (state.handoff && (filter === "all" || filter === "handoff")) {
    const handoff = state.handoff;
    const body = style.markdown(handoff.summary, inner);
    const section = (label: string, items: string[]) => {
      if (!items.length) return;
      body.push("", style.paint("handoff", label, true));
      for (const item of items) body.push(...wrap(`• ${item}`));
    };
    section("改动", handoff.changes);
    const resultLabels = { passed: "通过", failed: "失败", not_run: "未运行" };
    section("验证", handoff.verification.map(v => `${resultLabels[v.result]} · ${v.action} — ${v.detail}`));
    section("证据", handoff.evidence.map(e => `${e.path}${e.line ? `:${e.line}` : ""} — ${e.note}`));
    section("未解决", handoff.unresolved);
    section("下一步", handoff.nextSteps);
    const statusLabels = { completed: "完成", partial: "部分完成", blocked: "受阻" };
    card("handoff", `最终交接 · ${statusLabels[handoff.status]}`, body);
  }
  if (!lines.length) lines.push(style.paint("muted", filter === "handoff" ? "交接尚未生成。任务结束后会在这里显示结论与验证。" : "暂无此类事件。"));
  return lines;
}
