import { matchesKey, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { isTerminal, type Phase, type Snapshot, type TaskState } from "./protocol.js";
import { filters, MonitorStyle, plainLine, renderFeed, type FeedFilter } from "./monitor-view.js";
import type { CodexUsage } from "./codex-usage.js";

export type MonitorRoute = { page: "tasks" } | { page: "task"; sessionId: string; batchId: string; taskId: string };
const labels: Record<Phase, string> = {
  queued: "排队", starting: "启动中", running: "执行中", summarizing: "交接中", completed: "已完成",
  partial: "部分完成", blocked: "受阻", failed: "失败", cancelled: "已取消",
};

export class MonitorRouter implements Component {
  route: MonitorRoute = { page: "tasks" };
  private snapshots: Snapshot[] = [];
  private selected = 0;
  private offset = 0;
  private follow = true;
  private detailLength = 0;
  private pageSize = 1;
  private filter: FeedFilter = "all";
  private expanded = false;
  private help = false;
  private codexUsage: CodexUsage = { state: "searching", automatic: true };
  private readonly style: MonitorStyle;
  constructor(private height: () => number, private redraw: () => void, private quit: () => void, options: { color?: boolean } = {}) {
    this.style = new MonitorStyle(options.color ?? true);
  }

  update(snapshots: Snapshot[]) {
    // 保留选中任务身份，避免其他批次更新时跳到另一行。
    const previous = this.entries()[this.selected];
    this.snapshots = snapshots;
    if (previous) {
      const index = this.entries().findIndex(e => e.snapshot.sessionId === previous.snapshot.sessionId
        && e.snapshot.batchId === previous.snapshot.batchId && e.state.task.id === previous.state.task.id);
      if (index >= 0) this.selected = index;
    }
    this.selected = Math.max(0, Math.min(this.selected, this.entries().length - 1));
    this.redraw();
  }
  updateCodexUsage(usage: CodexUsage) { this.codexUsage = usage; this.redraw(); }
  invalidate() {}
  private entries() { return this.snapshots.flatMap(snapshot => snapshot.tasks.map(state => ({ snapshot, state }))); }
  private status(snapshot: Snapshot, state: TaskState) {
    const stale = !isTerminal(state.phase) && (snapshot.closed || Date.now() - Date.parse(snapshot.heartbeatAt) > 20_000);
    if (stale) return "连接失联·状态未知";
    if (!isTerminal(state.phase)) {
      if (state.runtime?.retry) { const r = state.runtime.retry; return `${r.scope === "model" ? "模型" : "摘要"}重试 ${r.attempt}/${r.maxAttempts} · ${Math.max(0, Math.ceil((Date.parse(r.until) - Date.now()) / 1000))}s`; }
      if (state.runtime?.compacting) return `压缩中·${state.runtime.compactionReason ?? ""}`;
    }
    return labels[state.phase] ?? state.phase;
  }

  handleInput(data: string) {
    if (data === "q" || matchesKey(data, "ctrl+c")) { this.quit(); return; }
    if (data === "?") { this.help = !this.help; this.redraw(); return; }
    if (this.help) {
      if (matchesKey(data, "escape") || data === "b" || matchesKey(data, "enter")) this.help = false;
      this.redraw(); return;
    }
    const up = matchesKey(data, "up") || data === "k";
    const down = matchesKey(data, "down") || data === "j";
    const pageUp = matchesKey(data, "pageUp") || data === "u" || matchesKey(data, "ctrl+u");
    const pageDown = matchesKey(data, "pageDown") || data === "d" || data === " " || matchesKey(data, "ctrl+d");
    const home = matchesKey(data, "home") || data === "g";
    const end = matchesKey(data, "end") || data === "G" || data === "f";
    if (this.route.page === "tasks") {
      const entries = this.entries();
      if (up || pageUp) this.selected = Math.max(0, this.selected - (pageUp ? this.pageSize : 1));
      if (down || pageDown) this.selected = Math.max(0, Math.min(entries.length - 1, this.selected + (pageDown ? this.pageSize : 1)));
      if (home) this.selected = 0;
      if (end) this.selected = Math.max(0, entries.length - 1);
      if (matchesKey(data, "enter")) {
        const entry = entries[this.selected];
        if (entry) {
          this.route = { page: "task", sessionId: entry.snapshot.sessionId, batchId: entry.snapshot.batchId, taskId: entry.state.task.id };
          this.offset = 0; this.follow = true;
        }
      }
    } else {
      if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "b") { this.route = { page: "tasks" }; this.redraw(); return; }
      const selectedFilter = filters[Number(data) - 1];
      if (/^[1-5]$/.test(data) && selectedFilter) { this.filter = selectedFilter.id; this.offset = 0; this.follow = true; }
      if (matchesKey(data, "tab")) { this.filter = filters[(filters.findIndex(f => f.id === this.filter) + 1) % filters.length]!.id; this.offset = 0; this.follow = true; }
      if (data === "e") { this.expanded = !this.expanded; this.offset = 0; }
      const page = this.pageSize;
      const tail = Math.max(0, this.detailLength - page);
      const position = this.follow ? tail : Math.min(this.offset, tail);
      if (pageUp || up) {
        this.offset = Math.max(0, position - (pageUp ? page : 1));
        this.follow = false;
      }
      if (pageDown || down) {
        this.offset = Math.min(tail, position + (pageDown ? page : 1));
        this.follow = false;
      }
      if (home) { this.offset = 0; this.follow = false; }
      if (end) this.follow = true;
    }
    this.redraw();
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    const rows = Math.max(1, this.height());
    const line = (value: string) => {
      const clipped = truncateToWidth(value, width);
      return this.style.color ? clipped : stripTerminalSequences(clipped);
    };
    const paint = this.style.paint.bind(this.style);
    const entries = this.entries();
    const header = [paint("text", "CO-PI MONITOR", true) + paint("muted", "  /  子代理工作台 · 只读")];
    if (this.help) return this.renderHelp(width, rows);
    const frame = (content: string[], footer: string[]) => {
      const room = Math.max(0, rows - footer.length);
      const result = content.slice(0, room);
      while (result.length < room) result.push("");
      return [...result, ...footer].slice(0, rows).map(line);
    };
    if (this.route.page === "tasks") {
      const active = entries.filter(e => !isTerminal(e.state.phase)).length;
      header.push(paint("stages", `任务 ${entries.length}  ·  活跃 ${active}`) + paint("muted", `  ·  结束 ${entries.length - active}`), paint("muted", "─".repeat(Math.min(width, 160))));
      const footer = [...this.cacheFooter(width, rows), paint("muted", width < 80 ? "j/k 选择 · Enter 详情 · ? 帮助 · q 退出" : "j/k ↑↓ 选择 · Enter 详情 · u/d 翻页 · ? 帮助 · q 退出")];
      const cardSize = rows >= 12 ? 3 : 1;
      this.pageSize = Math.max(1, Math.floor((rows - header.length - footer.length) / cardSize));
      const start = Math.floor(this.selected / this.pageSize) * this.pageSize;
      const content = [...header];
      for (let i = start; i < Math.min(entries.length, start + this.pageSize); i++) {
        const { snapshot, state } = entries[i]!;
        const selected = i === this.selected;
        const tone = state.error ? "error" : isTerminal(state.phase) ? "handoff" : "stages";
        content.push(paint(selected ? "text" : "muted", `${selected ? "▸" : " "} ${plainLine(state.task.title)}`, selected) + paint(tone, `  [${plainLine(this.status(snapshot, state))}]`));
        if (cardSize > 1) content.push(paint("muted", `  ${plainLine(state.summary, 180)}  ·  ${snapshot.batchId}/${state.task.id}`), "");
      }
      if (!entries.length) content.push("", paint("text", "等待第一项委派", true), "任务启动后，这里会显示阶段、工具执行与最终交接。", paint("muted", "若任务已启动，请确认 --state-dir 与 MCP 服务相同。"));
      return frame(content, footer);
    } else {
      const route = this.route;
      const entry = entries.find(e => e.snapshot.sessionId === route.sessionId && e.snapshot.batchId === route.batchId && e.state.task.id === route.taskId);
      if (!entry) return frame([...header, "任务当前不可用。请检查状态目录。"], [...this.cacheFooter(width, rows), "b / Esc 返回列表"]);
      const { snapshot, state } = entry;
      header.push(paint(state.error ? "error" : "stages", `[${plainLine(this.status(snapshot, state))}] `) + paint("text", plainLine(state.task.title), true));
      if (rows >= 12) header.push(paint("muted", `${plainLine(state.model ?? "模型待加载")}  ·  思考强度 ${plainLine(state.thinking ?? "—")}  ·  ${plainLine(snapshot.workspace)}`));
      if (rows >= 16) header.push(plainLine(state.summary));
      const m = state.metrics;
      if (rows >= 12) header.push(paint("muted", m ? `Tokens ${m.total} · 输入 ${m.input} / 输出 ${m.output} · 缓存 ${m.cacheRead}/${m.cacheWrite} · 估算 $${m.cost.toFixed(5)}` : "用量等待模型返回"));
      if (rows >= 16) header.push(paint("muted", `上下文 ${m?.contextTokens ?? "未知"}/${m?.contextWindow ?? "未知"} · 工具 ${m?.toolCalls ?? 0} · 队列 steer ${state.runtime?.queue.steering ?? 0} / followUp ${state.runtime?.queue.followUp ?? 0}`));
      const tabs = filters.map((filter, index) => {
        const active = filter.id === this.filter;
        return paint(active ? "text" : "muted", active ? `[${index + 1} ${filter.label}]` : `${index + 1} ${filter.label}`, active);
      });
      header.push(width < 55 ? tabs[filters.findIndex(f => f.id === this.filter)]! + paint("muted", "  Tab 切换") : tabs.join("   "));
      header.push(paint("muted", "─".repeat(Math.min(width, 160))));
      const content = renderFeed(state, width, this.filter, this.expanded, this.style);
      this.detailLength = content.length;
      const footer = [...this.cacheFooter(width, rows), paint("muted", width < 55 ? "j/k · u/d 翻页 · ? 帮助" : width < 90 ? "j/k 滚动 · u/d 翻页 · f 跟随 · ? 帮助" : "j/k 滚动 · u/d 翻页 · g 顶部 · f 跟随 · e 展开 · b 返回 · ? 帮助")];
      this.pageSize = Math.max(1, rows - header.length - footer.length - 1);
      const offset = this.follow ? Math.max(0, content.length - this.pageSize) : Math.min(this.offset, Math.max(0, content.length - this.pageSize));
      this.offset = offset;
      footer.unshift(paint(this.follow ? "stages" : "muted", `${this.follow ? "● 跟随" : "○ 浏览"}  ${offset + 1}–${Math.min(content.length, offset + this.pageSize)} / ${content.length} 行  · 工具${this.expanded ? "展开" : "摘要"}`));
      return frame([...header, ...content.slice(offset, offset + this.pageSize)], footer);
    }
  }

  private cacheFooter(width: number, rows: number): string[] {
    if (rows < 5) return [];
    const usage = this.codexUsage;
    const paint = this.style.paint.bind(this.style);
    const valid = usage.state === "ready" && usage.inputTokens !== undefined && usage.inputTokens > 0;
    const ratio = valid ? (usage.cachedInputTokens ?? 0) / usage.inputTokens! : undefined;
    const percent = ratio === undefined ? "—" : `${(ratio * 100).toFixed(1)}%`;
    const label = width < 55 ? "主 agent 缓存" : "主 agent cache-hit";
    const slots = width >= 75 ? 16 : width >= 55 ? 10 : 0;
    const filled = Math.round((ratio ?? 0) * slots);
    const bar = slots ? ` [${"━".repeat(filled)}${"─".repeat(slots - filled)}]` : "";
    const status = usage.state === "searching" ? "未找到线程 · --codex-thread 指定"
      : usage.state === "unavailable" ? "记录暂不可读"
      : usage.state === "waiting" ? "等待用量记录"
      : !valid ? "本次输入为 0" : "最近一次请求";
    const age = usage.updatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(usage.updatedAt)) / 1000)) : undefined;
    const elapsed = age === undefined ? "" : age < 60 ? `${age}s 前更新` : age < 3600 ? `${Math.floor(age / 60)}m 前更新` : `${Math.floor(age / 3600)}h 前更新`;
    const result = [paint("stages", `${label}${bar} ${percent}`, true) + paint("muted", ` · ${status}`)];
    if (rows >= 12) {
      const counts = usage.inputTokens === undefined ? "" : `${usage.cachedInputTokens!.toLocaleString("en-US")} / ${usage.inputTokens.toLocaleString("en-US")} tokens · `;
      result.push(paint("muted", usage.threadId ? `${counts}${usage.automatic ? "自动" : "线程"} ${usage.threadId.slice(0, 8)}${elapsed ? ` · ${elapsed}` : ""}` : "在项目目录启动，或用 --workspace 指定项目"));
    }
    return result;
  }

  private renderHelp(width: number, rows: number): string[] {
    const lines = ["快捷键 · Windows / macOS / Linux", "", "j/k 或 ↑↓     选择任务 / 逐行滚动", "u/d 或 Ctrl+U/D    上一页 / 下一页", "空格             下一页", "g / Home         回到顶部", "f / G / End      跟随最新内容", "Enter            打开任务", "1–5 / Tab        全部、阶段、工具、输出、交接", "e                展开 / 收起工具参数与结果", "b / Esc          返回任务列表", "q / Ctrl+C       退出监控（任务继续执行）", "", "思考仅显示阶段，不显示私有推理正文。", "公开文本按 Markdown 渲染，工具调用单独归组。", "", "? / b / Esc 关闭帮助"];
    return lines.slice(0, rows).map((line, index) => {
      const clipped = truncateToWidth(this.style.paint(index === 0 ? "text" : "muted", line, index === 0), width);
      return this.style.color ? clipped : stripTerminalSequences(clipped);
    });
  }
}
