export interface MonitorColorOptions {
  color?: boolean;
  "no-color"?: boolean;
  open?: boolean;
  once?: boolean;
}

export function resolveMonitorColor(options: MonitorColorOptions, env = process.env): boolean {
  if (options.color && options["no-color"]) throw new Error("--color 不能与 --no-color 合用。");
  if (options["no-color"]) return false;
  if (options.color) return true;
  // 独立桌面窗口使用自身的彩色主题，不继承 agent 捕获输出时注入的 NO_COLOR。
  if (options.open) return true;
  if (options.once) return false;
  return !env.NO_COLOR;
}
