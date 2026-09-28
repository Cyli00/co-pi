import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { isTerminal, type Phase, type Snapshot, type TaskState } from "./protocol.js";
import { filters, MonitorStyle, plainLine, renderFeedLayout, type FeedFilter, type FeedAnchor, type FeedLayout } from "./monitor-view.js";
import type { CodexUsage } from "./codex-usage.js";
import { formatMonitorTime } from "./monitor-time.js";
import type { TerminationTarget } from "./monitor-control.js";

export const DETAIL_SHORTCUTS = "←/→ 分类 · ↑/↓ 滚动 · w/s/PgUp/PgDn 翻页 · fn+↑/Home 回顶 · fn+↓/End 跟随 · t 展开/折叠 · Esc 返回 · ? 帮助";
const fitHint = (width: number, hints: string[]) => hints.find(hint => visibleWidth(hint) <= width) ?? hints.at(-1)!;

export type MonitorRoute = { page: "tasks" } | { page: "task"; sessionId: string; batchId: string; taskId: string };
type TaskEntry = { snapshot: Snapshot; state: TaskState };
type ReadingPosition = { offset: number; follow: boolean; anchor?: FeedAnchor };
type TaskView = { filter: FeedFilter; expanded: boolean; positions: Partial<Record<FeedFilter, ReadingPosition>> };
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
  private anchor?: FeedAnchor;
  private feedCache?: { key: string; layout: FeedLayout };
  private helpOffset = 0;
  private help = false;
  private info = false;
  private activeOnly = false;
  private readonly taskViews = new Map<string, TaskView>();
  private readonly taskNumbers = new Map<string, number>();
  private nextTaskNumber = 1;
  private codexUsage: CodexUsage = { state: "searching", automatic: true };
  private readonly style: MonitorStyle;
  private confirmation?: { entry: TaskEntry; key: string };
  private controlNotice = "";
  private readonly pendingTermination = new Map<string, number>();
  private readonly terminateTask?: (target: Omit<TerminationTarget, "threadId">) => Promise<void>;
  constructor(private height: () => number, private redraw: () => void, private quit: () => void,
    options: { color?: boolean; terminateTask?: (target: Omit<TerminationTarget, "threadId">) => Promise<void> } = {}) {
    this.style = new MonitorStyle(options.color ?? true);
    this.terminateTask = options.terminateTask;
  }

  update(snapshots: Snapshot[]) {
    // 保留选中任务身份，避免其他批次更新时跳到另一行。
    const previous = this.entries()[this.selected];
    this.snapshots = snapshots;
    const keys = new Set(this.allEntries().map(entry => this.entryKey(entry)));
    for (const [key, sentAt] of this.pendingTermination) {
      const entry = this.allEntries().find(entry => this.entryKey(entry) === key);
      if (!entry || isTerminal(entry.state.phase) || this.stale(entry.snapshot, entry.state) || Date.now() - sentAt > 10_000) {
        this.pendingTermination.delete(key);
        this.controlNotice = entry?.state.error === "terminated_by_user" ? `terminated by user · ${plainLine(entry.state.task.title)}`
          : entry && isTerminal(entry.state.phase) ? "任务已结束。" : "服务无响应，尚未确认终止；请检查连接。";
      }
    }
    for (const key of this.taskViews.keys()) if (!keys.has(key)) this.taskViews.delete(key);
    for (const key of this.taskNumbers.keys()) if (!keys.has(key)) this.taskNumbers.delete(key);
    for (const key of keys) if (!this.taskNumbers.has(key)) this.taskNumbers.set(key, this.nextTaskNumber++);
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
  private allEntries(): TaskEntry[] { return this.snapshots.flatMap(snapshot => snapshot.tasks.map(state => ({ snapshot, state }))); }
  private entries() { return this.allEntries().filter(entry => !this.activeOnly || !isTerminal(entry.state.phase)); }
  private entryKey({ snapshot, state }: TaskEntry) { return JSON.stringify([snapshot.sessionId, snapshot.batchId, state.task.id]); }
  private routeKey() {
    return this.route.page === "task" ? JSON.stringify([this.route.sessionId, this.route.batchId, this.route.taskId]) : undefined;
  }
  private saveView() {
    const key = this.routeKey();
    if (!key) return;
    const positions = this.taskViews.get(key)?.positions ?? {};
    positions[this.filter] = { offset: this.offset, follow: this.follow, anchor: this.anchor };
    this.taskViews.set(key, { filter: this.filter, expanded: this.expanded, positions });
  }
  private restorePosition() {
    const saved = this.taskViews.get(this.routeKey()!)?.positions[this.filter];
    this.offset = saved?.offset ?? 0;
    this.follow = saved?.follow ?? this.filter !== "handoff";
    this.anchor = saved?.anchor;
  }
  private openTask(entry: TaskEntry, keepFilter = false) {
    this.saveView();
    const saved = this.taskViews.get(this.entryKey(entry));
    this.route = { page: "task", sessionId: entry.snapshot.sessionId, batchId: entry.snapshot.batchId, taskId: entry.state.task.id };
    if (!keepFilter) this.filter = saved?.filter ?? (entry.state.handoff && isTerminal(entry.state.phase) ? "handoff" : "all");
    this.expanded = saved?.expanded ?? false;
    this.restorePosition();
    this.selected = Math.max(0, this.entries().findIndex(item => this.entryKey(item) === this.entryKey(entry)));
  }
  private stale(snapshot: Snapshot, state: TaskState) {
    return !isTerminal(state.phase) && (snapshot.closed || Date.now() - Date.parse(snapshot.heartbeatAt) > 20_000);
  }
  private attention(snapshot: Snapshot, state: TaskState) {
    return Boolean(state.error) || ["failed", "blocked", "partial"].includes(state.phase) || this.stale(snapshot, state);
  }
  private status(snapshot: Snapshot, state: TaskState) {
    if (state.error === "terminated_by_user") return isTerminal(state.phase) ? "terminated by user" : "正在终止";
    if (this.stale(snapshot, state)) return "连接失联·状态未知";
    if (!isTerminal(state.phase)) {
      if (state.runtime?.retry) { const r = state.runtime.retry; return `${r.scope === "model" ? "模型" : "摘要"}重试 ${r.attempt}/${r.maxAttempts} · ${Math.max(0, Math.ceil((Date.parse(r.until) - Date.now()) / 1000))}s`; }
      if (state.runtime?.compacting) return `压缩中·${state.runtime.compactionReason ?? ""}`;
    }
    return labels[state.phase] ?? state.phase;
  }

  handleInput(data: string) {
    if (data === "q" || matchesKey(data, "ctrl+c")) { this.quit(); return; }
    if (this.confirmation) {
      if (data === "y") { void this.confirmTermination(); return; }
      if (matchesKey(data, "escape") || data === "n") { this.confirmation = undefined; this.redraw(); }
      return;
    }
    if (data === "?") { this.help = !this.help; this.info = false; this.helpOffset = 0; this.redraw(); return; }
    if (data === "i") { this.info = !this.info; this.help = false; this.helpOffset = 0; this.redraw(); return; }
    if (this.help || this.info) {
      if (matchesKey(data, "escape") || data === "b" || matchesKey(data, "enter")) { this.help = false; this.info = false; }
      const page = Math.max(1, this.height() - 2);
      if (data === "j" || matchesKey(data, "down")) this.helpOffset++;
      if (data === "k" || matchesKey(data, "up")) this.helpOffset--;
      if (data === "s" || data === "d" || data === " " || matchesKey(data, "pageDown")) this.helpOffset += page;
      if (data === "w" || data === "u" || matchesKey(data, "pageUp")) this.helpOffset -= page;
      this.redraw(); return;
    }
    if (data === "x" && this.terminateTask) {
      const entry = this.route.page === "tasks" ? this.entries()[this.selected]
        : this.allEntries().find(entry => this.entryKey(entry) === this.routeKey());
      if (!entry || isTerminal(entry.state.phase)) this.controlNotice = "只能终止尚未结束的任务。";
      else if (this.stale(entry.snapshot, entry.state)) this.controlNotice = "服务连接已失联，无法确认终止。";
      else if (this.pendingTermination.has(this.entryKey(entry))) this.controlNotice = "终止请求已发送，等待任务停止。";
      else this.confirmation = { entry, key: this.entryKey(entry) };
      this.redraw(); return;
    }
    const up = matchesKey(data, "up") || data === "k";
    const down = matchesKey(data, "down") || data === "j";
    const pageUp = matchesKey(data, "pageUp") || data === "w" || data === "u" || matchesKey(data, "ctrl+u");
    const pageDown = matchesKey(data, "pageDown") || data === "s" || data === "d" || data === " " || matchesKey(data, "ctrl+d");
    const home = matchesKey(data, "home") || data === "g";
    const end = matchesKey(data, "end") || data === "G" || data === "f";
    if (this.route.page === "tasks") {
      if (data === "a") {
        const key = this.entries()[this.selected];
        this.activeOnly = !this.activeOnly;
        this.selected = key ? Math.max(0, this.entries().findIndex(entry => this.entryKey(entry) === this.entryKey(key))) : 0;
      }
      const entries = this.entries();
      if (up || pageUp) this.selected = Math.max(0, this.selected - (pageUp ? this.pageSize : 1));
      if (down || pageDown) this.selected = Math.max(0, Math.min(entries.length - 1, this.selected + (pageDown ? this.pageSize : 1)));
      if (home) this.selected = 0;
      if (end) this.selected = Math.max(0, entries.length - 1);
      if (matchesKey(data, "enter")) {
        const entry = entries[this.selected];
        if (entry) this.openTask(entry);
      }
    } else {
      if (matchesKey(data, "escape") || data === "b") { this.saveView(); this.route = { page: "tasks" }; this.redraw(); return; }
      if (data === "[" || data === "]") {
        const entries = this.entries();
        const index = entries.findIndex(entry => this.entryKey(entry) === this.routeKey());
        const target = index < 0 ? (data === "]" ? 0 : entries.length - 1)
          : Math.max(0, Math.min(entries.length - 1, index + (data === "]" ? 1 : -1)));
        if (entries[target]) this.openTask(entries[target]!, true);
        this.redraw(); return;
      }
      const next = matchesKey(data, "right") || matchesKey(data, "tab");
      const previous = matchesKey(data, "left") || matchesKey(data, "shift+tab");
      if (next || previous) {
        this.saveView();
        const index = filters.findIndex(f => f.id === this.filter);
        this.filter = filters[(index + (next ? 1 : -1) + filters.length) % filters.length]!.id;
        this.restorePosition();
      }
      if (data === "t") this.expanded = !this.expanded;
      if (pageUp || pageDown || up || down || home || end) this.anchor = undefined;
      const page = this.pageSize;
      const tail = Math.max(0, this.detailLength - page);
      const position = this.follow ? tail : Math.min(this.offset, tail);
      if (pageUp || up) {
        this.offset = Math.max(0, position - (pageUp ? page : 1));
        this.follow = false;
      }
      if (pageDown || down) {
        this.offset = Math.min(tail, position + (pageDown ? page : 1));
        // 已在末尾的向下操作不应暂停实时跟随；浏览模式由 f / End 显式恢复。
        this.follow = this.follow && this.offset === tail;
      }
      if (home) { this.offset = 0; this.follow = false; }
      if (end) this.follow = true;
    }
    this.redraw();
  }

  private async confirmTermination() {
    const confirmation = this.confirmation;
    this.confirmation = undefined;
    if (!confirmation || !this.terminateTask) return;
    const entry = this.allEntries().find(entry => this.entryKey(entry) === confirmation.key);
    if (!entry || isTerminal(entry.state.phase) || this.stale(entry.snapshot, entry.state)) {
      this.controlNotice = "任务状态已变化，请重新检查后操作。";
      this.redraw(); return;
    }
    this.pendingTermination.set(confirmation.key, Date.now());
    this.controlNotice = "正在发送终止请求…";
    this.redraw();
    try {
      await this.terminateTask({ sessionId: entry.snapshot.sessionId, batchId: entry.snapshot.batchId, taskId: entry.state.task.id });
      if (this.pendingTermination.has(confirmation.key)) this.controlNotice = "终止请求已发送，等待任务停止。";
    } catch (error) {
      this.pendingTermination.delete(confirmation.key);
      this.controlNotice = error instanceof Error && error.message === "termination_not_supported"
        ? "当前 co-pi 服务不支持终止，请更新并重载服务。"
        : "终止请求未确认，请检查任务状态和目录权限；不会自动重试。";
    }
    this.redraw();
  }

  private controlFooter() { return this.controlNotice ? [this.style.paint("tools", this.controlNotice)] : []; }

  render(width: number, allTasks = false): string[] {
    width = Math.max(1, width);
    const rows = Math.max(allTasks ? 12 : 1, this.height());
    const line = (value: string) => {
      const clipped = truncateToWidth(value, width);
      return this.style.color ? clipped : stripTerminalSequences(clipped);
    };
    const paint = this.style.paint.bind(this.style);
    if (this.confirmation) {
      const title = plainLine(this.confirmation.entry.state.task.title);
      const content = [paint("error", "终止所选任务？", true), ...wrapTextWithAnsi(title, width),
        ...wrapTextWithAnsi("仅停止这项任务，已产生的文件改动保留。", width)];
      return [...content.slice(0, Math.max(0, rows - 1)), paint("error", "y 终止 · Esc / n 取消", true)].map(line);
    }
    const entries = this.entries();
    const header = [paint("text", "CO-PI MONITOR", true) + paint("muted", `  /  子代理工作台 · ${this.terminateTask ? "x 终止任务" : "只读"}`)];
    if (this.info) return this.renderInfo(width, rows);
    if (this.help) return this.renderHelp(width, rows);
    if (rows < 4) return [line("终端过小：请增加到至少 4 行 · q 退出")];
    const frame = (content: string[], footer: string[]) => {
      if (allTasks) return [...content, ...footer].map(line);
      const room = Math.max(0, rows - footer.length);
      const result = content.slice(0, room);
      while (result.length < room) result.push("");
      return [...result, ...footer].slice(0, rows).map(line);
    };
    if (this.route.page === "tasks") {
      const all = this.allEntries();
      const active = all.filter(e => !isTerminal(e.state.phase)).length;
      // 只有完整显示所有任务后，才把剩余空间用于标题、摘要和详细用量。
      const roomy = allTasks || (rows >= 16 && rows >= entries.length + 7);
      if (!roomy) header.length = 0;
      header.push(paint("stages", `任务 ${all.length} · 活跃 ${active} · ${this.activeOnly ? "仅活跃" : "全部"}`));
      if (roomy) header.push(paint("muted", "─".repeat(Math.min(width, 160))));
      const controlHint = this.terminateTask ? " · x 终止" : "";
      const footer = [...this.controlFooter(), ...this.cacheFooter(width, rows, !roomy), paint("muted", fitHint(width, [
        `↑/↓ 选择 · Enter 详情 · a 活跃/全部${controlHint} · i 用量 · ? 帮助 · q 退出`,
        `Enter 详情 · a 筛选${controlHint} · ? 帮助`,
        `Enter 详情${controlHint} · ? 帮助`]))];
      const cardSize = allTasks || (roomy && rows >= entries.length * 2 + 7) ? 2 : 1;
      this.pageSize = allTasks ? Math.max(1, entries.length) : Math.max(1, Math.floor((rows - header.length - footer.length) / cardSize));
      const start = allTasks ? 0 : Math.floor(this.selected / this.pageSize) * this.pageSize;
      const content = [...header];
      for (let i = start; i < Math.min(entries.length, start + this.pageSize); i++) {
        const entry = entries[i]!;
        const { snapshot, state } = entry;
        const selected = i === this.selected;
        const alert = this.attention(snapshot, state);
        const tone = alert ? "error" : isTerminal(state.phase) ? "handoff" : "stages";
        content.push(paint(tone, `${selected ? "▸" : " "} #${this.taskNumbers.get(this.entryKey(entry))} ${alert ? "! " : ""}[${plainLine(this.status(snapshot, state))}] `, selected)
          + paint(selected ? "text" : "muted", plainLine(state.task.title), selected));
        if (cardSize > 1) content.push(paint("muted", `  ${plainLine(state.summary, 180)} · ${plainLine(snapshot.batchId)}/${plainLine(state.task.id)}`));
      }
      if (!entries.length) content.push(...(this.activeOnly && all.length
        ? ["暂无活跃任务 · 按 a 查看全部"]
        : [paint("text", "等待第一项委派", true), "任务启动后，这里会显示阶段、工具执行与最终交接。", paint("muted", "若任务已启动，请确认 --state-dir 与 MCP 服务相同。")]));
      return frame(content, footer);
    } else {
      const route = this.route;
      const entry = this.allEntries().find(e => e.snapshot.sessionId === route.sessionId && e.snapshot.batchId === route.batchId && e.state.task.id === route.taskId);
      if (!entry) return frame([...header, "任务当前不可用。请检查状态目录。"], [...this.cacheFooter(width, rows), "b / Esc 返回列表"]);
      const { snapshot, state } = entry;
      header.length = 0;
      const alert = this.attention(snapshot, state);
      header.push(paint(alert ? "error" : "stages", `#${this.taskNumbers.get(this.entryKey(entry))} ${alert ? "! " : ""}[${plainLine(this.status(snapshot, state))}] `) + paint("text", plainLine(state.task.title), true));
      if (rows >= 16) header.push(paint("muted", `${plainLine(state.model ?? "模型待加载")}  ·  思考强度 ${plainLine(state.thinking ?? "—")}  ·  ${plainLine(snapshot.workspace)}`));
      if (rows >= 20) header.push(plainLine(state.summary));
      const m = state.metrics;
      if (rows >= 16) header.push(paint("muted", m ? `Tokens ${m.total} · 输入 ${m.input} / 输出 ${m.output} · 缓存 ${m.cacheRead}/${m.cacheWrite} · 估算 $${m.cost.toFixed(5)}` : "用量等待模型返回"));
      if (rows >= 20) header.push(paint("muted", `上下文 ${m?.contextTokens ?? "未知"}/${m?.contextWindow ?? "未知"} · 工具 ${m?.toolCalls ?? 0} · 队列 steer ${state.runtime?.queue.steering ?? 0} / followUp ${state.runtime?.queue.followUp ?? 0}`));
      const tabs = filters.map(filter => {
        const active = filter.id === this.filter;
        return paint(active ? "text" : "muted", active ? `[${filter.label}]` : filter.label, active);
      });
      header.push(width < 55 ? tabs[filters.findIndex(f => f.id === this.filter)]! + paint("muted", "  ←/→ 切换") : tabs.join("   ") + paint("muted", "  ←/→"));
      const cacheKey = JSON.stringify([route, width, this.filter, this.expanded,
        state.events, state.omittedEvents, state.handoff, state.messages, state.phase, state.error]);
      if (this.feedCache?.key !== cacheKey) this.feedCache = { key: cacheKey,
        layout: renderFeedLayout(state, width, this.filter, this.expanded, this.style) };
      const { lines: content, anchors } = this.feedCache.layout;
      this.detailLength = content.length;
      const shortcut = fitHint(width, [DETAIL_SHORTCUTS,
        "←/→ 分类 · ↑/↓ 滚动 · w/s 翻页 · Home 回顶 · End 跟随 · t 展开/折叠 · Esc 返回 · ? 帮助",
        "←→ 分类 · ↑↓ 滚动 · [/] 任务 · t 展开 · Esc 返回 · ? 帮助",
        "←→ 分类 · t 展开 · Esc 返回 · ? 帮助"]);
      const mode = this.follow ? "● 跟随" : "○ 浏览 · f 跟随";
      const compactShortcut = fitHint(width, [
        `${mode} · ↑↓ 滚动 · Esc 返回 · ? 帮助`, `${mode} · Esc 返回 · ? 帮助`, `${mode} · Esc 返回`]);
      const footer = [...this.controlFooter(), ...this.cacheFooter(width, rows, rows < 20),
        paint("muted", (this.terminateTask ? "x 终止 · " : "") + (rows < 12 ? compactShortcut : shortcut))];
      const showPosition = rows >= 12;
      this.pageSize = Math.max(1, rows - header.length - footer.length - Number(showPosition));
      let position = this.offset;
      if (!this.follow && this.anchor) {
        const first = anchors.findIndex(a => a.key === this.anchor!.key);
        if (first >= 0) {
          let end = first;
          while (end + 1 < anchors.length && anchors[end + 1]!.key === this.anchor.key) end++;
          position = first + Math.min(this.anchor.row, end - first);
        } else position = 0;
      }
      const offset = this.follow ? Math.max(0, content.length - this.pageSize) : Math.min(position, Math.max(0, content.length - this.pageSize));
      this.offset = offset;
      this.anchor = this.follow ? undefined : anchors[offset];
      if (showPosition) footer.unshift(paint(this.follow ? "stages" : "muted", `${this.follow ? "● 跟随" : "○ 浏览"}  ${offset + 1}–${Math.min(content.length, offset + this.pageSize)} / ${content.length} 行${this.follow ? "" : " · f 跟随"} · 工具/思考${this.expanded ? "展开" : "折叠"}`));
      return frame([...header, ...content.slice(offset, offset + this.pageSize)], footer);
    }
  }

  private cacheFooter(width: number, rows: number, compact = false): string[] {
    if (rows < 8) return [];
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
    const recordedAt = usage.updatedAt ? new Date(usage.updatedAt) : undefined;
    const timestamp = recordedAt && Number.isFinite(recordedAt.getTime()) ? recordedAt : undefined;
    const age = timestamp ? Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 1000)) : undefined;
    const elapsed = age === undefined ? "" : age < 60 ? `${age}s 前` : age < 3600 ? `${Math.floor(age / 60)}m 前` : `${Math.floor(age / 3600)}h 前`;
    let updated = usage.inputTokens === undefined ? "尚无用量记录" : "记录时间未知";
    if (timestamp) updated = `${formatMonitorTime(usage.updatedAt, { year: width >= 75, zone: width >= 75 })} · ${elapsed}`;
    if (compact) {
      const shortThread = usage.threadId ? `${usage.threadId.slice(0, 8)}…${usage.threadId.slice(-4)}` : "未找到";
      const time = formatMonitorTime(usage.updatedAt, { year: false }) ?? updated;
      return [paint("muted", `主缓存 ${percent}${usage.state === "unavailable" ? " 不可读" : ""} · 线程 ${shortThread} · 本地 ${time} · i 详情`)];
    }
    const thread = usage.threadId ? width >= 70 ? usage.threadId : `${usage.threadId.slice(0, 8)}…${usage.threadId.slice(-4)}` : "未找到";
    const project = usage.workspace ? plainLine(width >= 100 ? usage.workspace : usage.workspace.split(/[\/]/).filter(Boolean).at(-1)) : "";
    const source = usage.workspaceSource === "tasks" ? "任务项目" : usage.workspaceSource === "argument" ? "指定项目" : "启动目录";
    const selection = usage.automatic ? `自动匹配${project ? ` · ${source} ${project}` : ""}` : "指定线程";
    const counts = width >= 110 && usage.inputTokens !== undefined
      ? ` · ${usage.cachedInputTokens!.toLocaleString("en-US")} / ${usage.inputTokens.toLocaleString("en-US")} tokens` : "";
    // 保留来源与记录时间；极小窗口优先提供正文，重绘不会改变记录时间。
    return [
      paint("stages", `${label}${bar} ${percent}`, true) + paint("muted", ` · ${status}${counts}`),
      paint("muted", `监控线程 ${thread} · ${selection}`),
      paint("muted", `${width >= 75 ? "用量更新" : "更新(本地)"} ${updated}`),
    ];
  }

  private renderHelp(width: number, rows: number): string[] {
    const lines = ["快捷键 · Windows / macOS / Linux", "", "↑/↓              选择任务 / 逐行滚动", "w/s / PgUp/PgDn  上一页 / 下一页", "空格             下一页", "fn+↑ / Home      回顶", "f / fn+↓ / End   跟随最新内容", "Enter            打开任务", "a                列表：仅活跃 / 全部", "[ / ]            详情：上一个 / 下一个任务", "←/→ / Tab        切换全部、阶段、工具、输出、交接", "t                展开 / 折叠工具与 SDK 思考文本", "Esc              返回任务列表", "q / Ctrl+C       退出监控（任务继续执行）", "", "思考正文来自 SDK；未提供正文的旧记录仅显示阶段。", "公开文本按 Markdown 渲染，工具调用单独归组。", "", "Fn 组合由终端映射；回顶/跟随需发送 Home/End。", "? / Esc 关闭帮助"];
    lines.splice(2, 0, "i                用量与标识详情 / 返回");
    if (this.terminateTask) lines.splice(3, 0, "x                终止所选任务，y 确认，Esc 取消", "终止任务保留已有文件改动，并报告 terminated by user。");
    return this.renderTextPage(lines, width, rows, "↑/↓ 滚动 · w/s 翻页 · ? / Esc 关闭帮助");
  }

  private renderInfo(width: number, rows: number): string[] {
    const lines = ["用量与标识 · 时间按本地时区显示", "", ...this.cacheFooter(160, 24)];
    const route = this.route;
    if (route.page === "task") lines.push("", `MCP 会话 ${plainLine(route.sessionId)}`, `批次 ${plainLine(route.batchId)}`, `任务 ${plainLine(route.taskId)}`);
    return this.renderTextPage(lines.flatMap(line => wrapTextWithAnsi(line, width)), width, rows, "↑↓ 滚动 · w/s 翻页 · i / Esc 返回");
  }

  private renderTextPage(lines: string[], width: number, rows: number, footer: string): string[] {
    const page = Math.max(1, rows - 1);
    this.helpOffset = Math.max(0, Math.min(this.helpOffset, lines.length - page));
    const visible = [...lines.slice(this.helpOffset, this.helpOffset + page), footer];
    return visible.slice(0, rows).map((line, index) => {
      const clipped = truncateToWidth(this.style.paint(index === 0 ? "text" : "muted", line, index === 0), width);
      return this.style.color ? clipped : stripTerminalSequences(clipped);
    });
  }
}
