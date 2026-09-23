# 权限分析基础模块

来源：[@gotgenes/pi-permission-system 33.0.5](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)，MIT 许可证见 [LICENSE](LICENSE)。

仅提取并适配以下模块，随 TypeScript 一起编译：

- `src/access-intent/bash/parser.ts` 的 WASM 初始化与解析器缓存。
- `src/access-intent/bash/async-cache.ts` 的失败后重试缓存。
- `src/path/canonicalize-path.ts` 的最近存在祖先解析。改为使用宿主路径策略；解析失败、悬空链接不再回退到词法放行。

未引入上游扩展注册、配置加载、多层规则、会话授权、交互 UI、日志系统、基础设施路径豁免和工具别名。Bash AST 的保守范围判定及工作区策略位于 `src/permission-policy.ts`：只接受已识别的简单命令和字面量路径，其余请求 Codex 审批。

运行时保留 `web-tree-sitter`。`tree-sitter-bash@0.25.1` 仅用于构建：`scripts/runtime-assets.mjs` 校验版本和固定 SHA-256，再把 `tree-sitter-bash.wasm`、其 MIT 许可证、版本及哈希信息复制到编译后的本目录。运行包无需安装它的 C 源码、原生绑定和预编译二进制；加载器只读取相邻 WASM。缺失或解析失败仍走既有拒绝/审批逻辑，不回退到宽松字符串判断。升级 grammar 时必须同时审核并更新构建脚本中的版本和哈希。

升级时对照上述上游文件审核变更，并运行 permission-policy、permission-files-sdk、permission-approval-sdk 和 runtime 测试。此处是应用层工具检查，不是操作系统沙箱。
