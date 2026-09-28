---
version: alpha
name: co-pi monitor
description: 面向并行子代理的中文终端监控与任务终止
colors:
  text: "#7DB4E8"
  stages: "#85C7AF"
  tools: "#D8B26E"
  handoff: "#C6A0D5"
  muted: "#8C96A6"
  error: "#EF8F8F"
omitted:
  - section: typography
    reason: 字体和字号由用户终端管理；应用只使用加粗与字符宽度。
  - section: spacing
    reason: 按终端行列分配空间，没有 CSS 间距标尺。
  - section: rounded
    reason: 终端字符界面没有像素圆角。
  - section: components
    reason: 组件的行数与交互约定见正文，运行时由 MonitorRouter 和 MonitorStyle 管理。
---

# cpi-monitor 设计约定

## Overview

用户需要确认多个 pi worker 是否在推进、查看工具记录、阅读最终交接，并可主动终止所选任务。退出监控不停止任务。业务依据是 README、协议中的任务阶段与现有列表／详情路由。

沿用进程监控台的紧凑布局、分类时间线和文字状态。任务与交接内容优先于装饰、缓存统计和内部运行参数，不引入网页卡片或动画。任务终止使用 TUI 内的确认页，不调用系统弹窗。

## Colors

颜色的唯一运行时来源是 `src/monitor-view.ts` 的 `colors`，由 `MonitorStyle` 供列表、详情和信息页共用；上面的值记录现有调色板，不生成第二套主题。

颜色主要区分阶段、工具、公开文本和交接。失败、受阻、部分完成、失联使用告警标记与文字，不能依靠颜色辨认。保留终端背景，彩色和无色模式使用相同文字和导航。当前调色板没有承诺任意终端背景都满足对比度要求，浅色主题与屏幕阅读器需实机验证。

配色开关统一由 `src/monitor-color.ts` 解析。`--open` 打开的独立终端默认使用完整调色板，不继承 agent 为捕获命令输出而设置的 `NO_COLOR`；启动器明确把 `--color` 传给新终端。用户可用 `--no-color` 选择无色，或用 `--color` 覆盖环境设置，二者不能同时使用。当前终端的交互模式仍遵循非空 `NO_COLOR`；`--once` 默认无色，显式 `--color` 时可输出 ANSI。不得因调整布局、导航或跨平台启动流程而减少六色语义区分。

## Typography

终端拥有字体和字号。中文、英文、路径与符号按可见字符宽度裁剪或换行。任务标题单行清洗，公开文本支持 Markdown；关键状态放在长标题之前。

## Layout

列表使用一行一项的紧凑模式。只有所有任务已能显示时，剩余空间才用于应用标题、任务摘要和详细用量；增高窗口不减少可见任务数。

详情的正文自行分页，pi-tui 不额外截获翻页键。矮窗口保留任务状态、分类、正文、跟随状态及返回操作。缓存用量可压成一行，`i` 信息页提供完整来源、时间和标识，支持滚动。

## Elevation & Depth

不使用背景层、阴影或过渡动画。使用文字、加粗和字符边框表达层级；监控刷新不改变已暂停阅读的位置。

## Shapes

沿用 `╭─`、`│`、`╰─` 表示工具、文本和交接记录；列表使用 `▸` 表示选择。`!` 与状态文字共同表示需关注的任务。

## Components

| 能力 | 唯一实现位置 | 行为 | 验证 |
| --- | --- | --- | --- |
| 列表与选择 | `MonitorRouter` | a 切换全部／仅活跃，保持任务身份；空筛选提示恢复全部 | monitor-ux、monitor-input |
| 分类与任务导航 | `MonitorRouter` | 左右键切换分类；[ / ] 切换相邻任务；Esc 返回当前列表选择 | monitor-ux、monitor-input |
| 阅读位置 | `MonitorRouter` | 每个任务、每个分类保存位置；交接首次从顶部读，其余首次跟随末尾 | monitor-ux、monitor |
| 跟随 | `MonitorRouter` | 末尾向下不暂停；向上或 Home 进入浏览；f / End 恢复跟随；状态始终可见 | monitor-ux、monitor-input |
| 日期时间 | `formatMonitorTime` | 事件和用量均使用本地时区，事件带日期和“本地”；非法时间显示未知 | monitor-ux |
| 样式与记录 | `MonitorStyle`、`renderFeedLayout` | 不同内容类别保留文字标签；工具与思考共用 t 展开状态 | monitor |
| 用户终止 | `MonitorRouter`、`requestTaskTermination`、`Supervisor` | x 选中当前任务，y 确认，Esc/n 取消；请求按线程、实例、批次及任务绑定；服务确认停止后才显示 terminated by user | monitor-control |

列表短编号在一次 monitor 运行中按完整任务身份分配，重排不会改变已有编号，不作为持久任务 ID。信息页显示真实 MCP 会话、批次和任务 ID。

活跃筛选只影响列表及相邻任务导航；正在阅读的任务即使完成，也不会突然消失。跨任务切换保留当前分类，分别恢复各项任务的阅读位置。

已结束且有交接的任务首次打开时直接进入交接。此后尊重用户保存的分类与位置，不因任务更新切走当前页面。

本地视图状态只保存在进程内，不写回 worker 或状态文件。历史保留规则仍由状态目录配置决定。

用户终止是明确的控制操作。确认页固定目标身份，不随任务排序或筛选变化；排队任务不再启动，运行中任务先取消，必要时由服务回收对应进程树。其他任务继续运行，已有文件改动保留。请求已发送不等于已终止；失败或等待确认超过 10 秒时明确提示，禁止自动重试。MCP 最终结果使用 `cancelled`、`terminated_by_user` 和 `terminated by user`，主 agent 不自动重新委派或接管该任务。

## Do's and Don'ts

- 优先让用户读到结论、状态和恢复操作。
- 将用户主动浏览和实时跟随区分开，避免刷新把用户拉走。
- 不自动把活跃任务重排到前方；使用显式筛选，避免选择行跳动。
- 不把工具 PTY 或 queued 开窗请求当作用户已看到窗口的证据。
- 不把单元测试、字符渲染或静态审查称为跨平台实机或辅助功能验收。
