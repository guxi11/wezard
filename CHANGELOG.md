# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed
- **`reload` 明明成功却报 "not responding"**。boot 恢复镜像绑定是一次裸 fan-out,每个绑定各问两次 tmux (pane 还活着吗 / cwd 在哪) —— 本机 349 个绑定就是 ~700 个 client 同时排在一台 tmux server 上,全部撞满 10s 超时,而 spawn 风暴顺带把事件循环压住: `:17890` 要 25s 才 bind。CLI 那头 `wait_up` 又是按**次数**收口的 (30 次 × 0.3s),端口没 bind 时 curl 立刻 connection-refused 返回,于是 ~9s 就放弃了 —— 守护进程正常起来了,人看到的是一行失败。两头都改:
  - 恢复改成一次 `list-panes -a` 取全量 pane 快照,所有绑定共用 (并发也封顶,快照取不到才退回逐个探活);`await` 立刻让出,`startHttp` 先绑端口。实测 start→listen 从 25.5s 降到 0.3s,349 个绑定 0.7s 恢复完,tmux 超时 0 次 (此前数千)。
  - `wait_up` / `wait_down` 改按墙钟收口 (90s / 30s),不再被「连接被拒绝返回得快」偷走预算。
- **`worldPeers` 引用了两个没导入的名字** (`mapLimit` / `wizardStore`),`npm run build` 在这棵工作树上是断的。
- **`A → B` 里的 B 几乎总是不可点**。头上那两个名字各挂自己的 chat 详情页,而凭据 (`?id=`) 只能从一条真实的 turn 记录里借 —— detail store 只留 24h/1000 条,于是被派活的那一个(刚出生的分身、闲了一天的同伴;本机 349 个已 attach 的会话里 329 个没有自己的记录)拿不到凭据,名字就退化成一段不可点的裸文本。跨聊天派活更糟:气泡就下发在 B 所在的那个群里,而那个群整个可能一条 turn 记录都没有,于是全场唯一点不开的名字正是这条消息的收件人。
  - 新增一种极小的记录 **聊天票据** (`kind:"chat"`, 一个聊天一条, 只承载「这个 id 属于哪个聊天」): 自己的 turn 取不到就退到它,于是「有没有链接」不再取决于「这个聊天最近有没有跑过一轮」。票据**不参与 TTL / LRU 回收** —— 它是长期凭据,过期等于群里的链接集体失效,而它承载的那点信息永不过时(它也不占预算:上限就是聊天数)。凭据强度按长寿命重新取:96 bit 随机,而不是 turn id 那种按 24h 寿命定的 `t<时间戳><6 随机>`。
  - 页面开在谁那一栏改由新的 `target=` 明说(同聊天才认,跨聊天的 `target` 一律忽略退回票据自己那栏)—— 于是凭据是谁的都不影响落点。零记录的聊天也点得开:页面开着就等于订上了那个 wizard 的 SSE,它一开口正文自己长出来。
  - 票据与其他记录一样转发给 svr,所以远端页面的行为一致;伪造的 id 仍然 404(`?id=` 就是凭据这一条没有变)。
- **一个聊天的默认 wizard 的地址不再拖着一个孤零零的 `#`**。默认 wizard 的名字就是聊天名,地址本该同样是 `lisct-5`,`peerAddress` 却印成 `lisct-5#`;更糟的是这个串喂回 `send_peer` 会被当成「裸 tag」,报的还是「`lisct-5` 是个聊天,不是 tag」—— 名册里读到的地址与工具收得下的地址对不上。现在两头对齐:印出来的是裸聊天名,`resolvePeerTag` 也把裸聊天名解析成那个聊天的默认 wizard(老写法 `lisct-5#` 继续认)。

## [1.4.1] - 2026-09-21

### Changed
- **精简: 把四处各自重写的东西收成一份**。没有行为变化,`npm run build` 与 6 个测试文件照常通过。
  - `shared/json-map-store.ts`: `sessions` / `mirror-store` / `wizard` / `jobs` 四个存储各自抄了一遍「读一份 keyed json、每次改动写穿」。收成一个 `loadJsonMap`,`gc` 钩子让 jobs 继续在写盘前丢掉 24h 前收工的行。顺带统一了容错口径 —— 此前只有 wizard / jobs 的写失败被吞掉,sessions / mirror-store 会抛; 这些都是恢复用的状态,丢了该重挂一次,不该拖垮一个活着的会话。
  - `shared/exec-path.ts`: `augmentedPath` 有 5 份副本 (其中一份还漏了 nvm 的 bin 目录)。合成一份,额外目录走第二个参数 (`session-scan` 要 `/usr/sbin` 找 `lsof`,`cfg-sync` 要 `/usr/bin`)。
  - `shared/std.ts`: `sleep` ×5、`truncate` / `clip` ×6 —— 后者原本有三种语义在互相混用。收成 `truncate` / `truncateWithCount` (`…(+N)`) / `clipLine` (先压成一行再截)。
  - `mirror-bridge.ts` 里 5 个纯改名的本地别名 (`tagOfTarget` = `tagOfKey`、`basePrincipalOf` = `baseOfKey`、`withSessionTag` = `withTagHeader`、`splitChunks` = `splitMarkdown`、`tmuxRun` = `runTmux`) 折回各自模块导出的名字 —— 同一件事两个名字,文件里两种写法都在用。
  - `mcp/server.ts`: 6 个早于 `daemonPost` 的工具还在手搓 fetch。全部折上去,并补一个 `daemonGet`; 现在整个文件只剩这两处 `fetch`。
  - `daemon/index.ts`: 14 处 `await import("./http.js")` 动态导入一个文件顶部已经静态导入的模块,`config-api` 同理。改成静态导入。
  - 删掉真正没人用的: `bindCliBackend` (已被 `bindCliBackends` 取代)、`cacheClear`、`CONFIG_KEYS`、`mainTitle`、`session-scan` 的 `dirnameOfNode`,以及 `approval.ts` 里一个只写不读的 `gone` 标志 (实际止血的是下面那个 `clientGone` race,注释描述的机制并不由它实现)。

### Fixed
- **多行消息注入会重复粘贴, 且回车从未真正被校验过**。Claude Code 把多行粘贴折叠成 `[Pasted text #1 +5 lines]`, 于是按文本指纹 (首 8 / 末 8 个非空白字符) 判定「贴进去了没有」的老判据双双落空: `sawHead` 耗光整个预算后误判为「没贴上」→ 盲目重贴, 而实测第三次粘贴会渲染成 `…OMEGATAIL[Pasted text #2 +5 lines]` —— 两份提示叠进同一个输入框。同一个盲区让回车后的「输入框清空了吗」永远在第一次轮询就为真, 等于根本没校验过提交。改成读**输入框整块** (两条 ruler 之间、首行以 `❯` 打头的那几行), 与贴之前的快照比对: 判据与文本内容无关, 折叠态照样成立。由此 (a) 只有确凿看见框仍是贴前的样子才重贴, 存疑一律不重贴 —— 多贴一次的代价远高于少贴一次; (b) 提交有了可信判据, 回车没落地时最多补到三次 (空框上的回车是 no-op)。认不出输入框布局的后端 (或基线读取失败) 整条退回原来的指纹法, 行为不变。

- 文档: `技术说明.md` 指向一个不存在的 `docs/ONBOARDING.md`; README 与技术说明都还在说「未命名的聊天不可寻址也不可被建入」,而 1.4.0 起没名字的聊天会按工作区自动补名。
- `CODEBUDDY.md` 是 `CLAUDE.md` 的手抄副本, 已经漂移了一条 (缺 daemon fd limit 那段)。改成符号链接, 从此不会再漂。

### Added
- README: 新增「编排: 读完材料才知道要分几路」一节 —— 工单 / 批量 `wait_peer` / `RESULT:` 收口行 / `send_peer({when:"idle"})` / `cloneMax` 各自解决什么问题, 以及 `run_agent_graph` 与它们的分工。另补模型作为 wizard 属性、名册增量、聊天自动命名。
- `技术说明.md`: 新增「wizard 网络: 身份、感知、编排」一节 (charter 为什么是系统提示、fork 的两条不变式、快照 + 增量的感知模型、控制流留在发起方的取舍, 带一张 fan-out 时序图)。
- `CLAUDE.md`: 补上 `jobs.ts` / `notices.ts` / `chat-name.ts` / `tasks.ts` 四个模块的职责, 以及「共享原语」一节 (动手写本地副本之前先看这里)。

## [1.4.0] - 2026-09-21

### Added
- **模型成为 wizard 的一个属性,而不是 spawn 那一瞬的开关**。此前只有 `spawn_clone` 和 `run_agent_graph` 的节点能挑模型,`new_claude_session` 挑不了(它是「造一个白纸 wizard」的唯一入口,而人手敲的 `/new opus` 一直是能挑的 —— 同一件事 IM 侧做得到、MCP 侧做不到);挑了也看不见、也留不住。三处一起补齐:
  - `new_claude_session` 新增 `model`,与 `/new [cli] [model]` 同权;`/sessions/new` 的回执与群里的就位气泡都带上它,分身的就位气泡同理(模型不是默认时才显示)。
  - **模型跟着会话走**。`--model` 写进 attach 状态与 `~/.wezard/mirror.json` 的绑定记录,两条 `--resume` 重生路径(pane 死了的自愈、dispatch 中途的重生)都把它带上 —— 此前一个被放在 haiku 上的 wizard,pane 一死就悄悄回到默认模型,而没有任何地方会说这件事。`/new` 仍然是重置点:它开的是**新会话**,没点名就是该 CLI 的默认。
  - **名册里看得见谁跑在什么模型上**。`wizard_roster` / `wizard_whoami` / `list_peers` 的每一行多一个 `model`(空 = 该 CLI 的默认)。不知道同伴跑在什么模型上,「要判断的给 opus、跑腿的给 haiku」这句话就只能凭记忆执行。宪章的工具清单同步点出这条取舍。
- **协同网络: 补上 fan-out / join 这一层**。此前编排只有两端 —— `send_peer`/`wait_peer` 是手工点对点,`run_agent_graph` 是预先声明好的静态线性循环;中间空着的正是「读完材料才知道要分几路」的那一种活。补的四件都遵循同一条取舍:**控制流留在发起的那个 wizard 的上下文里,守护进程只做账本与执行器**(graph 把控制流搬进 daemon,代价是 run 只能活在内存里、reload 即丢;账本没有这个问题)。
  - **`wait_peer` 一次等一组**。新 `tags`(最多 16 个)与 `need`(满几个就返回,默认全部;`1` = 谁先完事就先处理谁)。分身本来就在并行干活,一个一个等的墙钟是所有人之和,一起等只花最慢那一个的时间。法定人数一满,剩下的等待立刻撤掉,它们照常继续干。地址整批先解析 —— 打错一个不该等十分钟才发现;重复地址去重,不占两个名额。单目标的扁平回显照旧,老调用方无感。
  - **`send_peer` 的投递时机**。新 `when: "now" | "idle"`(默认 `now`,行为照旧)。`idle` 先等对方闲下来再投:两个 wizard 同时找第三个时,两段文本会挤进同一个输入框被当成一轮读掉 —— 这在协同网络里不是边角情况而是常态。「回答它的提问」「打断它」仍然该用 `now`。返回里一律带 `wasBusy`,让编排方知道这句话是被当场读到还是排在了它这一轮后面。
  - **名册增量**(`daemon/notices.ts`)。宪章里那份「出生时群里已有的 wizard」是 spawn 那一刻的快照,只会越来越假。现在群里谁出生、谁收工、谁改了职责,会以一行 `<system-reminder>` 挂在**下一次**进到该 wizard 的任何文本尾巴上(人说的话、同伴派活、定时任务三条注入路径都挂)—— 不占一轮、不进气泡、不进 transcript。感知 = spawn 时的快照 + turn 时的增量,两者都不花额外轮次。信箱是纯内存的,投递即清空。
  - **工单**(`open_job` / `close_job` / `list_jobs`,账本在 `~/.wezard/jobs.json`)。派出两个以上分身时先开一个工单,`spawn_clone` / `send_peer` 带上 `job` 即归属:① 群里只出「开工」「收工」两条气泡 —— 五路 fan-out 原本要刷十条交叉气泡,人从里面读不出结构,过程照旧在各自的 chat 详情页,收工那条把成员(各挂自己的详情链接)与各自那段活一并交代;② `close_job` 把**为这个工单生出来的**分身整批回收(被拉来帮忙的长期 wizard 与调用方自己不在其列)—— 忘记回收是常态,而每个分身都占一个 pane 和一份上下文。
  - **交付收口行**。`wait_peer` 的结果多一个 `result`:从对方最后一条回复里摘出 `RESULT: …`(或「结论:」)那一行,取最后一个匹配;摘不到就是空串,调用方照旧读 `lastText`。fan-out 的 join 载荷本来是「最后一条 assistant 文本」,而分身的最后一句可能是「好的我开始了」也可能是八百字散文,两种都没法直接汇总。对法与 graph 的 `until` 哨兵同源:不改 CLI 的输出格式(改不了),只在派活的提示里要求收口。
  - **分身预算**(`wrc.mirror.cloneMax`,默认 8;工单另有 12 个成员的上限)。分身能递归生分身,一次跑飞的编排足以把 fd 吃光(见 launchd plist 的 `NumberOfFiles`)。撞到上限的回执直接告诉它该怎么办:`stop_wizard` 收单个,`close_job` 整批回收。
  - 宪章同步更新:工具清单、编排剧本(先 `open_job` → `spawn_clone({inherit:true, task})` → 要求 `RESULT:` 收口 → 一次 `wait_peer({tags})` 等回来 → `close_job` 汇总并回收)、以及「名册会自己更新,不必去问」。
- **没名字的聊天按工作区自动起名**。名字就是地址: 一个没名字的聊天在别的聊天眼里只有 `chat:wr4-87DwAA…` 这串 key —— 能寻址,但模型抄错一个字符就找不到,人更读不出那是哪个群。而等人想起来去 `/name` 是等不到的(实测 16 个聊天只有 3 个起过名字,54% 的 wizard 的 `chat` 字段是空的)。每个聊天本来就带着一个可读的标识:它在干哪个项目。于是 `~/develop/Guxi11/weclaude` → `weclaude`,撞名加序号(`lisct` / `lisct-2`),非法字符折成 `-`,推不出名字(工作区为空)的原样留着 —— 宁可没名字,也不造一个同样不可读的 `chat-wr4`。只填空,**永不覆盖人起过的名字**。
  - 补名发生在「**要把名字交给模型**」的那一刻,而不是某条 spawn 路径上:`wizard_roster` / `list_chats` / `list_peers` / `wizard_whoami` / `notify` 的收件解析各一道拦截,外加**渲染 charter 时**一道 —— 后者最要紧:系统提示是随进程终身的,一个在聊天还没名字时出生的 wizard 会一辈子以为自己住在「(未命名)」的地方。再加开机 15s 后一次兜底(IM 侧的 `/peers` / `/help` 不经过任何 MCP 路由)。
  - 一个聊天的工作区取它名下各会话跑得最多的那个目录;分配顺序按会话数从多到少 —— 否则同一目录下 70 个会话的主力群会拿到 `lisct-7`,而一个只有一条冷记录的空群占了裸名 `lisct`。
  - 一次 `patchJsonc` 写完(首次补名会一口气命中十几个),注释与格式原样保留;写失败只记进内存不抛 —— 自动命名是锦上添花,不该把一次 roster 查询搞崩。补名不发群气泡(十几个群同时刷屏),但会给住在里面的 wizard 各投一条名册增量:「这个聊天现在叫 X」。
  - 实测: 16 个聊天全部有名,`chat` 字段为空的 wizard 从 167 降到 **0**,名册里带裸 key 的地址从 133 降到 **0**。
  - 顺带: `resolvePeerTag` 在「这个聊天里没有这个 tag」这一条分支上,候选清单给的是裸 target key,而隔壁两条分支早就映射成地址了 —— 这份清单存在的意义就是让调用方照着改一个能用的串。统一成 `peerAddress`。
- **名册从一份转储变成一张索引**。这台机器上实际有 300+ 个会话,`wizard_roster` 此前一次吐 129KB(≈3.2 万 token)—— 一个 wizard 每次想找人都付这个价,等于找不到人。现在服务端过滤:`query`(名字/职责/地址子串)、`cwd`(**工作区反查** ——「谁在这个目录里干活」此前根本问不出来)、`chat`、`alive`,默认只回最相关的一页(自己 → 活着的 → 最近动过的),并附 `total` / `matched` / `more` 让调用方知道自己看的是不是全部。默认一页 18KB,按职责找人从 308 条收敛到 1 条。
- `list_chats` 的每个会话行补上 `name` / `description` / `cwd`。此前只有 `target` / `tag` / `address`,想知道「那个群里哪个 wizard 是干什么的」必须再拉一次三百条的名册 —— chat → wizard 这条边存在但读不出内容。三个字段都取自注册表与 store,不探 tmux。
- **定时任务: 到点让一个 wizard 真的去干活**。到点把一句 prompt 注入目标 wizard 的会话,与那一刻有人在群里对它说这句话完全等价 —— pane 死了 `injectText` 自己把它拉起来,产出照常落进群和详情页。活在 daemon 里而不是某个会话里,所以 CLI 重启、`/clear`、会话结束都带不走它。
  - **时机写人话,不写 cron**。`shared/schedule-spec.ts` 是一层纯解析:「每个工作日晚上9:30」「每天早上9点」「每周三下午3点」「每周二和周四晚上8点」「每隔两小时」「每30分钟」「20分钟后」「明早9点」,中文数字(九点半/十点)、时段词(凌晨/上午/中午/下午/晚上)、刻钟(一刻/半/三刻)、英文(weekdays 21:30 / every 15m / tomorrow 9:30pm)都认。刻意不收 cron 表达式:人说的是前者,让模型翻译成 `30 21 * * 1-5` 翻错了没人看得出来。认不出就报错并列出能认的说法,绝不猜一个时间存下去;存成功后回显 `when` 与 `next` 供人当场确认。
  - 三种形状足够覆盖:`daily`(某几天的 HH:MM)、`every`(每 N 分钟)、`once`(绝对时刻,触发后自删)。判定收在一个纯函数 `isDue(when, now, since)` 里,同时承担同分钟去重、重启不重放、以及**5 分钟补跑窗口** —— 守护进程重启吃掉的那一下会补上,超窗就放弃(早上 9 点的活中午补跑比不跑更糟)。
  - 新 MCP 工具:`schedule_task`(省略 `tag` = 排给自己)· `list_tasks`(id / 人话回显 / 下次触发时刻)· `cancel_task`。
  - 定时注入强制走出处门(`injectText(…, { fromChat: true })`):定时点的火,结果必须在群里看得见,哪怕上一轮是人在 CLI 里敲的。放枪前先推一条 `⏰ 定时任务 · <时机>` 气泡 —— 否则群里凭空冒出一轮对话,没人知道是谁点的。
  - 定时表从 `topics.schedules` 升到顶层 `schedules`;老 config 读盘时就地抬一手,已排好的任务不会静默消失。
- **wizard: 绑定聊天的会话从此是一个有身份的角色**。一个 `chat:xxx[#tag]` 不再只是路由 key，它有名字(= 聊天名，带 tag 的分身读作 `chat#tag`)、一句职责、一份跨会话的记忆、一条家谱，以及「知道自己活在一个群里、群里还有别的同类」这件事。
  - **身份走系统提示，不走对话**。spawn 时把宪章写进 `~/.wezard/state/charters/<sid>.md`，以 `--append-system-prompt "$(cat …)"` 压进那个进程 —— 不占一轮、群里看不见、`/clear` 抹不掉、上下文窗口也挤不掉。所有 spawn 路径(群里 `/new`、pane 死了的自愈重生、编排生出来的分身)统一从 `setCharterProvider` 取身份，「是谁」不再取决于是哪段代码把它生出来的。没有该 flag 的后端(codebuddy)静默跳过，无回归。
  - **分身(clone) = fork 父亲此刻的上下文**。`spawn_clone({inherit:true})` 以 `--resume <父 sid> --fork-session` 起新 pane，CLI 把父亲的 transcript 复制成一份新的再继续写：分身开局就带着父亲读过的一切，父亲毫发无损。于是「先把公共材料读进一个基座，再从它分出 N 个干活的」成立 —— 材料只读一遍，却进了 N 份上下文。分叉文件在该 pane 收到**第一条消息**时才生成，所以开场白(即第一件活)是分叉的触发器，等到它才 attach；等不到就连 pane 一起收掉，绝不拿父亲的 sid 凑合。`inherit` 必填，没有默认值。
  - 新 MCP 工具：`wizard_whoami`(我是谁 / 上下文用了多少 / 分身有哪些) · `wizard_identity`(给自己起名字、写职责；默认会话起名同时给聊天起名) · `wizard_roster`(全体 wizard 与 clone：名字/聊天/工作区/职责/忙闲/家谱) · `spawn_clone` · `stop_wizard`(打断或终结) · `wizard_remember`(跨 `/clear` 活下来的长期记忆，每次 spawn 重新注入) · `wizard_handoff_self`(上下文快满时自己写简报、原地 `/clear` 重开、把简报贴回去)。
  - 注册表落在 `~/.wezard/wizards.json`(`wrc.mirror.wizardsFile`)。
- `/new` 接受位置参数 `[cli] [model] [prompt…]`，三个都可选、从前往后逐个认领：认得出的 CLI 名吃进后端、认得出的模型别名(`opus` / `sonnet` / `haiku` / `claude-opus-5` 这类完整 slug)吃进 `--model`、剩下的整段作为新会话的第一句话在 spawn 后照常走 dispatch 注入。`/new opus`、`/new 帮我看下这个 bug`、`/new codebuddy opus #docs 先读一遍 README` 都成立。模型槽刻意收窄到已知别名与 `claude|gpt|gemini|deepseek-*` slug —— 认不出的一律当正文，`/new 看看 sonnet 贵不贵` 不会被吃掉第一个词。

### Removed
- **BREAKING: 删掉 topic 订阅 / 广播整套子系统** —— `subscribe_topic` / `unsubscribe_topic` / `list_topics` / `broadcast_topic` / `schedule_broadcast` / `cancel_broadcast` 六个 MCP 工具、`POST /publish` 与五条 `/topics/*` 路由、`config.jsonc` 的 `topics.subs`,以及 `schedules` 里的 `broadcast` 记录形状。pub/sub 的价值是「发布者不认识订阅者」,而这里的收件人全是本机 wizard —— `list_chats` / `wizard_roster` 早就把通讯录完整、人类可读地枚举出来了。topic 于是成了给一本翻得完的通讯录加的一层间接:多一套与地址不兼容的命名、多一步注册、打错一个字永远静默收不到。它占掉 34 个工具里的 6 个、工具描述总量的 15%(这些描述进每一个 wizard 的系统提示),换来的是零真实使用。
  - 能力没丢,换了表达:**要通知人**用新的 `notify`(收件人就是地址,不需要谁先订阅);**要到点干活**用 `schedule_task`(定时广播只是它的退化特例 ——「到点说这一句固定的话」)。
  - 迁移:老 config 里 `topics.schedules` 中的广播记录读盘时被丢弃(不再抛错,一条过期定时不该把 daemon 挡在启动之外);`topics` 段留在盘上无害,可手工删。`POST /publish` 的外部调用方(CI / 监控脚本)改调 `POST /message`(直接给 chatid)。

### Changed
- **chat 详情页按后端的名字称呼它**。「Agent 正在思考」此前是写死的泛称 —— 一台机器上同时跑着 Claude Code 与 CodeBuddy 两种后端,页面却一律说「Agent」,看的人分不出眼前这一轮是谁在跑。现在开 turn 时按 transcript 的落盘路径反查后端(`backendForPath`),记进 `TurnDetailRecord.cli`,详情页与线程片段渲染成「Claude 正在思考」/「CodeBuddy 正在思考」;认不出的后端退回中性的「Agent」——宁可不说,也别说错一个产品名。存量记录没有这个字段,照旧显示「Agent」。
- **`notify`: wizard 说给人听的那条通路**。此前一个 wizard 只有两种开口方式 —— 自己那一轮的正常回复(只到自己群),和 `send_peer`(把话塞进另一个 agent 的输入框,驱动它干活)。「把结论贴到另一个群给人看」既不属于前者也不属于后者,此前只能借广播歪着走。`notify(to?, markdown)` 补上这一格:`to` 写聊天名(可多个),省略即自己这个群;跨群时气泡头沿用 relay 那一套 —— 写成带聊天名的全称并挂上 chat 详情链接,那边的人一眼看出是谁从哪说过来的。收件人认不出整条拒绝并列出来,绝不部分送达 ——「发了但没人收到」是这类工具最难查的故障。
- **把历史上的 peer 话术统一到 wizard/clone**。同一套东西此前有两种说法(「会话 / peer / sibling」与「wizard / 分身」)，模型读到的是分裂的世界观。现在 MCP 工具描述、`#tag` mention 提示(`<system-reminder>`)、`/help`、`/peers`、README 与架构文档一律讲同一种话：一个绑定聊天的会话 = 一个 wizard，它的分身 = clone，同一聊天里的其他 wizard = 同伴。**工具名保持不变** —— 名字是地址，改名会把 hint、文档与用户肌肉记忆一起打碎；`send_peer` 读作「跟另一个 wizard 说话」即可。
  - `/peers`(新增别名 `/wizards`)从「会话列表」改成**名册**：每行带名字、职责、忙闲、以及「分身自 #x」。名字与职责来自注册表，通过 `bindWizardStore` 进程级绑定读到，没登记过的仍只显示 tag。
  - `new_claude_session` 的描述明确写出它与 `spawn_clone` 的分工(白纸一张 vs 继承上下文)，`handoff` 明确指向 `wizard_handoff_self` 处理自己，`stop_graph` 指向 `stop_wizard` 做即时打断 —— 相邻能力之间互相指路，模型不必猜。
- **wizard 之间的对话在群里只留关键节点，且不重复**。一条 relay 只落在**收信那一方**的群里：派活(`send_peer` / `spawn_clone` 的开场白)显示在**目标**所在的群，跨群时源头群不再复述同一句话；跨群气泡的头写成 `源聊天#源wizard → 目标wizard`，对面群里的人一眼看出活是从哪个群派来的，而不是凭空冒出一条 `#tag`。`wait_peer` 拿回的结论反向只推给**提问方**的群 —— 答话方自己的群里那条回复本来就会以它自己的气泡出现；同一个群内更是整条省掉。分身出生、终结、自我交接仍各留一条，中间的催促只落在 chat 详情页。宪章里同时写死了说话的规矩：分清「对人说」与「对 wizard 说」、不复述、不客套、不替别人开口。
  - 头上那两个名字各自挂上**它自己的 chat 详情链接** —— 看见「A → B」的人下一步想问的永远是「A 那边在干嘛」，链接省掉他回群里翻 A 气泡这一步。凭据取该 wizard 最近那条 turn 记录（与 mirror 气泡的链接同源，`ww_uniq` 按聊天收敛，同群的详情页复用一个企微内置浏览器窗口）；`?id=` 同时决定页面默认选中哪个 `#tag`，所以必须是它**自己**的 turn，拿兄弟会话的 id 会把页面开在别人那一栏。从没跑过一轮的会话没有凭据，退回裸名字而不是死链。

### Fixed
- **`notify` 收不下 `聊天名#tag` 形式的地址**。`chatBaseOf` 只认「纯聊天名」与「裸 principal」,而 `wizard_roster` / `list_peers` 交到模型手里的 `address` 恰恰是 `org-archivist#exp` 这种带会话那一截的串 —— 于是同一个地址空间在 `send_peer` 那边通、在 `notify` 这边被整条拒收;更别扭的是全量 key(`chat:wr…#fix`)因为前缀命中而侥幸可用,两种写法行为相反。现在统一走 `parsePeerRef` 剥掉会话那一截(一个 tag 指不出第二个聊天),于是「知道某个 wizard 叫什么」就等于「能往它所在的群里对人说话」,哪怕那个群没起过名字(本机 16 个聊天里 13 个没名字,54% 的 wizard 的 `chat` 字段是空的)。
- **气泡里的表格不再塌成一行带竖线的文字**。头与正文之间只隔一个换行时,markdown 把正文首行当成头那一段的续行 —— 代码栅栏早有补丁,表格没有,而表格**不能打断一个段落**,于是整张表退化成纯文本。分隔逻辑收进 `headSep` 一处:正文以 ``` 开头给一个换行,以 `|` 开头给一个空行,其余照旧同行。wizard 之间的 relay 气泡(`<from> → <to>`)头一律独占一行、正文自成一块;brief 模式带详情链接的 standalone 气泡此前是写死的一个空格,同样接上这套规则。方向信息全在头里,正文不加任何引用/缩进标记。

## [1.3.23] - 2026-09-17

### Added
- `wrc.botNames`: 机器人在 WeCom 里的显示名(可配多个别名)。名字由建机器人的人自己取, 消息体里没有任何字段能读到, 此前硬编码 `wezard` / `weclaude` —— 改名后 `@<真名>` 剥不掉。配了名字的在单聊里也剥。

### Changed
- **@mention 剥离改为「一条消息只认定一个机器人名」**。候选 token = `@` 之后到空格/行尾为止且不含 `/` `\\`;路径优先被识别为路径(`@src/foo.ts` 连候选都进不来, 裸文件名再按扩展名形状排一道);剩下的第一个就是机器人名, 认定后把全文里同名的 `@` 全部剥掉(一条消息里可能 @ 它好几次, 但不可能有两个机器人)。群聊才做这套推断 —— 单聊 @ 不了人, 那里的 `@` 只按配置名剥。

### Fixed
- **引用/@ 机器人后的正文剥离不再依赖机器人叫什么名字**。改名后 `@<真名>` 会原样漏进 prompt 被语义解析(如误触发 wrc)。
- **`@wezard 看看 @src/foo.ts` 不再把文件路径一起吃掉**。旧逻辑按名剥掉 `@wezard` 后 @ 数降到 1, 随后"唯一 @ 即 mention"的兜底就把 `@src/foo.ts` 删了;新规则下路径根本不是候选。
- 引用正文本身的剥离(`parseTagHeader` 的 `emoji #tag` 头)一直是按出站气泡的 emoji 头反解的, 与机器人名无关 —— 不受影响。

## [1.3.22] - 2026-09-16

### Fixed
- `mirror`: **群里不再出现没有正文的消息**。两处噪音一并去掉 —— (1) CLI 轮首次静默时发的「CLI 侧对话不再下发到群里，点标签看实时详情。」入口提示整体移除: 有正文的 standalone 本就由 `withLinkedTag` 自带详情链接, 没正文时一条都不该发; (2) `brief` 下的 user 行无条件丢弃 —— 此前只在 `item.quiet` (即 `includeUser=false`) 时丢, 而 user_text 不在 `BRIEF_TURN_OPENERS` 里, `includeUser=true` 时它会穿过整条 brief 短路落到底部的 standalone fallback, 把人在 CLI 敲的那一行原样回显进群, 正好破掉 `chatOriginOnly`。

## [1.3.21] - 2026-09-16

### Fixed
- `mirror`: **askq 卡选「聊聊这个」不再卡死 CLI 面板**。text 注入复用的 `inject` 自带 modal guard, 而 AskUserQuestion 面板本身就是 modal —— 引导语被守卫拒掉, 自定义文本行永远空着, 驱动必败 (日志实测五连 `mirror askq chat drive failed` 均此因)。该注入现在带 `bypassModalGuard` 豁免; 注入文案改为「聊聊这个」, 并在 `confirmAskqSubmit` 里为 codebuddy 的二次确认框补 Enter (盲按一次 → 轮询面板关闭 → 没关再按, 上限 3 次)。

## [1.3.20] - 2026-09-16

### Fixed
- `mirror`: **CLI 侧一轮的 standalone 不再顶着两条一模一样的详情链接**。`ensureBriefTurn` 会把详情链接暂存到 `pendingBriefHeader` 再拼到首条正文前缀, 而 `sendStandalone` 本就通过 `withLinkedTag` 给每条 standalone 加同一条链接 (`linkedTagPrefix` 读的正是 `a.briefTurnId`) —— 两者叠加, 消息开头就是 `[🧙](url) [🧙](url) 正文`。暂存槽整体移除, 链接只由 withLinkedTag 一处产出。

### Changed
- `chat detail`: **子 agent 的一轮内联回父轮的时间轴, 不再作为兄弟卡片吊在最底下**。subagent turn 记录新增 `agent.parentTurnId`, 线程视图按 `createdAt` 把它插进父轮的气泡序列 (派发那一刻之后、父轮下一条动作之前) —— 此前它是顶层卡片, 父 agent 在 Task 返回后继续调的工具全排在它上面, 贴底阅读看到的反而是早已跑完的子 agent。SSE 相应改推父轮片段; 侧栏的「N 轮」与预览只算主会话自己的轮次 (token/工具用量仍按全部计)。
- `chat detail`: **上下文断点改为独立的分隔行, 在清空发生的那一刻就落地**。`/clear`、`/new`、会话轮换现在各写一条 `mark` 记录 (新的 detail 记录类型, 不占一轮统计), 线程里渲染成一条贯穿的虚线 —— 此前断点只能盖在"下一轮"的卡片头上, 要等人再开口才显形, 而那一轮还可能被当成空壳 turn 丢掉, 分隔就此消失。轮换判定 (`startTurn` 的 rotated) 一并以标记为基准, 不会在标记后再多画一条。

## [1.3.19] - 2026-09-16

### Changed
- `mirror`: **CLI 侧手敲的一轮不再下发到聊天** (`wrc.mirror.chatOriginOnly`, 默认开, 仅 `brief=true` 下生效)。镜像改为发生在两处 —— 人眼前的终端, 和 chat 详情页 (turn store 全量记录 + SSE 实时刷新)。每个 turn 现在带出处标记: 有 WeCom frame = 群里发起 (气泡照旧); 由一条真人 CLI 输入行开头 = CLI 轮, 终稿与斜杠命令回执只写详情页; 收口后的补写 / peer·graph 注入开出的轮沿用上一轮出处。审批与提问卡、卡前 pane 前言、`[mirror]` 系统提示、`/goal` 进度推送均不走这道门。每个 attachment 首次静默时发一条带详情链接的提示, 免得从没收过气泡的会话在群里无处可点。CLI 输入行同时开始写进 turn 的 `userQuery` (此前 `includeUser=false` 下详情页看不到人敲了什么), CLI 轮的 `cwd` 也补上, 与 WeCom 发起的轮次对齐。

### Removed
- `mirror`: **触限额自动续跑 (`wrc.mirror.limitResume`) 整体移除**。限额行不再被解析出 `resetsAt`、不再排定通知与到点注入; 配置项同步从 schema 删除 (旧 config 里残留该键会被 zod 忽略, 无需迁移)。keepalive 的 stall-resume 恢复无条件生效 —— 不再为已排定限额恢复的会话让路。

### Fixed
- `mirror`: **CodeBuddy pane 的 keepalive 不再突破 6 轮预算无限续命**。`tailTurns` 用 `Date.parse` 解析时间戳, 而 CodeBuddy 写的是 epoch-ms 数字 —— `Date.parse(数字)` 恒为 NaN, 每条 turn 的 `ms=0`, `keepaliveStamps` 退化为 mtime 兜底: ping/pong 自己的写入、`file-history-snapshot`/周期 `summary`/`turn-metrics` 等机器记录, 只要落在 ping settle 30s 静默窗之后, 全被当成真实活动把 `round` 清零, 预算重置再发一轮 6 次 (日志实测 #checkrun4 一晚 10+ 次)。现在数字时间戳直接透传 (Claude 的 ISO 字符串照旧 `Date.parse`), 时钟锚回消息轮本身; 同时 pong 判定从「紧邻 ping 的单条 assistant」放宽为「ping 之后到下一条 user 之前的所有 assistant」—— CodeBuddy 会把一条回复拆成多条独立 message 记录, 旧邻接规则会让拆出的后半段被误判为真实活动。

## [1.3.18] - 2026-09-14

### Fixed
- `mirror`: **CLI 敲 `/model` 等 slash 命令的回执即时推送 —— 不再吃 `standaloneDebounceMs` 防抖 (默认 30s)**。非 brief 路径下 skill_output (`⚙️ Switch model to …`) 此前与工具刷屏共用 standalone 防抖窗, 窗口被后续 item 反复重置时延迟还会更长; 现在 skill_output 一律先冲掉在途防抖缓冲 (保序, 同批 drain 里先到的 `> /model` 回显不被反超) 再立即发出。deferred / goal / 常规三条非 brief 消费路径同步生效; brief 路径本就即时, 不受影响。

## [1.3.17] - 2026-09-14

### Fixed
- `mirror`: **代按确认框改为「高亮核对 + 方向键导航」—— 数字键失效的布局 (CodeBuddy) 不再盲补 Enter**。原按法「发数字 N → 同标题框还在就补 Enter」隐含"数字键至少会把高亮挪到 N"的假设; CodeBuddy 的确认框数字键不一定生效 (其快捷键提示是 shift+tab/escape 系), 且实测默认高亮可能停在「Yes, and don't ask again…」上 —— 盲补的 Enter 会把**高亮项**按下去, 恰是哨兵发誓永不自动选中的放宽权限项。现在数字键没关掉框时: 读出当前高亮 → 方向键逐步挪到目标项 → **复核高亮就位后**才 Enter; 高亮读不出 / 挪不动 / 标题变化一律罢手交兜底。`answerNativeModal`(`.claude/**` 守卫) 与哨兵/审批卡代按共用此实现。

### Added
- `mirror`: **哨兵盲区诊断日志**。屏上有高亮编号行 (`looksLikePicker`) 却没判成 modal 时, 按屏去重记一条 `picker sentinel: numbered picker shape on pane but not judged modal` 及末 8 行屏面 —— 远端排查"哨兵为何没反应"不再无迹可循。发卡失败 (WS 断/发送失败) 时清哨兵指纹, 同屏下一 tick 自动重试, 不再被永久静默。

## [1.3.16] - 2026-09-14

### Fixed
- `mirror`: **原生 picker 哨兵识破 CodeBuddy 的确认框布局 —— 子代理 confirm 不再对远端隐形**。1.3.15 的 skipAll 哨兵在 devcloud (CodeBuddy) 上零命中, 成因是 `isModalPane` 的两条判据都被这版布局绕过: 确认框整圈圆角边框让 capture 行带 `│` 前后缀, 行首锚定的选项行正则落空; 快捷键提示内联在选项文案里 (`(escape)`), 没有 `Esc to cancel` footer —— 哨兵全盲且零日志。现在判定前逐行剥框线; footer 缺失时以权限三件套形状 (裸 `Yes` + `Yes, and …` + `No`) 作为 modal 证据补位 (是非题/plan review//model 天然不命中); `Are you sure …?` 纳入标题形状。注入防护 (`injectViaTmux` 的 modal 守卫) 与 `.claude/**` 守卫代按同步受益。
- `mirror`: **哨兵不再 gate 在 `danger.skipAll` 上 —— skipAll 关闭时原生确认框转标准审批卡发到绑定 chat**。此前 skipAll 关闭 = 哨兵整体停摆, 不过 hook 的确认框在远端既无卡也无法代按。现在读屏认出权限确认框后分三路: skipAll 开 → 代按一次性 `Yes` (原行为); 本 chat ⏱自动窗口内且内层工具不踩危险名单 → 同上代按; 否则 → 读屏下钻真实工具名/入参 (`parseConfirmContext`, DeferExecuteTool 布局解析 `toolName:"…"`/`params:{…}`) 发标准审批卡 (`runMirrorPickerFlow`, 与 askq/plan 镜像流同源), 点击后代按对应选项: ✅/⏱ → 一次性 `Yes` (⏱ 同时开 chat 自动窗口), ✅总是 → 原生「本会话不再询问」(静态规则帮不上不过 hook 的框), ❌ → Escape; 危险名单命中的卡走单次确认形态。本地先按掉 → 卡自动作废; 代按前重读屏校验仍是同一调用, 换框绝不盲按。

## [1.3.15] - 2026-09-10

### Fixed
- `approval`: **CodeBuddy 延迟加载工具 (`ToolSearch` → `DeferExecuteTool`) 的审批链按内层工具裁决**。deferred/MCP 工具经 `DeferExecuteTool(toolName, …)` 外层包装派发时, hook/daemon 只见外层名 —— matcher/danger/allow/deny 规则匹配不到真实工具, 卡片也读不出语义。现在 hook (`pre-tool-use.sh`) 与 daemon (`unwrapDeferredTool`, 兜底旧版 hook) 各下钻一层, 用 `tool_input.toolName`/`.toolInput` 替换外层再走审批链; wezard 自家 MCP 工具被 defer 后的 self-call bypass 一并恢复 (否则首次绑定又是鸡生蛋)。
- `approval`: **无 `agent_id`/`agent_type` 标记的子代理请求恢复父会话归属**。部分 CodeBuddy 版本的子代理 hook 两个标记都不带, 而 `subagentParentOf` 与 `fromSubagent` 只认标记 —— 归属反推失效, no-approver 时还错走 `ask` 挂进无人能点的原生 picker。现在 `subagents/agent-*.jsonl` 转录布局本身即子代理证据 (主转录布局仍需标记佐证); hook 侧 `record_mode` 同理改按布局+标记判子代理, 堵住「无标记子代理的 `default` 覆盖父会话 bypass 档案」。
- `mirror`: **`danger.skipAll` 下代按 CLI 原生权限 picker —— 不再对「本地 picker 先行、hook 后到/不到」的调用失明**。CodeBuddy 对一部分调用 (实测: 子代理里经 `ToolSearch`→`DeferExecuteTool` 派发的 MCP 工具) 先弹自家权限 picker、PreToolUse hook 在人点掉之后才触发 —— hook 链路零参与: daemon 无日志、无卡可发、`skipAll` 落空, pane 就地阻塞。与 AskUserQuestion「本地面板先行」同源, 解法同源: mirror 每 5s 读屏, `skipAll` 开启时对形状可信的权限确认框 (裸 `Yes` + `Yes, and …` 放宽变体 + `No` 三件齐全, 排除 是非题/plan review//model) 代按一次性 `Yes` 并发 chat 回执; 放宽静态权限的选项永不选中, 挑不出就不碰。`WEZARD_PICKER_SENTINEL=0` 关闭。

## [1.3.14] - 2026-09-10

### Fixed
- `usage`: **`/usage` 回复不再乱码、代码块恢复生效**。(1) `daemon/quota.ts` 源文件曾被按 GBK 读写的工具 round-trip 保存 (5a68952 引入): 非 ASCII 字节流按 GBK 两两配对, 奇数长度 run 的末字节被替换成字面 `?` (0x3f), 留下非法 UTF-8 —— `█ ░ ⏰ 从 近 •` 与 `🗓️` 的变体选择符全部阵亡 (偶数字节的 `⚠️` 恰好幸存), 编译产物原样带出, WeCom 渲染成 `�?`; 已按前一版完好提交逐字节恢复全部 16 处。(2) `withTagHeader` 同行拼头把 ` ``` ` 挤离行首, WeCom 不认作开栏栅栏 → 头部字面渲染 + 结尾栅栏反向开出空代码块; 现在 content 以栅栏开头时改用换行拼头 (`HEADER_RE` 尾部 `\s*` 吃得掉换行, 剥头/去重比对不受影响)。

## [1.3.13] - 2026-09-09

### Fixed
- `approval`: **"全跳过权限"模式在子代理里不再退化成本地原生 picker**。hook 的权限模式短路只认 `bypassPermissions` 一个字面量, 而 (1) CodeBuddy / IDE 协议注入报的是 `fullAccess`, (2) 子代理是另起的 CLI 实例, 拿不到父的 `--permission-mode`、自身 `permissions.defaultMode` 又通常没写, payload 里只剩 `ignore`/`current`/空这类「继承」语义值 —— 三者都匹配不上, 请求全掉进 daemon 长轮询, 子代理场景下那张卡没人点 → 回 `ask` → CLI 画出远端看不见的原生确认框。现在: (1) 字面量名单扩到 `bypassPermissions|fullAccess`; (2) 主线程每次把实际模式记进 `<stateDir>/modes/<sid>`, 子代理报继承语义值时按 transcript 反推父 sid 读回真实模式 (只有主线程写, 子代理的 `default` 不会覆盖父的 bypass; 父切回 `default` 时下一次主线程调用即自愈); (3) 解析后的模式随请求透传给 daemon, 在 `danger.skipAll` 同层再裁决一次 (`denyRules` / `AskUserQuestion` / `ExitPlanMode` 分支仍在其之前生效)。`WEZARD_HONOR_AUTO_MODE=0` 同时关掉 hook 与 daemon 两侧的直通。

## [1.3.12] - 2026-09-09

### Fixed
- `mirror`: **后台派发 (`run_in_background`) 的子 agent 不再让独白被当成终稿投递**。`openAgents` in-flight 记账原本假设「`function_call_result` 落回父转录 = 子 agent 结束」——该等式只对前台派发成立: 后台派发的 result 是 ~300ms 就回的 spawn 句柄, 账本在子 agent 真正开跑前就被销掉, 软收口 guard 在它唯一被设计来防的场景里 100% 失效 (日志中 `soft turn_end deferred` 零命中)。现在记账按前后台分流: 后台派发只由平台的完成通知 (`<task-notification>` 或无标签的 `[Framework Auto-Notification] …`, 按 label 命中、命中不了按 FIFO) 或 `OPEN_AGENT_TTL_MS`(15min) 销账。
- `mirror`: **软收口 defer 后会重挂, 不再永久悬挂**。此前 `fireSoftTurnEnd` 命中 guard 直接 return, 依赖「子 agent 返回后父侧必写新文本」自带下一次软收口; 而 CLI 侧起的无气泡 turn 没有 hard cap 兜底 (那只挂在 WeCom 发起的气泡上), 后台派发的结束信号又不会让父侧再写一段文本 ⇒ 正文永不投递。现在 defer 会按「最早未返回派发的 TTL 剩余」重挂; 子 agent 一返回则改用 15s 宽限窗口(父侧此刻正要写真正的答复, 立刻收口投出去的还是那句独白)。
- `mirror`: **「欠一次软收口」与静默计时器解耦**。此前任何新 item 都撤销待确认的软收口, 于是子 agent 返回时的 `tool_result`/完成通知/平台注入的 user 行会把欠账一起抹掉。现在只有父 agent 自己的产出 (`text`/`thinking`/`tool_use`/`turn_end`) 才推翻收口意图, 其余 item 只让欠账往后顺延。
- `mirror`: **对话边界清账不再是死代码**。`user` 行的边界语义原本挂在 `includeUser`(默认 false)上, renderLine 直接把整行丢掉 ⇒ 清账/keepalive 释放从不执行。现在无论 `includeUser` 都发出 `user_text`(quiet 只表示不渲染); 且清账按 `turnId` 认人, 只销「已经过去的那一轮」的前台派发, 不误伤本轮正在跑的。
- `mirror`: **同一 query 轮次内的重复终稿只投一次**。平台把「一个后台子 agent 完成」展开成结果与通知两条独立 user 注入, 模型被唤醒两次、各写一遍内容几乎相同的完整终稿; `briefConcluded` 只在 turn 内幂等, turn 一收下一条 text 就补开新 turn 再投一次。现在以 `queryEpoch`(仅真实用户输入推进)为界, 与上一份终稿 4-gram Jaccard ≥0.8 的判为重复投递, 只记进 turn/detail 不发群。

## [1.3.11] - 2026-09-09

### Fixed
- `wrc`: **引用去重的 transcript tail 改取「有效 tail」—— keepalive ping/pong 不再挤占回看轮次**。`quoteInContext` 兜底路径按最近 12 逻辑轮比对引用内容,挂机久了 keepalive 的 ping 及其应答会占满窗口,把用户真正引用的气泡挤出去 → 去重 miss、原文被重复注入 prompt。现在 `tailTurnsWithTools` 先按与 `keepaliveStamps` 同源的签名集(配置的 ping/resumePing + 旧版裸 `ping`)剔除 ping 轮与其紧随的应答轮,再数轮次。

## [1.3.10] - 2026-09-09

### Changed
- `mirror`: **codebuddy 软收口静默期默认 10s → 1s —— 纯文本答复/最终正文落盘 1s 无新 item 即定稿**。codebuddy jsonl 无 `end_turn`/`turn_duration` 硬信号, 每条 assistant 文本只能软收口确认; 实测叙述消息→紧随其后的 function_call 落盘间隔仅 4-8ms, 1s 已含 fs.watch 抖动/落盘延迟余量, 不再让最终结论干等 10s。可由 `wrc.mirror.softTurnEndMs` 覆盖。
- `mirror`: **派发子 agent 期间的独白不再被提前当 final 正文收口**。codebuddy 子 agent 转录 (`subagents/agent-*.jsonl`) 没有结束标记, 子 agent 会话结束返回主会话的唯一硬信号是父转录 `function_call_result` 落盘 —— 故以父转录 `function_call(Agent/Task)` ↔ `function_call_result` 配对判 in-flight。软收口到点若仍有未返回的派发 (`openAgents` 非空) 则 defer: 上一段文本按普通独白保留在流/气泡里, 待子 agent 返回后最终正文以自身的软收口正常收口; 无后续文本的死角由 350s hard cap 兜底。

## [1.3.9] - 2026-09-08

### Fixed
- `approval`: **子代理审批解析不到审批人时不再把 `ask` 送进无人可点的原生 picker —— 消除 headless/后台 subagent 授权永久挂起**。此前 subagent→父会话 re-routing 被 `wrc.mode === "mirror"` 门控: headless(/wrc) 模式 `getMirrorTarget` 为 undefined, re-route 永不触发; 且父会话要求已 mirror 绑定。当 subagent 上报未绑定的自身 session、`approvers` 与 `defaultChat` 又都为空时, `resolveApprover` 返回 undefined → handler 走 `fallback` 的 `ask` → 原生 picker 弹在没人能点的 headless/后台 subagent 里 → 永久卡死 (无卡、`danger.skipAll` 也救不了)。现在: (1) re-route 去掉 mirror 门控, 统一走 `getMirrorTarget` —— headless 模式由 index.ts 注入 sessions store 的反查 (session → 驱动它的 principal chat), 父归属与卡片路由两种模式一致; (2) 归属仍解析不出、`approver` 为 undefined 的子代理请求返回 `deny no_approver_for_subagent` (安全默认 + reason 引导配置), 而非 `ask`。

## [1.3.8] - 2026-09-07

### Added
- `daemon`: **切网后自动重建 WeCom WS 连接**。新增 `net-watch.ts` 轮询网卡 IPv4 指纹(5s 一拍,连续稳定 2 拍算 settle),换 WiFi / 插拔网线 / VPN 起停后立即原地 `disconnect + connect` 重建 socket——旧连接黑洞化时不再等心跳连续 miss 数个 30s 周期才恢复。相比整进程 reload,保留全部内存态(graph 运行、pending 长轮询、镜像绑定),且不依赖 launchd/systemd 的 respawn 策略。断网(指纹变空)只记日志不动作,等新网络 settle 后再触发。
- `mirror`: **触限额会话自动续跑** (`wrc.mirror.limitResume`, 默认开)。CC 触顶时写入 transcript 的 synthetic 限额行自带恢复时刻 (`quotaLimits.resetsAt`, epoch 秒; 旧版无此字段时从 "resets 2:30am" 文案按本机时区解析)。daemon 每 30s 轮询各 attachment: transcript 末轮是限额行 ⇒ 群里通知一次预定续跑时间, 到点 (reset + `delaySec`, 默认 60s) 后向仍停着的会话注入 `text` (默认 `continue`) 续跑。检测纯规则、逐轮从 tail 重推导, 无持久化 —— reload、人工亲自续跑、注入本身都靠「限额行不再是末轮」自然收敛; 再撞 429 会生成带新 resetsAt 的新限额行, 自动开启下一轮排定。pane 已死 (人收摊了)、正忙、`/stop` 静默中的会话不打扰。同时 keepalive 的 stall-resume 对已排定限额恢复的会话不再抢跑 —— reset 前注入只会再吃一条 429。

## [1.3.7] - 2026-09-07

### Added
- `mirror`: **subagent 执行过程进入 chat detail, Agent 调用期间气泡实时显示子 agent 状态**。Task/Agent 工具派出的子 agent 转录 (`<sid>/subagents/agent-*.jsonl`, claude/codebuddy 同构) 此前完全不可见 —— 主 jsonl 只有派发与最终总结, Explore 跑几分钟群里是黑洞。新增 `daemon/subagent-tail.ts` 观察器: 按 attachment 监听 subagents 目录 (fs.watch + 1s poll, 存量文件从 EOF 起、新 spawn 从 0 起拿到 task 原文; 目录跟随主 jsonl 实时路径, worktree 迁移不断流), 经各 backend 的 `normalizeLine` 归一后把子 agent 的 text/tool_use/tool_result/usage 记成带 `agent` 标记的 turn (`TurnDetailRecord.agent: {id,type,description}`), 在 chat 时间轴内联渲染 (绿色归属条 + 缩进卡片, 复用既有折叠工具气泡)。类型归属: claude 读 `agent-*.meta.json`; codebuddy 无 meta, 用父侧捕获的 Task/Agent 入参按 prompt 逐字匹配 (实测一致)。brief 气泡: 父 agent 阻塞在 Agent 调用期间, 子 agent 最新活动以 `🤖 type · 最新工具/思考行` 驱动 CoT 进度行 (last-writer-wins, 复用 1.5s 节流与 100 字单行约束), keepalive 吞没窗内静默。生命周期: 子 turn 随父 turn 收口统一关闭 (closeBriefTurn/finalizeStream/detach/migrate), 会话轮换重建 watch。

### Fixed
- `approval`: **子代理工具调用的审批归属修正 —— 与主会话同一套判定链**。CC/CodeBuddy 通常把子代理 hook 的 `session_id` 上报成父会话 id, 子代理工具调用因此天然被 `danger.skipAll` / 卡片 / ⏱窗口 / 缓存覆盖; 但部分 CC 版本 / IDE 集成会上报子代理**自己**的 session, 该 id 无镜像绑定时请求会落到 `ask` 兜底 —— 镜像 pane 里变成远程无人可点的原生确认框 (卡住、不下发卡片, 看似「不受 skipAll 控制」)。现在 hook 把 CC 的 `agent_id` / `agent_type` 透传给 daemon, daemon 在 mirror 模式下对「session_id 未绑定 + transcript_path 含 `/subagents/` 或落在父会话转录」的请求按 transcript 反推父会话并路由过去, 审批链 (skipAll/卡片/窗口/缓存/规则) 与主会话完全一致。
- `mirror`: **subagent watch 的 EOF/新文件判定修正 + codebuddy 类型归属真正落库**。
  - 此前 `subagent-tail` 首扫对已在盘的 agent 文件**从 0 重放**、之后出现的新 spawn 反而**跳到 EOF** —— 与注释/设计意图正好相反: daemon 重启、re-attach 会把历史 subagent 全量重放成新 turn (chat detail 里同一段执行反复出现), 而会话运行中新 spawn 的 agent (第二个起) 会丢开头、连 task 行都可能错过。现在以「目录是否已成功读过一次 + 文件 mtime 与 watch 建立时刻」判定: watch 建立前就在盘上的老文件从 EOF 起、不重放 (与主 tail 同语义); watch 建立后出现的文件一律从 0 起、完整拿到 task 原文。
  - codebuddy 无 `agent-*.meta.json`, 此前父侧 Task/Agent 入参按 prompt 匹配出的类型只喂了 brief 气泡的进度行, `TurnDetailRecord.agent.type/description` 仍旧是空 —— detail 页 header 只剩干巴巴的 `🤖 subagent`, 与气泡里解析出的类型自相矛盾 (codebuddy 恰恰是首个支持目标)。现在归属解析结果 (`resolveSubagentMeta`) 同时写进记录, 气泡 label 与 detail 页同源。
- `mirror`: **brief 模式 CLI-driven turn 不再单独发"只有链接"的空消息**。此前 `ensureBriefTurn` 通过 `sendRaw` 单独把 `briefDetailLink` 当一条 WeCom 消息推出去 (`web 团队 AI 助理 BOT` 列表里看到一条 `#dev` 标题但正文几乎为空,markdown 链接在客户端渲染为纯文本就成了"空消息");随后 `handleBriefItem`/`concludeBriefTurn` 走 standalone 推正文, 两条连发。现在把链接暂存到 `pendingBriefHeader`, 由该 turn 首条 standalone body (`concludeBriefTurn` / skill_output 路径) 取走拼到前缀, 一条消息同时含详情入口 + 正文。空 body 时整条丢弃、header 跟着清, 不会泄漏到下一 turn。CLI 输入触发 `/model` / `/context` / `/clear` 这类 skill_output 立即到达的命令时,群里从两条变一条,WeCom 渲染也好看。
- `launchd`: **plist 模板加 `SoftResourceLimits.NumberOfFiles`(65536),消除镜像会话一多 spawn 就 EBADF 的崩溃循环**。launchd 默认把软 fd 上限压在 256,而 daemon 启动时按活跃会话逐个恢复镜像(每个 = jsonl tail + subagent watchers + tmux spawn),几百个会话就把 fd 表耗尽,`spawn` 抛 `EBADF`、进程在 HTTP bind 之前就死,KeepAlive 陷入崩溃循环(`/status` 显示 down、`daemon.stderr.log` 报 `spawn EBADF`)。改口只在模板——已装的 plist 会被 `install.sh` 重新生成,手改 `~/Library/LaunchAgents` 那份会被覆盖。

### Changed
- **空消息门控 (chat-gate): 任何通道都不再下发"正文为空"的消息**。空 = 剥掉可路由头 (`🦊 #tag …` / `[🧙 #tag](url) 2/5 …`) 后没有任何可见内容 —— WeCom 把这种气泡渲染成一行光秃秃的 tag。两层拦截:
  - **中央 gate** (`daemon/last-response.ts` 的 SDK 包装层,单一缝全覆盖): `sendMessage` (markdown)、`replyStream` / `replyStreamWithCard` 的 `finish=true` 定稿帧,剥头后无可见正文一律丢弃并 warn 日志。两条豁免: `finish≠true` 的流式中间帧 (打字机 "…"/CoT 进度本来就可能暂时只有头,后续帧会覆盖); 附带 `templateCard` 的定稿 (卡片是载荷,丢卡片会卡死审批流)。headless (`cc-bridge`)、审批回执、MCP `send_markdown`、graph/peers 中继 (`notifyChat`) 等全部出站路径自动受保护。
  - **近源拦截** (`mirror-bridge`): `sendStandalone` / `sendRaw` / `enqueueStandalone` / `flushStandalone` 入口同判 —— 空内容不进 `standalonePending` FIFO、不占防抖 buf、不重置计时器,消除"空 part 入队 → flush join 出空串"的死角。
  判定复用 `parseTagHeader` (与引用去重同一套头解析),已验证: link-only / 纯 tag / 空白全拦, `[链接] 正文` / `🧙 正文` / 意外以动物 emoji 开头的正文全放行。

## [1.3.6] - 2026-09-04

### Added
- CLI/Skill: **`wezard update` 子命令 + `/wezard:update` skill —— 一键升级**。版本判定看**npm 全局副本**而非调用方副本（`npm view` 取 latest，全局已是 latest 则零操作退出；dev 检出领先 npm 时不会误判/误降级全局）→ `npm i -g wezard@latest`（postinstall 顺带 `claude plugin marketplace update` 刷新插件副本里的 hook/MCP/commands）→ **从新装目录 re-exec 收尾**（`__update-finish`，避免在已被 npm 替换的旧树上继续跑；新装副本是 < 1.3.6 旧代码时自动降级为旧副本自带的 `sync` + `reload`）。收尾按 launchd/systemd 记录的 daemon 家目录三分支：指向陈旧 npm prefix（nvm 换 node 后常见）先 HTTP 优雅停再重跑 `install.sh` 重指并顺带重启已注册的 svr；指向源码 dev 检出（`.git`/`tsconfig.json`）只 reload 不动 plist、并跳过 sync（dev 安装的 sync targets 必须继续指向 dev 仓库）；家目录缺失则提示跳过。非 dev 路径收尾统一跑 `wezard sync`（codebuddy hook 是打进本包的绝对路径，prefix 挪了必须重写）。升级后 hook 代码即时生效（每次 tool call 重新 exec），MCP server 与 commands 需重启会话，结束时打印提示。

## [1.3.5] - 2026-09-02

### Fixed
- `mirror`: **引用未收口的 last stream 不再把瞬态内容贴回 prompt**。tag 会话的出站流还在进行中时,群里最新气泡是实时中间态 —— 详情链接 URL + 最新一条 CoT/工具行 (brief) 或累积中的 acc (非 brief);此前引用它走 `quoteInContext` 两级判定 (lastResponse 只记 `finish=true`,transcript tail 里又没有 thinking/CoT 行) 双双 miss,URL 与实时工具/文本被整段注入正文。现在 mirror bridge 暴露 `isOpenBubbleQuote(target, quoted)`: 取该 target 未收口气泡的当前可见正文 (brief 为 `cotLastSent`/`cotText`,非 brief 为 `liveStream` 的 `acc`/`lastSent`),两侧先剥 URL 再做字母数字 canon 比对;引用剥完只剩 URL/省略号直接判命中。命中 ⇒ 只保留路由 tag,正文丢弃;引用旧气泡不受影响 (内容对不上未收口流,照旧走 tail 判定)。

### Changed
- MCP: **`enter` → `set_workspace`，换项目一步到位**。旧 `enter` 只写 pendingCwd、还要人去企微侧补发 `/new` 才生效；`set_workspace` 在 daemon 内部直接走完 `/new` 路径（`setPendingCwd` → 杀 pane → 新 cwd 重开 → attach → 📂 项目回执），等价于「cd 之后用户发了 /new」。调用方就是被换掉的会话时会被当场终止（工具结果不返回，回执气泡即凭证）；spawn 失败时切换仍留在 pendingCwd，手动 `/new` 可兜底。daemon 路由 `POST /mirror/cwd` → `POST /mirror/workspace`，`/pwd` 提示、tips、README、技术说明同步更新。

### Removed
- MCP `enter` 工具与 `POST /mirror/cwd` 写路由（读取用的 `GET /mirror/cwd` 保留），由 `set_workspace` / `POST /mirror/workspace` 取代。

## [1.3.4] - 2026-09-02

### Fixed
- `mirror`: **keepalive 静默判定改为按 user message 内容判断, 不再依赖内存计时窗口**。此前 ping/pong 是否进 chat 取决于 `keepaliveQuiet` 60s 窗口与 `isOwnInject` 60s TTL —— daemon reload / tail replay / 回复慢于 60s 时窗口失效, ping 原文与 pong 回复泄进群聊。现在 `renderLine` 对 user 行先做内容匹配 (`isKeepalivePing`, 与 `keepaliveStamps` 同一套归一化签名: `kc.ping` / `kc.resumePing` 前缀 + 裸 `ping`), 命中即发 `keepalive_start`, `onItem` 据此开启**内容级吞没** (`keepaliveByContent`): ping 行本身不回显、整轮回复(含 thinking/CoT 进度)全吞直到 `turn_end`; 真实 user 行或 5min fail-safe 兜底解除, 崩溃的 ping 轮不会永久静默真轮次。detail turn 与计时路径互不复开 (`fireKeepalive` 检查 `keepaliveTurnId` 已存在)。

## [1.3.3] - 2026-09-02

### Changed
- 文档: **README 与技术说明对齐现状并补全缺口**。README 目录补「跨聊天:给聊天命名」;init 问题表补 wrc 模式行(修复 4 问 ↔ 3 行不一致),前置与自动流程链补 `codebuddy` / 插件安装 / svr 详情中继 / Claude permissions 一次性导入。技术说明新增「多会话路由」(`#tag` 提取与剥离、auto-spawn、命名聊天四级地址空间、多 CLI 由 jsonl 路径反推 dialect)与「Prompt-cache 保活」(`lastMs`/`lastRealMs` 双时钟、四道判定门、零污染与 reload 不复燃)两章,均附流程图。

## [1.3.2] - 2026-09-02

### Added
- `wrc.allowFrom` 支持 `"all"` 通配: 数组含 `"all"` 时任何人可用 (鉴权、`/id` 授权状态展示同步生效)。

- `approval`: **新配置 `approval.danger.skipAll`(MCP key `danger_skip_all`) —— 跳过所有审批**。命中 matcher 的调用一律静默放行, 压过危险名单 / `askRules` / ⏱窗口 / 会话缓存; 与 `danger.skip`(只豁免名单命中) 成对、跳过范围递增。`denyRules` 拒绝与 `EnterPlanMode` 拦截仍生效 (拒绝不是审批), `AskUserQuestion` / `ExitPlanMode` 交互卡不受影响。与 `approval.enabled=false` 的区别: skipAll 明确回答 allow (CLI 零打扰), enabled=false 回答 ask (退回 CLI 本地权限)。`config_set` 的 `approval_mode` 增加枚举校验 (非法值会让 daemon reload 时 zod 抛错起不来)。新增 [审批配置.md](审批配置.md) 覆盖审批粒度、两个跳过开关、判定链与运行时切换。

- `mirror`: 新配置 `wrc.mirror.slashAckFirstLine`(默认 `false`)。开启后 `/clear`、`/new` 的会话边界回执只发第一行 ack(`cleared` / `created`),不再附 📂 项目信息与 💡 tip;含 `/clear`→`/new` 升级路径。cwd 随时 `/pwd` 可查。已加入 MCP `config_set` 白名单(key `slash_ack_first_line`),可在 wezard 会话里直接开关,写盘 + 内存即时生效、无需 reload。

## [1.3.1] - 2026-09-02

### Changed
- `mirror`: **对话边界收口不再凭空新发/覆盖消息**。连续发消息触发上一轮的强制结束时:(a) 有正文才写 —— brief 气泡以 `链接 正文` 收口、非 brief 的 liveStream 以累积 acc 收口、deferred 缓冲收入旧 streamId(`finish=true` 顺带关掉它的 loading 气泡),不再整体另发 standalone;(b) 没正文一个字都不写 —— 旧代码的裸链接/`" "` 空收口会把 `链接 …`/CoT 进度行整条覆盖掉,结束处理自己制造错发,现在气泡保持现有内容由企微 6min 窗口自然到期。`closeBriefTurn` 软/硬/边界三路统一为先 `concludeBriefTurn(briefLastText)` 再清态,`soft` 形参移除。

- `mirror` brief: **CoT 进度行的内容源补上非终句文本**。此前只取 thinking 与工具调用,模型在工具之间打的叙述性文字("我先看看这个文件…")不进气泡;现在进度行取"最新一条 CoT 内容"——thinking / 非终句文本(软后端含最终答案本身,收口时整条被覆盖)/ 工具调用,三类 whichever-latest。

## [1.3.0] - 2026-09-02

### Added
- `mirror` brief: **气泡在正文落地前实时显示 CoT 进度**。一轮里正文要等 final text 才落地,中间几十秒到几分钟气泡只有一个 `…`;现在最新的 thinking(codebuddy 的 reasoning 归一后的 `thinking` 块)与工具调用会持续覆盖进这条未收口的气泡,形态为 `tag 详情链接 \`进度片段…\``,片段压成单行、截断 100 字符(尾随省略号兼任"进行中"标记, 与截断标记合一不叠加)、刷新节流 1.5s。只写"还没收口的气泡":结论一到即被 `链接 正文` 整条替换,进度不残留在最终气泡里 —— 这是它与已下线的 thinkStyle 的分界线(后者把整轮 reasoning 拼进正文,单条体积翻几倍被分页切成多页刷屏)。

### Changed
- `mirror`: **新消息即对话边界 —— 上一 turn 的出站状态当场全部收尾,新回复只走最新气泡**。收到 WeCom 新消息时:(a) brief 模式立刻收掉上一 turn(气泡以详情链接收口、CoT 进度撤销、turn 记录关闭),新 turn 直接激活,不再排队 —— 排队 turn 的 frame 在前一个长 turn 期间(可达数分钟)过期,激活后 `replyStream` 全被企微拒收,是 #stream 会话"发卡后 mirror 静默"的根因;(b) 非 brief 的 deferred 缓冲(已消费未下发的 item)冲成 standalone 收尾,不再静默丢弃;(c) 旧 turn 挂着的 `softEnd` 静默期判决撤销,防止它在新 turn 中途开火提前收掉新气泡。`briefQueue` 排队机制随之整体移除;代价是旧 turn 页提前标"已完成"、CLI 侧仍在产出的尾部 item 记到新 turn 名下 —— 这正是"新回复走最新气泡"的语义。
- `mirror` brief: **收到消息那一刻就把详情链接挂进气泡**,ack 内容从 `…` 变成 `tag 详情链接 …`。链接的三个入参(turnId / target / host)在收消息时全部已知 —— turnId 本地生成、详情页记录由 `recordTurnStart` 先建好 —— 所以无需等任何 CLI 产出;尾随的 `…` 表示"正文还没到",正文到位时整条内容被 `链接 正文` 覆盖,始终没正文则以纯链接收口。此前是"3s 无产出才补链接"的 `earlyTimer`,既被 codebuddy 后端整体跳过,又会被 `user_text` 清表,实际常年不触发,气泡整轮停在纯文本占位上。
- `mirror` 分页预算改按**字节**计,单页上限抬到 3800B(`wrc.mirror.chunkChars` → `chunkBytes`,默认 `1800` → `3800`)。企微 markdown 的 `content` 上限是 4096 **字节**而非字符,旧的字符预算对英文浪费了大半页,对中文又必然超限;`shared/md-chunk` 的 `sizeOf` / `sliceLine` 同步改成 `Buffer.byteLength` 计量,长行按 code point 切(不再切断 emoji 代理对)。头部分片预留 32 → 64B(链接态 `[🧙 #tag](url)` 可达 110B)。
- `mirror` brief 模式: **气泡不再按"有无工具"分岔**。此前无工具的 turn 以 `正文\n\n链接` 收口(经 `withLinkedTag` 再包一次头,群里出现两个链接),有工具的走另一条路;现在统一为 `链接 正文`,`briefHadTool` 只用于判断 slash 命令的 `skill_output` 是不是本轮答案。

### Removed
- `mirror` **think-style 实验下线**: `wrc.mirror.thinkStyle` 及 `pushThink` / `doStreamThink` / `formatThinkStandalone` 全套移除(`<think>` 折叠区、standalone 的 `💭` 传输标记、`parseTagHeader` 的 `<think>` 剥离一并清掉), 实验代码保留在 `backup/think-style` 分支。

## [1.2.31] - 2026-09-01

### Fixed
- `mirror` think-style: **气泡收口后的 reasoning 不再作为裸正文泄进聊天**。长 turn 里气泡一旦收口(6min 编辑窗口、`earlyLinkBubble`、工具密集),后续落盘的 thinking 只能走 standalone 补发,而 standalone 的 think 识别只认 `🔧` / `↳` 两个工具行前缀 —— 纯 reasoning 段落被当成正文整段裸奔出去。`pushThink` 现在给进 standalone 的中间内容打 `💭` 传输标记,`formatThinkStandalone` 凭它分流入 `<think>`(标记在渲染时剥掉;`🔧` / `↳` 是给用户的工具行标记,保留)。
- `mirror` think-style: **软后端(codebuddy)的最终答复不再被误包进 `<think>`**。软后端没有 `final` 标记,终句与中间文本共用 `final===undefined`,此前一律走 `pushThink` —— 气泡活着时无害(收口有 `stripTrailingBody` 剥重复纠偏),气泡死了就等于给答复打上 think 标记直接发出去。现在该分支按气泡状态分流:活则仍进 think 累积并记 `briefLastText`,终句身份留给 `closeBriefTurn(soft)` 定夺;死则按正文发 —— 没有收口阶段可纠偏,而它很可能就是终句。

## [1.2.30] - 2026-09-01

### Changed
- `mirror` standalone 防抖窗口默认 `8s → 30s`(`wrc.mirror.standaloneDebounceMs`)。长 turn 里工具调用之间的间隔动辄十几秒,8s 仍会切成多条气泡;30s 能把一整段工具链聚合成一条再补发。

## [1.2.29] - 2026-09-01

### Changed
- `mirror` standalone 防抖窗口默认 `3s → 8s`(`wrc.mirror.standaloneDebounceMs`)。连续工具调用间隔常超过 3s,窗口太短仍会按气泡刷屏;8s 能把一整串工具调用聚合成一条 markdown 后再补发。

## [1.2.22] - 2026-08-27

### Changed
- `mirror` think-style: **中间过程实时流进 `<think>`,不再只在收口时拼前缀**。开启 `wrc.mirror.thinkStyle` 后,本轮的 reasoning、非 final 的中途文本、以及**每一次工具调用/结果**(`🔧 Name …` / `↳ …` 摘要)都实时追加进气泡里那段 `<think>🧙 …` 流,只有 final 文本才结束思考、落成 `</think>` 之后的正文。用户一发消息气泡立刻以 `<think>🧙 #tag ` 开头(tag 塞在 `<think>` 内),看得到 Claude 正在想什么,而不是先干等一个 `…` 占位再一次性出全文。

### Fixed
- `mirror` think-style: **气泡过了 6min 编辑窗口后,累积的思考不再丢**。窗口外气泡刷不动了,改走 10s 防抖把 think 增量整段补发成一条独立 `<think>🧙 …</think>` standalone;turn 收口时冲干净残余,不漏最后一段思考。
- `mirror` think-style: **软后端的最终正文不再重复出现一次**。软后端(如 codebuddy)的最终正文会先作为「非 final 中途文本」进过 think 流,收口再当正文用一次;收口前把 think 尾部恰好等于正文的那段剥掉(含前导 `\n\n`),保证正文只出现在 `</think>` 之后一次。
- `inbound` 引用去重: **带引用新建 / 改投到别的 `#tag` 时,原文不再被重复注入**。去重比对的会话改成引用气泡真正的**源会话**(反解 `emoji #tag` 头得知),而非路由目标——原文天然存在于源的 transcript,与你把它投到哪个 tag 无关;源未知(用户自打的引用)才回退按目标查。
- `inbound` 引用去重: **引用一个 `🔧 Grep …` 工具气泡不再误判为「不在上下文」而重复注入**。末轮 transcript 的扁平化文本现在也纳入 `tool_use` / `tool_result`(工具名+入参、结果文本),与出站工具气泡的 `🔧 <Name> <input>` / `↳ <result>` 渲染对齐,子串比对才能命中。
- `session-label` `parseTagHeader`: **think-style 气泡被引用时能正确反解出 tag 头**。tag 头此时塞在 `<think>` 内(`<think>🦊 #fix …</think>\n\n正文`),微信引用时 `<think>` 标记有时保留有时被渲染剥掉;现在先剥掉可能存在的起始 `<think>` 再认头,body 保留 think+正文全文(仅去 `<think>`/`</think>` 标记杂质),`canonContains` 子串比对必然命中。
- `approval` 「聊聊这个」: **补第二个 Enter,talk-about-this 不再卡在提交页**。自定义文本确认为本题答案后前进到提交页,还需再一个 Enter 在提交页(光标 0 = `1. Submit answers`)收工;缺它 CLI 会一直等输入。

## [1.2.21] - 2026-08-25

### Fixed
- `peers`: **compound `chatName#tag` 地址在用户正文里被正确识别并标注**。此前 `#tag` 的正则要求 `#` 前有空白,导致 `sanitizer#handle824` 这种紧凑写法对路由和标注都不可见——消息整条落进本 chat 的默认会话,目标 chat 里什么都没被创建。现在 `peerMentions` 在 `allTags` 之外额外扫描 `word#word` 形式的 compound 地址,chat 名合法即标注;目标会话尚不存在时(unborn peer)也注入提示,告诉 agent 先 `new_claude_session` 再 `send_peer`。

### Changed
- `launchd`: plist 模板移除 `NODE_ENV=production`——daemon 不依赖该变量,且它会干扰 tsx dev 模式。

## [1.2.20] - 2026-08-24

### Fixed
- `sessions`: **`new_claude_session` 在调用方自己的 chat 里建 peer**,不再掉进 `defaultChat`。这个工具此前不带 `selfRef`,daemon 只能 `target ?? cfg.defaultChat` 兜底,于是非 default 会话里的 agent 一喊「新开一个会话」,session 就落到另一个群里 —— 叫它的人既看不见也够不着;而且落点是**不带 tag 的 key**,那就是那个 chat 的默认会话,attach 直接把原本镜像在那儿的会话顶掉。现在:调用方按 `sessionId` / `tmuxPane` 解析出自己所在的 chat,新会话一律带 `#tag` 落成同 chat 的 peer(tag 可显式给,省略则由目录名派生并去重;撞上已存在的 tag 直接拒绝,而不是 respawn 掉那个正在跑的 peer),并且改走 `newSession` 而非裸 spawn+attach —— cwd/CLI 的 chat 级继承、tmux 窗口名、以及「created + 📂 当前项目」那条气泡全都和用户手打 `/new #tag` 完全一致:群里发得出消息、chat detail 里有记录、`list_peers` / `send_peer` 立刻能寻址。

### Added
- `chats`: **给聊天命名,跨聊天寻址与建会话**。一个 WeCom 聊天的身份是 `chat:wrkS…` 这种既读不出也打不进去的 id,所以在此之前跨聊天只有「全局唯一 tag」一条路:两个群各有一个 `#fix`,就谁也叫不动谁,唯一的出路是回去改别人的 tag。现在 `/name daily` 给聊天起个名(`/name` 查看、`/name -` 取消;名字全机唯一、大小写不敏感,落在 `config.jsonc` 的 `chats` 里,和 `topics` 同一套写法),地址空间随之变成两级:`fix` 仍是本聊天的 `#fix`(老语义一字不改,不唯一时才回退全局搜),`daily#fix` 精确到那个聊天的那个会话、不问 tag 全不全局唯一,`daily#` 是它的默认会话。`send_peer` / `peek_peer` / `wait_peer` 都收这个全称,`list_peers` 的每一行现在直接给出该照抄的 `address`,`foreignPeers` 也从「只有全局唯一 tag」放宽到「全局唯一 tag **或** 所在聊天有名字」。新增 `/chats` 与 `list_chats` 作为跨聊天目录(谁有名字、各自跑着哪些会话),以及 `name_chat` 让 agent 也能读写名字。最后一块:`new_claude_session` 新增 `chat` 参数,可以直接在**另一个已命名的聊天**里建 peer —— 「目标 peer 还不存在」不再需要找个人去那个群里手打 `/new`。未命名的聊天依旧无法被寻址、也无法被建入,这是刻意的:往一个谁也读不出的 `chat:wr…` id 里塞会话,等于把它扔进一个调用方根本不该进的群。
- `peers`: **跨 chat 的 peer 寻址**。`send_peer` / `peek_peer` / `wait_peer` / `handoff` 的 `tag` 参数在本 chat 找不到目标时,会在全 host 的 sessions 里回退搜同名 tag —— 只当命中数**正好为 1** 时才认(0/多命中都拒绝、把原因回给调用方),把「跨 chat 交接」收敛成「让目标群里的 peer 起一个全局唯一的 tag」这一个约束,不引入 alias 表、不改授权模型。相应地 `list_peers` 新增 `foreignPeers`(其他 chat 里全局唯一 tag 的 session 列表),给 agent 发现可跨群命中的 peer。跨 chat 的 relay 气泡两侧 chat 都会推,免得被叫的那侧看不到「另一个群的 agent 找上门了」这件事。典型用法:daily 语料链的 peer 产出 corpus,直接 `send_peer("sanitizer-ingest")` 交给 sanitizer 群里的 `#sanitizer-ingest` 继续。

## [1.2.19] - 2026-08-19

### Fixed
- `approval`: `.claude/**` 守卫退出 `mustCard` 语义——守卫要的不是「强制发卡」而是「allow 之后有人去按 CC 原生框」,⏱ 自动过窗口恢复生效。排掉 `.claude/worktrees/**`(整棵检出代码树,非配置面）但 worktree 自己的 `.claude/` 仍拦截。错误出口保持 `ask` 降级;收尾按 sessionId 串 promise 链防并发代按;必发卡按钮面改由 `forceSingle` 决定。

## [1.2.18] - 2026-08-19

### Fixed
- `approval`: 时间窗按钮不再是红色(企微 `style:3` 渲染成红色,与「放行」语义相悖),改 `style:1`(蓝)+ 文案 `⏱10h自动过` 点明语义;单条卡与批量卡同步。

### Changed
- `keepalive`: **每轮心跳都发完整指令**,不再从第二轮起缩成裸 `ping`。缩写省下的那点 cache-write 换来的是不确定的回复 —— 裸 `ping` 在模型看来只是一次普通提问,爱怎么答怎么答,而任何非 `pong` 的回复都会被当成真实活动:心跳被"解吞"发进企微、`lastRealMs` 重新锚定、轮次计数清零。完整指令每轮重述,回复才稳定是 `pong`。`keepaliveStamps` 仍认裸 `ping`(旧 transcript 里还留着)。

## [1.2.17] - 2026-08-17

### Fixed
- `approval`: 「✅总是」补两处遗漏。① **批量卡上也给这个按钮** —— 合流的成员是同一个工具的 N 次调用,单卡有「总是」而批量卡没有,只能先等它拆开或逐个点,机制在最需要的场景(一串同类调用)恰好用不上;逐位成员各自走一遍规则生成,已被现有规则覆盖的不重复加,结果与逐个点「总是」一致。② **`.claude/**` 守卫生效时不生成规则**,并说明原因。此前这种卡上点「总是」会存下一条**永远被守卫压过**的死规则,更糟的是万一日后关掉守卫,这条 allow 就把静默死锁原样放回来(不发卡 + pane 无限期阻塞);现在只做一次性放行,并回执讲清「那个原生确认框只有在你点过卡之后才能被代按,免审就等于回到死锁」。同理,「提炼不出可靠字面规则」的兜底提示也不再在守卫卡上误报。
- `ws`: WS 握手加 15s 超时,防止睡眠唤醒后 TCP 通但 upgrade 不返回导致重连链悬挂、对企微永久失聪(补 #7 之外的第二条失聪路径)。

## [1.2.16] - 2026-08-12

### Changed
- `approval`: **审批卡信息架构重排** —— 解决的是「看不出这张卡要批的是什么」。旧布局把 `🔐 授权 · <工具名> · <目录>/` 放在一级标题(26 字里有 8 个花在固定的锁图标与「授权」二字上),真正决定要不要点的**命令主体**却挤在描述行里被截断;并行跑多个会话时,几张卡长得一模一样,分不清是谁在请求。新布局按「谁在问 > 想干什么 > 具体命令 > 上下文」重排:一级标题放 Claude 自己写的 `tool_input.description`(它回答"想干什么",是 26 字里最值钱的内容;没有 description 的 `Read`/`Write`/`Edit` 回落「工具 · 目录/」,因为路径在下面引用区里已经有了);**命令主体搬进 `quote_area`**、无标题、整块可点进详情页;`horizontal_content` 放「上文」(最近一条用户消息)与**为什么要人来点这一下**(危险卡显示命中的名单规则,普通卡显示「审核」行 —— 即这条命令是**哪一段**没被 `allowRules` 覆盖,能算出规则时直接显示「点总是会生成什么」;没配任何规则时这行不显示,免得变成每张卡都有的噪声)。
- `approval`: **卡片标题带会话名** —— 一个 chat 里并行跑多个会话时,`⏱`/`✅` 点下去到底作用在谁身上是靠猜的。会话名按可靠度降级取:`#tag`(企微侧显式命名,人起的名最准)→ Claude Code 自己的会话名(`~/.claude{,-internal}/sessions/<pid>.json` 注册表的 `name`,即 CC 会话列表显示的那个;只覆盖活着的进程,而发卡时会话必然活着 —— hook 正是它触发的)→ transcript 首条用户消息首句 → sessionId 尾八位。发卡时算好写进 pending,已决卡重渲染直接复用(点击事件回调里拿不到 `transcript_path`,现算不出来)。
- `approval`: **长命令看全文的两条路径**,都挂在卡片自己身上,不再默认额外推一条全文消息:引用区整块可点 → 详情页(有高亮,PC 端好用);右上角「⋯」→「📄 展开完整命令」→ 按需在群里发全文(不跳出企微,手机端可用,按 1800 字/条分块)。起因是手机端客户端**实测只渲染 `quote_area` 前 2~3 行**,长命令在卡上根本看不完,而无条件先发一条全文消息会把群刷满。新增 `approval.cardQuoteMaxChars`(默认 1200;企微未公开 `quote_text` 上限,发送失败自动缩到 600 重试一次)与 `approval.fullCommandPreludeChars`(默认 **0 = 关闭**旧的无条件前置;设正数可恢复,用于客户端不渲染 `action_menu`、或就是要全文无条件落在群里的场景)。

### Added
- `approval`: 审批卡新增 **「✅总是」按钮** —— 由本次调用生成 `allowRules` 规则,热生效 + 追加写回 `config.jsonc`(对齐 Claude Code 原生弹窗的 Always allow)。解决的是三层规则的**上手断层**:规则机制有了,但要用就得离开企微、打开 `config.jsonc`、自己想清楚该写 `Bash(git log *)` 还是 `Bash(git *)` —— 于是绝大多数人一条都不配,继续每次都点卡。现在在手机上点一下就长一条规则出来。生成器 `alwaysAllowRulesFor`(已随三层规则合入,此前没有调用方)负责挑安全的字面前缀。三种「点了但不该存」的情况都**明确回执、不静默**:① 命中 `askRules` → allow 永远被 ask 压过,存了是死规则,提示要改 `askRules`;② 命中危险名单 → 提示只能用 `danger.allowPatterns`;③ 提炼不出可靠前缀(含 `$()`/反引号、未闭合引号、异形段首)→ 说明**具体是哪一种**成因后一次性放行。规则生成用未脱敏的原始 `toolInput`(`sensitiveArgRedact` 改写过的副本会生成匹配不上真实命令的前缀)。写盘失败只 `warn`、不回滚内存,本次点击的意图不因文件权限问题丢失。
- `init`: **一次性导入 Claude Code 的 `permissions`**(`wezard init` 交互确认,或 `wezard-init --import-claude-permissions [settings.json]` 随时增量重跑)。三层规则的语法本来就是 Claude `permissions` 的子集,而用惯 Claude Code 的人手上早就攒了几十条 allow/ask/deny —— 让他为了少收几张卡再手抄一遍 `config.jsonc` 是没必要的门槛,而门槛的实际后果是规则一条都不配、继续每次都发卡。`mapClaudePermissions` 逐条映射,引擎不支持的条目(如带 `//` 路径限定的 `Read(~/foo/**)`、`WebFetch(domain:*)`)**跳过并计数报给用户**,不静默丢。写回走 `appendUnique`,重复导入不会堆出重复规则。刻意只读一次、不做运行时耦合:Claude 的配置格式演进不会影响 daemon,导入后 `allowRules` 由 wezard 自管。
- `approval`: **`.claude/**` 写守卫** —— 补一个架构级的静默死锁。改动 Claude 自己的配置面(`settings.json` / `hooks` / `skills` / `commands` …)时,Claude Code 会立起它**自己的**原生确认框,而那个框**不经过 PreToolUse hook**:企微端既看不到也点不到,pane 就无限期阻塞,用户只看到会话「卡住了」。配了 `allowRules` 之后更糟(尤其从 Claude `settings.json` 批量导入的宽规则):规则一放行 = 不发卡 + pane 静默阻塞,连「有东西在等确认」这个信号都没有。现在命中 `.claude/**` 写、且该 session 有**活 pane** 可代按时强制发卡(压过 `allowRules` / ⏱窗口 / 会话缓存),用户点「允许」后 daemon 去 pane 上把那个框按掉。代按的边界刻意收得很窄——它做的是「完成用户已经作出的决定」,不是替他决定:只认标题形如 `Do/Would/Should you …` 的**权限**确认框(`/model` 选择器、plan review 同样是 modal 但语义完全不同,一律不碰)、只挑**裸 `Yes`**、永不选 `Yes, and don't ask again` 这类放宽后续权限的选项、只取屏上**最后一组**连续编号选项(屏上残留的旧确认不会被误按)。挑不出可信选项就不按:Esc 取消本次调用,再把原因作为一条用户消息注入会话,模型收到的是「这条路走不通 + 该怎么绕」,等价于预拦截 `deny + reason`。没有活 pane(headless / 未镜像的本地会话)则**完全不介入**——那种情形用户就在键盘前,自己按掉即可。新增配置 `approval.claudeConfigGuard`(默认开)/ `claudeConfigModalWaitMs`(4s;CC 要等 hook 进程退出才渲染那个框,所以代按只能在响应发出之后 fire-and-forget 地轮询等它出现)。路径判定 `claudeConfigWrite` 是纯函数:认 `Write`/`Edit`/`NotebookEdit` 的 `file_path` 与 Bash 重定向目标,按**路径段**比较(`.claude` 必须是完整一段,`foo.claude/x` 不算),软链目标也解析,`Read` 不拦。新增 36 例测试(`tests/claude-config-path.test.ts` 20 例 + `tests/modal-pane.test.ts` 补 6 例选项解析与代按挑选)。
- `approval`: **Claude-Code 风格的三层规则** `allowRules` / `askRules` / `denyRules`(语法子集见 `shared/allow-rules.ts`),判定链 `denyRules → danger → askRules → allowRules → ⏱窗口 → sessionCache → 发卡`。补的是 `matcher` 的粒度缺口:`matcher` 只认工具名,而「`git log` 免卡、`git push` 必卡」这类区分只能按**命令前缀**表达。支持 `Read` / `mcp__server__tool` / `Bash(git status)` 精确 / `Bash(git log *)` 前缀 / `Bash(npm run test:*)` 冒号前缀。安全语义都在纯函数里,可单测:复合命令按 `&&` `;` `|` 逐段校验(**任一段没被覆盖就发卡**,`ruleMatchesAny` 对 deny/ask 则是任一段命中即生效)、反斜杠转义的分隔符不切、引号内的分隔符不切、heredoc 体不参与匹配、段首 `VAR=value` 前缀剥掉后再比、fd 重定向里的 `&` 当数据而非后台符、命令含 `$()`/反引号一律不命中(展开结果静态判不了)。`AskUserQuestion` / `ExitPlanMode` / `EnterPlanMode` 在引擎内部硬保护,写了规则也不放行。**危险名单(`danger`)与 `askRules` 同层、排在 `allowRules` 之前**:否则一条 `Bash(git *)` 这样的宽 allow 规则就能让整份危险名单失效;`danger.skip` / `danger` 模式的早退也不再顺带关掉用户显式配的 `askRules`(`dangerEarlyExit`)。`fallbackOnError:"allow"` 的降级保护同样从「只护 danger」扩到「护住一切必发卡的请求」—— 否则 daemon 挂掉时 `askRules` 反而失效。新增 88 例单测(`tests/allow-rules.test.ts` / `tests/deny-reason.test.ts` / `tests/danger-early-exit.test.ts`,独立可执行,无 runner 依赖)。
- `inbound`: `/kill` —— 结束会话并移除 pane。先 Esc(给 CLI 一拍收尾 transcript 的时间)再 `kill-pane`,随后 detach 并**丢掉持久化绑定**:留着的话下一条消息会走死 pane 的 `--resume` 自愈把它原地复活,与 `/kill` 语义相反。之后该聊天的下一条消息自动新开会话。与 `/stop` 一样按 `#tag` 路由(`/kill #docs` 只干掉那个兄弟会话)。
- `chat details`: turn 记录带上运行时 `cwd`(取自 pane 的 `runningCwd`,而非全局 `wrc.cwd`),详情页两处呈现:顶栏 `📁 …/尾两段`(hover 出全路径)、侧栏会话行末尾 `📁 <目录名>`。同一 chat 的兄弟会话可以各跑各的目录(主仓 / worktree),不标出来光看 `#tag` 分不清谁在哪。
- `keepalive`: stall 恢复,**纯规则判定、不让 model 自判**。transcript 末轮是 synthetic API-error/limit 行(`API Error: Connection closed mid-response` / `You've hit your session limit`),或空闲 pane footer 出现错误横幅 —— 判定某轮因限流/接口失败中途夭折,ping 改发 `resumePing`(直接“继续未完成的工作”)。新增 config `keepalive.resumeOnStall`(默认开)/ `keepalive.resumePing`;`transcriptStalled` / `paneIsStalled` 两个规则信号。
- `inbound`: **引用即路由** —— 直接「引用」某个 `#tag` 会话的气泡来回复,等价于手打该 tag,消息投递到那个会话;且 quote 内容**不再进 prompt**(被引用的那条本就在目标会话自己的上下文里,重复贴入纯属污染)。识别依据是出站气泡的 `emoji #tag` 头(`parseTagHeader`,裸头与 chat-detail 链接头 `[🦊 #fix](url)` 两种形态都认,分片序号 / `← View chat details` 一并算作头),用户自己发的行首 `#tag` 消息同样可被引用。引用之外自己打的 `#tag` 优先级更高。配套规则:引用内容若**已在目标会话 context 尾部**(先比对最近一条出站气泡,miss 再归一化匹配目标 transcript 末 12 轮)则只保留这层路由绑定、正文丢弃;不在(跨会话转发 / 引同事的消息 / 目标已 `/clear`)才照旧渲染成引用块。text / image / mixed 三条入站路径统一走 `composeInbound`,图片消息因此也能被引用路由到 `#tag` 会话。
- `keepalive`: ping 的 assistant 回复只要不是纯 "pong" 即视为 real activity —— 从 chat 里放行(un-swallow)整轮续跑内容,并重锚 `lastRealMs` / 重置 round 预算。据此“回复是 pong 还是其他内容”刷新真实输出时钟。

- `chat details`: **graph 归因**。graph 注入的每一轮在 turn 记录上落一枚 `origin`(`runId` / 轮次 / 步序 / `fromTag`),随 `details.jsonl` 持久化 —— graph run 本身是内存态,一次 reload 就没了,归因必须自己过夜,否则重启后历史 turn 说不清是谁派的。三处呈现:turn 卡片顶部的紫色归因条(与上下文断点条并列,两者可同时出现)、侧栏会话行的 `🕸 runId` 徽标(区分「有人在跟 #fix 说话」和「graph 在喂它」)、以及主区顶部的运行条 `🕸 id · 🦊#fix → 🐢#review · ⟳ 轮 3/5`,当前步高亮、可点击跳转。**不画节点图**:`steps` 结构上不可能分叉,拓扑永远是一条线,画出来是纯装饰;真正有信息量的时间维度已经由 thread 承载。运行条的流水线从这些 `origin` 反推(`graphSummaries`),不依赖内存 run,svr 侧同样成立。

### Changed
- `peers`: **peer 之间的对话改从 transcript 读,不再抓 tmux pane**。`peek_peer` 返回 `dialog` —— 目标会话最近 N 轮的真实对话(`▸` 问 / `◂` 答),来自它自己的 jsonl:整条消息(pane 会被视口截断)、无 ANSI / TUI 噪声、天然带 role。pane 只保留两个它独有的职责:`busy` 判定,以及 transcript 尚未可读(没绑定 / 刚 `/clear`)时的兜底 `pane` 字段。入参 `rows` → `turns`(1-40,默认 6)。新增 `renderDialog`(纯函数)/ `peekTurns`(bridge)。
- `peers`: **agent↔agent 的问询与回复下发到 chat**。`send_peer` 注入成功后推一条 `<发起方> → <目标>` 气泡带原文,`wait_peer` 等到目标真正空闲后推一条 `<目标> → <发起方>` 带回复(超时不推 —— 半截的回答不是答案)。此前这些流量只发生在两个没人盯着的 pane 里。
- `graph`: 步骤气泡带上流量本身 —— `▸` 本步注入的 prompt、`◂` 该节点的回复,而非只有 `2/6 ✅`。
- `peers`: `keepaliveStamps` 判据从「紧跟 ping 的 assistant 回复一律算 keepalive」收窄为「仅纯 pong 算 keepalive」,配合 stall 恢复识别续跑;签名改收 `pingSigs: string[]`(同时匹配普通 ping 与 resume ping 的注入 user 行)。
- `peers`: `/peers` 输出重排 —— 摘要文本剥掉 markdown 活跃字符(反引号/星号/竖线,来自 transcript 的原文会被 WeCom 渲染成代码块而撕裂排版),同值字段(项目目录 / CLI)上提到标题行,条目之间空行分隔。
- `mirror`: 移除 `broadcastTo` 转发管道 —— `base#tag` 与 `base` 剥出来是同一个 WeCom chatid,节点自己的推送本就落在这个会话里,再广播一次纯属重复。

### Removed
- `keepalive`: 移除 KeepAlive 心跳通知(`keepalive.notify` 配置项及第 1/3/6 轮的 `KeepAlive n/N · ~Nk` 气泡)。保活是纯后台省钱动作,群里不需要看见;完整 ping/pong 仍留痕在 chat detail 时间线。

### Fixed
- `sessions`: **`/sessions` 扫描的子进程加硬超时**(`SCAN_CMD_TIMEOUT_MS`,15s)。`session-scan.ts` 的 `runCmd` 是上一轮 tmux 超时收敛漏掉的第四条 exec 路径 —— 它跑 `lsof` 和 `tmux`,两者都能无限期挂住:`lsof` 卡在僵死的网络挂载上、tmux server wedged。挂住的后果比丢一次扫描严重得多:`/sessions` 永远不回答,调用方的 `await` 也永远不返回。现在到点 `SIGKILL` 并退化成「没有输出」,与其它失败路径同一处理。
- `approval`: **`askRules` 的「必须单独确认」补齐到所有旁路**。上一版只在判定链上让 `askRules` 压过 `allowRules` 与 ⏱窗口,但发卡之后的五条旁路仍然只认 `danger`,于是命中 `askRules` 的卡照样会被绕过:① 另一张卡的「⏱ N 分钟全过」sweep 把它一并放行(`resolvePendingsByChat` 只排除 `p.meta.danger`);② 与其它请求合流成批量卡,被「全过」一次点掉;③ 命中会话缓存直接放行;④ 用户在这张卡上点「本会话都放行」/「N 分钟全过」时落缓存、开窗口;⑤ daemon 超时/断线时走 `fallbackOnError:"allow"` 静默放行(`fallback` 的第三参已改名 `forceSingle`,但传进去的仍是 `danger`)。现在这五处统一判 `mustCard`(危险名单 ∪ `askRules`),并把「必须单独点」作为 `forceSingle` 落到 pending meta 上 —— `danger` 字段退回只负责卡片渲染(⚠️ 标题 + 去掉「全过」按钮)。
- `mirror`: **tmux 调用全部收敛到一条 exec 路径并加硬超时**(`TMUX_TIMEOUT_MS`,默认 10s,`WEZARD_TMUX_TIMEOUT_MS` 可调,0 关闭)。此前 daemon 里有三份手写的 `spawn("tmux", …)`(`spawn-tmux.runTmux`、`mirror-bridge` 模块级 `tmuxRun`、`startMirror` 内又一个同名局部 `tmuxRun` 遮蔽了它),全部无超时:tmux server 一旦卡住,调用方永久 pending 且零日志 —— 一条入站消息建了 pane,随后 `tmuxPaneAlive` 再也不返回,该会话的 inject 队列被僵尸 job 锁住,那个聊天从此彻底静默,只能重启 daemon。现在三处合一,超时用 `SIGKILL`(卡在 wedged server 上的 tmux client 不理 `SIGTERM`)并以普通失败态 resolve,所有现存 `if (!r.ok)` 分支照旧生效;超时必留痕,由 daemon 启动时注入的 reporter 打 `warn`。`load-buffer -` 这类 stdin 变体一并走同一路径。
- `mirror`: **inject job 加 watchdog**(`INJECT_JOB_TIMEOUT_MS`)。job 链上每个 `await` 原本都是无界的,超时后队列不再释放;现在到点释放队列、告知用户,并 bump `injectGen` 让僵尸 job 醒来后不再往 pane 里贴。job 起手先打一行 `inject job start`,下次卡住能定位到具体步骤。
- `mirror`: **`/stop` 改为先收口、后 Esc**。旧实现先探 pane、探不到就早退 —— 而 tmux 本身就是卡住的那一环时,用户手上留着一个关不掉的 `…` 气泡和一条谁也过不去的 inject 队列。现在先做与 tmux 无关的部分(bump `injectGen`、清 inject 队列、收掉所有挂起气泡/stream),再尽力 Esc;Esc 失败只报告不致命,并带上收了几个气泡。只想按 Esc 的调用方(不传 `opts`)行为不变。
- `mirror`: **拒绝往 modal 状态的 CLI picker 里注入**。权限确认框 / `/model` 选择器 / plan review 这类 modal 会把粘贴进去的文本吃掉,并把随后的 Enter 读成「确认当前高亮项」—— 一条 WeCom 消息就此丢失,同时替用户点掉了一个他没看到的确认框。最典型的触发场景:编辑 `.claude/**` 下任何文件都会让 Claude Code 立起它自己的「allow Claude to edit its own settings」确认,而那个框**不过 PreToolUse hook**,daemon 完全不知情,pane 就一直阻塞在那里。现在注入前先 `capture-pane -p` 看一屏,判定为 modal 就带标题原因返回失败(消息不丢,用户可去 tmux 处理或 `/stop` 后重发)。判定放在**按后端分流之前** —— 每个 CLI 后端都有自己的原生确认框,放到分流之后只保护得住 claude 一家;图片注入路径同样先过这道判定。判据刻意保守:必须同时出现「编号选项行」与「`Esc to cancel` footer」两个信号才算 modal(误判会挡住正常消息,比漏判一个冷门布局更糟);capture 只取当前屏、不进 scrollback(用户答完的旧确认会永远留在 scrollback 里,带上它会把镜像永久堵死)。逃生开关 `WEZARD_MODAL_GUARD=0`。
- `ws`: **重连上限改为无限**(`MAX_RECONNECT = -1`,走 SDK 原生无限重连 + 30s 封顶的指数退避)。有限次数是个陷阱:睡眠唤醒 / 切网时 DNS 短暂 `ENOTFOUND`,10 次重连累计只撑约 2 分钟就耗尽,此后 SDK 抛 `WSReconnectExhaustedError` 彻底躺平 —— 进程活着、`/healthz` 的 `ok` 仍为 true、HTTP 端口也通,但对 WeCom 完全失聪:发不出卡、收不到按钮点击,且不会自行恢复(DNS 早已好了也没用)。两个 fail-fast 边界不受影响:认证失败走独立的 `MAX_AUTH_FAIL` 计数器;被服务端踢下线(别处建了新连接)时 SDK 置 `isManualClose` 后本就不重连,不会两个 daemon 互抢。
- `mirror`: **`/clear` 轮换的会话认领必须可归属到本 pane**,否则拒绝认领。轮换后的 transcript 只有「首条 user 行是 `/clear`」这一个特征,每个 chat 的 `/clear` 都长这样;同一 project dir 下两个 chat 先后 `/clear` 时,先起的 watcher 会把后者刚轮换出来的会话抢走 —— 两个 chat 就此永久串线(还会写盘固化):A 的消息注进自己的 pane,产出却镜像到 B 的会话里。现在目录扫描只在「候选唯一 且 窗口内本目录没有别的 chat 也在 `/clear`」时才认领,否则退让给下一条注入的文本指纹(`armSilentForkRebind`,pane 级确定)来定位。`/clear` 的登记发生在 inject **之前**,以便更早武装的兄弟 watcher 能看见重叠。
- `mirror`: `injectText` 成功后清除 `muteUntilInject` / `justSpawned`。graph 拉起的节点由 `newSession` 置静音、再由 `injectText` 注入,而清除静音只写在 WeCom dispatch 路径上 —— 结果 `onItem` 永远在静音分支早退,节点既不推气泡也不 `recordTurnStart`,在 chat 列表和 chat 详情里完全不存在。

## [1.2.15] - 2026-08-07

### Fixed
- `session-label`: `withTagHeader` 对无 tag 默认会话不加前缀 —— approval vote 回执、plan 卡、error 等经 `withTagHeader` 发送的消息无 🧙 标识。现统一为所有 target 都带前缀(tagged → `emoji #tag`，untagged → `🧙`)。

## [1.2.14] - 2026-08-07

### Changed
- `mirror`: 所有 emoji+tag 前缀和 detail link 文本去掉反引号包裹 —— WeCom markdown 里 backtick 渲染为代码样式,与可点击链接视觉冲突。
- `mirror`: 默认会话（无 tag）所有推送现统一带 🧙 前缀,不再裸发。
- `mirror`: KeepAlive 通知也带 chat detail 链接(使用 `keepaliveTurnId`)。

### Fixed
- `peers`: `keepaliveStamps` 对 ping 后紧跟的 assistant pong 未识别为 keepalive 回复,导致 pong 误算为 real activity 重置 round。

## [1.2.13] - 2026-08-07

### Added
- `mirror`: 所有 standalone 消息和 finalized bubble 的 emoji+tag 前缀现在是可点击的 chat detail 链接(有活跃 turn 时);无 tag 的默认会话使用 🧙 作为链接图标。

### Fixed
- `inbound`: `/stop` 成功时不再回复消息,仅失败时通知。
- `mirror`: KeepAlive 通知只在第 1、3、6 轮发送(不再每轮都推)。
- `mirror`: KeepAlive 轮次计数修复 —— ping/pong 结算后的 mtime 抖动不再误触 `grewSinceLast` 重置 round(添加 30s `settledAt` 宽限窗口)。
- `mirror`: chat detail 链接格式统一:emoji+tag 包在反引号内作为链接文本,🧙 作为无 tag 会话的默认图标,"← View chat details" 变为普通文本提示。

### Fixed
- `mirror`: inline peer spawn(`#tag` 首条消息自动建会话)和 graph runner spawn 不再下发 "📂 当前项目" 提示消息到 WeCom — `newSession` 新增 `silent` 选项,隐式路径传 `silent: true` 跳过 `pushProjectInfo`;显式 `/new` 仍正常推送。

## [1.2.11] - 2026-08-06

### Added
- `mirror`: `muteUntilInject` — 新 spawn 的 session 在首次 inject 成功前静默初始输出(greeting/system),避免 `#tag` 自动建会话时把 CLI 开场白推到 WeCom。
- `mirror`: `earlyTimer` (3s) — inject 后若 CLI 在 3s 内无任何产出,先把 loading 气泡收成 chat detail 链接;首条 item 到达即清除,不影响正常流。

### Fixed
- `mirror`: `muteUntilInject` 在 inject 失败路径未清除(return 在赋值前),导致会话永久静默。
- `mirror`: `earlyTimer` 对排队中的 turn 错引 `a.briefBubble`(仍指向前一个活跃 bubble),改为闭包捕获的 bubble ref。

## [1.2.10] - 2026-08-06

### Changed
- `mirror`: 保活默认轮次 8 → 6(桥接窗口 ~34min → ~26min)。
- `mirror`: 保活连击瘦身 —— 一轮连击里只有第一发 ping 带完整指令文案,后续轮次只注入 bare `ping`(指令已在上下文里,cache-write delta 更小、pane 更干净)。`keepaliveStamps` 同步识别 bare `ping`,否则连击轮会被误判为真实活动、重置轮次并自我续命。

### Fixed
- `mirror`: TUI 里手打 `/clear` 后保活仍继续 —— `migrateAttachment`(所有会话轮换的唯一漏斗)此前不碰保活态,旧时钟接着 ping 空上下文;且其 `store.set` 整记录替换会把 dispatch 刚落盘的 `/clear` 暂停从盘上抹掉(reload 后复活)。现迁移目标判定为真清空时像 `/stop` 一样置 `keepaliveOff` 并清时钟,暂停态随迁移记录一并落盘。

## [1.2.9] - 2026-08-05

### Fixed
- `mirror`: `/clear` 与 `/new` 现和 `/stop` 一样暂停保活。二者都把会话重置为空壳 —— 缓存里没有任何真实上下文可保温,继续 ping 只是白烧预算(此前 `/new` 建会话不暂停、`/clear` 在 dispatch 里反而**解除**了暂停)。`/new` 在 `newSession` attach 后落停,`/clear` 在 dispatch 里改为暂停而非解除;停顿持久化,下一个真实 turn(WeCom inbound,或 pane 过 grace 后转 busy)自动恢复。

## [1.2.8] - 2026-08-05

### Fixed
- `inbound`: `#tag` 后夹一个不可见格式字符(输入法/复制常带的 `U+2060` word-joiner、零宽空格等)时,tag 右边界断言 `(?=\s|$)` 落空 —— 整个 `TAG_RE` 不匹配,`parseTag` 返回空 tag,消息被误路由到**默认会话**而非目标 `#tag` 会话。右边界字符类补入零宽(`U+200B–200D`)、word joiner(`U+2060`)、BOM(`U+FEFF`),与空白同等视作合法分隔。

## [1.2.7] - 2026-08-01

### Fixed
- `mirror`: KeepAlive 轮次计数卡在 `1/N` —— 1.2.6 把调度改用消息时钟后,`grewSinceLast`(轮次重置 + 真实活动重锚的判据)错用了 `lastMs`(**含保活自己的 ping/pong**)。心跳的 ping+pong 也是消息 turn,会推高 `lastMs`,在交互式会话里 pong 隔几秒才生成、时序有缝,导致下一个非 pinging tick 把自己的心跳误判为「新活动」而把 `round` 归零,`n` 永远爬不过 1。改为只看 `lastRealMs`(已滤除 ping/pong):纯保活期间轮次正常累加 `1/N→2/N→…`,只有真实对话才重置。

## [1.2.6] - 2026-07-31

### Fixed
- `mirror`: **保活调度彻底改用消息 turn 时间戳,不再依赖文件 mtime**。Claude Code 每轮会往 jsonl 追加 `file-history-snapshot` / `ai-title` / `mode` / `permission-mode` 等**无 `timestamp` 的非消息行**,它们顶高文件 mtime 却不代表任何真实对话。旧逻辑 `idleSinceTouch` / `realIdle` / `grewSinceLast` 全建立在 `statSync(mtime)` 上,于是这些元数据写入被误判为「活跃」:`grewSinceLast` 每周期重锚 `realMtime` 使 `realIdle` 永不过 `maxIdleSec` —— **真实对话在数小时前的死会话被无限保活**(daemon 每次启动/reload 还会把「末行是 ping」的死会话集体复活)。现新增 `keepaliveStamps` 从消息 turn 取 `lastMs`(最后一条消息=缓存触碰)/`lastRealMs`(最后一条非 ping/非 pong=真实空闲基准),文件 mtime 仅作「要不要重读 tail」的廉价闸门;tail 内无真实 turn ⇒ 判死。移除 `realMtime` 字段;`n/N` 分母按实际 cadence(`ttlSec-marginSec`)floor 计。
- `mirror`: `/stop` 暂停保活现**持久化**(`keepaliveOff` / `keepaliveOffAt` 写入 `mirror-attachments.json`),daemon reload / launchd 重启不再复活一个被用户显式静音的会话;真实 inbound 或 busy-resume 解除时同步落盘。

## [1.2.5] - 2026-07-31

### Added
- `mcp`: 新增 `config_set` tool — 在对话中直接读写 wezard 配置（allowFrom、审批时间窗口、danger skip、cwd、log level 等），无需手动编辑 config.jsonc。

## [1.2.4] - 2026-07-31

### Changed
- `mirror`: KeepAlive 心跳通知带回轮次计数 —— 从 `KeepAlive · ~Nk tokens` 恢复为 `KeepAlive n/N · ~Nk tokens`。`n` = 上次真实（非 ping）活动以来的 ping 轮数（真实活动重新锚定时归零），`N` = 当前配置下缓存冷掉前的最大保活轮数。1.2.1 随 `maxPings`→`maxIdleSec` 一并去掉的 `n/max`，现按需求改以派生分母回归。

## [1.2.3] - 2026-07-31

### Fixed
- `mirror`: `/stop` 暂停保活的第二个自我唤醒漏洞 —— 1.2.0 给 busy-resume 加了 grace，但 `grewSinceLast`（transcript 增长）分支没有守卫。`/stop` 的 Esc 打断会产生尾部写入（被中断的 turn + 残留 tool result），下一个 tick 把它当成真实活动立刻解除刚请求的暂停，KeepAlive 照常触发。现在纯 transcript 增长不再解除 `/stop` 暂停，只有 busy pane（过 grace）或 WeCom inbound 能恢复。

## [1.2.2] - 2026-07-31

### Fixed
- `mirror`: tagged-only chat（无 untagged 默认会话）中 `enter` 设置 cwd 后 `/clear` 不触发目录切换 — `chatCwdFallback` 只读 base principal，base 不存在时返回空；dispatch 和 newSession 现在都 fallback 到 caller 自身的 `pendingCwd`。

## [1.2.1] - 2026-07-31

### Changed
- `mirror`: 保活调度改为**锚定最后一次真实（非 ping）对话** — 保活自己的 ping 不再刷新空闲锚点，因此不会把一个搁置很久的会话误判成活跃而无限续命。真实空闲超过 `maxIdleSec`（新配置，默认 = `ttlSec` 5min）即停手，让缓存自然冷掉；reload 时若 transcript 末轮是自己的 ping，则视作早已空闲、不重新烧热。配置项 `maxPings` 移除，替换为 `maxIdleSec`（保活功能在 1.2.0 刚发布，此为随即修正）。聊天心跳去掉 `n/max` 计数，只显示 `❤️ 保活 · context ~Nk tokens`。

## [1.2.0] - 2026-07-31

### Added
- `mcp`: 事件订阅/广播全面 MCP 化 — 新增 `subscribe_topic` / `unsubscribe_topic` / `broadcast_topic` / `schedule_broadcast` / `cancel_broadcast` / `list_topics`,直接对 AI 说人话即可订阅/广播/定时。
- `mcp`: 新增 `handoff` tool — 原地把一个 pane 的会话交接给全新会话。
- `mirror`: prompt-cache 保活心跳 — 空闲 pane 在缓存过期前廉价续命；心跳记入 chat detail，留痕含真实 cache-read usage。
- `approval`: 新增 `danger.skip` — 命中危险名单也免卡直接放行。

### Changed
- `mirror`: `/stop` 暂停保活 + 明确终止语义。

### Removed
- **BREAKING** `topics`: 移除订阅/广播的 IM 文本命令(「订阅」「广播」「每天…广播」「取消广播」「订阅列表」「广播列表」)及 `/skill-b`,全部改由 MCP 工具驱动。`POST /publish` 外部触发接口保留。

### Fixed
- `mirror`: `/stop` 暂停保活失效 — 保活自身的 ping 会让 pane 变 busy，而 busy 被当成「真实活动」立刻解除暂停；改为对 busy-resume 加 30s grace 窗口，只有暂停后真正的新一轮才恢复（WeCom dispatch 仍即时恢复）。
- `sync`: 为 CodeBuddy targets 把 MCP entry 写入 `mcp.json`。
- 发布包补齐 svr plist/service 模板。

## [1.1.4] - 2026-07-31

### Fixed
- `approval`: reload 续接 — 重启时挂着的审批不再 fallback 成本地权限框。

## [1.1.3] - 2026-07-31

### Added
- `approval`: 新增 `danger` 模式 — 只对危险名单发卡,其余静默放行。

### Changed
- `mcp`: 重命名 `cd` 工具为 `enter` — 更贴合实际语义。

## [1.1.2] - 2026-07-30

### Added
- `approval`: codebuddy 下 `AskUserQuestion` / `ExitPlanMode` 由 mirror 接管下发卡片。
- `detail`: detail/chat url 参数加 `ww_uniq=1`。

## [1.1.1] - 2026-07-30

### Changed
- `approval`: 危险名单移除普通 `git push` — 仅保留强推等不可逆操作。

## [1.1.0] - 2026-07-30

### Added
- `chat`: 上下文断点可见化 — `/clear`、`/new`、会话轮换在线程里显式分隔。

## [1.0.0] - 2026-07-29

首个稳定版:项目更名 `weclaude` → `wezard`。

### Changed
- **BREAKING**: 项目更名 `weclaude` → `wezard`,新增 `wezard migrate` 迁移命令。
- `init`: 本地拉起 svr,详情/会话链接默认走内网 IP。

### Added
- `approval`: 危险操作名单 — 命中者强制逐次单独审批。
- `session-scan`: 通过 `ps` + `lsof` fallback 支持 macOS。

### Fixed
- `chat`: 修复移动端滚动 — `.main` 加 `min-height:0`,叠加 overscroll + safe-area。

[Unreleased]: https://github.com/guxi11/wezard/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/guxi11/wezard/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/guxi11/wezard/compare/v1.3.23...v1.4.0
[1.3.23]: https://github.com/guxi11/wezard/compare/v1.3.22...v1.3.23
[1.3.22]: https://github.com/guxi11/wezard/compare/v1.3.21...v1.3.22
[1.3.21]: https://github.com/guxi11/wezard/compare/v1.3.20...v1.3.21
[1.3.20]: https://github.com/guxi11/wezard/compare/v1.3.19...v1.3.20
[1.3.19]: https://github.com/guxi11/wezard/compare/v1.3.18...v1.3.19
[1.3.18]: https://github.com/guxi11/wezard/compare/v1.3.17...v1.3.18
[1.3.17]: https://github.com/guxi11/wezard/compare/v1.3.16...v1.3.17
[1.3.16]: https://github.com/guxi11/wezard/compare/v1.3.15...v1.3.16
[1.3.15]: https://github.com/guxi11/wezard/compare/v1.3.14...v1.3.15
[1.3.14]: https://github.com/guxi11/wezard/compare/v1.3.13...v1.3.14
[1.3.13]: https://github.com/guxi11/wezard/compare/v1.3.12...v1.3.13
[1.3.12]: https://github.com/guxi11/wezard/compare/v1.3.11...v1.3.12
[1.3.11]: https://github.com/guxi11/wezard/compare/v1.3.10...v1.3.11
[1.3.10]: https://github.com/guxi11/wezard/compare/v1.3.9...v1.3.10
[1.3.9]: https://github.com/guxi11/wezard/compare/v1.3.8...v1.3.9
[1.3.8]: https://github.com/guxi11/wezard/compare/v1.3.7...v1.3.8
[1.3.7]: https://github.com/guxi11/wezard/compare/v1.3.6...v1.3.7
[1.3.6]: https://github.com/guxi11/wezard/compare/v1.3.5...v1.3.6
[1.3.5]: https://github.com/guxi11/wezard/compare/v1.3.4...v1.3.5
[1.3.3]: https://github.com/guxi11/wezard/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/guxi11/wezard/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/guxi11/wezard/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/guxi11/wezard/compare/v1.2.31...v1.3.0
[1.2.31]: https://github.com/guxi11/wezard/compare/v1.2.30...v1.2.31
[1.2.30]: https://github.com/guxi11/wezard/compare/v1.2.29...v1.2.30
[1.2.29]: https://github.com/guxi11/wezard/compare/v1.2.28...v1.2.29
[1.2.21]: https://github.com/guxi11/wezard/compare/v1.2.20...v1.2.21
[1.2.20]: https://github.com/guxi11/wezard/compare/v1.2.19...v1.2.20
[1.2.19]: https://github.com/guxi11/wezard/compare/v1.2.18...v1.2.19
[1.2.18]: https://github.com/guxi11/wezard/compare/v1.2.17...v1.2.18
[1.2.17]: https://github.com/guxi11/wezard/compare/v1.2.16...v1.2.17
[1.2.16]: https://github.com/guxi11/wezard/compare/v1.2.15...v1.2.16
[1.2.15]: https://github.com/guxi11/wezard/compare/v1.2.14...v1.2.15
[1.2.14]: https://github.com/guxi11/wezard/compare/v1.2.13...v1.2.14
[1.2.13]: https://github.com/guxi11/wezard/compare/v1.2.12...v1.2.13
[1.2.12]: https://github.com/guxi11/wezard/compare/v1.2.11...v1.2.12
[1.2.11]: https://github.com/guxi11/wezard/compare/v1.2.10...v1.2.11
[1.2.10]: https://github.com/guxi11/wezard/compare/v1.2.9...v1.2.10
[1.2.9]: https://github.com/guxi11/wezard/compare/v1.2.8...v1.2.9
[1.2.8]: https://github.com/guxi11/wezard/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/guxi11/wezard/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/guxi11/wezard/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/guxi11/wezard/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/guxi11/wezard/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/guxi11/wezard/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/guxi11/wezard/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/guxi11/wezard/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/guxi11/wezard/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/guxi11/wezard/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/guxi11/wezard/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/guxi11/wezard/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/guxi11/wezard/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/guxi11/wezard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/guxi11/wezard/releases/tag/v1.0.0
