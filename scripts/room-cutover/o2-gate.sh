#!/usr/bin/env bash
# O2 账实闸 (cutover 第 8 步 / O2 演练共用): daemon /status.openDuties (内存) 对 observe.mjs
# duties 重放盘上账本 (第 6 步迁移写入并报告的那个目录)。不等 = daemon 起来时账本没接上 → 红,
# 打印两个数, 调用方 (run-cutover.sh) 据此逆序回退。
# 两次取数之间恰好有新 duty 落账会假红一次, 隔 3s 重取一遍再定。
# 用法: o2-gate.sh <status URL> <账本目录>    exit 0 = 绿, 1 = 红
set -uo pipefail
URL=${1:?需要 /status URL}
ROOMS=${2:?需要账本目录}
HERE=$(cd "$(dirname "$0")" && pwd)

read_mem() {
  curl -s --noproxy '*' -m 5 "$URL" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.openDuties===undefined?"ERR":String(j.openDuties))})'
}
read_disk() {
  node "$HERE/observe.mjs" duties --rooms "$ROOMS" 2>/dev/null | sed -n 's/^duties: \([0-9][0-9]*\) 条未结.*/\1/p'
}

mem=$(read_mem); disk=$(read_disk)
if [ "$mem" != "$disk" ]; then sleep 3; mem=$(read_mem); disk=$(read_disk); fi
if [ -z "$mem" ] || [ -z "$disk" ] || [ "$mem" != "$disk" ]; then
  echo "O2 RED: 内存未结 duty ${mem:-<取不到>} != 账本重放 ${disk:-<取不到>} (重放自 $ROOMS)"
  exit 1
fi
echo "O2 GREEN: 内存未结 duty $mem == 账本重放 $disk (重放自 $ROOMS)"
