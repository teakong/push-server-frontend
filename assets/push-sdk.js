/**
 * 一封传话 MCP 浏览器 SDK（ES5）
 *
 * 全部请求都从用户浏览器直连 https://www.phprm.com，
 * 不经过你自己的服务端，避免所有用户共用服务器 IP 触发限流。
 *
 *   开通通道码   create_auth_session / poll_auth_session
 *   通道管理     get_access_token 换短期令牌 → /oauth2/push/channel/*
 *   推送消息     send_push_message
 *
 * 兼容性：纯 ES5 语法，无 async/await、模板字符串、箭头函数、URLSearchParams。
 *   - 有原生 Promise 时直接用，没有（如 IE11）用内置的轻量实现
 *   - 有 fetch 时用 fetch，没有时自动回退 XMLHttpRequest
 *
 * 引入方式（UMD）：
 *   浏览器 <script>   window.YfPush.*
 *   CommonJS          var YfPush = require('./push-sdk.js')
 *   Vue / React 等    import YfPush from './push-sdk.js'（Vite / webpack / esbuild 均可）
 *
 * 多实例 / 自定义域名：
 *   var sdk = YfPush.create({ apiBase: 'https://www.phprm.com', mcpSource: 'my-admin' });
 *   sdk.listTools().then(function (tools) {});
 *
 * 一键开通道卡片（自带样式与逻辑，宿主页面不用再抄一份 HTML/CSS）：
 *   YfPush.create({ mcpSource: 'my-admin' }).mountAuthCard('#auth-slot', {
 *       onSuccess: function (r) {
 *           // r.channelCode / r.mcpConfig / r.provider / r.email
 *       }
 *   });
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    if (typeof define === 'function' && define.amd) {
        define([], factory);
        return;
    }
    root.YfPush = factory();
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
    'use strict';

    var DEFAULTS = {
        apiBase: 'https://www.phprm.com',
        mcpSource: 'workbuddy',
        /* 邮件授权入口通道码：不传则从 /services/public/ping 取官方示例通道 */
        entryChannelCode: ''
    };
    var FALLBACK_ENTRY = '4d05f4abdb0a0c2a0269900809946903';
    var MAX_SAFE_DIGITS = '9007199254740991';
    var NUM_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

    /* ---------------- Promise 降级（IE11 无 Promise） ---------------- */

    function MiniPromise(executor) {
        var self = this;
        self._state = 0;
        self._value = undefined;
        self._handlers = [];
        self._scheduled = false;

        function settle(state, value) {
            if (self._state !== 0) { return; }
            if (state === 1 && value && (typeof value === 'object' || typeof value === 'function')) {
                var then;
                try {
                    then = value.then;
                } catch (e) {
                    settle(2, e);
                    return;
                }
                if (typeof then === 'function') {
                    var called = false;
                    try {
                        then.call(value, function (next) {
                            if (called) { return; }
                            called = true;
                            settle(1, next);
                        }, function (reason) {
                            if (called) { return; }
                            called = true;
                            settle(2, reason);
                        });
                    } catch (e2) {
                        if (!called) { called = true; settle(2, e2); }
                    }
                    return;
                }
            }
            self._state = state;
            self._value = value;
            schedule(self);
        }

        try {
            executor(function (value) { settle(1, value); }, function (reason) { settle(2, reason); });
        } catch (e) {
            settle(2, e);
        }
    }

    function schedule(promise) {
        if (promise._scheduled || promise._state === 0) { return; }
        promise._scheduled = true;
        setTimeout(function () {
            promise._scheduled = false;
            flush(promise);
        }, 0);
    }

    function flush(promise) {
        if (promise._state === 0) { return; }
        var handlers = promise._handlers;
        promise._handlers = [];
        for (var i = 0; i < handlers.length; i++) {
            var h = handlers[i];
            var callback = promise._state === 1 ? h.onFulfilled : h.onRejected;
            if (typeof callback !== 'function') {
                if (promise._state === 1) { h.resolve(promise._value); }
                else { h.reject(promise._value); }
                continue;
            }
            try {
                h.resolve(callback(promise._value));
            } catch (e) {
                h.reject(e);
            }
        }
    }

    MiniPromise.prototype.then = function (onFulfilled, onRejected) {
        var self = this;
        return new MiniPromise(function (resolve, reject) {
            self._handlers.push({ onFulfilled: onFulfilled, onRejected: onRejected, resolve: resolve, reject: reject });
            schedule(self);
        });
    };

    MiniPromise.prototype['catch'] = function (onRejected) {
        return this.then(null, onRejected);
    };

    MiniPromise.resolve = function (value) {
        if (value instanceof MiniPromise) { return value; }
        return new MiniPromise(function (resolve) { resolve(value); });
    };

    MiniPromise.reject = function (reason) {
        return new MiniPromise(function (resolve, reject) { reject(reason); });
    };

    var P = typeof Promise === 'function' ? Promise : MiniPromise;

    /* ---------------- 通用工具 ---------------- */

    function isUnsafeIntDigits(digits) {
        digits = String(digits).replace(/^0+(?=\d)/, '');
        if (digits.length < MAX_SAFE_DIGITS.length) { return false; }
        if (digits.length > MAX_SAFE_DIGITS.length) { return true; }
        return digits > MAX_SAFE_DIGITS;
    }

    /** 把超过 MAX_SAFE_INTEGER 的整数字面量包成字符串，避免 messageId 等大整数丢精度 */
    function quoteUnsafeInts(text) {
        text = String(text);
        var out = '';
        var i = 0;
        var n = text.length;
        while (i < n) {
            var ch = text.charAt(i);
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
            if ((ch >= '0' && ch <= '9') || (ch === '-' && /[0-9]/.test(text.charAt(i + 1)))) {
                NUM_RE.lastIndex = i;
                var m = NUM_RE.exec(text);
                if (m && m.index === i) {
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

    /** JSON-RPC 响应可能是 JSON，也可能是 SSE（data: 行） */
    function parseEnvelope(text) {
        try {
            return parseJsonSafe(text);
        } catch (e) {
            var lines = String(text).split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].replace(/^\s+|\s+$/g, '');
                if (line.indexOf('data:') === 0) {
                    try {
                        return parseJsonSafe(line.slice(5).replace(/^\s+|\s+$/g, ''));
                    } catch (e2) {
                        /* 继续找下一行 */
                    }
                }
            }
        }
        throw new Error('MCP 响应解析失败');
    }

    function isChannelCode(value) {
        return /^[0-9a-f]{32}$/i.test(String(value || ''));
    }

    /** 表单编码，替代 URLSearchParams（IE11 不支持） */
    function encodeParams(params) {
        var parts = [];
        if (!params) { return ''; }
        for (var key in params) {
            if (!Object.prototype.hasOwnProperty.call(params, key)) { continue; }
            var value = params[key];
            if (value === undefined || value === null) { continue; }
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
        }
        return parts.join('&');
    }

    /** 没有 fetch 时用 XMLHttpRequest，返回与 fetch 相同形状的 {ok,status,text()} */
    function xhrRequest(url, opt) {
        opt = opt || {};
        return new P(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(opt.method || 'GET', url, true);
            var headers = opt.headers || {};
            for (var name in headers) {
                if (Object.prototype.hasOwnProperty.call(headers, name)) {
                    xhr.setRequestHeader(name, headers[name]);
                }
            }
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                if (xhr.status === 0) {
                    reject(new Error('网络请求失败'));
                    return;
                }
                resolve({
                    ok: xhr.status >= 200 && xhr.status < 300,
                    status: xhr.status,
                    text: function () { return P.resolve(xhr.responseText); }
                });
            };
            xhr.onerror = function () { reject(new Error('网络请求失败')); };
            xhr.send(opt.body === undefined || opt.body === null ? null : opt.body);
        });
    }

    function copyText(text) {
        var value = String(text === undefined || text === null ? '' : text);

        function legacy() {
            if (typeof window !== 'undefined' && window.clipboardData) {
                try {
                    return window.clipboardData.setData('Text', value);
                } catch (e) {}
            }
            var ta = document.createElement('textarea');
            ta.value = value;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e2) {}
            document.body.removeChild(ta);
            return ok;
        }

        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
            return navigator.clipboard.writeText(value).then(function () {
                return true;
            }, function () {
                return legacy();
            });
        }
        return P.resolve(legacy());
    }

    function recordsUrl(qrCodeUrl) {
        var url = String(qrCodeUrl || '');
        return url.indexOf('/qr/c/') >= 0 ? url.replace('/qr/c/', '/u/') : '';
    }

    /* ---------------- 一键开通道卡片：文案与样式 ---------------- */

    var AUTH_STYLE_ID = 'yf-auth-style';
    var AUTH_UID = 0;

    var AUTH_LABELS = {
        title: '还没有通道码？用第三方账号一键开通',
        desc: '选一种第三方登录，按提示完成授权，页面会自动领取属于你的推送通道码。',
        provider_label: '登录方式',
        email_label: '接收邮箱',
        email_ph: '填写你将收到验证码的邮箱',
        email_required: '请填写接收邮箱',
        start: '生成授权链接',
        cancel: '取消',
        starting: '正在创建授权会话…',
        open: '点此完成授权（会打开第三方登录页）',
        open_login: '点此输入邮箱验证码（打开登录页）',
        waiting: '等待授权，每 {sec}s 轮询一次…（会话 {min} 分钟内有效）',
        success: '授权成功，你的通道码：',
        config_label: '给你的 AI 客户端的配置（mcpConfig）：',
        copy_cfg: '复制配置',
        copied: '已复制',
        stopped: '已停止轮询：',
        err_prefix: '开通道失败：',
        canceled: '已取消本次授权'
    };

    var AUTH_PROVIDERS = {
        feishu: '飞书',
        dingtalk: '钉钉',
        gitee: 'Gitee',
        github: 'GitHub',
        email: '邮箱验证码'
    };

    var AUTH_FALLBACK_PROVIDERS = ['feishu', 'dingtalk', 'gitee', 'github', 'email'];

    var AUTH_CSS = [
        '.yf-auth{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#333;font-size:15px;line-height:1.6;text-align:left;}',
        '.yf-auth,.yf-auth *{box-sizing:border-box;}',
        '.yf-auth-title{margin:0 0 10px;font-size:18px;font-weight:400;color:#222;line-height:1.4;}',
        '.yf-auth-desc{margin:0 0 14px;font-size:13px;color:#999;line-height:1.8;}',
        '.yf-auth-row{display:flex;align-items:flex-start;margin:0 0 12px;flex-wrap:nowrap;}',
        '.yf-auth-label{flex:0 0 84px;width:84px;margin-right:10px;line-height:34px;font-size:15px;font-weight:400;color:#666;}',
        '.yf-auth-input{flex:1 1 auto;width:100%;min-width:0;max-width:520px;height:34px;padding:7px 11px;border:1px solid #e0e4ea;border-radius:6px;background:#fff;color:#333;font-size:15px;line-height:18px;}',
        '.yf-auth-input:focus{outline:none;border-color:#4eb389;box-shadow:0 0 0 3px rgba(78,179,137,.15);}',
        '.yf-auth-actions{align-items:center;}',
        '.yf-auth-btn{display:inline-block;height:32px;padding:0 16px;border-radius:4px;font-size:14px;line-height:30px;text-align:center;cursor:pointer;font-family:inherit;}',
        '.yf-auth-primary{background:#4eb389;border:1px solid #4eb389;color:#fff;}',
        '.yf-auth-primary:hover:not(:disabled){background:#3da076;border-color:#3da076;}',
        '.yf-auth-primary:disabled{opacity:.6;cursor:default;}',
        '.yf-auth-cancel{background:#fff;border:1px solid #d9dde3;color:#666;}',
        '.yf-auth-cancel:hover{background:#f6f7f9;}',
        '.yf-auth-btn+.yf-auth-btn{margin-left:8px;}',
        '.yf-auth-link{display:inline-block;height:32px;padding:0 16px;background:#4eb389;border-radius:4px;color:#fff;font-size:14px;line-height:32px;text-decoration:none;}',
        '.yf-auth-link:hover{background:#3da076;color:#fff;}',
        '.yf-auth-result{margin-top:4px;font-size:14px;line-height:1.8;color:#444;}',
        '.yf-auth-result p{margin:0 0 8px;}',
        '.yf-auth-muted{font-size:13px;color:#999;}',
        '.yf-auth-err{color:#d9534f;}',
        '.yf-auth-code{font-family:Consolas,Monaco,"Courier New",monospace;word-break:break-all;}',
        '.yf-auth-pre{margin:0;padding:10px 12px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:4px;color:#212529;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;}',
        '.yf-auth-copy{position:absolute;top:6px;right:6px;height:26px;padding:0 10px;background:#fff;border:1px solid #dee2e6;border-radius:4px;color:#555;font-size:12px;line-height:24px;cursor:pointer;font-family:inherit;}',
        '.yf-auth-copy:hover{background:#f2f3f5;}',
        '@media (max-width:560px){.yf-auth-row{display:block;}.yf-auth-label{display:block;width:auto;line-height:1.6;margin:0 0 4px;}.yf-auth-input{width:100%;max-width:none;}.yf-auth-actions .yf-auth-label{display:none;}}'
    ].join('\n');

    function escHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** 只替换 {name} 占位，缺值保留原样 */
    function formatText(tpl, vars) {
        return String(tpl).replace(/\{(\w+)\}/g, function (match, key) {
            return vars && vars[key] !== undefined ? String(vars[key]) : match;
        });
    }

    function injectAuthStyle() {
        if (typeof document === 'undefined' || document.getElementById(AUTH_STYLE_ID)) { return; }
        var style = document.createElement('style');
        style.id = AUTH_STYLE_ID;
        style.type = 'text/css';
        if (style.styleSheet) {
            style.styleSheet.cssText = AUTH_CSS;
        } else {
            style.appendChild(document.createTextNode(AUTH_CSS));
        }
        (document.head || document.getElementsByTagName('head')[0] || document.body).appendChild(style);
    }

    /* ---------------- 实例 ---------------- */

    function create(options) {
        options = options || {};
        var apiBase = String(options.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
        var mcpSource = String(options.mcpSource || DEFAULTS.mcpSource);
        var fixedEntry = isChannelCode(options.entryChannelCode) ? String(options.entryChannelCode).toLowerCase() : '';
        var mcpUrl = apiBase + '/services/push/mcp';
        var fetchImpl = options.fetch;
        var entryCodePromise = null;
        var tokenCache = { code: '', token: '', expireAt: 0 };

        function http(url, opt) {
            if (fetchImpl) { return fetchImpl(url, opt); }
            if (typeof fetch !== 'undefined') { return fetch(url, opt); }
            return xhrRequest(url, opt);
        }

        function entryChannelCode() {
            if (fixedEntry) { return P.resolve(fixedEntry); }
            if (!entryCodePromise) {
                entryCodePromise = http(apiBase + '/services/public/ping', {
                    headers: { 'Accept': 'application/json' }
                }).then(function (resp) {
                    return resp.text();
                }).then(function (text) {
                    var json = parseJsonSafe(text);
                    var rows = json && json.data && json.data.rows;
                    var code = rows && rows[0] && rows[0].channelCode;
                    return isChannelCode(code) ? String(code).toLowerCase() : FALLBACK_ENTRY;
                })['catch'](function () {
                    return FALLBACK_ENTRY;
                });
            }
            return entryCodePromise;
        }

        function rpc(body, channelCode) {
            var headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'X-Mcp-Source': mcpSource
            };
            if (isChannelCode(channelCode)) {
                headers['X-Push-Channel-Code'] = String(channelCode).toLowerCase();
            }
            return http(mcpUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            }).then(function (resp) {
                if (!resp.ok) {
                    throw new Error('MCP 服务返回 HTTP ' + resp.status);
                }
                return resp.text();
            }).then(function (text) {
                var env = parseEnvelope(text);
                if (env.error) {
                    throw new Error(env.error.message || 'MCP 服务返回错误');
                }
                return env;
            });
        }

        function callTool(tool, args, channelCode) {
            return rpc({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'tools/call',
                params: { name: tool, arguments: args || {} }
            }, channelCode).then(function (env) {
                var content = env.result && env.result.content && env.result.content[0];
                var biz;
                try {
                    biz = parseJsonSafe(content.text);
                } catch (e) {
                    throw new Error('MCP 业务响应解析失败');
                }
                if (Number(biz.code) !== 0) {
                    var err = new Error(biz.message || 'MCP 业务错误');
                    err.bizCode = biz.code;
                    err.biz = biz;
                    throw err;
                }
                return biz.data || {};
            });
        }

        /** 拉 tools/list，返回工具数组（每项含 name / inputSchema） */
        function listTools() {
            return rpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} })
                .then(function (env) {
                    return (env.result && env.result.tools) || [];
                });
        }

        /**
         * 登录方式枚举：以 tools/list 里 create_auth_session 的 provider 枚举为唯一事实源，
         * 服务端新增登录方式时前端无需改代码。
         * @returns {Promise<string[]>} 如 ['feishu','dingtalk','gitee','github','email']
         */
        function listProviders() {
            return listTools().then(function (tools) {
                var tool = null;
                for (var i = 0; i < tools.length; i++) {
                    if (tools[i] && tools[i].name === 'create_auth_session') {
                        tool = tools[i];
                        break;
                    }
                }
                var props = tool && tool.inputSchema && tool.inputSchema.properties;
                var list = props && props.provider && props.provider.enum;
                return Object.prototype.toString.call(list) === '[object Array]' ? list.slice() : [];
            });
        }

        /**
         * 创建授权会话（免注册开通通道）
         * @param {string} provider 登录方式，取自 listProviders()
         * @param {{email?:string, channelCode?:string}} [config] provider=email 时必填邮箱
         * @returns {Promise<{sessionId:string, authUrl:string, loginUrl:string, emailHint:string, pollInterval:number, expiresIn:number}>}
         */
        function createAuthSession(provider, config) {
            config = config || {};
            var p = String(provider || 'email').toLowerCase();
            return entryChannelCode().then(function (entry) {
                var args = { provider: p };
                if (p === 'email') {
                    var email = String(config.email || '').replace(/^\s+|\s+$/g, '');
                    if (email === '') {
                        throw new Error('邮箱验证码方式需要填写收件邮箱');
                    }
                    args.email = email;
                    args.channelCode = isChannelCode(config.channelCode)
                        ? String(config.channelCode).toLowerCase()
                        : entry;
                }
                return callTool('create_auth_session', args, entry);
            });
        }

        function createEmailSession(email) {
            return createAuthSession('email', { email: email });
        }

        /**
         * 查询授权会话：pending / success / expired / consumed / failed
         * @returns {Promise<{status:string, channelCode?:string, message?:string, pollInterval?:number}>}
         */
        function pollSession(sessionId) {
            return entryChannelCode().then(function (entry) {
                return callTool('poll_auth_session', { sessionId: sessionId }, entry);
            });
        }

        /** 通道码换短期访问令牌；令牌按通道码缓存，过期前不再重复申请 */
        function accessToken(code) {
            code = String(code || '').toLowerCase();
            if (!isChannelCode(code)) {
                return P.reject(new Error('通道码格式不正确'));
            }
            if (tokenCache.code === code && tokenCache.token && Date.now() < tokenCache.expireAt) {
                return P.resolve(tokenCache.token);
            }
            return callTool('get_access_token', { channelCode: code }, code).then(function (data) {
                var token = String(data.access_token || '');
                if (token === '') {
                    throw new Error('获取推送授权令牌失败');
                }
                tokenCache = {
                    code: code,
                    token: token,
                    expireAt: Date.now() + Math.max(60, (Number(data.expires_in) || 7200) - 120) * 1000
                };
                return token;
            });
        }

        function forgetToken() {
            tokenCache = { code: '', token: '', expireAt: 0 };
        }

        /** /oauth2/push/* 业务接口：Bearer 令牌，401/403 换令牌重试一次 */
        function request(code, path, params, isPost, retried) {
            return accessToken(code).then(function (token) {
                var url = apiBase + path;
                var opt = {
                    method: isPost ? 'POST' : 'GET',
                    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
                };
                if (isPost) {
                    opt.body = encodeParams(params);
                    opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                } else if (params) {
                    var qs = encodeParams(params);
                    if (qs) {
                        url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
                    }
                }

                return http(url, opt).then(function (resp) {
                    if (resp.status === 401 || resp.status === 403) {
                        if (!retried) {
                            forgetToken();
                            return request(code, path, params, isPost, true);
                        }
                        throw new Error('推送授权令牌已失效，请刷新页面后重试');
                    }
                    return resp.text().then(function (text) {
                        var biz;
                        try {
                            biz = parseJsonSafe(text);
                        } catch (e) {
                            throw new Error('推送服务响应异常（HTTP ' + resp.status + '）');
                        }
                        if (Number(biz.code) !== 0) {
                            var err = new Error(biz.message || ('推送服务错误 ' + biz.code));
                            err.biz = biz;
                            throw err;
                        }
                        if (isPost) {
                            forgetToken();
                        }
                        return biz.data;
                    });
                });
            });
        }

        /**
         * 通道列表：顶层是当前通道，rows 是它下面的子通道
         * @returns {Promise<{channelCode:string, channelName:string, pushType:number, qrCodeUrl:string, rows:Array}>}
         */
        function listChannels(code) {
            return request(code, '/oauth2/push/channel/list', null, false).then(function (data) {
                return data || {};
            });
        }

        /** 新增子通道：params = {channelName, pushType, webhookUrl?, signSecret?, corpId?, agentId?, corpSecret?} */
        function addChannel(code, params) {
            return request(code, '/oauth2/push/channel/add', params, true).then(function (data) {
                return data || {};
            });
        }

        /** 修改通道：params = {channelCode, channelName, status?, webhookUrl?, ...} */
        function editChannel(code, params) {
            return request(code, '/oauth2/push/channel/edit', params, true);
        }

        function deleteChannel(code, targetCode) {
            return request(code, '/oauth2/push/channel/deleteChannel', { channelCode: targetCode }, true);
        }

        /**
         * 重置通道码，返回新通道码（接口可能直接给字符串，也可能包一层）
         * @returns {Promise<string>}
         */
        function resetChannel(code, targetCode) {
            return request(code, '/oauth2/push/channel/resetChannel', { channelCode: targetCode }, true)
                .then(function (data) {
                    var next = typeof data === 'string'
                        ? data
                        : String((data && (data.channelCode || data.code)) || '');
                    return isChannelCode(next) ? next.toLowerCase() : '';
                });
        }

        /**
         * 推送一条消息（MCP send_push_message）
         * @param {string} code 通道码
         * @param {{head:string, body?:string, url?:string, avatar?:string}} message
         */
        function sendPushMessage(code, message) {
            message = message || {};
            var args = { head: String(message.head || ''), channelCode: code };
            if (message.body) { args.body = message.body; }
            if (message.url) { args.url = message.url; }
            if (message.avatar) { args.avatar = message.avatar; }
            return callTool('send_push_message', args, code);
        }

        /**
         * 在页面上挂一个「一键开通道」卡片：自带样式、provider 枚举拉取、轮询与结果展示。
         * 容器原有内容会被清空；授权成功时通过 onSuccess 把结果交给宿主系统落库。
         * @param {string|Element} target 容器选择器或元素
         * @param {{title?:string, desc?:string, provider?:string, labels?:Object, providers?:Object,
         *          onSuccess?:function, onError?:function}} [opt]
         * @returns {{el:Element, destroy:function}}
         */
        function mountAuthCard(target, opt) {
            opt = opt || {};
            if (typeof document === 'undefined') {
                throw new Error('mountAuthCard 只能在浏览器里使用');
            }
            var host = typeof target === 'string' ? document.querySelector(target) : target;
            if (!host) {
                throw new Error('mountAuthCard：找不到容器 ' + target);
            }

            var key;
            var labels = {};
            for (key in AUTH_LABELS) {
                if (Object.prototype.hasOwnProperty.call(AUTH_LABELS, key)) { labels[key] = AUTH_LABELS[key]; }
            }
            if (opt.labels) {
                for (key in opt.labels) {
                    if (Object.prototype.hasOwnProperty.call(opt.labels, key)) { labels[key] = opt.labels[key]; }
                }
            }
            if (opt.title !== undefined) { labels.title = opt.title; }
            if (opt.desc !== undefined) { labels.desc = opt.desc; }

            var providerNames = {};
            for (key in AUTH_PROVIDERS) {
                if (Object.prototype.hasOwnProperty.call(AUTH_PROVIDERS, key)) { providerNames[key] = AUTH_PROVIDERS[key]; }
            }
            if (opt.providers) {
                for (key in opt.providers) {
                    if (Object.prototype.hasOwnProperty.call(opt.providers, key)) { providerNames[key] = opt.providers[key]; }
                }
            }

            var uid = 'yf-auth-' + (++AUTH_UID);
            var state = { sessionId: '', timer: 0, running: false, destroyed: false, provider: '', email: '' };

            injectAuthStyle();
            host.innerHTML = '';
            var root = document.createElement('div');
            root.className = 'yf-auth';
            root.innerHTML =
                (labels.title ? '<h3 class="yf-auth-title">' + escHtml(labels.title) + '</h3>' : '')
                + (labels.desc ? '<p class="yf-auth-desc">' + escHtml(labels.desc) + '</p>' : '')
                + '<div class="yf-auth-row">'
                + '<label class="yf-auth-label" for="' + uid + '-provider">' + escHtml(labels.provider_label) + '</label>'
                + '<select class="yf-auth-input yf-auth-select" id="' + uid + '-provider"></select>'
                + '</div>'
                + '<div class="yf-auth-row yf-auth-email-row">'
                + '<label class="yf-auth-label" for="' + uid + '-email">' + escHtml(labels.email_label) + '</label>'
                + '<input class="yf-auth-input yf-auth-email" id="' + uid + '-email" type="email" autocomplete="email" placeholder="'
                + escHtml(labels.email_ph) + '">'
                + '</div>'
                + '<div class="yf-auth-row yf-auth-actions">'
                + '<span class="yf-auth-label"></span>'
                + '<button class="yf-auth-btn yf-auth-primary yf-auth-start" type="button">' + escHtml(labels.start) + '</button>'
                + '<button class="yf-auth-btn yf-auth-cancel" type="button" style="display:none">' + escHtml(labels.cancel) + '</button>'
                + '</div>'
                + '<div class="yf-auth-result" style="display:none"></div>';
            host.appendChild(root);

            var sel = root.querySelector('.yf-auth-select');
            var emailRow = root.querySelector('.yf-auth-email-row');
            var emailInput = root.querySelector('.yf-auth-email');
            var startBtn = root.querySelector('.yf-auth-start');
            var cancelBtn = root.querySelector('.yf-auth-cancel');
            var result = root.querySelector('.yf-auth-result');

            function setResult(html) {
                result.innerHTML = html;
                result.style.display = 'block';
            }

            function setBusy(busy) {
                startBtn.disabled = busy;
                cancelBtn.style.display = busy ? '' : 'none';
            }

            function reset() {
                if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
                state.running = false;
                state.sessionId = '';
            }

            function toggleEmail() {
                emailRow.style.display = String(sel.value || '').toLowerCase() === 'email' ? '' : 'none';
            }

            function notifyError(msg) {
                if (typeof opt.onError !== 'function') { return; }
                try { opt.onError(new Error(String(msg || ''))); } catch (e) {}
            }

            function stopWith(msg) {
                reset();
                setBusy(false);
                setResult('<span class="yf-auth-err">' + escHtml(labels.stopped) + escHtml(msg || '') + '</span>');
            }

            function fail(msg) {
                stopWith(labels.err_prefix + (msg || ''));
                notifyError(msg);
            }

            function renderOptions(list, keep) {
                var wanted = String(keep || sel.value || '').toLowerCase();
                sel.innerHTML = '';
                for (var i = 0; i < list.length; i++) {
                    var value = String(list[i]);
                    var option = document.createElement('option');
                    option.value = value;
                    option.textContent = providerNames[value.toLowerCase()] || value;
                    sel.appendChild(option);
                }
                for (var j = 0; j < sel.options.length; j++) {
                    if (String(sel.options[j].value).toLowerCase() === wanted) { sel.selectedIndex = j; break; }
                }
            }

            function succeed(data) {
                var code = data && data.channelCode ? String(data.channelCode) : '';
                var provider = state.provider;
                var email = state.email;
                var sid = state.sessionId;
                var cfg = data && data.mcpConfig;
                var cfgText = '';
                if (cfg) {
                    try {
                        cfgText = typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2);
                    } catch (e) { cfgText = ''; }
                }
                reset();
                setBusy(false);
                setResult('<p>' + escHtml(labels.success) + '<span class="yf-auth-code">' + escHtml(code) + '</span></p>'
                    + (cfgText
                        ? '<p class="yf-auth-muted">' + escHtml(labels.config_label) + '</p>'
                          + '<div style="position:relative">'
                          + '<button class="yf-auth-copy" type="button">' + escHtml(labels.copy_cfg) + '</button>'
                          + '<pre class="yf-auth-pre">' + escHtml(cfgText) + '</pre>'
                          + '</div>'
                        : ''));
                var copyBtn = result.querySelector('.yf-auth-copy');
                var pre = result.querySelector('.yf-auth-pre');
                if (copyBtn && pre) {
                    copyBtn.onclick = function () {
                        copyText(cfgText).then(function () {
                            copyBtn.textContent = labels.copied;
                        });
                    };
                }
                if (typeof opt.onSuccess === 'function') {
                    try {
                        opt.onSuccess({
                            channelCode: code,
                            mcpConfig: cfg,
                            mcpConfigText: cfgText,
                            provider: provider,
                            email: email,
                            sessionId: sid,
                            raw: data
                        });
                    } catch (e) {}
                }
            }

            function pollLoop(intervalMs) {
                state.timer = setTimeout(function () {
                    if (!state.running || state.destroyed) { return; }
                    pollSession(state.sessionId).then(function (data) {
                        if (state.destroyed) { return; }
                        var status = data && data.status;
                        if (status === 'success') { succeed(data); return; }
                        if (status === 'expired' || status === 'consumed' || status === 'failed') {
                            var msg = data && data.message ? data.message : status;
                            stopWith(msg);
                            notifyError(msg);
                            return;
                        }
                        pollLoop((Number(data && data.pollInterval) || 5) * 1000);
                    })['catch'](function (err) {
                        fail(err && err.message ? err.message : String(err));
                    });
                }, intervalMs);
            }

            function start() {
                if (state.running || state.destroyed) { return; }
                var provider = String(sel.value || 'email').toLowerCase();
                var email = String(emailInput.value || '').replace(/^\s+|\s+$/g, '');
                if (provider === 'email' && email === '') {
                    setResult('<span class="yf-auth-err">' + escHtml(labels.email_required) + '</span>');
                    return;
                }
                reset();
                state.running = true;
                setBusy(true);
                setResult('<span class="yf-auth-muted">' + escHtml(labels.starting) + '</span>');
                createAuthSession(provider, { email: email }).then(function (data) {
                    if (state.destroyed) { return; }
                    var link = data && (data.authUrl || data.loginUrl);
                    if (!data || !data.sessionId || !link) {
                        fail('missing sessionId/authUrl');
                        return;
                    }
                    state.sessionId = data.sessionId;
                    state.provider = provider;
                    state.email = email;
                    var sec = Number(data.pollInterval) || 5;
                    var min = Math.max(1, Math.round((Number(data.expiresIn) || 600) / 60));
                    setResult('<div class="yf-auth-row yf-auth-actions"><span class="yf-auth-label"></span>'
                        + '<a class="yf-auth-link" href="' + escHtml(link) + '" target="_blank" rel="noopener">'
                        + escHtml(String(data.provider || '').toLowerCase() === 'email' ? labels.open_login : labels.open)
                        + '</a></div>'
                        + '<p class="yf-auth-muted">' + escHtml(formatText(labels.waiting, { sec: sec, min: min })) + '</p>');
                    /* 弹窗可能被拦截：链接已经渲染在结果区，拦了也能继续轮询 */
                    try { window.open(link, '_blank', 'noopener'); } catch (e) {}
                    pollLoop(sec * 1000);
                })['catch'](function (err) {
                    fail(err && err.message ? err.message : String(err));
                });
            }

            function cancel() {
                if (!state.running) { return; }
                stopWith(labels.canceled);
            }

            function destroy() {
                state.destroyed = true;
                reset();
                if (root.parentNode) { root.parentNode.removeChild(root); }
            }

            renderOptions(AUTH_FALLBACK_PROVIDERS, opt.provider || '');
            toggleEmail();
            startBtn.onclick = start;
            cancelBtn.onclick = cancel;
            sel.onchange = toggleEmail;
            /* 服务端新增登录方式时无需改宿主代码；拉取失败就维持静态兜底 */
            listProviders().then(function (list) {
                if (state.destroyed || !list || !list.length) { return; }
                renderOptions(list, sel.value);
                toggleEmail();
            })['catch'](function () {});

            return { el: root, destroy: destroy };
        }

        return {
            apiBase: apiBase,
            mcpUrl: mcpUrl,
            mcpSource: mcpSource,
            entryChannelCode: entryChannelCode,
            rpc: rpc,
            callTool: callTool,
            listTools: listTools,
            listProviders: listProviders,
            createAuthSession: createAuthSession,
            createEmailSession: createEmailSession,
            pollSession: pollSession,
            accessToken: accessToken,
            forgetToken: forgetToken,
            request: request,
            listChannels: listChannels,
            addChannel: addChannel,
            editChannel: editChannel,
            deleteChannel: deleteChannel,
            resetChannel: resetChannel,
            sendPushMessage: sendPushMessage,
            mountAuthCard: mountAuthCard,
            recordsUrl: recordsUrl,
            copyText: copyText
        };
    }

    var shared = create({});
    shared.create = create;
    return shared;
});
