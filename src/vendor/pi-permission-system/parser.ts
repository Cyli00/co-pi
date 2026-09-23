import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { memoizeAsyncWithRetry } from "./async-cache.js";

// 提取上游的 WASM 解析器初始化；不加载扩展、会话规则或审批界面。
async function initParser() {
  const { Parser, Language } = await import("web-tree-sitter");
  const req = createRequire(import.meta.url);
  const treeSitterWasm = req.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => treeSitterWasm });
  const parser = new Parser();
  const bash = await Language.load(fileURLToPath(new URL("./tree-sitter-bash.wasm", import.meta.url)));
  parser.setLanguage(bash);
  return parser;
}
export const getParser = memoizeAsyncWithRetry(initParser);
