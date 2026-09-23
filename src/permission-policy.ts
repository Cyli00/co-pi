import { dirname, join, relative, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Node } from "web-tree-sitter";
import { getParser } from "./vendor/pi-permission-system/parser.js";
import { canonicalizePath } from "./vendor/pi-permission-system/canonicalize-path.js";

type Reason = { surface: string; path?: string; target?: string };
const fileTools = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const sdkPaths = import(pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/tools/path-utils.js")).href) as Promise<{
  resolveReadPath(path: string, cwd: string): string;
  resolveToCwd(path: string, cwd: string): string;
}>;

export async function resolvedToolInput(toolName: string, input: Record<string, unknown>, cwd: string) {
  if (!fileTools.has(toolName)) return input;
  const paths = await sdkPaths;
  const path = typeof input.path === "string" ? input.path : ".";
  return { ...input, path: toolName === "read" ? paths.resolveReadPath(path, cwd) : paths.resolveToCwd(path, cwd) };
}

function literal(node: Node): string | undefined {
  if (node.type === "word" && !/[\\\$`*?\[\]{}~]/.test(node.text)) return node.text;
  if (node.type === "raw_string") return node.text.slice(1, -1);
  if (node.type === "string" && node.namedChildren.every(child => child.type === "string_content")
    && !/[\\\$`]/.test(node.text)) return node.text.slice(1, -1);
  return undefined;
}

// 只接受单条简单命令；复合语句、解释器、Git 和选项内的间接输入均交给审批。
function simpleCommandPaths(root: Node): string[] | undefined {
  if (root.hasError || root.namedChildren.length !== 1) return;
  let statement = root.namedChildren[0]!;
  const paths: string[] = [];
  if (statement.type === "redirected_statement") {
    const body = statement.childForFieldName("body");
    if (!body) return;
    for (const redirect of statement.namedChildren.filter(child => child !== body && child.id !== body.id)) {
      if (redirect.type !== "file_redirect") return;
      const destination = redirect.childForFieldName("destination");
      if (!destination || redirect.namedChildren.length !== 1) return;
      const operator = redirect.children.filter(child => !child.isNamed).map(child => child.text).join("");
      if (![">", ">>", "<"].includes(operator)) return;
      const path = literal(destination);
      if (path === undefined || !path) return;
      paths.push(path);
    }
    statement = body;
  }
  if (statement.type !== "command") return;
  const nameNode = statement.childForFieldName("name");
  const name = nameNode?.text;
  if (!name || !["pwd", "echo", "printf", "cat", "head", "tail", "wc", "ls"].includes(name)) return;
  const args: string[] = [];
  for (const node of statement.namedChildren) {
    if (node.id === nameNode!.id) continue;
    const value = literal(node);
    if (value === undefined) return;
    args.push(value);
  }
  if (name === "pwd" && args.some(arg => !["-L", "-P", "--"].includes(arg))) return;
  if (name === "printf" && args[0]?.startsWith("-")) return;
  if (!["pwd", "echo", "printf"].includes(name)) {
    let options = true;
    const flags: Record<string, RegExp> = { cat: /^-[AbEenstTuv]+$/, head: /^-[0-9]+$/, tail: /^-[0-9]+$/, wc: /^-[clmwL]+$/, ls: /^-[alhd1]+$/ };
    for (const arg of args) {
      if (options && arg === "--") { options = false; continue; }
      if (options && arg.startsWith("-") && arg !== "-") {
        if (!flags[name]!.test(arg)) return;
      } else if (arg !== "-") paths.push(arg);
    }
  }
  return paths;
}

export async function createPermissionPolicy(cwd: string) {
  const workspace = canonicalizePath(cwd);
  const checkPath = (path: string, reasons: Reason[]) => {
    try {
      const target = canonicalizePath(resolve(cwd, path));
      const inside = relative(workspace, target);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        reasons.push({ surface: "external_canonical_path", target });
      }
    } catch { reasons.push({ surface: "unresolved_path", path }); }
  };
  return async (toolName: string, rawInput: Record<string, unknown>): Promise<Reason[]> => {
    const input = await resolvedToolInput(toolName, rawInput, cwd);
    const reasons: Reason[] = [];
    if (fileTools.has(toolName)) {
      checkPath(String(input.path), reasons);
    } else if (toolName === "bash") {
      // spawnHook 可以改变工作目录；相对路径必须对应实际执行目录。
      if (typeof input.workdir === "string" && resolve(input.workdir) !== resolve(cwd)) {
        reasons.push({ surface: "unknown_workdir", path: input.workdir });
        return reasons;
      }
      try {
        const command = String(input.command ?? "");
        // Bash 先消除续行；解析器可能把同一参数拆开，不能分别判断路径。
        if (/\\\r?\n/.test(command)) return [{ surface: "unknown_execution" }];
        const tree = (await getParser()).parse(command);
        if (!tree) return [{ surface: "unknown_execution" }];
        try {
          const paths = simpleCommandPaths(tree.rootNode);
          if (!paths) reasons.push({ surface: "unknown_execution" });
          else for (let path of paths) {
            // Shell 的链接/.. 按物理路径解析，不能用 resolve 的词法折叠放行。
            if (path.split(process.platform === "win32" ? /[\\/]/ : /\//).includes("..")) {
              reasons.push({ surface: "parent_shell_path", path });
              continue;
            }
            if (process.platform === "win32" && path.startsWith("/")) {
              // Git Bash 的盘符挂载可以准确换算，/tmp、/etc 等虚拟根交给审批。

              if (/^\/[a-zA-Z](?:\/|$)/.test(path)) path = `${path[1]}:/${path.slice(3)}`;
              else { reasons.push({ surface: "unknown_shell_path", path }); continue; }
            }
            if (path.startsWith("~")) reasons.push({ surface: "unknown_shell_path", path });
            else checkPath(path, reasons);
          }
        } finally { tree.delete(); }
      } catch { reasons.push({ surface: "unresolved_shell" }); }
    } else reasons.push({ surface: "unknown_tool" });
    return reasons;
  };
}

export type PermissionPolicy = Awaited<ReturnType<typeof createPermissionPolicy>>;
