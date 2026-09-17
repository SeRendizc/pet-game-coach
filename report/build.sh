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

TECTONIC="${TECTONIC:-tectonic}"
CACHE="${TECTONIC_CACHE_DIR:-../tmp/tex/cache}"
OUT="${1:-../output/pdf}"

mkdir -p "$CACHE" "$OUT"
TECTONIC_CACHE_DIR="$CACHE" "$TECTONIC" -X compile main.tex --outdir "$OUT"

# 统一输出文件名
[ -f "$OUT/main.pdf" ] && mv -f "$OUT/main.pdf" "$OUT/xiaoya-coach-report.pdf"
echo "→ $OUT/xiaoya-coach-report.pdf"
