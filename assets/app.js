/**
 * push-server 通道管理 —— 纯 HTML + JavaScript 版（无任何服务端代码）
 *
 * 架构说明：
 * - 通道码（PHPRM_CHANNEL_CODE）存 LocalStorage（key: phprm_channel_code），仅存本浏览器
 * - 未设置通道码：调匿名接口 /services/public/ping 取官方示例通道，做「群组提醒示例」推送测试
 *   （推送走 POST /services/push/send/{channelCode}，与官网 index.html 同一链路）
 * - 已设置通道码：
 *   · 推送测试直接用用户通道码（不再用 ping 示例码）
 *   · 通道管理走 MCP get_access_token 换短期令牌 → Authorization: Bearer 调 /oauth2/push/* 接口
 *     （channel/list 无分页；add/edit/deleteChannel 支持增删改）
 * - 官方所有端点均已开启 CORS（access-control-allow-origin 回显来源），浏览器可直连
 */
(function () {
  'use strict';

  var API = 'https://www.phprm.com';
  var MCP_URL = API + '/services/push/mcp';
  var PING_URL = API + '/services/public/ping';
  var KEY_NAME = 'phprm_channel_code';

  /* localStorage 被禁用（隐私模式/内嵌 WebView）时的内存兜底，避免静默失败 */
  var memCode = '';

  var PUSH_TYPES = [
    { v: 1,  t: '浏览器' },
    { v: 6,  t: '企业微信群机器人' },
    { v: 7,  t: '钉钉群机器人' },
    { v: 8,  t: '飞书群机器人' },
    { v: 9,  t: '企业微信应用' },
    { v: 10, t: '组合（多通道聚合）' },
    { v: 11, t: 'webhook推送' },
    { v: 16, t: 'BARK（iOS）' },
    { v: 29, t: 'Telegram' },
    { v: 30, t: 'Discord' },
    { v: 50, t: '官方邮件' },
    { v: 51, t: 'QQ邮箱' },
    { v: 52, t: '163邮箱' },
    { v: 53, t: '126邮箱' },
    { v: 54, t: '搜狐邮箱' },
    { v: 55, t: '139邮箱' },
    { v: 56, t: '189邮箱' },
    { v: 57, t: '新浪邮箱' },
    { v: 58, t: '阿里云邮箱' }
  ];
  var NEED_WEBHOOK = { 6: 1, 7: 1, 8: 1, 11: 1, 16: 1 };
  var NEED_SECRET = { 6: 1, 7: 1, 8: 1 };
  /* 需 corpId/agentId/corpSecret 三件套的类型：
     9=企业微信应用（企业ID/应用ID/应用Secret）；51~58=自定义邮箱（发信人昵称/邮箱地址/授权码）；50 官方邮件不需要 */
  var NEED_EMAIL = { 9: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };
  var THREE_LABELS = {
    9:    ['企业ID', '应用ID', '应用Secret', ''],
    email: ['发信人昵称', '邮箱地址', '授权码', '（邮箱服务商生成的授权码）']
  };

  /* ---------------- 基础工具 ---------------- */

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * 大整数安全 JSON 解析。
   * 背景：JS 只有 IEEE-754 双精度，JSON.parse 遇到超过 MAX_SAFE_INTEGER 的整数会丢精度
   * （如 messageIdList 里的 1688754255588143105 → 1688754255588143000）。
   * 方案：解析前先扫描原文，把超限的「整数字面量」包成字符串字面量，再交给 JSON.parse，
   *      于是这些 ID 以字符串形式落地，数字精度原样保留。
   * 注意：字符串字面量内部（含转义）整段跳过，不会误伤 content.text 里的 JSON 串。
   */
  var MAX_SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER); // "9007199254740991"

  function isUnsafeIntDigits(digits) {
    digits = String(digits).replace(/^0+(?=\d)/, '');   // 去掉前导 0
    if (digits.length < MAX_SAFE_DIGITS.length) { return false; }
    if (digits.length > MAX_SAFE_DIGITS.length) { return true; }
    return digits > MAX_SAFE_DIGITS;                    // 等长数值字符串可直接字典序比较
  }

  var NUM_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;     // sticky，从 lastIndex 精确匹配

  function quoteUnsafeInts(text) {
    text = String(text);
    var out = '';
    var i = 0, n = text.length;
    while (i < n) {
      var ch = text.charAt(i);
      /* 字符串字面量：整段原样拷贝，避免把 "text":"{...}" 里的数字给改了 */
      if (ch === '"') {
        var j = i + 1;
        while (j < n) {
          var c = text.charAt(j);
          if (c === '\\') { j += 2; continue; }
          if (c === '"') { break; }
          j++;
        }
        j = Math.min(j, n - 1);
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      /* 数字字面量 */
      if ((ch >= '0' && ch <= '9') || (ch === '-' && /[0-9]/.test(text.charAt(i + 1)))) {
        NUM_RE.lastIndex = i;
        var m = NUM_RE.exec(text);
        if (m) {
          var raw = m[0];
          if (!/[\.eE]/.test(raw) && isUnsafeIntDigits(raw.replace(/^-/, ''))) {
            out += '"' + raw + '"';
          } else {
            out += raw;
          }
          i += raw.length;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  function parseJsonSafe(text) {
    return JSON.parse(quoteUnsafeInts(text));
  }

  /** fetch 后按安全模式取 JSON（替代 resp.json()），并统一处理非 JSON 响应 */
  async function readJson(resp) {
    var text = await resp.text();
    try {
      return parseJsonSafe(text);
    } catch (e) {
      throw new Error('接口响应不是 JSON（HTTP ' + resp.status + '）');
    }
  }

  function toast(msg, type, ms) {
    var box = el('toasts');
    var d = document.createElement('div');
    d.className = 'toast' + (type ? ' ' + type : '');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(function () { if (d.parentNode) { d.parentNode.removeChild(d); } }, ms || 4200);
  }

  function getCode() {
    try { return localStorage.getItem(KEY_NAME) || memCode; } catch (e) { return memCode; }
  }
  function setCode(c) {
    memCode = c;
    try { localStorage.setItem(KEY_NAME, c); }
    catch (e) { toast('注意：浏览器禁止本地存储，通道码仅在当前页面内有效，刷新后需重新填写', 'err', 7000); }
  }
  function clearCode() {
    memCode = '';
    try { localStorage.removeItem(KEY_NAME); } catch (e) {}
  }
  /** 规范化通道码：去掉所有空白（用户从终端/聊天工具复制时常带换行、空格） */
  function normCode(s) {
    return String(s || '').replace(/\s+/g, '');
  }
  function maskCode(c) {
    c = String(c || '');
    if (c.length < 14) { return c; }
    return c.slice(0, 6) + '******' + c.slice(-6);
  }

  function copyText(text, tip) {
    var done = function () { toast(tip || '已复制：' + text, 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动复制', 'err'); }
    document.body.removeChild(ta);
  }

  /* ---------------- 弹窗 ---------------- */

  function openModal(id) {
    el(id).style.display = 'flex';
    var first = el(id).querySelector('input, select, button');
    if (first) { setTimeout(function () { first.focus(); }, 50); }
  }
  function closeModal(id) { el(id).style.display = 'none'; }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var closer = t.closest ? t.closest('[data-close]') : null;
    if (closer) { closeModal(closer.getAttribute('data-close')); return; }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      ['settingsModal', 'addModal', 'editModal', 'delModal', 'qrModal', 'testModal', 'resetModal'].forEach(function (id) {
        var m = el(id); if (m && m.style.display !== 'none') { m.style.display = 'none'; }
      });
    }
  });

  /* ---------------- API 层 ---------------- */

  /**
   * MCP JSON-RPC 调用（Streamable HTTP，无状态协议，每次带 X-Push-Channel-Code）
   * channelCode 参数可覆盖 Header 通道码（未设置通道码的示例模式下按目标通道逐次传入）
   * 返回工具结果里 content[0].text 解析出的业务 JSON：{code, message, data}
   */
  async function mcpCall(tool, args, channelCode) {
    var resp = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-Push-Channel-Code': channelCode || getCode(),
        'X-Mcp-Source': 'push-server-frontend'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: args || {} }
      })
    });
    if (!resp.ok) { throw new Error('MCP HTTP ' + resp.status); }
    var text = await resp.text();
    var env;
    try {
      env = parseJsonSafe(text);
    } catch (e) {
      /* SSE 格式兜底：逐行找 data: 前缀 */
      env = null;
      text.split(/\r?\n/).forEach(function (line) {
        if (!env && line.indexOf('data:') === 0) {
          try { env = parseJsonSafe(line.slice(5).trim()); } catch (e2) {}
        }
      });
      if (!env) { throw new Error('MCP 响应解析失败'); }
    }
    if (env.error) { throw new Error('MCP: ' + (env.error.message || JSON.stringify(env.error))); }
    var content = env.result && env.result.content && env.result.content[0];
    if (!content || !content.text) { throw new Error('MCP 返回缺少 content'); }
    var biz;
    /* content.text 里是业务 JSON 字符串，同样按大整数安全模式解析 */
    try { biz = parseJsonSafe(content.text); } catch (e) { throw new Error(content.text); }
    if (biz.code !== 0) { throw new Error(biz.message || 'MCP 业务错误 code=' + biz.code); }
    return biz.data;
  }

  /* access_token 缓存：按 expires_in 倒计时，留 120 秒余量；任务内复用 */
  var tokenCache = { token: '', expireAt: 0 };
  async function getToken(force) {
    if (!force && tokenCache.token && Date.now() < tokenCache.expireAt) { return tokenCache.token; }
    var data = await mcpCall('get_access_token', { channelCode: getCode() });
    if (!data || !data.access_token) { throw new Error('获取 access_token 失败'); }
    tokenCache = {
      token: data.access_token,
      expireAt: Date.now() + ((Number(data.expires_in) || 7200) - 120) * 1000
    };
    return tokenCache.token;
  }
  function dropToken() { tokenCache = { token: '', expireAt: 0 }; }

  /**
   * /oauth2/push/* 业务接口。
   * 约定：参数只认 query 或 x-www-form-urlencoded；错误一律 HTTP 200 + 非 0 业务码；
   * 401/403 才是令牌失效 → 换新令牌重试一次。
   */
  async function oauth(path, params, isPost, retried) {
    var token = await getToken();
    var url = API + path;
    var opt = { method: isPost ? 'POST' : 'GET', headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token } };
    if (isPost) {
      opt.body = new URLSearchParams(params || {});
      opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (params) {
      var qs = new URLSearchParams(params).toString();
      if (qs) { url += (url.indexOf('?') >= 0 ? '&' : '?') + qs; }
    }
    var resp = await fetch(url, opt);
    if (resp.status === 401 || resp.status === 403) {
      if (!retried) { dropToken(); return oauth(path, params, isPost, true); }
      throw new Error('令牌无效（access_token 不正确），请检查通道码');
    }
    var biz = await readJson(resp);
    if (biz.code !== 0) {
      var err = new Error(biz.message || ('业务错误 code=' + biz.code));
      err.biz = biz;
      throw err;
    }
    return biz.data;
  }

  /** 推送一条消息：走 MCP send_push_message 工具（channelCode 同时进 Header 与入参，双保险） */
  async function pushSend(channelCode, head, body, url) {
    var args = { head: head, channelCode: channelCode };
    if (body) { args.body = body; }
    if (url) { args.url = url; }
    var data = await mcpCall('send_push_message', args, channelCode);
    if (!data || !data.messageIdList || !data.messageIdList.length) {
      throw new Error('推送未返回 messageIdList');
    }
    return { code: 0, data: data };
  }

  /* ---------------- 状态 ---------------- */

  var demoChannel = null;   /* ping 返回的官方示例通道（仅未设置通道码时使用） */
  var channelRows = [];     /* channel/list 渲染用行（含完整 channelCode） */
  var channelsMeta = null;  /* channel/list 顶层父通道信息 */

  /* 通道码输入框的默认示例文案；ping 拿到真实示例通道码后会被替换 */
  var DEFAULT_CODE_PLACEHOLDER = '粘贴 32 位通道码，如 4d05f4abdb0a0c2a0269900809946903';
  function updateCodePlaceholder() {
    var input = el('codeInput');
    if (!input) { return; }
    var code = demoChannel && demoChannel.channelCode;
    input.placeholder = code ? ('粘贴 32 位通道码，如 ' + code) : DEFAULT_CODE_PLACEHOLDER;
  }

  /* ---------------- 推送测试卡片 ---------------- */

  async function loadDemo() {
    if (getCode()) { return; }
    var box = el('demoChannelBox');
    box.style.display = 'flex';
    el('demoName').textContent = '示例通道加载中…';
    try {
      var resp = await fetch(PING_URL, { headers: { 'Accept': 'application/json' } });
      var biz = await readJson(resp);
      var rows = (biz.data && biz.data.rows) || [];
      if (!rows.length) {
        box.style.display = 'none';
        updateCodePlaceholder();
        toast('官方示例通道暂不可用（ping 返回空），请设置自己的通道码后再测试', 'err', 6000);
        return;
      }
      demoChannel = rows[0];
      updateCodePlaceholder();
      el('demoQr').src = demoChannel.qrCodeUrl || '';
      el('demoQr').title = '点击放大';
      el('demoQr').style.cursor = 'zoom-in';
      var nameEl = el('demoName');
      nameEl.textContent = demoChannel.channelName || '在线体验';
      if (demoChannel.pushUrl) {
        nameEl.href = demoChannel.pushUrl;
        nameEl.target = '_blank';
        el('demoPushUrl').href = demoChannel.pushUrl;
        el('demoPushUrl').style.display = '';
      } else {
        nameEl.removeAttribute('href');
        el('demoPushUrl').style.display = 'none';
      }
      el('demoTag').textContent = (demoChannel.pushTypeDesc || '浏览器') + ' · 官方公开示例';
      el('demoCodeMasked').textContent = maskCode(demoChannel.channelCode);
      el('demoTip').textContent = '此通道码来自官方 ping 示例通道，任何人都能往里推，仅用于链路体验';
      el('sendTargetTip').textContent = '将推送到官方示例通道「' + (demoChannel.channelName || '在线体验') + '」';
    } catch (e) {
      box.style.display = 'none';
      updateCodePlaceholder();
      toast('无法连接官方服务（' + e.message + '）。若以 file:// 打开请改用 http://localhost 访问', 'err', 6000);
    }
  }

  function renderPushCard() {
    var code = getCode();
    var title = el('pushCardTitle');
    if (code) {
      var curName = '';
      var match = null;
      if (channelsMeta && channelsMeta.channelCode === code) { curName = channelsMeta.channelName; match = channelsMeta; }
      else if (channelRows && channelRows.length) { var found = channelRows.find(function(r) { return r.channelCode === code; }); if (found) { curName = found.channelName; match = found; } }
      title.innerHTML = '当前MCP配置的通道：<span class="mono"></span>';
      title.querySelector('.mono').textContent = curName || code;
      el('demoChannelBox').style.display = 'none';
      var targetTip = '将推送到你设置的通道';
      if (match) {
        if (Number(match.pushType) === 10) {
          targetTip = '将推送到下方所有子通道';
        } else {
          targetTip = '将推送到「' + esc(match.channelName || '') + '」通道';
        }
      }
      el('sendTargetTip').textContent = targetTip;
    } else {
      title.textContent = '群组提醒示例';
      if (demoChannel) { el('demoChannelBox').style.display = 'flex'; }
    }
  }

  async function onSend() {
    var btn = el('sendBtn');
    var head = el('pushHead').value.trim();
    var body = el('pushBody').value.trim();
    var url = el('pushUrl').value.trim();
    var code = getCode() || (demoChannel && demoChannel.channelCode);
    if (!head) { toast('请填写消息标题', 'err'); return; }
    if (head.length > 200) { toast('标题不能超过 200 字符', 'err'); return; }
    if (!code) { toast('暂无可用通道：请设置通道码，或等示例通道加载完成', 'err'); return; }

    btn.disabled = true;
    btn.textContent = '推送中…';
    try {
      var biz = await pushSend(code, head, body, url);
      var pre = el('pushResult');
      pre.style.display = 'block';
      pre.textContent = '推送成功（MCP send_push_message 响应）：\n' + JSON.stringify(biz, null, 2);
      var ids = biz.data && biz.data.messageIdList;
      toast('推送成功' + (ids && ids.length ? '，消息ID：' + ids.join(', ') : ''), 'ok', 6000);
      if (!getCode()) {
        toast('示例通道：相同内容请求间隔不能小于 30 秒', '', 5000);
      }
    } catch (e) {
      var pre2 = el('pushResult');
      pre2.style.display = 'block';
      pre2.textContent = '推送失败：' + e.message;
      toast('推送失败：' + e.message, 'err', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = '发送测试';
    }
  }

  /* ---------------- 通道管理卡片 ---------------- */

  function showPlaceholder(html) {
    el('channelTableWrap').innerHTML = '<div class="placeholder">' + html + '</div>';
  }

  async function loadChannels() {
    var code = getCode();
    if (!code) {
      showPlaceholder(
        '<p>设置通道码后即可在这里管理你的推送通道（新增 / 修改 / 删除 / 测试 / 复制通道码）。</p>' +
        '<p class="muted">还没有通道码？去官网 <a href="https://push.phprm.com/mcp.html" target="_blank" rel="noopener">push.phprm.com/mcp.html</a> 注册创建，然后在右上角「设置通道码」填入 32 位通道码。</p>'
      );
      return;
    }
    el('channelTableWrap').innerHTML = '<div class="load-tip">通道列表加载中…</div>';
    try {
      var data = await oauth('/oauth2/push/channel/list');
      renderChannels(data);
    } catch (e) {
      var msg = esc(e.message || String(e));
      var hint = /通道码|令牌|access_token|无效/i.test(msg)
        ? '<p class="muted">通道码可能无效或已被重置，请右上角重新设置。</p>'
        : '';
      showPlaceholder('<p class="err">通道列表加载失败：' + msg + '</p>' + hint +
        '<p><button class="btn btn-ghost" onclick="PS.loadChannels()">重试</button></p>');
    }
  }

  function renderChannels(data) {
    channelsMeta = data;
    var rows = (data && data.rows) || [];
    /* 用户设置的是组合父通道码时，顶层 data 即当前通道，补进列表首行 */
    if (data && data.channelCode && data.channelCode === getCode()) {
      rows = [data].concat(rows);
    }
    channelRows = rows;

    var parentTip = data && data.channelName
      ? '父通道：' + esc(data.channelName) + '（' + esc(data.pushTypeDesc || '') + '）'
      : '';
    el('channelParentInfo').textContent = parentTip;

    if (!rows.length) {
      showPlaceholder('<p>该通道组下暂无子通道，点右上角「+ 新增推送通道」创建。</p>');
      return;
    }

    var hasAnyNickname = rows.some(function (r) { return r.channelMemberRelId; });
    var html = '<div class="table-wrap"><table class="chan"><thead><tr>' +
      '<th>#</th><th>二维码/推送记录</th><th>通道名称</th>' + (hasAnyNickname ? '<th>创建人昵称</th>' : '') +
      '<th>通道码</th><th>创建时间</th><th style="min-width:200px">操作</th>' +
      '</tr></thead><tbody>';
    /* 序号预计算：pushType=10（组合）的行显示「父通道」，其余行按「子N」连续编号 */
    var subSeq = 0;
    rows.forEach(function (r) {
      if (Number(r.pushType) === 10) { r._isParent = true; }
      else { subSeq++; r._subIdx = subSeq; }
    });
    rows.forEach(function (r, i) {
      var isCur = r.channelCode === getCode();
      var isParent = !!r._isParent;
      var idxText = isParent ? '父通道' : '子' + (r._subIdx || i);
      var idxCls = 'idx' + (isParent ? ' idx-parent' : '');
      var qr = r.qrCodeUrl
        ? '<img class="qr" src="' + esc(r.qrCodeUrl) + '" alt="二维码" title="点击放大" data-qr="' + esc(r.qrCodeUrl) + '" data-url="' + esc(r.pushUrl) + '" data-name="' + esc(r.channelName || '') + '">'
        : '<span class="muted">—</span>';
      var nameBadge = (isCur ? '<span class="badge-cur">当前</span>' : '') +
        (Number(r.status) === 0 ? '<span class="badge-off">已停用</span>' : '');
      var name = r.pushUrl
        ? '<a class="name" href="' + esc(r.pushUrl) + '" target="_blank" rel="noopener">' + esc(r.channelName) + '</a>'
        : '<span class="name">' + esc(r.channelName) + '</span>';
      html += '<tr>' +
        '<td><span class="' + idxCls + '" title="' + esc(r.pushTypeDesc || '') + '">' + idxText + '</span></td>' +
        '<td>' + qr + '</td>' +
        '<td>' + name + nameBadge + '<div class="muted small">' + esc(r.pushTypeDesc || '') + '</div></td>' +
        (hasAnyNickname ? '<td>' + (r.channelMemberRelId ? '<span class="nickname" data-i="' + i + '" title="单击修改昵称">' + esc(r.nickname || '-') + '</span>' : '<span class="muted">—</span>') + '</td>' : '') +
        '<td class="code">' + esc(maskCode(r.channelCode)) + '</td>' +
        '<td>' + esc(r.createTime || '-') + '</td>' +
        '<td><div class="ops-row">' +
        '<button class="btn btn-sm btn-o-red" data-op="del" data-i="' + i + '">删除</button>' +
        '<button class="btn btn-sm btn-o-green" data-op="edit" data-i="' + i + '">修改</button>' +
        '<button class="btn btn-sm btn-o-green" data-op="test" data-i="' + i + '">测试</button>' +
        '<button class="btn btn-sm btn-o-green" data-op="copy" data-i="' + i + '">复制</button>' +
        '<button class="btn btn-sm btn-o-red" data-op="reset" data-i="' + i + '">重置</button>' +
        '</div></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    el('channelTableWrap').innerHTML = html;
    renderPushCard();
  }

  el('channelTableWrap').addEventListener('click', function (ev) {
    /* 二维码缩略图 → 打开放大浮层 */
    var qrImg = ev.target.closest ? ev.target.closest('img.qr[data-qr]') : null;
    if (qrImg) {
      el('qrTitle').textContent = '使用手机扫码访问：' + (qrImg.getAttribute('data-name') || '');
      el('qrBig').src = qrImg.getAttribute('data-qr');
      el('groupUrl').href = qrImg.getAttribute('data-url');
      openModal('qrModal');
      return;
    }

    /* 单击昵称进入编辑模式 */
    var nick = ev.target.closest ? ev.target.closest('.nickname') : null;
    if (nick) {
      var idx = Number(nick.getAttribute('data-i'));
      var r = channelRows[idx];
      if (!r || !r.channelMemberRelId) { return; }
      if (nick.querySelector('input')) { return; }
      var oldVal = r.nickname || '';
      var input = document.createElement('input');
      input.type = 'text';
      input.value = oldVal;
      input.maxLength = 16;
      input.className = 'nickname-edit';
      input.style.width = '140px';
      nick.textContent = '';
      nick.appendChild(input);
      input.focus();
      input.select();

      async function doSave() {
        var val = input.value.trim();
        if (val === oldVal) { nick.textContent = oldVal || '-'; return; }
        input.disabled = true;
        try {
          await oauth('/oauth2/push/channel/member/edit', { channelMemberRelId: r.channelMemberRelId, nickname: val }, true);
          r.nickname = val;
          toast('昵称修改成功', 'ok');
          loadChannels();
        } catch (e) {
          toast('修改失败：' + (e.message || e), 'err', 6000);
          nick.textContent = oldVal || '-';
        }
      }
      input.addEventListener('keydown', function (ev2) { if (ev2.key === 'Enter') { ev2.preventDefault(); doSave(); } if (ev2.key === 'Escape') { nick.textContent = oldVal || '-'; } });
      input.addEventListener('blur', function () { doSave(); });
      return;
    }

    var btn = ev.target.closest ? ev.target.closest('button[data-op]') : null;
    if (!btn) { return; }
    var r = channelRows[Number(btn.getAttribute('data-i'))];
    if (!r) { return; }
    var op = btn.getAttribute('data-op');
    if (op === 'test') {
      openTestModal(r);
    } else if (op === 'copy') {
      copyText(r.channelCode, '已复制完整通道码');
    } else if (op === 'edit') {
      openEdit(r);
    } else if (op === 'del') {
      el('delTarget').textContent = '通道：' + (r.channelName || '') + ' · ' + maskCode(r.channelCode);
      el('delSubmit').setAttribute('data-code', r.channelCode);
      if (r.channelCode === getCode()) {
        el('delTarget').textContent += '（这是当前应用绑定的通道，服务端会拒绝删除）';
      }
      openModal('delModal');
    } else if (op === 'reset') {
      openReset(r);
    }
  });

  /* -------- 测试推送弹窗（对齐官网：head/body/url/avatar + 实时 API 网址 + GET 推送） -------- */

  var testChannel = null; /* 当前测试目标通道 */

  function isUrl(s) { return /^https?:\/\/.+/i.test(s || ''); }

  /** 按推送类型切换三件套标签文案（9=企业微信应用用 企业ID/应用ID/应用Secret，邮箱用默认文案） */
  function setThreeLabels(type) {
    var l = type === 9 ? THREE_LABELS[9] : THREE_LABELS.email;
    el('addCorpLabel').textContent = l[0];
    el('addAgentLabel').textContent = l[1];
    el('addSecretLabel').textContent = l[2];
    el('addCorpSecret').placeholder = '对应参数 corpSecret' + (l[3] || '');
    el('editCorpLabel').textContent = l[0];
    el('editAgentLabel').textContent = l[1];
    el('editSecretLabel').textContent = l[2];
    el('editCorpSecret').placeholder = '对应参数 corpSecret' + (l[3] || '');
  }

  /** 按 head/body/url/avatar 实时拼接 GET API 网址（与官网 sendUrlChange 同构） */
  function buildTestApiUrl() {
    if (!testChannel) { return ''; }
    var url = API + '/services/push/send/' + testChannel.channelCode +
      '?head=' + encodeURIComponent(el('testHead').value.trim() || '测试');
    var body = el('testBody').value.trim();
    var link = el('testUrl').value.trim();
    var avatar = el('testAvatar').value.trim();
    if (body) { url += '&body=' + encodeURIComponent(body); }
    if (link && isUrl(link)) { url += '&url=' + encodeURIComponent(link); }
    if (avatar && isUrl(avatar)) { url += '&avatar=' + encodeURIComponent(avatar); }
    return url;
  }

  function refreshTestApiUrl() {
    el('testApiUrl').textContent = buildTestApiUrl();
  }

  function openTestModal(r) {
    testChannel = r;
    el('testTitle').textContent = '测试' + (r.channelName || '');
    el('testHead').value = '测试';
    el('testBody').value = '';
    el('testUrl').value = '';
    el('testAvatar').value = '';
    refreshTestApiUrl();
    openModal('testModal');
    setTimeout(function () { el('testHead').focus(); }, 60);
  }

  ['testHead', 'testBody', 'testUrl', 'testAvatar'].forEach(function (id) {
    el(id).addEventListener('input', refreshTestApiUrl);
    el(id).addEventListener('change', refreshTestApiUrl);
  });

  el('testCopyUrl').addEventListener('click', function () {
    var url = buildTestApiUrl();
    if (url) { copyText(url, 'API网址复制成功，可集成到您的代码中'); }
  });

  /**
   * 推送：GET 拼好的 API 网址直推（/services/push/send/{code}，与官网 testMessageSend 同链路）。
   * head/body/url/avatar 全参数支持，无需登录态。
   */
  async function onTestPush() {
    var btn = el('testPushBtn');
    if (!testChannel) { toast('缺少目标通道', 'err'); return; }
    if (!el('testHead').value.trim()) { toast('请填写 head（消息标题）', 'err'); return; }
    btn.disabled = true; btn.textContent = '推送中…';
    var link = el('testUrl').value.trim();
    var avatar = el('testAvatar').value.trim();
    if (link && !isUrl(link)) { toast(link + "网址不合法，已忽略", 'ok', 6000); }
    if (avatar && !isUrl(avatar)) { toast(avatar + "头像不合法，已忽略", 'ok', 6000); }
    try {
      var resp = await fetch(buildTestApiUrl(), { method: 'GET', headers: { 'Accept': 'application/json' } });
      var biz = await readJson(resp).catch(function (e) { throw new Error(e.message || '接口响应异常'); });
      if (biz.code !== 0) { throw new Error(biz.message || '推送失败'); }
      var isBrowser = (testChannel && testChannel.pushType === 1);
      toast(isBrowser ? '推送成功' : '推送成功, 可到官网查看推送日志', 'ok', 6000);
      closeModal('testModal');
    } catch (e) {
      toast('推送失败：' + (e.message || e), 'err', 6000);
    } finally {
      btn.disabled = false; btn.textContent = '推送';
    }
  }
  el('testPushBtn').addEventListener('click', onTestPush);

  /* -------- 新增 -------- */

  function fillTypeSelect() {
    var sel = el('addType');
    if (sel.options.length) { return; }
    PUSH_TYPES.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.v; o.textContent = t.t;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      var v = Number(sel.value);
      el('addWebhookRow').style.display = NEED_WEBHOOK[v] ? 'flex' : 'none';
      el('addSecretRow').style.display = NEED_SECRET[v] ? 'flex' : 'none';
      var email = NEED_EMAIL[v];
      setThreeLabels(v);
      el('addCorpIdRow').style.display = email ? 'flex' : 'none';
      el('addAgentIdRow').style.display = email ? 'flex' : 'none';
      el('addCorpSecretRow').style.display = email ? 'flex' : 'none';
    });
  }

  async function onAdd() {
    if (!getCode()) { toast('请先在右上角设置通道码', 'err'); return; }
    fillTypeSelect();
    el('addName').value = '';
    el('addWebhook').value = '';
    el('addSecret').value = '';
    el('addCorpId').value = '';
    el('addAgentId').value = '';
    el('addCorpSecret').value = '';
    el('addErr').style.display = 'none';
    el('addWebhookRow').style.display = 'none';
    el('addSecretRow').style.display = 'none';
    var email = NEED_EMAIL[Number(el('addType').value)];
    setThreeLabels(Number(el('addType').value));
    el('addCorpIdRow').style.display = email ? 'flex' : 'none';
    el('addAgentIdRow').style.display = email ? 'flex' : 'none';
    el('addCorpSecretRow').style.display = email ? 'flex' : 'none';
    openModal('addModal');
  }

  async function onAddSubmit() {
    var name = el('addName').value.trim();
    var type = Number(el('addType').value);
    var hook = el('addWebhook').value.trim();
    var secret = el('addSecret').value.trim();
    var err = el('addErr');
    err.style.display = 'none';
    if (!name) { err.textContent = '请填写通道名称'; err.style.display = 'block'; return; }
    if (NEED_WEBHOOK[type] && !/^https?:\/\/.+/i.test(hook)) {
      err.textContent = '该推送类型必须填写合法的接收地址（http/https）';
      err.style.display = 'block'; return;
    }
    var params = { channelName: name, pushType: type };
    if (hook) { params.webhookUrl = hook; }
    if (secret && NEED_SECRET[type]) { params.signSecret = secret; }
    /* 自定义邮箱：发信人昵称→corpId、邮箱地址→agentId、授权码→corpSecret */
    if (NEED_EMAIL[type]) {
      var corpId = el('addCorpId').value.trim();
      var agentId = el('addAgentId').value.trim();
      var corpSecret = el('addCorpSecret').value.trim();
      if (corpId) { params.corpId = corpId; }
      if (agentId) { params.agentId = agentId; }
      if (corpSecret) { params.corpSecret = corpSecret; }
    }
    var btn = el('addSubmit');
    btn.disabled = true; btn.textContent = '创建中…';
    try {
      var ch = await oauth('/oauth2/push/channel/add', params, true);
      closeModal('addModal');
      toast('通道创建成功，新通道码：' + (ch && ch.channelCode || '（见列表）'), 'ok', 8000);
      if (ch && ch.channelCode) { copyText(ch.channelCode, '已复制新通道码'); }
      loadChannels();
    } catch (e) {
      err.textContent = '创建失败：' + (e.message || e);
      err.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = '创建';
    }
  }

  /* -------- 修改 -------- */

  var editTarget = null;

  function openEdit(r) {
    editTarget = r;
    el('editTarget').textContent = '目标通道：' + (r.channelName || '') + ' · ' + maskCode(r.channelCode) +
      '（' + (r.pushTypeDesc || '') + '）';
    el('editName').value = r.channelName || '';
    el('editWebhook').value = r.webhookUrl || '';
    el('editWebhookRow').style.display = NEED_WEBHOOK[r.pushType] ? 'flex' : 'none';
    var email = NEED_EMAIL[r.pushType];
    setThreeLabels(r.pushType);
    el('editCorpId').value = r.corpId || '';
    el('editAgentId').value = r.agentId || '';
    el('editCorpSecret').value = r.corpSecret || '';
    el('editSignSecret').value = r.signSecret || '';
    el('editCorpIdRow').style.display = email ? 'flex' : 'none';
    el('editAgentIdRow').style.display = email ? 'flex' : 'none';
    el('editCorpSecretRow').style.display = email ? 'flex' : 'none';
    el('editSignSecretRow').style.display = (r.signSecret !== undefined && r.signSecret !== null) ? 'flex' : 'none';
    el('editStatus').value = String(Number(r.status) === 0 ? 0 : 1);
    el('editErr').style.display = 'none';
    if (r.channelCode === getCode()) {
      el('editErr').textContent = '注意：这是当前应用绑定的通道，停用（或改名/换码）后请同步更新你的 MCP 配置';
      el('editErr').style.display = 'block';
    }
    openModal('editModal');
  }

  async function onEditSubmit() {
    if (!editTarget) { return; }
    var name = el('editName').value.trim();
    var status = el('editStatus').value;
    var hook = el('editWebhook').value.trim();
    var err = el('editErr');
    err.style.display = 'none';
    if (!name) { err.textContent = '请填写通道名称'; err.style.display = 'block'; return; }
    var params = { channelCode: editTarget.channelCode, channelName: name, status: status };
    if (hook && NEED_WEBHOOK[editTarget.pushType]) { params.webhookUrl = hook; }
    /* 自定义邮箱三件套：仅在对应类型下透传（留空则不提交，保持原值） */
    if (NEED_EMAIL[editTarget.pushType]) {
      var corpId = el('editCorpId').value.trim();
      var agentId = el('editAgentId').value.trim();
      var corpSecret = el('editCorpSecret').value.trim();
      if (corpId) { params.corpId = corpId; }
      if (agentId) { params.agentId = agentId; }
      if (corpSecret) { params.corpSecret = corpSecret; }
    }
    /* 加签 Secret：存在 signSecret 字段时透传 */
    var signSecret = el('editSignSecret').value.trim();
    if (signSecret !== '') { params.signSecret = signSecret; }
    var btn = el('editSubmit');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await oauth('/oauth2/push/channel/edit', params, true);
      closeModal('editModal');
      toast('通道修改成功', 'ok');
      loadChannels();
    } catch (e) {
      err.textContent = '修改失败：' + (e.message || e);
      err.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  }

  /* -------- 重置 -------- */

  var resetTarget = null;

  function openReset(r) {
    resetTarget = r;
    el('resetTarget').textContent = '通道：' + (r.channelName || '') + ' · ' + maskCode(r.channelCode);
    var isCur = r.channelCode === getCode();
    el('resetTip').textContent = isCur
      ? '确认重置该通道的通道码？重置后旧通道码将失效，新通道码会自动更新到当前 MCP 配置。'
      : '确认重置该通道的通道码？重置后旧通道码将失效。';
    openModal('resetModal');
  }

  async function onResetSubmit() {
    if (!resetTarget) { return; }
    var oldCode = resetTarget.channelCode;
    var isCur = normCode(oldCode) === normCode(getCode());
    var btn = el('resetSubmit');
    btn.disabled = true; btn.textContent = '重置中…';
    try {
      var data = await oauth('/oauth2/push/channel/resetChannel', { channelCode: oldCode }, true);
      closeModal('resetModal');
      /* 接口返回的 data 本身就是新的 channelCode 字符串 */
      var newCode = data;
      if (newCode) {
        if (isCur) {
          setCode(newCode);
          updateCodeBtn();
          renderPushCard();
          await loadChannels();
          var changedTip = el('codeChangedTip');
          changedTip.textContent = '您的通道码已经从 ' + oldCode + ' 变更到 ' + newCode;
          changedTip.style.display = 'block';
          el('codeInput').value = newCode;
          openSettings();
          toast('通道码已重置', 'ok');
        } else {
          toast('通道码已重置', 'ok');
          loadChannels();
        }
      } else {
        toast('通道码已重置', 'ok');
        loadChannels();
      }
    } catch (e) {
      toast('重置失败：' + (e.message || e), 'err', 6000);
    } finally {
      btn.disabled = false; btn.textContent = '确认重置';
    }
  }

  /* -------- 删除 -------- */

  async function onDelSubmit() {
    var code = el('delSubmit').getAttribute('data-code');
    if (!code) { return; }
    var btn = el('delSubmit');
    btn.disabled = true; btn.textContent = '删除中…';
    try {
      await oauth('/oauth2/push/channel/deleteChannel', { channelCode: code }, true);
      closeModal('delModal');
      toast('通道已删除（不可恢复）', 'ok');
      loadChannels();
    } catch (e) {
      toast('删除失败：' + (e.message || e), 'err', 6000);
      if (/当前应用绑定/.test(e.message || '')) { closeModal('delModal'); }
    } finally {
      btn.disabled = false; btn.textContent = '确认删除';
    }
  }

  /* ---------------- 设置通道码 ---------------- */

  function updateCodeBtn() {
    var btn = el('codeBtn');
    var code = getCode();
    if (code) {
      btn.textContent = '通道码 ' + maskCode(code);
      btn.classList.add('has');
    } else {
      btn.textContent = '设置通道码';
      btn.classList.remove('has');
    }
  }

  function openSettings() {
    el('codeInput').value = getCode() || '';
    el('codeErr').style.display = 'none';
    el('codeChangedTip').style.display = 'none';
    openModal('settingsModal');
    setTimeout(function () { el('codeInput').focus(); el('codeInput').select(); }, 60);
  }

  function onSaveCode() {
    var code = normCode(el('codeInput').value);
    var err = el('codeErr');
    if (!/^[0-9a-fA-F]{32}$/.test(code)) {
      err.textContent = '通道码应为 32 位十六进制字符串（去官网 push.phprm.com/mcp.html 创建通道后复制）';
      err.style.display = 'block';
      return;
    }
    setCode(code);
    dropToken();
    closeModal('settingsModal');
    updateCodeBtn();
    renderPushCard();
    toast('通道码已保存', 'ok');
    loadChannels();
  }

  function onClearCode() {
    clearCode();
    dropToken();
    demoChannel = null;
    updateCodePlaceholder();
    closeModal('settingsModal');
    updateCodeBtn();
    renderPushCard();
    toast('已清除通道码，回到官方示例通道体验模式', 'ok');
    loadDemo();
    loadChannels();
  }

  /* ---------------- 绑定与启动 ---------------- */

  /* Agent 指南药丸：复制 skill.md 地址（对勾反馈 1.5s，对齐官网 mcp.html） */
  el('agentGuideCopy').addEventListener('click', function () {
    var btn = this;
    var url = 'https://push.phprm.com/skill.md';
    var done = function () {
      btn.classList.add('is-copied');
      setTimeout(function () { btn.classList.remove('is-copied'); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url, done); });
    } else { fallbackCopy(url, done); }
  });

  el('codeBtn').addEventListener('click', openSettings);
  el('saveCodeBtn').addEventListener('click', onSaveCode);
  el('clearCodeBtn').addEventListener('click', onClearCode);
  el('codeInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { onSaveCode(); } });

  el('sendBtn').addEventListener('click', onSend);
  el('demoQr').addEventListener('click', function () {
    if (demoChannel && demoChannel.qrCodeUrl) {
      el('qrTitle').textContent = '使用手机扫码访问：' + (demoChannel.channelName || '');
      el('qrBig').src = demoChannel.qrCodeUrl;
      el('groupUrl').href = demoChannel.pushUrl;
      openModal('qrModal');
    }
  });
  el('refreshBtn').addEventListener('click', function () { loadChannels(); });
  el('addBtn').addEventListener('click', onAdd);
  el('addSubmit').addEventListener('click', onAddSubmit);
  el('editSubmit').addEventListener('click', onEditSubmit);
  el('delSubmit').addEventListener('click', onDelSubmit);
  el('resetSubmit').addEventListener('click', onResetSubmit);

  updateCodeBtn();
  renderPushCard();
  if (getCode()) {
    loadChannels();
  } else {
    loadDemo();
    loadChannels(); /* 渲染占位提示 */
  }

  /* 暴露给自动化验证 / 调试 */
  window.PS = {
    loadDemo: loadDemo,
    loadChannels: loadChannels,
    pushSend: pushSend,
    getCode: getCode,
    setCode: function (c) { setCode(c); dropToken(); updateCodeBtn(); renderPushCard(); loadChannels(); }
  };
})();
