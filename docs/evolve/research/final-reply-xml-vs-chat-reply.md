# 终句内嵌 `<reply re= to=>` 回执 vs `chat_reply` 工具

> 分析 `.Victor` (派活 `.wezard-1`) · 2026-11-21 · 只分析、不改代码
> 代码证据基于 `v3` HEAD `e81f274`; 账本 / 日志实测取自本机 `~/.wezard/state/rooms/*.jsonl` 与 `daemon.log` (只读)
> 前作: `agent-team-comms.md` (.Frank, 基于 `cf3e0b3`, 是 room 切换**之前**的代码); `docs/room/design.md` §C2

## 0. 结论先行

**不建议把终句 XML 做成完成 / 路由信号。** `chat_reply` 继续作为唯一的完成信号。终句可以拿来当**内容兜底**, 但不能当**完成信号**。

1. **业内「终句即返回值」成立, 靠的是一个 wezard 没有的前提: 调用和任务 1:1, 返回地址由调用栈隐含。** subagent、`as_tool`、LangGraph 的 subagent 都是「一次调用、一个任务、一个调用方」, 所以终句不需要写地址。wezard 的 wizard 是长寿会话, 同时身处多个 room, 一轮可能同时服务好几条 duty (实测 68 条 reply 里有 4 条 `re` 是数组, 还有「补充合并」的输入)。一旦要在终句里写 `re=` / `to=`, XML 就只是把 `chat_reply` 的参数挪进了正文, 同时丢掉 schema 校验、即时回包 (403/409 当轮可改), 也丢掉了轮中送达。Claude Code 自己的跨会话消息 (同样是长寿的对等会话) 也规定**回复不自动, 要显式 `SendMessage`**。
2. **这几乎就是 2 天前 `fd4715b` 刚删掉的那套机制。** 被删的是 `router.ts` 896 行和 `message-events.ts` 1202 行, 包括 `.name RESULT:` 分段、`settleFinal`、inputIds 覆盖和纠正回路。`design.md` §C2 把「终句兜底自动投递」(F-2) 判为「199 次返修的病根」。和 `RESULT:` 相比, XML 确实少了两项推断:
   - 「这句话是不是定论」: 标签本身就说明了;
   - 「轮在哪里结束」: 只对 claude 成立, 靠 Stop hook 的 `last_assistant_message`。

   但在 codebuddy / claude-internal / codex 上, 这两项推断照样要做。XML 还新增了一个风险: **被引用的 XML 会被误解析**。
3. **XML 想解决的「漏调工具」, 已经被轮内的门基本压住了。** 实测 (§3):
   - room 切换 (11-19) 后出现过 7 条「被提醒后仍没有交代」系统行。其中至少 4 条是 progress 误报 (`e98bf0c` 已修), 只有 1 条是真漏 (`7aeb85fc.39`, 管家派完活忘了回)。
   - Stop hook 上线 (`fa50d5a`, 11-21 00:44Z) 之后拦过 2 次, 两次都在**同一轮内 5s / 18s** 补上了 `chat_reply`, 此后没有再出现系统行。

   样本还小, 需要继续量 (R4), 但现在没有证据说明需要第二条完成通道。

**推荐方案 (混合, 但完成信号只有一个)**: 「工具关账 + Stop hook 轮内门 + 终句只当草稿 / 内容兜底」。下面 R1–R5 都不引入新的完成语义:

| # | 改动 | 解决什么 |
|---|---|---|
| R1 | `hooks/stop.sh` 把 `last_assistant_message` 一并 POST 给 daemon, daemon 暂存为这一轮的终句草稿。block 的 reason 里允许用 `chat_reply({re, fromFinal:true})` 一键发出草稿原文 | 漏调时不用把长结论重写一遍, 省输出 token; 仍然是模型显式确认 |
| R2 | 已拦过一次仍没交代时, escalate 系统行附上终句草稿的摘录, 标「未确认交代」, **不关账** | 提问者至少能看到内容, 而不只是一句「没交代」(这是 F-3 的窄版, 只用在最后一道兜底) |
| R3 | 把 Stop hook 扩到 claude-internal / codebuddy (先实测 `decision:"block"`), codex 接它自己的 Stop 事件 (版本支持的话) | 轮内门覆盖到全部后端; 这比 XML 的跨后端收益更大 |
| R4 | 记三个计数: 拦截率、拦截后同轮自愈率、escalate 数 (现在只有一行 info 日志) | 给「要不要上 XML」一个数据闸门 |
| R5 | 清死代码: `daemon/index.ts:120` 从 peers 引入的 `parseClosing` / `addressedResults` / `receiptKeyword` / `stripClosingMark` / `renderReceiptEnvelope` 没有任何调用; `mirror-bridge.ts:72` 的 `parseClosing` / `stripForChat` 同样只有 import | 防止旧的终句语义被人「顺手接回来」 |

---

## 1. 业内回执模型

| 系统 | 结果怎么回 | 地址从哪来 | 中途进展 | 完成由谁判 |
|---|---|---|---|---|
| Claude Code subagent (Task / Agent) | 只把最终消息作为工具结果 (或后台完成通知) 交回父会话 | 调用栈: 谁 spawn 就回给谁 | 没有 (中间过程留在子会话里) | 子会话停下 = 完成 |
| Claude Code agent teams | teammate 停下时, idle 通知**自动带上终答**给 lead; 另外有显式 `SendMessage` 邮箱 | lead 固定 | 显式 `SendMessage` | task 状态要显式写, 官方承认 "sometimes fail to mark tasks as completed"; 用 `TaskCompleted` / `TeammateIdle` hook (exit 2) 在轮内拦 |
| Claude Code 跨会话消息 | **回复不自动**, 收方要再调一次 `SendMessage` | 显式写 | 显式 | 无完成概念 |
| OpenAI Agents SDK | `as_tool`: 终答作为工具返回值; handoff: 控制权直接转给对方, 不回执 | 调用栈 / 单次 run | 无 | run 结束 |
| AutoGen | 群聊共享线程; Core 的 `send_message` 返回 handler 的返回值 | 共享上下文 / RPC | 群聊里随时说 | 终止条件 |
| LangGraph / LangChain | subagent 取 `messages[-1]`; handoff 用 `Command(goto, update)` 写 state | 图的边 | 写进 state | 节点返回 |
| CrewAI | task 输出作为下一件 task 的 context; 委托以工具调用的形式进行 | 流程定义 | 无 | task 返回 |

**两类模型, 分界线是「返回地址是不是隐含的」。**
- 一次调用对应一个任务 (前四行的 subagent / as_tool / LangGraph / CrewAI): 终句就是返回值。模型不用记、不会漏, 但也只能回一次, 而且只能回给调用方。
- 长寿的对等会话 (teams 邮箱、跨会话消息): 一律显式发送。各家也承认显式状态会漏, 补救办法是 hook 在**轮内**拦截。

两者叠加的产品 (Claude Code teams) 的做法是: 终答自动**捎给 lead 当通知**, 不当 task 完成。这和下面的 R1/R2「终句当草稿 / 内容兜底, 不关账」同构。

wezard 的 wizard 属于第二类。它被唤醒的一轮不是「一次调用」: 同一轮可能同时服务多个 room 的多条 duty, 还会收到中途补充; 一条 duty 也常常要跨好几轮 (先回 progress, 下一轮才回 done)。

## 2. 逐维对比

方案 X 指: 终句内嵌 `<reply re=… to=…>…</reply>`, daemon 从终句解析并转发, Stop hook 校验。方案 T 指现状的 `chat_reply` 工具。

| 维度 | T: `chat_reply` (现状) | X: 终句 XML | 判断 |
|---|---|---|---|
| **漏写** | 模型要记得调工具。有 Stop hook 时当轮拦住, 实测 2/2 同轮自愈; 没有 Stop hook 的后端走轮终提醒 + 系统行 | 写终句是模型的惯性动作, 漏的概率**可能更低**; 但「写了终句却忘了套标签」同样会发生, 同样需要 Stop hook 来拦 | 两边都要靠 Stop hook 兜底, X 的边际收益很小 |
| **格式错** | 由 schema 校验 (CLI 侧); daemon 回 403/409, 并附原因, 模型**当轮**就能改 | 属性没加引号、漏了闭合标签、被 markdown 代码块或加粗包住、属性用了全角 …… 只有到轮终才发现。`RESULT:` 那一代的 A3 (反引号 / 加粗认不出, 修复链 2d223aa / e7fccb2 / 550ed15 / 6b90e26) 会以新语法重演 | T 胜 |
| **多条回复 / 多 duty** | `re` 可以是数组, 一次关多条; 一轮里也可以调多次 | 多个 `<reply>` 块可以表达。但每块都要写对 id; 块之间出现散文时, 归属不清 | 打平; X 的规则面更大 |
| **progress / need 中间态** | 轮中随时可调; 实测 68 条 reply 里 22 条是 progress。长活可以在轮中报进展, 然后接着干 | 可以加 `status=` 属性, 但**只能在轮终发出**。长活 (lead / coder) 要报进展就只能先结束这一轮 | T 胜 |
| **延迟** | 调用即入账本, 绑定 room 立刻进企微 | 要等轮终, 外加 Stop hook 与解析 | T 胜 (对长活影响明显) |
| **取证 (终句在哪)** | 不需要 | claude: Stop hook 的 `last_assistant_message` 可靠。但标签如果写在中间某段文本里, 后面又跟了一次工具调用和一句「finished」, 最后一条消息里就没有标签, 还得回去翻 transcript。其他后端: 回到 transcript 尾部推断 (软后端轮终 39b6dfd、transcript 异步落盘有滞后) | T 胜 |
| **跨后端** | MCP 四个后端都支持, 语义一致 | 只有 claude 有已验证的 Stop hook (`shared/session-hooks.ts:37-41` 的 `STOP_HOOK_BACKENDS = {"claude"}`); codex 只注入了 SessionStart / PreToolUse / PermissionRequest (`shared/codex-hooks.ts:187-189`), codex 的 transcript 也是另一种格式 (`shared/codex.ts`) | T 胜 |
| **注入 / 伪造** | 只有工具调用能写; 账本按 holder 做 ACL | 被转述的 XML 会被误解析。**这次派活本身就是例子**: 人的原话里写着 `<reply re=122 to=.alice>…</reply>`, 任何分析它、在终句里引用它的 wizard 都会触发解析。`peek_peer` / `room_read` 读到的同伴原文、宪章里的示例同理。缓解办法是只认自己名下的 open duty、忽略代码块内容, 但这又回到了 A3 那种「规则面越长越多」 | T 胜。ACL 能把影响限制在「误关自己的账」, 但误关就意味着提问者拿到一句引用片段当结论 |
| **可审计** | 在 transcript 里是结构化的 tool_use, 在账本里是 `origin:"tool"` | 写进账本也行 (`origin:"final"`), 但证据是正文, 「是不是故意写的」要靠人判断 | T 略胜 |
| **token 成本** | 每次 `chat_reply` 多一次采样: tool_use → tool_result → 再写一句终句, 相当于把整段上下文按缓存价**再读一次**, 加上约 100–300 个输出 token; 每个会话首次使用还要付一次 ToolSearch 加载 schema 的代价 (Claude Code 会推迟加载 MCP schema) | 少一次采样, 也不用 ToolSearch | **X 唯一的硬收益**。按 100k 上下文、缓存读 0.1× 粗算, 每轮约等于 10k 输入 token 的价钱。R1 (`fromFinal`) 能省掉重写长结论的输出 token; 采样次数省不掉 |
| **与 `RESULT:` 先例的关系** | `fd4715b` 起就是唯一的完成信号 | 是 `RESULT:` / `.name RESULT:` 的语法升级版; `design.md:383` 明确把「同一个群里两种完成语义长期并存」定为 D2 病 | X 等于把刚删掉的东西换个外观接回来 |

### 2.1 旧 `@.name RESULT:` 体系的现状 (核实结果)

- **已整体退役**: `fd4715b` (11-19, `refactor(room)!`) 删除了 `router.ts`、`message-events.ts`、`idle-nudge.ts`、strict-gate 等九个模块, 以及 `settleFinal` / `deliverFinal` / mirror 终句投递链。`design.md:418-426` 列出了删除清单。
- **残留**: `daemon/peers.ts:469-604` 的 `parseClosing` / `addressedResults` / `receiptKeyword` / `stripClosingMark` / `renderReceiptEnvelope` 还在, 但**没有活的调用方**: `daemon/index.ts:120` 和 `daemon/mirror-bridge.ts:72` 都只有 import。CLAUDE.md 里描述 router / message-events 的那几段已经过时。
- **唯一还从终句读语义的地方**: 定时任务的 `QUIET` (`shared/task-file.ts:183-186`、`daemon/peers.ts:763`)。它只决定「要不要外发」, 不关账、不寻址, 风险面很小。这也说明: 终句可以承载「内容 / 是否外发」, 不适合承载「关哪条账」。
- **和 room 体系的关系**: 被替代, 不是并存。`chat_reply` 的 `status` 四态对应旧的 `RESULT:` / `NEED:` / `PROGRESS:`; 旧的 inputIds 覆盖改成了游标比较 (`design.md:101`)。

## 3. 实测 (本机账本, 11-19 切换之后)

| 项 | 数 |
|---|---|
| room 数 | 20 |
| reply 行 | 68 = done 37 + progress 22 + need 1 + passed 7 (daemon 写的) + 不带 status 1 |
| `re` 是数组的 reply | 4 / 68 |
| 「被提醒后仍没有交代」系统行 | 7。`7aeb85fc.7/.13/.15/.21` 都已经回过 progress, 是误报 (`e98bf0c` 修复); `.39` 是真漏; 另外 2 条在其他 room |
| Stop hook 拦截 (`daemon.log` 中的「Stop hook 拦住」) | 2 次: `.Olive` 拦后 18s 补上 `re=[31db68ef.2, 31db68ef.5]` done; `.Iris` 拦后 5s 补上 `8bd6014f.5` done |
| Stop hook 上线后的系统行 | 0 |

管家的常见节奏是「派活 → 当轮 progress (已派给 .X) → 回执唤醒 → done」, 也就是一条 duty 跨两轮、发两条 reply。X 方案能表达这种节奏 (每轮终句各写一块), 但做不到「轮中报一句进展然后继续干」。

## 4. 推荐与迁移步骤

**主线: 不引入 X。** 按 R5 → R4 → R1 → R2 → R3 的顺序做, 每一步都能单独回退:

1. **R5 清死代码** (低风险): 删掉 index / mirror 对旧终句解析函数的 import; peers.ts 里只保留 QUIET 和 `stripForChat` 还要用的部分。同时更新 CLAUDE.md 里关于 router / message-events 的过时段落。
2. **R4 计量**: 在 `hub.onStop` / `onIdle` / `escalate` 上加计数, 进 `/status` 或 rolepage, 内容是「拦截率 = 拦截轮 / 有 duty 的轮」「自愈率 = 拦截后同轮补上 / 拦截」。
3. **R1 终句草稿**: `stop.sh` 的 jq 加上 `last_assistant_message`; daemon 按 uid 暂存最近一份草稿 (只放内存, 一轮有效)。`chat_reply` 加可选参数 `fromFinal:true`, 用草稿原文作为 text。block 的 reason 改为「…… 你的终句看起来就是答复: `chat_reply({re:"X", fromFinal:true})`」。完成仍然只认工具调用。
4. **R2 兜底带内容**: escalate 写系统行时, 如果有草稿, 附上前 N 字并标「未确认交代」, 不改 duty 状态。
5. **R3 扩后端**: 先在装有 claude-internal / codebuddy 的机器上实测 `--settings` 里带 Stop 键会不会让整份 settings 读失败 (`session-hooks.ts:38-40` 的顾虑), 然后加进 `STOP_HOOK_BACKENDS`; codex 按它自己的 hooks 能力单独接。

**数据闸门**: R4 跑 2–4 周。只有当「拦截率 > 15% 且自愈率 < 95%」时, 才值得回头评估一种受限的 X。受限的意思是:
- 只在 claude 上用;
- 只认 `last_assistant_message` 里、代码块之外的块, 语法严格为 `<reply re="id" status="done|need|progress|passed">`;
- `re` 必须是自己名下的 open duty;
- 同一轮里只要调过 `chat_reply`, 就忽略所有 XML;
- 账本记 `origin:"final"`, 便于单独统计和回滚。

## 5. 需要人拍板的取舍

1. **完成信号是否只认工具** (推荐: 是)。选「否」等于在 claude 上恢复第二种完成语义, 跟 `design.md` §C2 定下的 F-1 相反。
2. **R2 要不要把未确认的终句内容写进绑定 room** (推荐: 写, 但只写摘录并标明「未确认」)。代价: 绑定 room 里的每一条都会真的进企微, 半成品可能被人当成结论。
3. **R1 要不要给 `chat_reply` 加 `fromFinal`** (推荐: 加)。代价: 工具面多一个参数, 而且草稿只存在内存, daemon reload 后会丢 (丢了就退回让模型重写)。
4. **R3 的投入**: 要不要为 claude-internal / codebuddy / codex 做 Stop hook 实测。不做, 这些后端就一直走「轮终提醒 → 系统行」这条慢路。
