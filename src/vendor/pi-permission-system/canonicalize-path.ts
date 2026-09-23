import { lstatSync, realpathSync } from "node:fs";
import { parse, sep, join } from "node:path";

// 改编上游最近存在祖先解析：无法解析时必须审批，不退回词法路径放行。
export function canonicalizePath(absolutePath: string): string {
  const root = parse(absolutePath).root;
  if (!root) throw new Error("absolute_path_required");
  const parts = absolutePath.slice(root.length).split(sep).filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const candidate = root + parts.slice(0, i).join(sep);
    try {
      return join(realpathSync(candidate), ...parts.slice(i));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // 悬空链接不是普通的新建文件，不能按工作区内的缺失祖先放行。
      try { if (lstatSync(candidate).isSymbolicLink()) throw new Error("unresolved_symlink"); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
    }
  }
  throw new Error("unresolved_path");
}
