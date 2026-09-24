#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$OSTYPE" == msys* ]]; then
  script_dir="$(cygpath -m "$script_dir")"
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js ≥ 22.19.0，并加入 PATH。' >&2
  exit 1
fi
exec node "$script_dir/install.mjs" "$@"
