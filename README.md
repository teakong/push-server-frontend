# push-server-frontend

一封传话（push-server）的**纯前端接入示例 + 浏览器 SDK**。零后端代码：浏览器直连官方 API（官方已开启 CORS，无需任何代理或中转），用户用自己的邮箱开通推送通道，业务事件发生时推一条消息到手机。

仓库提供三样东西：可直接体验的**通道管理首页**、**最小接入演示页**，以及一份完整的 **SDK 接入指南**。

## 目录一览

| 文件 | 作用 |
| --- | --- |
| `index.html` | 官网首页 / 通道管理演示：推送测试、授权开通道、通道管理、分享给好友、讲解视频，中英双语 |
| `demo.html` | 最小接入示例，三行代码挂载「开通道 + 管通道」卡片 |
| `push-sdk-guide.html` | SDK 接入指南（场景、五分钟接入、授权、管理面板、API 对照、推送、FAQ、相关项目） |
| `assets/push-sdk.js` | 核心 SDK，UMD 单文件，暴露全局 `YfPush` |
| `assets/app.js` | `index.html` 的页面逻辑：i18n、推送测试、分享卡、设置通道码弹窗（通道管理已交给 SDK） |
| `assets/style.css` | 官网页面样式；**接入 SDK 时不需要引入，它与 SDK 无关** |
| `LICENSE` | MIT |

## 本地运行

放到任意静态服务器即可，例如 XAMPP：

```
http://localhost/push-server-frontend/
```

也可用 `python -m http.server`、`npx serve` 等任意静态服务托管；唯一要求是经 `http(s)://` 访问（`file://` 下部分浏览器会拦截跨域请求）。

- 首页：<http://localhost/push-server-frontend/index.html>
- 最小示例：<http://localhost/push-server-frontend/demo.html>
- 接入指南：<http://localhost/push-server-frontend/push-sdk-guide.html>

## SDK 快速接入

引入一个脚本即可（官方 CDN）：

```html
<script src="https://push.phprm.com/static/js/push-sdk.js"></script>
```

挂载「开通道 + 管通道」整套界面（自带样式与逻辑，宿主页面无需另写 HTML/CSS）：

```html
<div id="auth-slot"></div>
<script>
  YfPush.create({ mcpSource: 'my-website' }).mountAuthCard('#auth-slot', {
    onSuccess: function (r) {
      console.log('通道码', r.channelCode);
    }
  });
</script>
```

- 用户未设置通道码 → 渲染授权卡，授权成功后就地展开管理面板；
- 已设置通道码 → 可带码直入管理面板（支持从 URL `?channelCode=xxx` 读取）。

也可以只用方法、界面自己画——不调用 `mountAuthCard` 时 SDK 不注入任何样式：

```js
var sdk = YfPush.create({ apiBase: 'https://www.phprm.com', mcpSource: 'my-admin' });
sdk.listChannels().then(function (list) { /* 通道列表 */ });
```

完整示例见 `demo.html`，逐项说明见 `push-sdk-guide.html`。

## SDK 特性

- **零后端、直连官方**：所有请求从用户浏览器直连 `https://www.phprm.com`，避免所有用户共用一台服务器 IP 触发限流。
- **UMD 三用**：浏览器 `<script>` 拿全局 `YfPush`；CommonJS `require('./push-sdk.js')`；ESM `import YfPush from './push-sdk.js'`（Vite / webpack / esbuild 均可）。
- **纯 ES5、兼容性好**：无 async/await、模板字符串、箭头函数；有原生 Promise/fetch 时直接用，没有时自动回退（如 IE11）。
- **多实例 / 自定义域名**：`YfPush.create({ apiBase, mcpSource })` 可同时创建多个实例。
- **样式隔离**：只注入一个 `<style id="yf-auth-style">`，所有选择器限定在 `.yf-auth` / `.yf-mgr` / `.yf-portal` 作用域内，不碰 `body` / `html` / `:root`，不改宿主站点原有外观与功能。移除卡片无副作用。
- **可定制**：`injectStyle: false` 关掉内置样式、`className` 加自定义 class、`labels` 改全部文案；回调 `onSuccess` / `onCodeChanged` / `onError` 均可选。

主要方法：`listTools`、`listChannels`、`addChannel`、`editChannel`、`deleteChannel`、`resetChannel`、`sendPushMessage`、`createAuthSession`、`pollSession`。

## 通道码与推送链路

- **通道码**：32 位，仅存浏览器 LocalStorage（key `phprm_channel_code`），不会上传到本仓库任何服务；支持把本页网址发给好友实现免登录进入管理（`?channelCode=xxx`）。
- **推送测试**：走 MCP `send_push_message` 工具（`POST /services/push/mcp`，channelCode 同时进 Header 与入参），与 AI 客户端调用完全同链路；也可生成一个 GET 网址 `https://www.phprm.com/services/push/send/{通道码}` 直接推送。
- **鉴权**：MCP `get_access_token` 换短期令牌 → `Authorization: Bearer` 调用 `/oauth2/push/channel/*`，令牌按 `expires_in` 缓存复用。
- **未设置通道码时**：首页调匿名接口 `/services/public/ping` 拉取官方公开示例通道，可直接发测试推送体验链路（示例通道任何人都能推，仅用于链路体验）。

## 相关链接

- 官网与控制台：<https://push.phprm.com/mcp.html>（注册、创建通道码）
- Agent 接入指南（skill.md）：<https://push.phprm.com/skill.md>
- MCP Server 地址：`https://www.phprm.com/services/push/mcp`
- push-server 技能源码：<https://github.com/teakong/push-server>（Gitee 镜像：<https://gitee.com/teakong/push-server>）
- AI 弹幕组件：<https://github.com/teakong/danmu>

## License

MIT
