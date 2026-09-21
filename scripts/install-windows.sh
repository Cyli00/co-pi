#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -x /c/Git/bin/bash.exe ]]; then
  printf '%s\n' '请先将 Git for Windows 安装到 C:\Git，确保 C:\Git\bin\bash.exe 可用。' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js ≥ 22.19.0，并加入 PATH。' >&2
  exit 1
fi
exec node "$script_dir/install.mjs" --platform win32 "$@"
