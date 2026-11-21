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
 *
 * —— 样式隔离约定（放心集成到任何现有网站）——
 *   1) SDK 只注入一个 <style id="yf-auth-style">，所有选择器都带 .yf-auth / .yf-mgr /
 *      .yf-portal 前缀，不写 body / html / * / a / button 等全局标签，也不碰 :root，
 *      因此不会改动宿主站点已有的外观与功能；删除卡片时样式仍在但无匹配节点，无副作用。
 *   2) 你不需要引入任何 CSS 文件，官网那套 style.css 与本 SDK 无关，切勿一起引入。
 *
 * —— 定制能力（满足「只要方法」或「只换皮」两类高级用法）——
 *   A. 只使用方法、UI 全自定义：完全不要调 mountAuthCard，直接用 create() 返回的
 *      listChannels / addChannel / editChannel / deleteChannel / resetChannel /
 *      sendPushMessage / createAuthSession / pollSession 等方法自己渲染，SDK 此时不注入任何样式。
 *
 *   自动取码（访问统计推送管理页）：
 *     sdk.autoGetChannelCode({ referer: 'https://ce.phprm.com/teakong/' }).then(function (code) {});
 *   依次请求 getDataInfo -> MCP get_access_token -> channel/list，取回组合通道码并存 localStorage；
 *   任一步失败即 reject，业务方可引导用户自行开通。
 *   B. 用内置逻辑、换自己的皮：mountAuthCard 传 opt.injectStyle=false 关掉内置样式，
 *      再用 opt.className 给根节点加自定义 class，由你自己的 CSS 按 .yf-* 结构改写；
 *      opt.labels 可改全部文案，opt.title / opt.desc 改标题描述，opt.providers 改登录方式名。
 *   C. 回调：onSuccess(r) / onCodeChanged(code) / onError(err) 全部可选。
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

    /* 轻量 MD5（RFC 1321，纯 ES5，零依赖）；仅用于生成访问统计接口的 apiSign */
    var md5Hex = (function () {
        function safeAdd(x, y) {
            var lsw = (x & 0xffff) + (y & 0xffff);
            var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
            return (msw << 16) | (lsw & 0xffff);
        }
        function rotl(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
        function cmn(q, a, b, x, s, t) { return safeAdd(rotl(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
        function toHexWords(w) {
            var s = '';
            for (var i = 0; i < 4; i++) {
                var b = (w >>> (i * 8)) & 0xff;
                s += (b < 16 ? '0' : '') + b.toString(16);
            }
            return s;
        }
        function utf8Bytes(str) {
            var out = '';
            for (var i = 0; i < str.length; i++) {
                var c = str.charCodeAt(i);
                if (c < 0x80) { out += String.fromCharCode(c); }
                else if (c < 0x800) {
                    out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
                } else if (c < 0xd800 || c >= 0xe000) {
                    out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                } else {
                    i++;
                    var c2 = str.charCodeAt(i);
                    var cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
                    out += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                }
            }
            return out;
        }
        return function (input) {
            var s = utf8Bytes(String(input));
            var len = s.length;
            var words = (((len + 8) >> 6) + 1) * 16;
            var x = [];
            for (var i = 0; i < words; i++) { x[i] = 0; }
            for (i = 0; i < len; i++) { x[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8); }
            x[len >> 2] |= 0x80 << ((len % 4) * 8);
            var bits = len * 8;
            x[words - 2] = bits >>> 0;
            x[words - 1] = Math.floor(bits / 4294967296);
            var a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
            for (var j = 0; j < words; j += 16) {
                var oa = a, ob = b, oc = c, od = d;
                a = ff(a,b,c,d,x[j],7,0xd76aa478); d = ff(d,a,b,c,x[j+1],12,0xe8c7b756); c = ff(c,d,a,b,x[j+2],17,0x242070db); b = ff(b,c,d,a,x[j+3],22,0xc1bdceee);
                a = ff(a,b,c,d,x[j+4],7,0xf57c0faf); d = ff(d,a,b,c,x[j+5],12,0x4787c62a); c = ff(c,d,a,b,x[j+6],17,0xa8304613); b = ff(b,c,d,a,x[j+7],22,0xfd469501);
                a = ff(a,b,c,d,x[j+8],7,0x698098d8); d = ff(d,a,b,c,x[j+9],12,0x8b44f7af); c = ff(c,d,a,b,x[j+10],17,0xffff5bb1); b = ff(b,c,d,a,x[j+11],22,0x895cd7be);
                a = ff(a,b,c,d,x[j+12],7,0x6b901122); d = ff(d,a,b,c,x[j+13],12,0xfd987193); c = ff(c,d,a,b,x[j+14],17,0xa679438e); b = ff(b,c,d,a,x[j+15],22,0x49b40821);
                a = gg(a,b,c,d,x[j+1],5,0xf61e2562); d = gg(d,a,b,c,x[j+6],9,0xc040b340); c = gg(c,d,a,b,x[j+11],14,0x265e5a51); b = gg(b,c,d,a,x[j],20,0xe9b6c7aa);
                a = gg(a,b,c,d,x[j+5],5,0xd62f105d); d = gg(d,a,b,c,x[j+10],9,0x02441453); c = gg(c,d,a,b,x[j+15],14,0xd8a1e681); b = gg(b,c,d,a,x[j+4],20,0xe7d3fbc8);
                a = gg(a,b,c,d,x[j+9],5,0x21e1cde6); d = gg(d,a,b,c,x[j+14],9,0xc33707d6); c = gg(c,d,a,b,x[j+3],14,0xf4d50d87); b = gg(b,c,d,a,x[j+8],20,0x455a14ed);
                a = gg(a,b,c,d,x[j+13],5,0xa9e3e905); d = gg(d,a,b,c,x[j+2],9,0xfcefa3f8); c = gg(c,d,a,b,x[j+7],14,0x676f02d9); b = gg(b,c,d,a,x[j+12],20,0x8d2a4c8a);
                a = hh(a,b,c,d,x[j+5],4,0xfffa3942); d = hh(d,a,b,c,x[j+8],11,0x8771f681); c = hh(c,d,a,b,x[j+11],16,0x6d9d6122); b = hh(b,c,d,a,x[j+14],23,0xfde5380c);
                a = hh(a,b,c,d,x[j+1],4,0xa4beea44); d = hh(d,a,b,c,x[j+4],11,0x4bdecfa9); c = hh(c,d,a,b,x[j+7],16,0xf6bb4b60); b = hh(b,c,d,a,x[j+10],23,0xbebfbc70);
                a = hh(a,b,c,d,x[j+13],4,0x289b7ec6); d = hh(d,a,b,c,x[j],11,0xeaa127fa); c = hh(c,d,a,b,x[j+3],16,0xd4ef3085); b = hh(b,c,d,a,x[j+6],23,0x04881d05);
                a = hh(a,b,c,d,x[j+9],4,0xd9d4d039); d = hh(d,a,b,c,x[j+12],11,0xe6db99e5); c = hh(c,d,a,b,x[j+15],16,0x1fa27cf8); b = hh(b,c,d,a,x[j+2],23,0xc4ac5665);
                a = ii(a,b,c,d,x[j],6,0xf4292244); d = ii(d,a,b,c,x[j+7],10,0x432aff97); c = ii(c,d,a,b,x[j+14],15,0xab9423a7); b = ii(b,c,d,a,x[j+5],21,0xfc93a039);
                a = ii(a,b,c,d,x[j+12],6,0x655b59c3); d = ii(d,a,b,c,x[j+3],10,0x8f0ccc92); c = ii(c,d,a,b,x[j+10],15,0xffeff47d); b = ii(b,c,d,a,x[j+1],21,0x85845dd1);
                a = ii(a,b,c,d,x[j+8],6,0x6fa87e4f); d = ii(d,a,b,c,x[j+15],10,0xfe2ce6e0); c = ii(c,d,a,b,x[j+6],15,0xa3014314); b = ii(b,c,d,a,x[j+13],21,0x4e0811a1);
                a = ii(a,b,c,d,x[j+4],6,0xf7537e82); d = ii(d,a,b,c,x[j+11],10,0xbd3af235); c = ii(c,d,a,b,x[j+2],15,0x2ad7d2bb); b = ii(b,c,d,a,x[j+9],21,0xeb86d391);
                a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
            }
            return toHexWords(a) + toHexWords(b) + toHexWords(c) + toHexWords(d);
        };
    })();


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
        manage: '管理我的通道',
        config_label: '给你的 AI 客户端的配置（mcpConfig）：',
        copy_cfg: '复制配置',
        copied: '已复制',
        stopped: '已停止轮询：',
        err_prefix: '开通道失败：',
        canceled: '已取消本次授权',
        mgr_title: '通道管理',
        mgr_tip: '在这里增删子通道、改名、启停或重置，改动即时生效。',
        mgr_loading: '加载中…',
        mgr_empty: '还没有子通道，点右上角「新增通道」添加一个。',
        mgr_add: '新增通道',
        mgr_refresh: '刷新',
        mgr_name: '通道名称',
        mgr_type: '推送类型',
        mgr_webhook: '接收地址（Webhook）',
        mgr_secret: '加签密钥',
        mgr_tri: '高级参数（企业微信应用 / 自定义邮箱）',
        mgr_tri1: '企业ID 或 发信人昵称',
        mgr_tri2: '应用ID 或 邮箱地址',
        mgr_tri3: '应用Secret 或 授权码',
        mgr_status: '状态',
        mgr_on: '启用',
        mgr_off: '停用',
        mgr_code: '通道码',
        mgr_edit: '修改',
        mgr_del: '删除',
        mgr_copy: '复制',
        mgr_copied: '已复制完整通道码',
        mgr_reset: '重置',
        mgr_test: '测试',
        mgr_save: '保存',
        mgr_cancel: '取消',
        mgr_del_confirm: '确定删除这个通道？删除后不可恢复。',
        mgr_reset_confirm: '确定换一个新通道码？旧码会立即失效。',
        mgr_add_ok: '新增成功',
        mgr_saved: '已保存',
        mgr_deleted: '已删除',
        mgr_reset_done: '已换新码',
        mgr_test_sent: '测试消息已发送',
        mgr_err: '操作失败：',
        mgr_col_type: '推送类型',
        mgr_col_qr: '二维码',
        mgr_col_name: '通道名称',
        mgr_col_code: '通道码',
        mgr_col_time: '创建时间',
        mgr_col_op: '操作',
        mgr_parent: '父通道',
        mgr_current: '当前',
        mgr_off: '已停用',
        mgr_unnamed: '未命名通道',
        mgr_qr_click: '点击放大',
        mgr_qr_scan: '使用手机扫码访问：',
        mgr_records: '推送记录',
        mgr_records_loading: '推送记录组件加载中，请稍候…',
        mgr_records_fail: '打开推送记录失败，请刷新页面重试',
        mgr_add_title: '新增推送通道',
        mgr_edit_title: '修改推送通道',
        mgr_create: '创建',
        mgr_name_req: '请填写通道名称',
        mgr_webhook_req: '该推送类型必须填写接收地址',
        mgr_webhook_bad: '接收地址必须是合法的 http/https 地址',
        mgr_tg_token: 'Telegram 通道必须填写 Bot Token',
        mgr_tg_chat: 'Telegram 通道必须填写 Chat ID',
        mgr_dc_webhook: 'Discord 通道必须填写 Webhook 地址',
        mgr_dc_bad: 'Discord Webhook 必须是合法的 http/https 地址',
        mgr_target: '目标通道',
        mgr_test_title: '测试推送',
        mgr_test_head: '标题',
        mgr_test_body: '正文',
        mgr_test_url: '跳转网址',
        mgr_test_avatar: '图标网址',
        mgr_test_send: '发送测试',
        mgr_sending: '发送中…',
        mgr_head_req: '请填写标题',
        mgr_url_bad: '跳转网址必须是合法的 http/https 地址',
        mgr_avatar_bad: '图标网址必须是合法的 http/https 地址',
        mgr_test_ok: '推送成功，可到官网查看推送日志',
        mgr_test_ok_browser: '推送成功',
        mgr_test_preview: '请求预览',
        mgr_confirm_title: '提示',
        mgr_confirm_reset: '确认重置',
        mgr_confirm_del: '确认删除',
        mgr_reset_full: '确认重置该通道的通道码？重置后旧通道码将失效。',
        mgr_del_full: '确认删除这个通道吗？删除后该通道的推送立即失效。',
        mgr_add_done: '通道已创建',
        mgr_reset_ok: '通道码已重置',
        mgr_close: '关闭'
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
        '.yf-auth-input{flex:1 1 auto;width:100%;min-width:0;max-width:520px;padding:7px 11px;border:1px solid #e0e4ea;border-radius:6px;background:#fff;color:#333;font-size:15px;line-height:18px;}',
        '.yf-auth-input:focus{outline:none;border-color:#0ea5e9;box-shadow:0 0 0 3px rgba(78,179,137,.15);}',
        '.yf-auth-actions{align-items:center;}',
        '.yf-auth-btn{display:inline-block;height:32px;padding:0 16px;border-radius:4px;font-size:14px;line-height:30px;text-align:center;cursor:pointer;font-family:inherit;}',
        '.yf-auth-primary{background:#0ea5e9;border:1px solid #0ea5e9;color:#fff;}',
        '.yf-auth-primary:hover:not(:disabled){background:#0284c7;border-color:#0284c7;}',
        '.yf-auth-primary:disabled{opacity:.6;cursor:default;}',
        '.yf-auth-cancel{background:#fff;border:1px solid #d9dde3;color:#666;}',
        '.yf-auth-cancel:hover{background:#f6f7f9;}',
        '.yf-auth-btn+.yf-auth-btn{margin-left:8px;}',
        '.yf-auth-link{display:inline-block;height:32px;padding:0 16px;background:#0ea5e9;border-radius:4px;color:#fff;font-size:14px;line-height:32px;text-decoration:none;}',
        '.yf-auth-link:hover{background:#0284c7;color:#fff;}',
        '.yf-auth-result{margin-top:4px;font-size:14px;line-height:1.8;color:#444;}',
        '.yf-auth-result p{margin:0 0 8px;}',
        '.yf-auth-muted{font-size:13px;color:#999;}',
        '.yf-auth-err{color:#dc2626;}',
        '.yf-auth-code{font-family:Consolas,Monaco,"Courier New",monospace;word-break:break-all;}',
        '.yf-auth-pre{margin:0;padding:10px 12px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:4px;color:#212529;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;}',
        '.yf-auth-copy{position:absolute;top:6px;right:6px;height:26px;padding:0 10px;background:#fff;border:1px solid #dee2e6;border-radius:4px;color:#555;font-size:12px;line-height:24px;cursor:pointer;font-family:inherit;}',
        '.yf-auth-copy:hover{background:#f2f3f5;}',
        '.yf-mgr{margin-top:14px;border-top:1px solid #eef1f5;padding-top:12px;}',
        '.yf-mgr-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}',
        '.yf-mgr-head h4{margin:0;font-size:15px;font-weight:600;color:#222;flex:1 1 auto;}',
        '.yf-mgr-tip{margin:0 0 10px;font-size:12px;color:#999;line-height:1.6;}',
        '.yf-mgr-mini{height:28px;padding:0 10px;border:1px solid #d9dde3;border-radius:4px;background:#fff;color:#555;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-family:inherit;}',
        '.yf-mgr-mini-primary{background:#0ea5e9;border-color:#0ea5e9;color:#fff;}',
        '.yf-mgr-mini-primary:hover{background:#0284c7;border-color:#0284c7;}',
        '.yf-mgr-mini:disabled{opacity:.6;cursor:default;}',
        '.yf-mgr-list{margin-top:8px;border:1px solid #e6eaef;border-radius:6px;overflow:hidden;}',
        '.yf-mgr-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #eef1f5;font-size:13px;flex-wrap:wrap;}',
        '.yf-mgr-row:last-child{border-bottom:none;}',
        '.yf-mgr-name{font-weight:500;color:#333;min-width:0;word-break:break-all;}',
        '.yf-mgr-tag{padding:1px 7px;border-radius:10px;background:#f0f3f6;color:#6b7684;font-size:11px;white-space:nowrap;}',
        '.yf-mgr-tag-off{background:#fdecec;color:#c0392b;}',
        '.yf-mgr-code{font-family:Consolas,Monaco,monospace;color:#888;font-size:11px;flex:1 1 auto;min-width:80px;word-break:break-all;}',
        '.yf-mgr-ops{display:flex;gap:6px;flex-wrap:wrap;}',
        '.yf-mgr-ops a{color:#0ea5e9;text-decoration:none;cursor:pointer;font-size:12px;}',
        '.yf-mgr-ops a.mgr-danger{color:#dc2626;}',
        '.yf-mgr-ops a:hover{text-decoration:underline;}',
        '.yf-mgr-form{margin-top:10px;padding:12px;border:1px solid #e6eaef;border-radius:6px;background:#fafbfc;}',
        '.yf-mgr-form .yf-auth-row{margin-bottom:8px;}',
        '.yf-mgr-form .yf-auth-label{flex-basis:110px;width:110px;font-size:13px;line-height:32px;}',
        '.yf-mgr-form .yf-auth-input{height:32px;font-size:13px;line-height:18px;}',
        '.yf-mgr-form textarea.yf-auth-input{height:auto;min-height:60px;resize:vertical;}',
        '.yf-mgr-msg{margin:6px 0;font-size:12px;color:#0ea5e9;}',
        '.yf-mgr-msg-err{color:#dc2626;}',
        '.yf-mgr-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;}',
        '.yf-mgr-table th,.yf-mgr-table td{padding:7px 6px;border-bottom:1px solid #eef1f5;text-align:left;vertical-align:middle;}',
        '.yf-mgr-table th{color:#8a95a3;font-weight:500;background:#fafbfc;}',
        '.yf-mgr-table tr:last-child td{border-bottom:none;}',
        '.yf-mgr-table .c-type{width:74px;}.yf-mgr-table .c-qr{width:48px;}.yf-mgr-table .c-code{width:110px;}.yf-mgr-table .c-time{width:92px;}.yf-mgr-table .c-op{width:150px;}',
        '.yf-mgr-table.chan th.col-name,.yf-mgr-table.chan td.col-name{width:150px;min-width:0;text-align:center;white-space:normal;word-break:break-all;}',
        '.yf-mgr-qr{width:36px;height:36px;border:1px solid #e6eaef;border-radius:3px;cursor:zoom-in;}',
        '.yf-mgr-badge{display:inline-block;margin:2px 3px 0 0;padding:1px 6px;border-radius:10px;background:#eef7f2;color:#0284c7;font-size:11px;}',
        '.yf-mgr-badge-off{background:#fdecec;color:#c0392b;}',
        '.yf-mgr-rec-link{color:#0366d6;cursor:pointer;font-size:12px;}',
        '.yf-mgr-mini-link{display:inline-block;margin:1px 4px 1px 0;padding:0;border:0;background:none;color:#0ea5e9;font-size:12px;cursor:pointer;font-family:inherit;}',
        '.yf-mgr-mini-link.danger{color:#dc2626;}',
        '.yf-mgr-mini-link.info{color:#0366d6;}',
        '.yf-mgr-mask{position:fixed;inset:0;background:rgba(20,28,40,.45);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;}',
        '.yf-mgr-dlg{width:100%;max-width:480px;max-height:90vh;overflow:auto;background:#fff;border-radius:10px;padding:18px 20px;font-size:14px;box-shadow:0 8px 30px rgba(0,0,0,.15);}',
        '.yf-mgr-dlg h4{margin:0 0 6px;font-size:16px;color:#222;}',
        '.yf-mgr-dlg .yf-mgr-confirm-msg{margin:6px 0 10px;font-size:18px;line-height:1.6;color:#1a1a2e;font-weight:500;}',
        '.yf-mgr-dlg .yf-mgr-dlg-target{margin:0 0 12px;font-size:12px;color:#888;}',
        '.yf-mgr-dlg .yf-auth-input:disabled{background:#f4f6f8;color:#999;}',
        '.yf-mgr-url{display:block;margin:6px 0;padding:8px;background:#f8f9fa;border:1px solid #e6eaef;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:11px;color:#555;word-break:break-all;max-height:80px;overflow:auto;}',
        '.yf-mgr-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:100000;padding:10px 18px;border-radius:6px;background:rgba(35,45,55,.94);color:#fff;font-size:13px;max-width:80vw;text-align:center;}',
        '.yf-mgr-toast.err{background:#c0392b;}',
        '.yf-mgr-qr-big{display:block;margin:10px auto;}',
        '@media (max-width:560px){.yf-auth-row{display:block;}.yf-auth-label{display:block;width:auto;line-height:1.6;margin:0 0 4px;}.yf-auth-input{width:100%;max-width:none;}.yf-auth-actions .yf-auth-label{display:none;}.yf-mgr-form .yf-auth-label{flex-basis:auto;width:auto;}}',
        /* ===== 以下整段来自 push-server-frontend/assets/style.css 原文，仅加 .yf-portal 作用域前缀（防止污染宿主页面），值一律未改 ===== */
        '.yf-portal{--bg:#f6f8fa;--bg-elevated:#ffffff;--bg-overlay:#f3f4f6;--line:#e1e4e8;--line-subtle:#f0f1f3;--text:#1a1a2e;--text-primary:#111827;--muted:#6b7280;--brand:#0ea5e9;--brand-dark:#0284c7;--brand-bg:rgba(14,165,233,0.08);--teal:#14b8a6;--ok:#059669;--warn:#d97706;--err:#dc2626;--link:#0366d6;--radius:6px;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-align:left;}',
        '.yf-portal,.yf-portal *{box-sizing:border-box;}',
        '.yf-portal a{color:var(--link);text-decoration:none;}.yf-portal a:hover{text-decoration:underline;opacity:0.9;}',
        '.yf-portal .mono{font-family:"JetBrains Mono","Fira Code","SFMono-Regular",Consolas,Menlo,"Courier New",monospace;font-size:15px;}',
        '.yf-portal .muted{color:var(--muted);font-size:15px;}',
        '.yf-portal .small{font-size:14px;}',
        '.yf-portal .err{color:var(--err);}',
        '.yf-portal .card{background:var(--bg-elevated);border:1px solid var(--line);border-radius:var(--radius);padding:22px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,0.04);}',
        '.yf-portal .card h2{font-size:18px;margin:0 0 16px;font-weight:600;color:var(--text-primary);letter-spacing:-0.3px;}',
        '.yf-portal .card h2 .hint{font-size:15px;color:var(--muted);font-weight:400;margin-left:8px;}',
        '.yf-portal .card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:16px;}',
        '.yf-portal .card-head h2{margin:0;}',
        '.yf-portal .card-head-btns{display:flex;gap:8px;}',
        '.yf-portal .placeholder{text-align:center;padding:34px 12px;color:var(--muted);}',
        '.yf-portal .demo-channel .qr{width:92px;height:92px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;}',
        '.yf-portal .demo-channel-info .row1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.yf-portal .demo-channel-info .row1 a{font-weight:600;font-size:17px;color:var(--text-primary);}',
        '.yf-portal .tag{display:inline-block;font-size:13px;padding:3px 9px;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--muted);font-weight:500;}',
        '.yf-portal .tag.on{border-color:var(--ok);color:var(--ok);background:rgba(5,150,105,0.06);}',
        '.yf-portal .demo-channel-info .mono{margin:4px 0;color:var(--brand);font-weight:600;font-size:14px;}',
        '.yf-portal .demo-channel-info .links{display:flex;gap:16px;flex-wrap:wrap;align-items:baseline;}',
        '.yf-portal .push-form{border-top:1px solid var(--line-subtle);padding-top:16px;}',
        '.yf-portal .form-row{display:flex;align-items:flex-start;gap:14px;margin-bottom:14px;flex-wrap:wrap;}',
        '.yf-portal .form-row label{width:76px;flex:none;padding-top:8px;color:var(--muted);font-size:15px;font-weight:500;}',
        '.yf-portal .form-row input[type="text"],.yf-portal .form-row input[type="email"],.yf-portal .form-row textarea,.yf-portal .form-row select{flex:1;min-width:240px;border:1px solid var(--line);border-radius:var(--radius);padding:8px 11px;font:inherit;color:var(--text);background:var(--bg-elevated);font-size:15px;transition:border-color 0.15s;}',
        '.yf-portal .form-row input:focus,.yf-portal .form-row textarea:focus,.yf-portal .form-row select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-bg);}',
        '.yf-portal .form-row.actions{margin-top:18px;}',
        '.yf-portal .form-row.actions label{display:none;}',
        '.yf-portal .btn{border:1px solid var(--line);border-radius:var(--radius);cursor:pointer;padding:6px 15px;font-size:15px;font-family:inherit;line-height:1.5;background:var(--bg-elevated);color:var(--text);font-weight:500;transition:all 0.15s;}',
        '.yf-portal .btn:disabled{opacity:.4;cursor:not-allowed;}',
        '.yf-portal .btn-primary{background:var(--brand);color:#fff;border-color:var(--brand);font-weight:600;}',
        '.yf-portal .btn-primary:hover:not(:disabled){background:var(--brand-dark);border-color:var(--brand-dark);}',
        '.yf-portal .btn-danger{background:var(--err);color:#fff;border-color:var(--err);font-weight:600;}',
        '.yf-portal .btn-danger:hover:not(:disabled){background:#b91c1c;border-color:#b91c1c;}',
        '.yf-portal .btn-ghost{border-color:var(--line);color:var(--muted);background:transparent;}',
        '.yf-portal .btn-ghost:hover:not(:disabled){border-color:var(--brand);color:var(--brand);background:var(--brand-bg);}',
        '.yf-portal .btn-o-red{border-color:var(--err);color:var(--err);background:transparent;font-size:14px;}',
        '.yf-portal .btn-o-red:hover{background:rgba(220,38,38,0.06);}',
        '.yf-portal .btn-o-green{border-color:var(--ok);color:var(--ok);background:transparent;font-size:14px;}',
        '.yf-portal .btn-o-green:hover{background:rgba(5,150,105,0.06);}',
        '.yf-portal .btn-o-blue{border-color:var(--brand);color:var(--brand);background:transparent;font-size:14px;}',
        '.yf-portal .btn-o-blue:hover{background:var(--brand-bg);}',
        '.yf-portal .btn-sm{padding:4px 11px;font-size:14px;border-radius:4px;}',
        '.yf-portal .btn-chat{margin-left:6px;vertical-align:middle;font-size:12px;}',
        '.yf-portal .table-wrap{overflow-x:auto;}',
        '.yf-portal table.chan{width:100%;border-collapse:collapse;font-size:15px;}',
        '.yf-portal table.chan th,.yf-portal table.chan td{border-bottom:1px solid var(--line-subtle);padding:12px 14px;text-align:center;vertical-align:middle;white-space:nowrap;}',
        '.yf-portal table.chan th{color:var(--muted);font-weight:500;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;}',
        '.yf-portal table.chan tr:last-child td{border-bottom:none;}',
        '.yf-portal table.chan tr:hover td{background:var(--bg-overlay);}',
        '.yf-portal table.chan .col-type{width:140px;}',
        '.yf-portal table.chan .col-qr{width:150px;}',
        '.yf-portal table.chan .col-name{text-align:center;min-width:0;width:150px;}',
        '.yf-portal table.chan .col-code{width:160px;}',
        '.yf-portal table.chan .col-time{width:170px;}',
        '.yf-portal table.chan .col-op{width:280px;}',
        '.yf-portal .ops-row{display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;}',
        '.yf-portal table.chan .idx{min-width:26px;max-width:100%;height:26px;padding:0 8px;border-radius:999px;background:var(--brand-bg);color:var(--brand);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.yf-portal table.chan .idx-type{background:var(--bg-overlay);color:var(--muted);}',
        '.yf-portal table.chan .idx-parent{background:rgba(20,184,166,0.12);color:var(--teal);}',
        '.yf-portal table.chan img.qr{width:64px;height:64px;border-radius:var(--radius);border:1px solid var(--line);background:var(--bg);cursor:zoom-in;}',
        '.yf-portal table.chan img.qr:hover{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-bg);}',
        '.yf-portal table.chan .nickname{display:inline-block;min-width:60px;cursor:pointer;padding:2px 8px;border-radius:4px;border:1px dashed transparent;font-size:15px;}',
        '.yf-portal table.chan .nickname:hover{background:var(--brand-bg);border-color:var(--brand);}',
        '.yf-portal .qr-modal{width:auto;min-width:420px;padding:30px;text-align:center;position:relative;}',
        '.yf-portal .qr-modal h3{text-align:center;word-break:break-all;padding-right:24px;color:var(--text-primary);}',
        '.yf-portal .qr-big-wrap{display:flex;justify-content:center;padding:6px 0 10px;}',
        '.yf-portal .qr-big{width:320px;height:320px;max-width:100%;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);}',
        '.yf-portal .modal-close{position:absolute;top:10px;right:12px;width:28px;height:28px;line-height:26px;border:none;background:transparent;color:var(--muted);font-size:20px;cursor:pointer;border-radius:4px;padding:0;transition:all 0.15s;}',
        '.yf-portal .modal-close:hover{background:var(--line);color:var(--text);}',
        '.yf-portal .test-modal{width:680px;padding:0;overflow:hidden;}',
        '.yf-portal .modal-head-blue{color:var(--brand);display:flex;align-items:center;padding:14px 16px 0;background:none;}',
        '.yf-portal .modal-head-blue span{font-size:17px;font-weight:600;word-break:break-all;}',
        '.yf-portal .modal-body-pad{padding:22px 0 0 0;}',
        '.yf-portal .trow{display:flex;align-items:center;margin-bottom:14px;gap:14px;padding:4px 10px;}',
        '.yf-portal .trow .tkey{width:58px;flex:none;color:var(--muted);font-size:15px;text-align:right;font-family:"JetBrains Mono","Fira Code",Consolas,Menlo,monospace;}',
        '.yf-portal .trow input[type="text"]{flex:1;border:1px solid var(--line);border-radius:var(--radius);padding:8px 11px;font:inherit;color:var(--text);background:var(--bg-elevated);font-size:15px;transition:border-color 0.15s;}',
        '.yf-portal .trow input[type="text"]:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-bg);}',
        '.yf-portal .trow .tval{flex:1;min-width:0;font-size:15px;}',
        '.yf-portal .api-url{word-break:break-all;color:var(--link);background:var(--bg-overlay);border:1px dashed var(--line);border-radius:var(--radius);padding:8px 11px;margin-top:6px;font-size:14px;}',
        '.yf-portal .trow.actions .tval{display:flex;gap:10px;}',
        '.yf-portal .btn-cancel{background:var(--bg-overlay);color:var(--muted);border-color:var(--line);}',
        '.yf-portal .btn-cancel:hover:not(:disabled){background:var(--line);color:var(--text);}',
        '.yf-portal table.chan .name{font-weight:600;color:var(--text-primary);cursor:pointer;}',
        '.yf-portal table.chan .name:hover{color:var(--link);text-decoration:underline;}',
        '.yf-portal table.chan .code{font-family:"JetBrains Mono","Fira Code",Consolas,Menlo,monospace;font-size:14px;color:var(--muted);}',
        '.yf-portal .badge-cur{background:var(--brand-bg);color:var(--brand);font-size:12px;border-radius:999px;padding:1px 8px;margin-left:6px;font-weight:600;}',
        '.yf-portal .badge-off{background:rgba(217,119,6,0.08);color:var(--warn);font-size:12px;border-radius:999px;padding:1px 8px;margin-left:6px;font-weight:600;}',
        '.yf-portal .empty-row{text-align:center;color:var(--muted);padding:26px 0 !important;}',
        '.yf-portal .load-tip{color:var(--muted);text-align:center;padding:22px 0;}',
        '.yf-portal .modal-mask{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:flex-start;justify-content:center;padding:90px 16px 16px;z-index:100;backdrop-filter:blur(4px);}',
        '.yf-portal .modal{background:var(--bg-elevated);border-radius:8px;padding:64px 106px;width:680px;max-width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.12);position:relative;border:1px solid var(--line);}',
        '.yf-portal .modal h3{margin:0 0 10px;font-size:17px;font-weight:600;padding-right:24px;color:var(--text-primary);}',
        '.yf-portal .modal p{margin:6px 0;}',
        '.yf-portal .modal .form-row label{width:76px;}',
        '.yf-portal .modal input[type="text"],.yf-portal .modal select{width:100%;border:1px solid var(--line);border-radius:var(--radius);padding:9px 11px;font:inherit;background:var(--bg-elevated);color:var(--text);font-size:15px;transition:border-color 0.15s;}',
        '.yf-portal .modal input:focus,.yf-portal .modal select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-bg);}',
        '.yf-portal .modal-btns{display:flex;gap:8px;margin-top:18px;align-items:center;}',
        '.yf-portal .toast{background:var(--bg-elevated);color:var(--text-primary);border-radius:var(--radius);padding:11px 16px;font-size:15px;max-width:380px;box-shadow:0 4px 20px rgba(0,0,0,0.08);word-break:break-all;border:1px solid var(--line);}',
        '.yf-portal .toast.ok{background:var(--ok);color:#fff;border-color:var(--ok);font-weight:500;}',
        '.yf-portal .toast.err{background:var(--err);color:#fff;border-color:var(--err);font-weight:500;}',
        /* 弹窗表单行高对齐官网：控件用 1.55 行高由 padding 自然撑高，label 去掉旧授权卡片的 34px 行高 */
        '.yf-portal .yf-auth-input{line-height:1.55;}',
        '.yf-portal .form-row label,.yf-portal .yf-auth-label{line-height:1.55;}',
        '@media (max-width:760px){.yf-portal .modal{width:auto;padding:30px 22px;}.yf-portal .qr-modal{min-width:0;}.yf-portal .qr-big{width:260px;height:260px;}}',
        '@media (max-width:640px){.yf-portal .form-row label{width:100%;padding-top:0;}}'
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

        /**
         * 访问统计「推送管理页」自动取组合通道码（新用户首次进入时调用一次即可）
         *
         * 场景：业务站给每个注册用户分配了二级目录名称空间（如 https://ce.phprm.com/teakong/），
         * 且已接入一封传话访问统计；访问统计会为该目录自动建好一个组合通道，
         * 本方法把它的通道码自动取回来并存入 localStorage，免去用户手动开通 / 填码。
         *
         * 链路（任一步失败即放弃，不做补偿，业务方可引导用户自己去开通）：
         *   1) GET /push/h5/app/api/getDataInfo?type=checkUrlChannelCode&appKey=pushBookmark&referer=<名称空间>&title=...&_t=...
         *      -> data.channelCode（子通道码，仅用于换令牌）
         *   2) MCP get_access_token（复用 accessToken）
         *   3) GET /oauth2/push/channel/list（复用 listChannels）
         *      -> data.channelCode（组合通道码，最终要存的）
         *   4) 存 localStorage + onSuccess 回调 + resolve 组合通道码
         *
         * @param {Object} options
         *   - referer {string} 必填，业务用户名称空间（如 https://ce.phprm.com/teakong/），作为 getDataInfo 的 referer 参数
         *   - title {string} 可选，getDataInfo 的 title 参数
         *   - timestamp {string|number} 可选，_t 与 apitimestamp，默认当前时间戳
         *   - apiKey {string} 可选，签名密钥，默认 amvk2ag1hwfswq
         *   - nonce {string} 可选，apinonce，默认 md5(Math.random())
         *   - headers {Object} 可选，覆盖/追加 getDataInfo 请求头（签名头自动生成，可被覆盖）
         *   - dataApi {string} 可选，getDataInfo 接口地址，默认 apiBase + /push/h5/app/api/getDataInfo
         *   - storageKey {string} 可选，localStorage key，默认 phprm_channel_code
         *   - skipStorage {boolean} 可选，true = 只返回码不写 localStorage
         *   - onSuccess {Function} 可选，成功回调 (comboCode, detail)=>{}
         *   - onError {Function} 可选，失败回调 (err)=>{}
         * @returns {Promise<string>} resolve 组合通道码；任一步失败 reject
         */
        function autoGetChannelCode(options) {
            options = options || {};
            var onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : null;
            var onError = typeof options.onError === 'function' ? options.onError : null;

            return P.resolve().then(function () {
                var referer = String(options.referer || '').replace(/^\s+|\s+$/g, '');
                if (referer === '') {
                    throw new Error('autoGetChannelCode 缺少 referer（业务用户名称空间，如 https://ce.phprm.com/teakong/）');
                }
                var dataApi = String(options.dataApi || (apiBase + '/push/h5/app/api/getDataInfo'));
                var title = options.title != null ? String(options.title) : '你的性格与哪座城市最匹配 - 测什么';
                // 访问统计接口签名：nonce = md5(random)，sign = md5(ts#apiKey#nonce)
                // （算法见 push-front 的 email_login.html / config.js，已用抓包值反推验证）
                var apiKey = String(options.apiKey || 'amvk2ag1hwfswq');
                var timestamp = options.timestamp != null ? String(options.timestamp) : String(Date.now());
                var apiNonce = options.nonce != null ? String(options.nonce) : md5Hex(String(Math.random()));
                var apiSign = md5Hex(timestamp + '#' + apiKey + '#' + apiNonce);
                var storageKey = String(options.storageKey || 'phprm_channel_code');
                var skipStorage = !!options.skipStorage;

                var query = encodeParams({
                    type: 'checkUrlChannelCode',
                    appKey: 'pushFront',
                    referer: referer,
                    title: title,
                    _t: timestamp
                });
                var headers = {
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'apinonce': apiNonce,
                    'apisign': apiSign,
                    'apitimestamp': timestamp
                };
                if (options.headers) {
                    for (var hk in options.headers) {
                        if (Object.prototype.hasOwnProperty.call(options.headers, hk)) {
                            headers[hk] = options.headers[hk];
                        }
                    }
                }

                // 第一步：getDataInfo 拿子通道码
                return http(dataApi + (dataApi.indexOf('?') >= 0 ? '&' : '?') + query, {
                    method: 'GET', headers: headers
                }).then(function (resp) {
                    if (!resp.ok) { throw new Error('查询通道码失败（HTTP ' + resp.status + '）'); }
                    return resp.text();
                }).then(function (text) {
                    var json = parseJsonSafe(text);
                    if (Number(json.code) !== 0) {
                        throw new Error(json.message || ('查询通道码失败（code=' + json.code + '）'));
                    }
                    var childCode = json && json.data && json.data.channelCode;
                    if (!isChannelCode(childCode)) {
                        throw new Error('该名称空间尚未开通访问统计通道（referer=' + referer + '）');
                    }
                    return String(childCode).toLowerCase();
                }).then(function (childCode) {
                    // 第二、三步：子通道码换令牌 + 拉列表，顶层 channelCode 即组合通道码
                    return listChannels(childCode).then(function (list) {
                        var comboCode = list && list.channelCode;
                        if (!isChannelCode(comboCode)) {
                            throw new Error('通道列表未返回合法组合通道码');
                        }
                        return { comboCode: String(comboCode).toLowerCase(), childCode: childCode, list: list };
                    });
                }).then(function (detail) {
                    // 第四步：存 localStorage（存储失败不影响返回）+ 回调
                    if (!skipStorage && storageKey) {
                        try {
                            if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
                                localStorage.setItem(storageKey, detail.comboCode);
                            }
                        } catch (e) {}
                    }
                    if (onSuccess) {
                        try { onSuccess(detail.comboCode, detail); } catch (e2) {}
                    }
                    return detail.comboCode;
                });
            })['catch'](function (err) {
                if (onError) {
                    try { onError(err); } catch (e) {}
                }
                throw err;
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
         *          manage?:boolean, onSuccess?:function, onError?:function}} [opt] manage=false 关闭成功态内嵌的通道管理面板
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

            /* 管理面板常量必须在使用前赋值：下面 opt.code 分支会直接 return 并调到 mountManage→openForm，
               若把这些 var 赋值留在分支之后，var 提升只会得到 undefined（openForm 读 MGR_TYPES.length 报错）。
               因此统一放这里，保证两条路径（有码直入 / 授权后进）都能拿到值。 */
            /* 推送类型：新增表单下拉用，排除组合类型（10） */
            var MGR_TYPES = [
                [1, '浏览器'], [6, '企业微信群机器人'], [7, '钉钉群机器人'], [8, '飞书群机器人'],
                [9, '企业微信应用'], [11, 'webhook推送'], [16, 'BARK（iOS）'], [29, 'Telegram'],
                [30, 'Discord'], [50, '官方邮件'], [51, 'QQ邮箱'], [52, '163邮箱'], [53, '126邮箱'],
                [54, '搜狐邮箱'], [55, '139邮箱'], [56, '189邮箱'], [57, '新浪邮箱'], [58, '阿里云邮箱']
            ];
            var MGR_NEED_WEBHOOK = { 6: 1, 7: 1, 8: 1, 11: 1, 16: 1 };
            var MGR_NEED_SECRET = { 6: 1, 7: 1, 8: 1 };
            var MGR_NEED_CORP = { 9: 1, 29: 1, 30: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };
            var MGR_NEED_AGENT = { 9: 1, 29: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };
            var MGR_NEED_CORP_SECRET = { 9: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };
            var MGR_WEBHOOK_LABEL = { 6: '企业微信机器人地址', 7: '钉钉机器人地址', 8: '飞书机器人地址', 11: '接收地址', 16: '推送地址' };
            var MGR_WEBHOOK_PH = {
                6: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
                7: 'https://oapi.dingtalk.com/robot/',
                8: 'https://open.feishu.cn/open-apis/bot/v2',
                16: 'https://api.day.app/'
            };
            var MGR_TRI_LABEL = {
                9: ['企业ID', '应用ID', '应用Secret'],
                29: ['Bot Token', 'Chat ID', ''],
                30: ['Webhook 地址', '', ''],
                mail: ['发信人昵称', '邮箱地址', '授权码']
            };
            var MGR_TRI_PH = {
                9: ['ww1234567890abcdef', '1000002', '应用 Secret'],
                29: ['123456789:AAHxxxxxxxx', '-1001234567890', ''],
                30: ['https://discord.com/api/webhooks/xxx/xxx', '', ''],
                mail: ['如：线报提醒', 'name@qq.com', '邮箱授权码']
            };

            if (opt.injectStyle !== false) { injectAuthStyle(); }
            host.innerHTML = '';

            /* 已有通道码：跳过授权卡，直接在容器里挂完整管理面板（宿主站点记住了码，下次进来直接管理）。
               仍支持 onCodeChanged 回写新码；返回同样的 {el,destroy} 句柄，宿主无需区分两条路径。 */
            if (opt.code && isChannelCode(opt.code)) {
                var manageEl = mountManage(String(opt.code).toLowerCase(), host,
                    typeof opt.onCodeChanged === 'function' ? opt.onCodeChanged : null);
                return {
                    el: manageEl,
                    destroy: function () { if (manageEl && manageEl.parentNode) { manageEl.parentNode.removeChild(manageEl); } }
                };
            }

            var root = document.createElement('div');
            root.className = 'yf-auth' + (opt.className ? ' ' + opt.className : '');
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

            function maskCode(c) {
                c = String(c || '');
                return c.length > 10 ? c.slice(0, 4) + '…' + c.slice(-4) : c;
            }

            /**
             * 在容器内挂一个完整的通道管理面板（列表 / 二维码 / 推送记录 / 新增 / 修改 / 换码 / 删除 / 测试）。
             * 所有 UI 由 SDK 自建、样式内联注入，宿主页面零依赖；数据走 SDK 自带的管理 API。
             * @param {string} code 授权拿到的通道码
             * @param {Element} host 挂载容器
             * @param {function} [onCodeChanged] 当前通道换码后的回调，宿主可用它回写自己的账号（如 bindCode）
             */
            function mountManage(code, host, onCodeChanged) {
                var wrap = document.createElement('div');
                wrap.className = 'yf-mgr yf-portal';
                wrap.innerHTML = '<div class="card-head">'
                    + '<h2>' + escHtml(labels.mgr_title) + '<span class="hint"></span></h2>'
                    + '<span class="card-head-btns">'
                    + '<button class="yf-mgr-mini btn btn-sm btn-ghost" type="button" data-act="refresh">' + escHtml(labels.mgr_refresh) + '</button>'
                    + '<button class="yf-mgr-mini yf-mgr-mini-primary btn btn-sm btn-primary" type="button" data-act="add">' + escHtml(labels.mgr_add) + '</button></span></div>'
                    + '<p class="yf-mgr-tip muted small">' + escHtml(labels.mgr_tip) + '</p>'
                    + '<div class="yf-mgr-msg err small" style="display:none"></div>'
                    + '<div class="yf-mgr-list"><div class="yf-mgr-row load-tip">' + escHtml(labels.mgr_loading) + '</div></div>';
                host.appendChild(wrap);

                var listEl = wrap.querySelector('.yf-mgr-list');
                var msgEl = wrap.querySelector('.yf-mgr-msg');
                var state = { code: String(code || '').toLowerCase(), rows: [], parent: null };
                var dialogLayer = null;

                function toast(text, isErr) {
                    var t = document.createElement('div');
                    t.className = 'yf-mgr-toast' + (isErr ? ' err' : '');
                    t.textContent = text || '';
                    (document.body || document.documentElement).appendChild(t);
                    setTimeout(function () { if (t.parentNode) { t.parentNode.removeChild(t); } }, 3200);
                }
                function msg(text, isErr) {
                    msgEl.textContent = text || '';
                    msgEl.className = 'yf-mgr-msg' + (isErr ? ' yf-mgr-msg-err' : '');
                    msgEl.style.display = text ? 'block' : 'none';
                }
                function typeName(v) {
                    for (var i = 0; i < MGR_TYPES.length; i++) { if (MGR_TYPES[i][0] === Number(v)) { return MGR_TYPES[i][1]; } }
                    return '';
                }
                function isCurrent(r) { return String((r && r.channelCode) || '').toLowerCase() === state.code; }
                function closeDialog() { if (dialogLayer && dialogLayer.parentNode) { dialogLayer.parentNode.removeChild(dialogLayer); } dialogLayer = null; }
                function openDialog(title, target, innerHtml, footBtns) {
                    closeDialog();
                    var mask = document.createElement('div');
                    mask.className = 'yf-mgr-mask modal-mask yf-portal';
                    var dlg = document.createElement('div');
                    dlg.className = 'yf-mgr-dlg modal';
                    /* 底部按钮组由调用方一次传入，保证「取消 + 主操作」在同一行（对齐官网 index.html），
                       避免多组 .modal-btns 各自 flex 造成上下堆叠。qr 等无主操作的弹窗可省略。 */
                    var foot = footBtns || ('<div class="modal-btns"><button class="btn btn-ghost" type="button" data-act="dlg-close">' + escHtml(labels.mgr_close) + '</button></div>');
                    dlg.innerHTML = '<button class="modal-close" type="button" data-act="dlg-close" aria-label="' + escHtml(labels.mgr_close) + '">×</button>'
                        + '<h3>' + escHtml(title) + '</h3>'
                        + (target ? '<p class="yf-mgr-dlg-target muted small">' + escHtml(target) + '</p>' : '')
                        + innerHtml
                        + foot;
                    mask.appendChild(dlg);
                    mask.onclick = function (e) { if (e.target === mask) { closeDialog(); } };
                    dlg.onclick = function (e) {
                        var b = e.target;
                        while (b && b !== dlg && !(b.getAttribute && b.getAttribute('data-act'))) { b = b.parentNode; }
                        if (!b || b === dlg) { return; }
                        if (b.getAttribute('data-act') === 'dlg-close') { closeDialog(); }
                    };
                    (document.body || document.documentElement).appendChild(mask);
                    dialogLayer = mask;
                    return dlg;
                }

                /* 自定义确认弹窗（对齐官网截图：标题「提示」+ 正文 + 灰色目标行 + 取消/危险确认按钮），
                   替代原生 window.confirm——原生弹窗样式与各站点不统一，且此处需要展示通道名与打码头。 */
                function openConfirm(title, message, target, okText, onOk) {
                    var body = '<p class="yf-mgr-confirm-msg">' + escHtml(message) + '</p>'
                        + (target ? '<p class="yf-mgr-dlg-target muted small">' + escHtml(target) + '</p>' : '');
                    var foot = '<div class="modal-btns">'
                        + '<button class="btn btn-ghost" type="button" data-act="dlg-close">' + escHtml(labels.mgr_cancel) + '</button>'
                        + '<button class="btn btn-danger" type="button" data-act="confirm-ok">' + escHtml(okText) + '</button></div>';
                    var dlg = openDialog(title, '', body, foot);
                    var okBtn = dlg.querySelector('[data-act="confirm-ok"]');
                    if (okBtn) {
                        okBtn.onclick = function () {
                            if (okBtn.disabled) { return; }
                            okBtn.disabled = true;
                            closeDialog();
                            try { onOk(); } catch (e) {}
                        };
                    }
                    return dlg;
                }

                function renderList() {
                    if (!state.rows.length) {
                        listEl.innerHTML = '<div class="yf-mgr-row">' + escHtml(labels.mgr_empty) + '</div>';
                        return;
                    }
                    var h = '<div class="table-wrap"><table class="yf-mgr-table chan"><thead><tr>'
                        + '<th class="c-type col-type">' + escHtml(labels.mgr_col_type) + '</th>'
                        + '<th class="c-qr col-qr">' + escHtml(labels.mgr_col_qr) + '</th>'
                        + '<th class="col-name">' + escHtml(labels.mgr_col_name) + '</th>'
                        + '<th class="c-code col-code">' + escHtml(labels.mgr_col_code) + '</th>'
                        + '<th class="c-time col-time">' + escHtml(labels.mgr_col_time) + '</th>'
                        + '<th class="c-op col-op">' + escHtml(labels.mgr_col_op) + '</th></tr></thead><tbody>';
                    for (var i = 0; i < state.rows.length; i++) {
                        var r = state.rows[i] || {};
                        var isParent = Number(r.pushType) === 10;
                        var off = Number(r.status) === 0;
                        var qr = r.qrCodeUrl
                            ? '<img class="yf-mgr-qr qr" src="' + escHtml(r.qrCodeUrl) + '" data-act="qr" data-i="' + i + '" alt="' + escHtml(labels.mgr_col_qr) + '" title="' + escHtml(labels.mgr_qr_click) + '">'
                            : '—';
                        var nameHtml = '<span class="name">' + escHtml(r.channelName || labels.mgr_unnamed) + '</span>'
                            + (isCurrent(r) ? '<span class="yf-mgr-badge badge-cur">' + escHtml(labels.mgr_current) + '</span>' : '')
                            + (off ? '<span class="yf-mgr-badge badge-off">' + escHtml(labels.mgr_off) + '</span>' : '')
                            + (Number(r.pushType) === 1 ? '<br><span class="yf-mgr-rec-link" data-act="records" data-i="' + i + '">' + escHtml(labels.mgr_records) + '</span>' : '');
                        var ops = '';
                        if (!isParent) { ops += '<button class="yf-mgr-mini-link btn btn-sm btn-o-green" data-act="edit" data-i="' + i + '">' + escHtml(labels.mgr_edit) + '</button>'; }
                        ops += '<button class="yf-mgr-mini-link btn btn-sm btn-o-blue" data-act="test" data-i="' + i + '">' + escHtml(labels.mgr_test) + '</button>'
                            + '<button class="yf-mgr-mini-link btn btn-sm btn-o-green" data-act="copy" data-i="' + i + '">' + escHtml(labels.mgr_copy) + '</button>'
                            + '<button class="yf-mgr-mini-link btn btn-sm btn-o-red" data-act="reset" data-i="' + i + '">' + escHtml(labels.mgr_reset) + '</button>';
                        if (!isCurrent(r)) { ops += '<button class="yf-mgr-mini-link btn btn-sm btn-o-red" data-act="del" data-i="' + i + '">' + escHtml(labels.mgr_del) + '</button>'; }
                        h += '<tr><td class="c-type"><span class="idx idx-type">' + escHtml(isParent ? labels.mgr_parent : (r.pushTypeDesc || typeName(r.pushType))) + '</span></td>'
                            + '<td class="c-qr">' + qr + '</td>'
                            + '<td class="col-name">' + nameHtml + '</td>'
                            + '<td class="c-code code" title="' + escHtml(r.channelCode || '') + '">' + escHtml(maskCode(r.channelCode)) + '</td>'
                            + '<td class="c-time">' + escHtml(r.createTime || '—') + '</td>'
                            + '<td class="c-op"><div class="ops-row">' + ops + '</div></td></tr>';
                    }
                    listEl.innerHTML = h + '</tbody></table></div>';
                }

                function load() {
                    msg('');
                    listEl.innerHTML = '<div class="yf-mgr-row">' + escHtml(labels.mgr_loading) + '</div>';
                    return listChannels(state.code).then(function (data) {
                        var top = data || {};
                        state.parent = top;
                        var children = (top.rows || []).slice();
                        if (top.channelCode && String(top.channelCode).toLowerCase() === state.code) { children.unshift(top); }
                        state.rows = children;
                        renderList();
                    })['catch'](function (err) {
                        listEl.innerHTML = '';
                        msg(labels.mgr_err + (err && err.message ? err.message : String(err)), true);
                    });
                }

                function fieldHtml(name, label, ph, value, type) {
                    var tag = type === 'textarea'
                        ? '<textarea class="yf-auth-input" data-f="' + name + '" placeholder="' + escHtml(ph || '') + '">' + escHtml(value || '') + '</textarea>'
                        : '<input class="yf-auth-input" data-f="' + name + '" type="text" value="' + escHtml(value || '') + '" placeholder="' + escHtml(ph || '') + '">';
                    return '<div class="yf-auth-row form-row" data-row="' + name + '"><label class="yf-auth-label">' + escHtml(label) + '</label>' + tag + '</div>';
                }

                function openForm(row) {
                    var isEdit = !!row;
                    var r = row || {};
                    var type = Number(r.pushType) || 1;
                    var opts = '';
                    for (var k = 0; k < MGR_TYPES.length; k++) {
                        if (Number(MGR_TYPES[k][0]) === 10) { continue; }
                        opts += '<option value="' + MGR_TYPES[k][0] + '"' + (type === MGR_TYPES[k][0] ? ' selected' : '') + '>' + escHtml(MGR_TYPES[k][1]) + '</option>';
                    }
                    var body = ''
                        + (isEdit ? '' : '<div class="yf-auth-row form-row" data-row="type"><label class="yf-auth-label">' + escHtml(labels.mgr_type) + '</label><select class="yf-auth-input" data-f="pushType">' + opts + '</select></div>')
                        + fieldHtml('channelName', labels.mgr_name, '', r.channelName || '')
                        + (isEdit && Number(r.pushType) !== 10 ? '<div class="yf-auth-row form-row" data-row="status"><label class="yf-auth-label">' + escHtml(labels.mgr_status) + '</label><select class="yf-auth-input" data-f="status"><option value="1"' + (Number(r.status) !== 0 ? ' selected' : '') + '>' + escHtml(labels.mgr_on) + '</option><option value="0"' + (Number(r.status) === 0 ? ' selected' : '') + '>' + escHtml(labels.mgr_off) + '</option></select></div>' : '')
                        + '<div data-row="webhook" style="display:none">' + fieldHtml('webhookUrl', MGR_WEBHOOK_LABEL[type] || labels.mgr_webhook, MGR_WEBHOOK_PH[type] || 'https://', r.webhookUrl || '') + '</div>'
                        + '<div data-row="secret" style="display:none">' + fieldHtml('signSecret', labels.mgr_secret, '', '') + '</div>'
                        + '<div data-row="corp" style="display:none">' + fieldHtml('corpId', labels.mgr_tri1, '', r.corpId || '') + '</div>'
                        + '<div data-row="agent" style="display:none">' + fieldHtml('agentId', labels.mgr_tri2, '', r.agentId || '') + '</div>'
                        + '<div data-row="corp-secret" style="display:none">' + fieldHtml('corpSecret', labels.mgr_tri3, '', '') + '</div>'
                        + '<div class="yf-mgr-msg err small" data-f="err" style="display:none"></div>';
                    var foot = '<div class="modal-btns">'
                        + '<button class="btn btn-ghost" type="button" data-act="dlg-close">' + escHtml(labels.mgr_cancel) + '</button>'
                        + '<button class="btn btn-primary" type="button" data-act="save" data-i="' + (isEdit ? state.rows.indexOf(r) : '') + '">' + escHtml(isEdit ? labels.mgr_save : labels.mgr_create) + '</button></div>';
                    var target = isEdit ? ((r.channelName || '') + ' · ' + maskCode(r.channelCode) + (isCurrent(r) ? '（' + labels.mgr_current + '）' : '')) : '';
                    var dlg = openDialog(isEdit ? labels.mgr_edit_title : labels.mgr_add_title, target, body, foot);

                    function sync() {
                        var t = isEdit ? type : Number(dlg.querySelector('[data-f="pushType"]').value);
                        function show(name, on) { var el = dlg.querySelector('[data-row="' + name + '"]'); if (el) { el.style.display = on ? '' : 'none'; } }
                        show('webhook', !!MGR_NEED_WEBHOOK[t]);
                        show('secret', !!MGR_NEED_SECRET[t]);
                        show('corp', !!MGR_NEED_CORP[t]);
                        show('agent', !!MGR_NEED_AGENT[t]);
                        show('corp-secret', !!MGR_NEED_CORP_SECRET[t]);
                        var tri = MGR_TRI_LABEL[t] || MGR_TRI_LABEL.mail;
                        var ph = MGR_TRI_PH[t] || MGR_TRI_PH.mail;
                        function setField(f, label, placeholder) {
                            var el = dlg.querySelector('[data-row="' + f + '"]');
                            if (el) { el.querySelector('label').textContent = label; el.querySelector('[data-f]').placeholder = placeholder; }
                        }
                        setField('webhook', MGR_WEBHOOK_LABEL[t] || labels.mgr_webhook, MGR_WEBHOOK_PH[t] || 'https://');
                        setField('corp', tri[0], ph[0]);
                        setField('agent', tri[1], ph[1]);
                        setField('corp-secret', tri[2], ph[2]);
                        /* 当前码不允许改类型：编辑时 select 不渲染 */
                        return t;
                    }
                    sync();
                    var typeSel = dlg.querySelector('[data-f="pushType"]');
                    if (typeSel) { typeSel.onchange = function () { sync(); var n = dlg.querySelector('[data-f="channelName"]'); if (n && (!n.value || n.getAttribute('data-auto') === '1')) { n.value = typeName(typeSel.value); n.setAttribute('data-auto', '1'); } }; }
                    var nameIn = dlg.querySelector('[data-f="channelName"]');
                    if (!isEdit && nameIn) { nameIn.value = typeName(typeSel ? typeSel.value : type); nameIn.setAttribute('data-auto', '1'); }
                    if (nameIn) { nameIn.focus(); }
                    var saveBtn = dlg.querySelector('[data-act="save"]');
                    if (saveBtn) { saveBtn.onclick = function () { saveForm(saveBtn); }; }
                }

                function formErr(dlg, text) {
                    var errEl = dlg.querySelector('[data-f="err"]');
                    if (errEl) { errEl.textContent = text; errEl.className = 'yf-mgr-msg yf-mgr-msg-err'; errEl.style.display = 'block'; }
                }
                function isHttp(v) { return /^https?:\/\/.+/i.test(String(v || '').replace(/^\s+|\s+$/g, '')); }
                function val(dlg, name) { var el = dlg.querySelector('[data-f="' + name + '"]'); return el ? String(el.value || '').replace(/^\s+|\s+$/g, '') : ''; }

                function saveForm(btn) {
                    var dlg = btn.parentNode.parentNode;
                    while (dlg && !dlg.querySelector) { dlg = dlg.parentNode; }
                    dlg = dialogLayer ? dialogLayer.querySelector('.yf-mgr-dlg') : dlg;
                    if (!dlg) { return; }
                    var idx = btn.getAttribute('data-i');
                    var isEdit = idx !== null && idx !== undefined && idx !== '';
                    var row = isEdit ? state.rows[Number(idx)] : null;
                    var name = val(dlg, 'channelName');
                    if (!name) { formErr(dlg, labels.mgr_name_req); return; }
                    var type = row ? Number(row.pushType) : Number(val(dlg, 'pushType'));
                    var params = { channelName: name };
                    if (row) { params.channelCode = row.channelCode; var st = val(dlg, 'status'); if (st) { params.status = st; } }
                    else { params.pushType = type; }
                    var hook = val(dlg, 'webhookUrl');
                    if (MGR_NEED_WEBHOOK[type]) {
                        if (!hook) { formErr(dlg, labels.mgr_webhook_req); return; }
                        if (!isHttp(hook)) { formErr(dlg, labels.mgr_webhook_bad); return; }
                        params.webhookUrl = hook;
                    } else if (hook) { params.webhookUrl = hook; }
                    var secret = val(dlg, 'signSecret');
                    if (secret && MGR_NEED_SECRET[type]) { params.signSecret = secret; }
                    var corp = val(dlg, 'corpId'), agent = val(dlg, 'agentId'), corpSecret = val(dlg, 'corpSecret');
                    if (type === 29) { if (!corp) { formErr(dlg, labels.mgr_tg_token); return; } if (!agent) { formErr(dlg, labels.mgr_tg_chat); return; } }
                    else if (type === 30) { if (!corp) { formErr(dlg, labels.mgr_dc_webhook); return; } if (!isHttp(corp)) { formErr(dlg, labels.mgr_dc_bad); return; } }
                    if (MGR_NEED_CORP[type] && corp) { params.corpId = corp; }
                    if (MGR_NEED_AGENT[type] && agent) { params.agentId = agent; }
                    if (MGR_NEED_CORP_SECRET[type] && corpSecret) { params.corpSecret = corpSecret; }
                    btn.disabled = true;
                    var task = row ? editChannel(state.code, params) : addChannel(state.code, params);
                    task.then(function (created) {
                        closeDialog();
                        msg(row ? labels.mgr_saved : labels.mgr_add_done);
                        toast(row ? labels.mgr_saved : labels.mgr_add_done);
                        if (!row && created && created.channelCode) { copyText(created.channelCode)['catch'](function () {}); }
                        return load();
                    })['catch'](function (err) {
                        formErr(dlg, labels.mgr_err + (err && err.message ? err.message : String(err)));
                        btn.disabled = false;
                    });
                }

                function openTest(row) {
                    var body = fieldHtml('testHead', labels.mgr_test_head, '', '测试')
                        + '<div data-row="testBody" style="display:block">' + fieldHtml('testBody', labels.mgr_test_body, '', '', 'textarea') + '</div>'
                        + fieldHtml('testUrl', labels.mgr_test_url, 'https://', '')
                        + fieldHtml('testAvatar', labels.mgr_test_avatar, 'https://', '')
                        + '<span class="yf-mgr-rec-link" data-act="test-preview">' + escHtml(labels.mgr_test_preview) + '</span>'
                        + '<code class="yf-mgr-url" data-f="preview"></code>'
                        + '<div class="yf-mgr-msg err small" data-f="err" style="display:none"></div>';
                    var foot = '<div class="modal-btns">'
                        + '<button class="btn btn-ghost" type="button" data-act="dlg-close">' + escHtml(labels.mgr_cancel) + '</button>'
                        + '<button class="btn btn-primary" type="button" data-act="test-send">' + escHtml(labels.mgr_test_send) + '</button></div>';
                    var target = (row.channelName || '') + ' · ' + maskCode(row.channelCode) + (isCurrent(row) ? '（' + labels.mgr_current + '）' : '');
                    var dlg = openDialog(labels.mgr_test_title, target, body, foot);
                    function refreshPreview() {
                        var url = apiBase + '/services/push/send/' + row.channelCode + '?head=' + encodeURIComponent(val(dlg, 'testHead') || '测试');
                        var b = val(dlg, 'testBody'), u = val(dlg, 'testUrl'), a = val(dlg, 'testAvatar');
                        if (b) { url += '&body=' + encodeURIComponent(b); }
                        if (u) { url += '&url=' + encodeURIComponent(u); }
                        if (a) { url += '&avatar=' + encodeURIComponent(a); }
                        dlg.querySelector('[data-f="preview"]').textContent = url;
                    }
                    var inputs = dlg.querySelectorAll('[data-f^="test"]');
                    for (var i = 0; i < inputs.length; i++) { inputs[i].oninput = refreshPreview; }
                    refreshPreview();
                    var previewLink = dlg.querySelector('[data-act="test-preview"]');
                    if (previewLink) { previewLink.onclick = refreshPreview; }
                    var sendBtn = dlg.querySelector('[data-act="test-send"]');
                    sendBtn.onclick = function () {
                        var head = val(dlg, 'testHead'), link = val(dlg, 'testUrl'), avatar = val(dlg, 'testAvatar');
                        if (!head) { formErr(dlg, labels.mgr_head_req); return; }
                        if (link && !isHttp(link)) { formErr(dlg, labels.mgr_url_bad); return; }
                        if (avatar && !isHttp(avatar)) { formErr(dlg, labels.mgr_avatar_bad); return; }
                        sendBtn.disabled = true; sendBtn.textContent = labels.mgr_sending;
                        sendPushMessage(row.channelCode, { head: head, body: val(dlg, 'testBody'), url: link, avatar: avatar })
                            .then(function () {
                                closeDialog();
                                toast(Number(row.pushType) === 1 ? labels.mgr_test_ok_browser : labels.mgr_test_ok);
                            })['catch'](function (err) {
                                formErr(dlg, labels.mgr_err + (err && err.message ? err.message : String(err)));
                                sendBtn.disabled = false; sendBtn.textContent = labels.mgr_test_send;
                            });
                    };
                }

                function openQr(row) {
                    /* DOM 结构照搬官网 index.html 的 qr-modal：qr-big-wrap 包裹 qr-big（居中 320px），
                       底部「推送记录」链接居中，无额外底部按钮（仅右上角 ×）。
                       双 class：yf-* 作 JS/测试钩子，qr-* 命中照搬自官网的 .yf-portal 样式。 */
                    var body = '<div class="qr-big-wrap"><img class="yf-mgr-qr-big qr-big" src="' + escHtml(row.qrCodeUrl) + '" alt="' + escHtml(labels.mgr_col_qr) + '"></div>'
                        + (Number(row.pushType) === 1 ? '<p class="muted small" style="text-align:center"><span class="yf-mgr-rec-link" data-act="records" data-i="' + state.rows.indexOf(row) + '">' + escHtml(labels.mgr_records) + '</span></p>' : '');
                    var dlg = openDialog(labels.mgr_qr_scan + (row.channelName || ''), '', body, '<div></div>');
                    dlg.classList.add('qr-modal');
                    var rec = dlg.querySelector('[data-act="records"]');
                    if (rec) { rec.onclick = function () { openRecords(row); }; }
                }

                function openRecords(row) {
                    var code = String((row && row.channelCode) || '').toLowerCase();
                    if (!code) { toast(labels.mgr_err + labels.mgr_col_code, true); return; }
                    var via = recordsUrl(row.qrCodeUrl);
                    if (window.WebsitePusher && typeof window.WebsitePusher.init === 'function') {
                        try {
                            window.WebsitePusher.init({
                                appName: row.channelName || labels.mgr_title,
                                channelCode: code,
                                hidePanel: 1,
                                hideDialog: 0,
                                danMu: 1,
                                danMuSetting: { aiDanMu: 0 },
                                plugins: 'control,input'
                            });
                            return;
                        } catch (e) {}
                    }
                    if (via) { window.open(via, '_blank', 'noopener'); }
                    else { toast(labels.mgr_records_fail, true); }
                }

                wrap.onclick = function (e) {
                    var t = e.target;
                    while (t && t !== wrap && !(t.getAttribute && t.getAttribute('data-act'))) { t = t.parentNode; }
                    if (!t || t === wrap) { return; }
                    var act = t.getAttribute('data-act');
                    var i = t.getAttribute('data-i');
                    var row = (i !== null && i !== undefined && i !== '') ? state.rows[Number(i)] : null;
                    if (act === 'refresh') { forgetToken(); load(); }
                    else if (act === 'add') { openForm(null); }
                    else if (act === 'edit') { openForm(row); }
                    else if (act === 'save') { saveForm(t); }
                    else if (act === 'qr') { openQr(row); }
                    else if (act === 'test') { openTest(row); }
                    else if (act === 'records') { openRecords(row); }
                    else if (act === 'copy') {
                        if (row && row.channelCode) {
                            copyText(row.channelCode).then(function () { toast(labels.mgr_copied); })['catch'](function () { toast(labels.mgr_err + labels.mgr_copy, true); });
                        }
                    }
                    else if (act === 'reset') {
                        if (!row) { return; }
                        openConfirm(labels.mgr_confirm_title, labels.mgr_reset_full,
                            (row.channelName || labels.mgr_unnamed) + ' · ' + maskCode(row.channelCode),
                            labels.mgr_confirm_reset, function () {
                                resetChannel(state.code, row.channelCode).then(function (next) {
                                    toast(labels.mgr_reset_ok + (next ? '：' + next : ''));
                                    if (isCurrent(row)) {
                                        state.code = String(next || '').toLowerCase() || state.code;
                                        if (typeof onCodeChanged === 'function') { try { onCodeChanged(state.code); } catch (e) {} }
                                    }
                                    return load();
                                })['catch'](function (err) { toast(labels.mgr_err + (err && err.message ? err.message : String(err)), true); });
                            });
                    } else if (act === 'del') {
                        if (!row) { return; }
                        openConfirm(labels.mgr_confirm_title, labels.mgr_del_full,
                            (row.channelName || labels.mgr_unnamed) + ' · ' + maskCode(row.channelCode),
                            labels.mgr_confirm_del, function () {
                                deleteChannel(state.code, row.channelCode).then(function () {
                                    toast(labels.mgr_deleted);
                                    return load();
                                })['catch'](function (err) { toast(labels.mgr_err + (err && err.message ? err.message : String(err)), true); });
                            });
                    }
                };

                load();
                return wrap;
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
                /* 授权成功后就地挂通道管理面板；opt.manage===false 可关闭 */
                if (code && opt.manage !== false) {
                    mountManage(code, result, typeof opt.onCodeChanged === 'function' ? opt.onCodeChanged : null);
                }
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
            autoGetChannelCode: autoGetChannelCode,
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
