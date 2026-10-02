// Rolepage 的服务端外壳 —— 只剩一张静态 HTML 骨架。
//
// 样式与脚本在 web/chat.css / web/chat.js, 由 /chat/app.css、/chat/app.js 独立提供
// (见 ./chat-http)。页面 shell 常驻不变, 资源按 ETag 缓存; 消息正文由服务端渲染
// (diff / ANSI / 语法高亮只在 shared/detail-render 实现一次)。
//
// 资源 URL 一律用相对路径 —— svr 常挂在反代子路径下 (如 /wc/role), 绝对路径会 404。
// /role 与 /chat 同在根下, 所以两者都能用同一个 `chat/app.js`。
//
// 左栏顶上是**当前 role** 的名片 (身份 + 关系/日程入口), 下面是它的会话列表; 右栏
// 只管一个会话 —— 头上写这个群聊/私聊是什么, 下面是消息。关系与日程都是当前 role
// 的, 所以入口挂在名片上, 视图在右栏里换显。
//
// 用量条 (.usage) 是同一个组件的两个挂载点, 跟着「这本账是谁的」走: wizard 的总账
// 属于整页 (#pg-usage, 横跨两栏的页脚); 人自己不跑轮次, 账属于它点开的那个窗口
// (#ch-usage, 右栏底)。
import { createHash } from "node:crypto";
import { SHARED_CSS, TURN_CSS } from "./detail-render.js";
import { readAsset, type Asset } from "./web-assets.js";

/** 拼出来的资源的 ETag = 各片 ETag 之和 —— 任一片变了整体都失效, 缺片记 `-`。 */
const etagOf = (parts: readonly (Asset | undefined)[]): string =>
  `W/"${parts.map((a) => a?.etag.slice(3, -1) ?? "-").join("+")}"`;

/** 编进代码里的那几片样式 (SHARED_CSS / TURN_CSS) 没有文件 mtime: 按内容哈希算它那一片的 ETag ——
 *  只改了它们时 ETag 也得变, 否则浏览器拿 304 一直用旧样式 (改 detail-render 的 CSS 在页面上不生效)。 */
const BUILTIN_CSS: Asset = ((body) => ({ body, type: "text/css", etag: `W/"${createHash("sha1").update(body).digest("hex").slice(0, 12)}"` }))(`${SHARED_CSS}${TURN_CSS}`);

/** /chat/app.css = 代码高亮主题 + 详情页共用样式 + 本视图外壳样式。 */
export const chatStyles = (): Asset => {
  const [theme, own] = ["hljs-github.min.css", "chat.css"].map(readAsset);
  return {
    body: `${theme?.body ?? ""}${BUILTIN_CSS.body}${own?.body ?? ""}`,
    type: "text/css; charset=utf-8",
    etag: etagOf([theme, BUILTIN_CSS, own]),
  };
};

/** /chat/vendor.js = markdown-it + highlight.js, 随包分发。原先走 unpkg: 外网慢的时候
 *  head 里的阻塞脚本能把整页卡上十几秒, 而这两个库本来就不随页面变。 */
export const chatVendor = (): Asset => {
  const parts = ["markdown-it.min.js", "highlight.min.js"].map(readAsset);
  return {
    body: parts.map((a) => a?.body ?? "").join(";\n"),
    type: "text/javascript; charset=utf-8",
    etag: etagOf(parts),
  };
};

export const chatScript = (): Asset =>
  readAsset("chat.js") ?? { body: "", type: "text/javascript; charset=utf-8", etag: 'W/"nojs"' };

export const renderChatPage = (): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>对话现场</title>
<link rel="stylesheet" href="chat/app.css">
</head><body>
<div class="app" id="app">
  <aside class="side">
    <header class="rolebar" id="rolebar">
      <div class="who" id="rb-who"></div>
    </header>
    <nav class="convs" id="convs" aria-label="会话"></nav>
  </aside>
  <main class="main">
    <header class="chathead" id="chathead">
      <button class="back" id="tb-back" aria-label="返回会话列表">‹</button>
      <div class="ch-who" id="ch-who"></div>
      <div class="ch-acts" id="ch-acts"></div>
    </header>
    <div class="thread" id="thread"><div class="thread-in" id="thread-in"></div></div>
    <div class="pane" id="pane-world" hidden>
      <div class="wtools" id="wtools"></div>
      <div class="wscroll" id="wscroll"><div class="wmap" id="wmap"></div></div>
    </div>
    <div class="pane" id="pane-plan" hidden><div class="plan-in" id="plan-in"></div></div>
    <footer class="usage" id="ch-usage" hidden></footer>
  </main>
</div>
<footer class="usage page" id="pg-usage" hidden></footer>
<script src="chat/vendor.js" defer></script>
<script src="chat/app.js" defer></script>
</body></html>`;
