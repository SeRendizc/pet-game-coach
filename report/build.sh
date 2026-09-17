#!/usr/bin/env bash
# 构建报告 PDF。
#
# 依赖：tectonic（XeTeX 引擎）。它自带包管理与按需下载，不需要完整 TeX Live。
#   macOS:  brew install tectonic
#   或直接下载单文件二进制：https://github.com/tectonic-typesetting/tectonic/releases
#
# 为什么用 tectonic 而不是 MacTeX：本机 /opt/homebrew 无写权限，装不了 cask；
# tectonic 是单文件，放哪儿都能跑。中文来自 macOS 系统字体（Songti/Heiti/Kaiti），
# 已实测可被 XeTeX 找到（包括 AssetsV2 里的字体）。
set -euo pipefail
cd "$(dirname "$0")"

# 找 tectonic：显式环境变量 > 仓库内自带 > PATH。
# 原来的默认值是光秃秃的 "tectonic"，而本机二进制在 tmp/tex/ 下，
# 于是直接跑 ./report/build.sh 会 command not found——README 里写的命令跑不了。
if [ -z "${TECTONIC:-}" ]; then
  if [ -x ../tmp/tex/tectonic ]; then TECTONIC=../tmp/tex/tectonic
  elif command -v tectonic >/dev/null 2>&1; then TECTONIC=tectonic
  else
    echo "找不到 tectonic。装一个（brew install tectonic），或把二进制放到 tmp/tex/tectonic，" >&2
    echo "或用 TECTONIC=/path/to/tectonic 指定。" >&2
    exit 1
  fi
fi
CACHE="${TECTONIC_CACHE_DIR:-../tmp/tex/cache}"
OUT="${1:-../output/pdf}"

# Markdown 残留检查。
# 这个报告用 LaTeX 写，曾经有 **粗体** 原样印进 PDF——不报错、不警告，只是难看地出现在成品里，
# 所以必须机械拦一道。注意它必须在 cd 之后：放在 cd 之前时，sections/*.tex 相对的是调用者目录，
# 从仓库根运行会找不到文件而静默通过（第一版就是这么写的）。
if grep -nE '(^|[^\\])\*\*|^#{1,6} ' sections/*.tex main.tex 2>/dev/null | grep -v '^\s*%'; then
  echo "" >&2
  echo "上面这些行里有 Markdown 记号，LaTeX 不会解释它们，会原样印出来。" >&2
  echo "粗体用 \\textbf{}，标题用 \\section{}。" >&2
  exit 1
fi

mkdir -p "$CACHE" "$OUT"
TECTONIC_CACHE_DIR="$CACHE" "$TECTONIC" -X compile main.tex --outdir "$OUT"

# 统一输出文件名
[ -f "$OUT/main.pdf" ] && mv -f "$OUT/main.pdf" "$OUT/xiaoya-coach-report.pdf"
echo "→ $OUT/xiaoya-coach-report.pdf"
