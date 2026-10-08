# push-server-frontend

[一封传话 push-server](https://push.phprm.com/mcp.html) 的纯前端通道管理页面：**零后端代码**，单个 HTML + JS + CSS，浏览器直连官方 API（官方已开启 CORS，无需任何代理）。

## 在线使用

放到任意静态服务器即可，例如 XAMPP：

```
http://localhost/push-server-frontend/
```

也可直接用 `python -m http.server`、`npx serve` 等任意静态服务托管；唯一要求是经 `http(s)://` 访问（`file://` 下部分浏览器拦截跨域）。

## 功能

### 1. 群组提醒示例（未设置通道码时）

- 调用匿名接口 `GET /services/public/ping` 拉取官方公开示例通道，展示通道名、脱敏通道码、手机接收二维码
- 可直接向示例通道发送测试推送（走 MCP `send_push_message`），完整体验推送链路
- 提示：示例通道任何人都能推送，仅用于链路体验

### 2. 推送测试

- 填写 head / body / url，点击「发送测试」
- 推送走 **MCP `send_push_message` 工具**（`POST /services/push/mcp`，channelCode 同时进 Header 与入参），与 AI 客户端调用完全同链路
- 表格「测试」按钮打开测试弹窗：head / body / url / avatar 输入，实时拼接 API 网址（可复制集成到你的代码），推送默认走 MCP；填了 avatar 时自动回退 GET API（MCP 不支持该参数）

### 3. 通道管理（设置通道码后）

- 右上角设置 32 位通道码（`PHPRM_CHANNEL_CODE`，仅存浏览器 LocalStorage），标题变为「当前MCP配置的通道码」
- 自动加载 `GET /oauth2/push/channel/list`（无分页），按 `pushType=10`（组合）标记「父通道」，其余行连续编号「子1、子2…」
- 支持增删改：
  - **新增** `/channel/add`：18 种推送类型；通道名称按所选类型自动预填（可改，手改后不再覆盖）；webhook/群机器人按类型显示接收地址与加签（钉钉=Webhook、飞书=webhook地址+签名验证、企业微信群机器人=Webhook地址，并给出各家官方 webhook 前缀作示例）；自定义邮箱（51~58）显示 发信人昵称(corpId)/邮箱地址(agentId)/授权码(corpSecret)；企业微信应用(9)显示 企业ID/应用ID/应用Secret
  - **修改** `/channel/edit`：改名、改配置、启用/停用（status 0/1）
  - **删除** `/channel/deleteChannel`：二次确认，当前绑定通道服务端会拒绝
- 二维码点击放大浮层；「复制」按钮复制完整通道码
- 鉴权流程：MCP `get_access_token` 换短期令牌 → `Authorization: Bearer` 调用业务接口；令牌按 `expires_in` 缓存复用，401/403 才重取

## 项目结构

```
├── index.html          # 页面结构（含全部弹窗）
├── assets/
│   ├── style.css       # 全站样式
│   └── app.js          # API 层 + 交互逻辑（MCP JSON-RPC / oauth2 封装）
└── _ref/               # 开发用回归脚本（headless Edge CDP 断言，可删）
```

## 相关链接

- 官网与控制台：<https://push.phprm.com/mcp.html>（注册创建通道码）
- MCP Server 地址：`https://www.phprm.com/services/push/mcp`
- Agent 指南（skill.md）：<https://push.phprm.com/skill.md>
- push-server 技能源码：<https://github.com/teakong/push-server>

## License

MIT
