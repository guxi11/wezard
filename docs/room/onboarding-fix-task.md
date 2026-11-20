# 新群引导按 room 设计重做 (任务文件, 以本文件为准)

人 2026-11-20 下令「修」。诊断见群消息 6b664ebb.203。派活方: .guidewrong。

## 现象 (2026-11-20 15:01 实录)
新群首句「@wezard 在 ~/develop/Tencent 下创建一个 dhtpm 的目录，并在里面初始化 codebuddy.md，然后绑定它为 workspace」:
- guideGate (daemon/inbound.ts:1126) 用 workspaceInput 取第一个路径片段 `~/develop/Tencent`, 存在 → bind-new, 0.5s 内建管家, 工作区记成父目录; dhtpm / codebuddy.md / 绑定它 全丢。
- 引导化身根本没起 (只在 retry 时起), 没有任何对话。
- 触发绑定的这句被吞 (guideGate return true), 没交给新管家; 人只能引用重发。
- room 账本: 绑定后下一条人话才 open room, founder = 管家 (index.ts ensureBoundRoom ≈1770); guide 从不进 room。
- 另: room 模型里终句零语义, 而 guideRefusal 拒掉全部 wezard MCP —— 引导化身在 room 世界里**根本没法说话** (chat_reply 也被拒)。

## 设计依据
docs/room/contract.md §4: 新群 guide 以 founder (ord=1) 入 room 即 host; 交接 = 邀请人指定的管家入群, 然后 guide room_leave → host 落到管家。daemon 仍是状态机主人 (校验 / 落盘 / 绑定都在 daemon), guide 只表达 + 发起一次受控绑定。

## 要做的
1. **快路径只收「纯答案」**: 整句 (strip @ 与首尾引号/标点后) **就是**一个路径, 或**就是**一个名册命中的管家名 → 保留现有一步绑定 (judgeOnboarding/applyOnboarding)。其它任何句子 (含路径但还有别的话、相对路径、什么都认不出) 一律交引导化身, 不再从长句里抽第一个路径绑。斜杠命令 / .name / /id /help 行为不变。
2. **guide 入 room 当 founder**: 交给引导化身时, 该群 room 由 guide 作 founder (ord=1) 开出, 人这句落账本并唤醒 guide (确认 ensureBoundRoom 在未绑定群里确实以 guide 为 founder; 不是就改)。
3. **guide 的工具面 = 白名单三项**: `chat_reply` / `chat_say` (只限本群 room) + 新增 `onboard_bind`。其余照旧拒 (approval.ts ≈2143 与 index.ts refuseGuide ≈731 两处都改成白名单; guideRefusal 加 action 白名单参数或单独判)。
4. **新 MCP `onboard_bind({workspace?, create?, name?})`** (mcp/server.ts + daemon 路由, 只许引导化身调, 其余 403):
   - workspace: 绝对或 ~ 开头; `create:true` 时允许 mkdir **最后一级** (父目录必须已存在、目标必须在 $HOME 下, 已存在就当普通目录); 否则必须已存在。name: 绑已有管家 (同 judgeOnboarding 名字分支)。两者给一个。
   - 校验失败 → 4xx 带原因, 引导继续 (guide 自己向人追问)。
   - 成功: judgeOnboarding + applyOnboarding (bindSteward 包 guardCharter, 照现有写法) → room 里 ① 管家 join (via invite, by guide) ② guide 名下本 room 的未结 duty 全部 move 给管家 (复用 /room/transfer 的 move op 写法) —— 人的原话因此交到管家手上并唤醒它 ③ guide leave (leaveOps; 此时它手上已无 duty, 不应产生 canceled 行) → host = 管家 ④ 落「[wezard] ✅ 引导完成 …」系统行进 room (镜像进企微; 用 renderOnboardingDone)。
   - guide 收尸: 工具调用先返回成功, 等它这一轮结束 (或 60s 上限) 再 killPane + drop; drop 不得再触发 leaveRooms 产生多余 canceled 行。
5. **guide 话术** (renderGuideOpening / renderGuideRetry 重写): 说明它只有 chat_reply / chat_say / onboard_bind; 目标是定下管家工作目录; 「在 X 下建 Y 并绑定」这类话直接 onboard_bind({workspace:"X/Y", create:true}); 有歧义才用 chat_reply(status:"need") 问人; 句子里绑定之外的要求 (如初始化 codebuddy.md) **不要自己做也不要答**, 绑定后随 duty 转给管家; 绑定前不要 done 关人的那条。
6. 已在途 (onboarding.json 里有) 但 guide 不在 room 的老群: 下一句人话按新流程走即可, 不做迁移。

## 验收 (逐条贴证据)
- tests/onboarding.test.ts 补/改: 纯路径快路径绑定; 今天那句原文 → 不绑定、交 guide; onboard_bind create 只建一级 / 父不存在拒 / $HOME 外拒 / 非 guide 调用 403; guide 白名单 (chat_reply 放, set_workspace 拒); 绑定后 room 状态: 管家是成员且 host、guide 已离开、人那条 duty 的 holder 是管家、无 canceled 行。
- `npx tsx tests/onboarding.test.ts` 与 tests/room-leave-cancel.test.ts 各跑一次贴 rc; `npm run typecheck` + `npm run build` 绿。
- 不 reload daemon (由派活方验收后统一 reload)。

## 约束
- 只改 daemon/ shared/ mcp/ 与上面点名的 tests; 共享工作树, 只 stage 自己的文件, edit→add→commit 压进同一条 Bash, commit 前看 `git diff --cached --stat`。
- 提交信息前缀 fix(onboarding):; CHANGELOG [Unreleased] 加一条 Fixed。
- 完成后用 chat_reply(status:"done") 交代: commit、改了哪些文件、各测试 rc、遗留。

## 进度 (执行者自维护)
- [x] 1 快路径收窄
- [x] 2 guide founder — ensureBoundRoom 原本不会给未绑定群开 guide room (它先 resolveSteward, 回落 routed), 所以 new 了一条: index.ts `guideTakeover` 显式开 room + guide 作 founder ord=1
- [x] 3 白名单 (GUIDE_TOOLS; 本群 room 的限制在 /room/say 与 /room/reply 的 guideOutsideRoom)
- [x] 4 onboard_bind (+ planOnboardBind 纯判定; 轮终后收尸)
- [x] 5 话术 (renderGuideOpening 现在是引导的「宪章」)
- [x] 测试 + typecheck + build + 提交 — d493ca6; onboarding.test.ts rc=0, room-leave-cancel.test.ts rc=0, typecheck/build 0
