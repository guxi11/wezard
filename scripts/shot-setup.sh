#!/bin/sh
# 一次性装好 scripts/shot.mjs 要用的 headless 浏览器, 全程不用 sudo、不动系统配置:
#   1. npx playwright install chromium-headless-shell  → ~/.cache/ms-playwright (~290MB)
#   2. 浏览器缺的系统共享库 (无桌面机器常缺 libatk / libgbm …): `apt-get download` 取 .deb, dpkg -x 解到
#      ~/.cache/wezard-shot-libs/root (~4MB), shot.mjs 启动浏览器时自动把它挂进 LD_LIBRARY_PATH。
#   3. 中文 + emoji 字体 (无桌面机器没有, 截出来全是方块): wqy-microhei (~5MB) + Noto Color Emoji (~10MB)
#      解到 ~/.local/share/fonts/wezard-shot (用户字体目录, fontconfig 默认就扫)。
# 重跑幂等。注意: 仓库若在 NODE_ENV=production 的机器上, 先 `npm install --include=dev` (playwright 是 devDependency)。
set -eu
cd "$(dirname "$0")/.."
npx playwright install chromium-headless-shell
BIN=$(ls "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell | tail -1)
LIBS="$HOME/.cache/wezard-shot-libs"
export LD_LIBRARY_PATH="$LIBS/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
for _ in 1 2 3; do
  MISSING=$(ldd "$BIN" | awk '/not found/ {print $1}')
  [ -z "$MISSING" ] && break
  mkdir -p "$LIBS/debs"
  # 已在 Ubuntu 22.04 (jammy) 上验证过的清单; 别的发行版缺库时脚本会在末尾报出缺哪些
  PKGS="libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libasound2 libatspi2.0-0 libxrender1 libwayland-server0 libxcb-randr0 libxi6"
  (cd "$LIBS/debs" && apt-get download $PKGS >/dev/null 2>&1 || true)
  for d in "$LIBS"/debs/*.deb; do dpkg -x "$d" "$LIBS/root"; done
done
STILL=$(ldd "$BIN" | awk '/not found/ {print $1}')
[ -z "$STILL" ] || { echo "仍缺共享库: $STILL (需要 sudo apt install 对应包)" >&2; exit 1; }
FONTS="$HOME/.local/share/fonts/wezard-shot"
if [ ! -f "$FONTS/wqy-microhei.ttc" ] || ! ls "$FONTS"/*Emoji*.ttf >/dev/null 2>&1; then
  mkdir -p "$LIBS/debs" "$FONTS" "$LIBS/fontroot"
  (cd "$LIBS/debs" && apt-get download fonts-wqy-microhei fonts-noto-color-emoji >/dev/null 2>&1 || true)
  for d in "$LIBS"/debs/fonts-*.deb; do dpkg -x "$d" "$LIBS/fontroot"; done
  find "$LIBS/fontroot" \( -name '*.ttc' -o -name '*.ttf' \) -exec cp {} "$FONTS"/ \;
  rm -rf "$LIBS/fontroot"
fi
echo "shot: 浏览器就绪 → $BIN"
