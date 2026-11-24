# multi-source-binding · DONE 收口 (任务文件, 以此为准)

仓库 /Users/zyy/develop/Guxi11/cc-wecom, 分支 v3 (勿切勿 push)。特性五笔已落: 08843a2+b11974c 设计稿 / 6a3e758 拍板落稿 / 28b3471 P1 / f172181 P2 / 52e665d P3 / ba58723 P4。收口只做文档与全量验证, 不改运行逻辑 (发现真 bug 就停下来 chat_reply need 报我)。

## 要做的事
1. docs/dev-guide.md: 按其现有体例补「新 MCP 工具三处联动」清单条目 —— room_bind / room_unbind / room_fork 的 mcp/tools.ts 注册 + daemon 路由 + charter 名册 (参照 §10 工具面三处联动)。若已有通用清单, 把三个工具补进对应小节即可, 别重构文档。
2. daemon/wizard.ts charter 行 (P4 补的那行) 核一遍措辞: 是否讲清「频道 @ 你先落频道 room 交你判: 该我的 room_bind / 旧 room 找那个 host / 该另起 room_fork / 不判 10 分钟自动另起」。需要就在不破坏 charter.test 的前提下微调。
3. CHANGELOG.md Unreleased: 一条特性条目 (room↔信息源多对一绑定: 源与 room 解耦、bind/unbind 账本 op+boot 索引对账闸、出站按行目标源、频道 @ 首触交 host 判定+10min 兜底、dry-run 证据、room_fork、频道成员补拉; 无出站额度)。按仓里现有 changelog 风格写。
4. 全量测试: 跑 tests/*.test.ts 全套 (已知 13 个历史基线红外, 列出名单即可不算失败); npx tsc --noEmit。
5. rolepage 绑定展示 (设计稿 §10 提到) —— 本阶段**不做**, 留作后续单独活, 在交代里注明。

## 纪律
不 push 不 reload 不 build; 只动 docs/、daemon/wizard.ts (charter 措辞)、CHANGELOG.md、本任务文件; pathspec 提交; commit: docs(room): msb 收口 dev-guide/charter/CHANGELOG + 全量测试记录

## 交代
chat_reply (status done): commit、全量测试结果 (含基线红名单)、取舍/遗留。卡住 need。

## 进度 (执行者自维护)
- [ ] dev-guide 三处联动条目
- [ ] charter 措辞核对
- [ ] CHANGELOG Unreleased
- [ ] 全量测试 + tsc
- [ ] pathspec 提交 + 交代

