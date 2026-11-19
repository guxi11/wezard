# room 模型实施 · 共用简报 (lead: .LeoAdams)

契约 (已拍板, 不再论证): docs/room/contract.md
设计稿 (背景): docs/room/design.md
纯核心已落 (分支 room-model @ 12e7ef4): shared/room.ts (类型 / fold / judge / hostOf / mirrors / uidOf / dmRoomId / renderMsgLine / unreadFor), daemon/rooms.ts (每 room 一个 jsonl 的 store, fsync), daemon/wizard.ts (WizardRecord.uid + store.byUid)。读它们就知道数据形状; 不要改它们的语义, 需要新增纯函数可以加, 改签名先问 lead。

## daemon HTTP 契约 (lead 在主分支实现; 你们按这个对接)
全部 POST, body 由 MCP 侧带 selfRef (现有 daemonPost 已自动带, 照 mcp/tools.ts 现有写法)。成功 {ok:true, room, id?, ...}; 失败 {ok:false, reason} + 400/403/409。
- /room/say     {room?, text, to?: string[], interrupt?: boolean}
- /room/ask     {room?, to: string[], text, kind?: "ask"|"task", after?: string[], for?: string, planId?: string, interrupt?: boolean}
- /room/reply   {re: string[], text?: string, status?: "done"|"need"|"progress"|"passed"|"canceled"}
- /room/notify  {room?: string[], markdown}
- /room/file    {room?, path, kind?, caption?, title?, description?, re?}
- /room/open    {with: string[], title?}
- /room/invite  {room, who}
- /room/join    {room, reason}
- /room/approve {re, accept: boolean}
- /room/leave   {room, who?}
- /room/members {room?}                         → 纯文本
- /room/transfer{re, to}
- /room/read    {room?, from?, since?, until?, limit?, all?: boolean, per?}  → 纯文本
- /room/watch   {room, on: boolean}
- GET /api/room?id=&before=&limit=  (rolepage; svr 侧同名接口读快照或转发)
room 参数: room id (`chat:…` / `user:…` / `dm:…` / `adhoc:…`) 或聊天名; to / who: wizard 名 (带不带 '.')。

## 删除面 (你们这边若碰到就按此删, 不留兼容)
tell_peer、read_chat、chat_members、list_chats 的 strict 说明; tell_peer 的 return/public/fyi/priority 参数; topOnly / speech(strict|implicit) / 「严格模式」一切文案。

## 工作纪律
- 只在**自己的 worktree** 里改, 只 commit 自己的文件 (git add <具体路径>), 不 push, 不 reload, 不碰 ~/.wezard。
- typecheck: `npx tsc --noEmit -p .`; 单测: `npx tsx tests/<x>.test.ts`。
- 交付: 行首 `.LeoAdams RESULT:` + 分支名 + commit + 改了什么 + 「取舍 / 遗留」。
