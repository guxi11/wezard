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
import { SHARED_CSS, TURN_CSS } from "./detail-render.js";
import { readAsset, type Asset } from "./web-assets.js";

/** /chat/app.css = 详情页共用样式 + 本视图外壳样式。 */
export const chatStyles = (): Asset => {
  const own = readAsset("chat.css");
  return {
    body: `${SHARED_CSS}${TURN_CSS}${own?.body ?? ""}`,
    type: "text/css; charset=utf-8",
    etag: own?.etag ?? 'W/"nocss"',
  };
};

export const chatScript = (): Asset =>
  readAsset("chat.js") ?? { body: "", type: "text/javascript; charset=utf-8", etag: 'W/"nojs"' };

export const renderChatPage = (): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>对话现场</title>
<link rel="stylesheet" href="https://unpkg.com/highlight.js@11/styles/github.min.css">
<link rel="stylesheet" href="chat/app.css">
<script src="https://unpkg.com/markdown-it@14/dist/markdown-it.min.js"></script>
<script src="https://unpkg.com/@highlightjs/cdn-assets@11/highlight.min.js"></script>
</head><body>
<div class="app" id="app">
  <aside class="side">
    <header class="rolebar" id="rolebar">
      <div class="who" id="rb-who"></div>
    </header>
    <div class="acts" id="rb-acts"></div>
    <nav class="convs" id="convs" aria-label="会话"></nav>
    <footer class="sidefoot" id="rb-foot" hidden><div id="rb-sess"></div></footer>
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
<script src="chat/app.js" defer></script>
</body></html>`;
