/**
 * push-server 通道管理 —— 纯 HTML + JavaScript 版（无任何服务端代码）
 *
 * 架构说明：
 * - 通道码（PHPRM_CHANNEL_CODE）存 LocalStorage（key: phprm_channel_code），仅存本浏览器
 * - 支持从 URL 读取 ?channelCode=xxx 写入 LocalStorage（分享链路：把本页网址发给好友即可免登录进入通道管理）
 * - 未设置通道码：调匿名接口 /services/public/ping 取官方示例通道，做「群组提醒示例」推送测试
 *   （推送走 POST /services/push/send/{channelCode}，与官网 index.html 同一链路）
 * - 已设置通道码：
 *   · 推送测试直接用用户通道码（不再用 ping 示例码）
 *   · 通道管理走 MCP get_access_token 换短期令牌 → Authorization: Bearer 调 /oauth2/push/* 接口
 *     （channel/list 无分页；add/edit/deleteChannel 支持增删改）
 * - 官方所有端点均已开启 CORS（access-control-allow-origin 回显来源），浏览器可直连
 * - 中英双语：文案集中在 I18N，右上角可切换，选择记在 LocalStorage（key: ps_lang）
 */
(function () {
  'use strict';

  var API = 'https://www.phprm.com';
  var MCP_URL = API + '/services/push/mcp';
  var PING_URL = API + '/services/public/ping';
  var KEY_NAME = 'phprm_channel_code';
  var LANG_KEY = 'ps_lang';
  var AGENT_GUIDE_URL = 'https://push.phprm.com/skill.md';

  /* ---------------- 文案（中英双语） ---------------- */

  var I18N = {
    'zh-cn': {
      lang_btn: 'EN',
      app_title: 'push-server 通道管理 · 一封传话',
      brand_sub: '一封传话 · 通道管理与推送测试',
      agent_guide_label: 'Agent 指南：',
      agent_guide_copy: '复制 skill.md 地址',
      agent_guide_open: '打开 skill.md',
      btn_set_code: '设置通道码',
      btn_code: '通道码 ',

      push_title_demo: '群组提醒示例',
      push_title_code: '当前MCP配置的通道：',
      label_head: '标题',
      label_body: '推送内容',
      label_url: '跳转网址',
      label_avatar: '指定头像',
      ph_head: '消息标题，200 字以内',
      default_head: '测试',
      ph_body: '请输入要推送的内容（Markdown），选填',
      ph_url: '跳转链接，选填，如 https://example.com/pr/123',
      ph_avatar: '指定发布人头像网址，选填',
      btn_send: '发送测试',
      btn_refresh: '刷新',
      btn_add: '+ 新增推送通道',
      chan_title: '通道管理',

      demo_push_records: '查看推送记录页',
      demo_loading: '示例通道加载中…',
      demo_tag: '官方公开示例',
      demo_tip: '此通道码来自官方 ping 示例通道，任何人都能往里推，仅用于链路体验',
      demo_unavailable: '官方示例通道暂不可用（ping 返回空），请设置自己的通道码后再测试',
      demo_offline: '无法连接官方服务',
      demo_rate_limit: '示例通道：相同内容请求间隔不能小于 30 秒',
      target_demo: '将推送到官方示例通道「{name}」',
      target_mine: '将推送到你设置的通道',
      target_all: '将推送到下方所有子通道',
      target_one: '将推送到「{name}」通道',

      placeholder_no_code: '设置通道码后即可在这里管理你的推送通道（新增 / 修改 / 删除 / 测试 / 复制通道码）。',
      placeholder_no_code_hint: '还没有通道码？去官网 <a href="https://push.phprm.com/mcp.html" target="_blank" rel="noopener">push.phprm.com/mcp.html</a> 注册创建，然后在右上角「设置通道码」填入 32 位通道码。',
      placeholder_empty: '该通道组下暂无子通道，点右上角「+ 新增推送通道」创建。',
      loading: '通道列表加载中…',
      load_fail: '通道列表加载失败：',
      load_fail_hint: '通道码可能无效或已被重置，请右上角重新设置。',
      retry: '重试',
      parent_tip: '父通道：',

      share_title: '复制网址发送给正在使用SKILL的好友，他也能指挥agent干活',
      share_p1: '把这个页面的网址发给已经安装 <strong>push-server</strong> SKILL 的好友，对方无需登录即可直接打开本页。URL 上的 <code>channelCode</code> 会自动写入他的浏览器 MCP 配置（LocalStorage），并加载该组合通道下的子通道列表。',
      share_p2: '好友把链接里的 <code>channelCode</code> 填进自己 AI 客户端 MCP 配置的 <code>X-Push-Channel-Code</code> Header，Agent 就能把任务结果推送到该通道；他也可以在本页直接管理这些子通道。',
      btn_copy_link: '复制当前链接',
      copied_link: '已复制当前链接',
      share_note: '注意：通道码等同于推送凭证，请只发送给可信任的人；被分享者只能管理该组合通道内的子通道，不能进入你的账号。',
      foot: '纯 HTML + JavaScript 实现，无任何服务端代码；通道码仅保存在本浏览器 LocalStorage。接口由 <a href="https://push.phprm.com/mcp.html" target="_blank" rel="noopener">一封传话官网</a> 提供。',

      set_code_title: '设置通道码',
      set_code_desc: '通道码（PHPRM_CHANNEL_CODE）是 32 位推送凭证，在官网控制台创建通道后获得。',
      code_ph: '粘贴 32 位通道码',
      set_code_hint: '还没有通道码？去官网 <a href="https://push.phprm.com/mcp.html" target="_blank" rel="noopener">push.phprm.com/mcp.html</a> 注册创建。',
      code_invalid: '通道码应为 32 位十六进制字符串（去官网 push.phprm.com/mcp.html 创建通道后复制）',
      code_saved: '通道码已保存',
      code_cleared: '已清除通道码，回到官方示例通道体验模式',
      btn_clear: '清除',
      btn_cancel: '取消',
      btn_save: '保存',
      btn_create: '创建',
      btn_push: '推送',

      add_title: '新增推送通道',
      edit_title: '修改通道',
      field_name: '通道名称',
      field_type: '推送类型',
      field_webhook: '接收地址',
      field_secret: '加签 Secret',
      field_status: '状态',
      ph_channel_name: '如：告警接收端',
      ph_secret: '群机器人启用加签时才填，选填',
      status_on: '启用（正常接收推送）',
      status_off: '停用（推送将返回「通道未开启」）',
      add_tip: '提示：使用父通道码推送将自动推送到所有子通道。',

      qr_title: '使用手机扫码访问',
      push_records: '点这里可以打开该通道的推送记录页',
      trow_api: 'API网址',
      copy_api: '复制网址',
      api_tip: '集成到您的代码中即可',
      copy_api_ok: 'API网址复制成功，可集成到您的代码中',

      del_title: '删除通道',
      del_tip: '确认删除该通道？删除不可恢复，同组成员与历史消息一并失效。',
      btn_confirm_del: '确认删除',
      reset_title: '重置通道码',
      reset_tip: '确认重置该通道的通道码？重置后旧通道码将失效。',
      btn_confirm_reset: '确认重置',

      th_type: '推送类型',
      th_qr: '二维码/推送页面',
      th_name: '通道名称',
      th_nickname: '创建人昵称',
      th_code: '通道码',
      th_time: '创建时间',
      th_op: '操作',
      idx_parent: '父通道',
      idx_sub: '子',
      badge_cur: '当前',
      badge_off: '已停用',
      op_del: '删除',
      op_edit: '修改',
      op_test: '测试',
      op_copy: '复制',
      op_reset: '重置',
      op_chat: '群聊',

      three_9: ['企业ID', '应用ID', '应用Secret', ''],
      three_email: ['发信人昵称', '邮箱地址', '授权码', '（邮箱服务商生成的授权码）'],
      pt_1: '浏览器', pt_6: '企业微信群机器人', pt_7: '钉钉群机器人', pt_8: '飞书群机器人',
      pt_9: '企业微信应用', pt_10: '组合（多通道聚合）', pt_11: 'webhook推送', pt_16: 'BARK（iOS）',
      pt_29: 'Telegram', pt_30: 'Discord', pt_50: '官方邮件', pt_51: 'QQ邮箱', pt_52: '163邮箱',
      pt_53: '126邮箱', pt_54: '搜狐邮箱', pt_55: '139邮箱', pt_56: '189邮箱', pt_57: '新浪邮箱',
      pt_58: '阿里云邮箱',

      /* 提示 / 错误 */
      need_head: '请填写消息标题',
      head_too_long: '标题不能超过 200 字符',
      no_channel: '暂无可用通道：请设置通道码，或等示例通道加载完成',
      push_sending: '推送中…',
      push_result_ok: '推送成功（MCP send_push_message 响应）：',
      push_ok: '推送成功',
      push_ok_ids: '，消息ID：',
      push_fail: '推送失败：',
      url_invalid: '网址不合法，已忽略',
      avatar_invalid: '头像网址不合法，已忽略',
      url_code_invalid: '链接里的 channelCode 不是一个合法的 32 位通道码，已忽略',
      storage_denied: '注意：浏览器禁止本地存储，通道码仅在当前页面内有效，刷新后需重新填写',
      copy_fail: '复制失败，请手动复制',
      copied_prefix: '已复制：',
      copied_code: '已复制完整通道码',
      copied_new_code: '已复制新通道码',
      no_json: '接口响应不是 JSON',
      nick_ok: '昵称修改成功',
      nick_fail: '修改失败：',
      no_test_channel: '缺少目标通道',
      test_push_ok: '推送成功, 可到官网查看推送日志',
      test_push_ok_browser: '推送成功',
      need_code_first: '请先在右上角设置通道码',
      need_name: '请填写通道名称',
      need_webhook: '该推送类型必须填写合法的接收地址（http/https）',
      creating: '创建中…',
      created: '通道创建成功，新通道码：',
      created_none: '（见列表）',
      create_fail: '创建失败：',
      saving: '保存中…',
      edit_ok: '通道修改成功',
      edit_fail: '修改失败：',
      edit_target: '目标通道：',
      edit_current_tip: '注意：这是当前应用绑定的通道，停用（或重置）后请同步更新你的 MCP 配置',
      del_target: '通道：',
      del_current_tip: '（这是当前应用绑定的通道，服务端会拒绝删除）',
      del_ok: '通道已删除（不可恢复）',
      del_fail: '删除失败：',
      deleting: '删除中…',
      reset_self_tip: '确认重置该通道的通道码？重置后旧通道码将失效，新通道码会自动更新到当前 MCP 配置。',
      resetting: '重置中…',
      reset_changed: '您的通道码已经从 {old} 变更到 {new}',
      reset_ok: '通道码已重置',
      reset_fail: '重置失败：',
      chat_invalid: '该通道不支持群聊',
      chat_unready: '群聊组件未加载，请刷新页面后重试'
    },

    'en-us': {
      lang_btn: '中文',
      app_title: 'push-server Channel Management · OnePass',
      brand_sub: 'OnePass · Channel management and push test',
      agent_guide_label: 'Agent Guide: ',
      agent_guide_copy: 'Copy skill.md URL',
      agent_guide_open: 'Open skill.md',
      btn_set_code: 'Set Channel Code',
      btn_code: 'Code ',

      push_title_demo: 'Group reminder demo',
      push_title_code: 'Channel in current MCP config: ',
      label_head: 'Title',
      label_body: 'Content',
      label_url: 'Jump URL',
      label_avatar: 'Avatar',
      ph_head: 'Message title, max 200 chars',
      default_head: 'Test',
      ph_body: 'Content to push (Markdown), optional',
      ph_url: 'Jump link, optional, e.g. https://example.com/pr/123',
      ph_avatar: "Sender avatar image URL, optional",
      btn_send: 'Send Test',
      btn_refresh: 'Refresh',
      btn_add: '+ New Push Channel',
      chan_title: 'Channel Management',

      demo_push_records: 'View push records',
      demo_loading: 'Loading demo channel…',
      demo_tag: 'Official public demo',
      demo_tip: 'This code comes from the official ping demo channel; anyone can push to it, for testing only',
      demo_unavailable: 'The official demo channel is unavailable (ping returned empty). Set your own channel code to test.',
      demo_offline: 'Cannot reach the official service',
      demo_rate_limit: 'Demo channel: identical content can only be pushed once every 30 seconds',
      target_demo: 'Will push to the official demo channel "{name}"',
      target_mine: 'Will push to the channel you configured',
      target_all: 'Will push to every sub channel below',
      target_one: 'Will push to channel "{name}"',

      placeholder_no_code: 'Set a channel code and you can manage your push channels here (create / edit / delete / test / copy).',
      placeholder_no_code_hint: 'No channel code yet? Create one at <a href="https://push.phprm.com/mcp.html" target="_blank" rel="noopener">push.phprm.com/mcp.html</a>, then paste the 32-char code via "Set Channel Code" at the top right.',
      placeholder_empty: 'No sub channel yet. Click "+ New Push Channel" at the top right to create one.',
      loading: 'Loading channels…',
      load_fail: 'Failed to load channels: ',
      load_fail_hint: 'The channel code may be invalid or was reset. Please set it again at the top right.',
      retry: 'Retry',
      parent_tip: 'Parent channel: ',

      share_title: 'Share the link with friends using SKILL — they can also command the agent',
      share_p1: 'Send this page URL to anyone who has installed the <strong>push-server</strong> SKILL. They can open it directly without signing in. The <code>channelCode</code> in the URL is written to their browser MCP configuration (LocalStorage) and the sub-channel list loads automatically.',
      share_p2: 'Once they put the <code>channelCode</code> into the <code>X-Push-Channel-Code</code> Header of their AI client MCP config, the agent can push task results to that channel. They can also manage the sub channels right here.',
      btn_copy_link: 'Copy current link',
      copied_link: 'Current link copied',
      share_note: 'Note: the channel code is a push credential. Only share it with trusted people. Recipients can only manage sub channels inside this combo channel, not access your account.',
      foot: 'Pure HTML + JavaScript, no server-side code; the channel code lives in this browser LocalStorage only. APIs are provided by <a href="https://push.phprm.com/mcp.html" target="_blank" rel="noopener">OnePass</a>.',

      set_code_title: 'Set Channel Code',
      set_code_desc: 'The channel code (PHPRM_CHANNEL_CODE) is a 32-char credential created in the console.',
      code_ph: 'Paste the 32-char channel code',
      set_code_hint: 'No channel code yet? Create one at <a href="https://push.phprm.com/mcp.html" target="_blank" rel="noopener">push.phprm.com/mcp.html</a>.',
      code_invalid: 'The channel code must be a 32-char hex string (create a channel at push.phprm.com/mcp.html first)',
      code_saved: 'Channel code saved',
      code_cleared: 'Channel code cleared, back to the official demo mode',
      btn_clear: 'Clear',
      btn_cancel: 'Cancel',
      btn_save: 'Save',
      btn_create: 'Create',
      btn_push: 'Push',

      add_title: 'New Push Channel',
      edit_title: 'Edit Channel',
      field_name: 'Channel Name',
      field_type: 'Push Type',
      field_webhook: 'Endpoint URL',
      field_secret: 'Sign Secret',
      field_status: 'Status',
      ph_channel_name: 'e.g. Alert receiver',
      ph_secret: 'Only when the group bot enables signing, optional',
      status_on: 'Enabled (receives pushes)',
      status_off: 'Disabled (pushes return "channel not enabled")',
      add_tip: 'Tip: pushing with a parent channel code delivers to every sub channel.',

      qr_title: 'Scan with your phone',
      push_records: 'Open the push records page of this channel',
      trow_api: 'API URL',
      copy_api: 'Copy URL',
      api_tip: 'Integrate it into your code',
      copy_api_ok: 'API URL copied, ready to integrate',

      del_title: 'Delete Channel',
      del_tip: 'Delete this channel? This cannot be undone; members and history are invalidated too.',
      btn_confirm_del: 'Delete',
      reset_title: 'Reset Channel Code',
      reset_tip: 'Reset the channel code? The old code stops working immediately.',
      btn_confirm_reset: 'Reset',

      th_type: 'Push Type',
      th_qr: 'QR / Push Page',
      th_name: 'Channel Name',
      th_nickname: 'Creator Nickname',
      th_code: 'Channel Code',
      th_time: 'Created',
      th_op: 'Actions',
      idx_parent: 'Parent',
      idx_sub: 'Sub',
      badge_cur: 'Current',
      badge_off: 'Disabled',
      op_del: 'Delete',
      op_edit: 'Edit',
      op_test: 'Test',
      op_copy: 'Copy',
      op_reset: 'Reset',
      op_chat: 'Group Chat',

      three_9: ['Corp ID', 'Agent ID', 'App Secret', ''],
      three_email: ['Sender Name', 'Email Address', 'Auth Code', ' (generated by your email provider)'],
      pt_1: 'Browser', pt_6: 'WeCom Group Bot', pt_7: 'DingTalk Group Bot', pt_8: 'Feishu Group Bot',
      pt_9: 'WeCom App', pt_10: 'Combo (multi-channel)', pt_11: 'Webhook', pt_16: 'BARK (iOS)',
      pt_29: 'Telegram', pt_30: 'Discord', pt_50: 'Official Email', pt_51: 'QQ Mail', pt_52: '163 Mail',
      pt_53: '126 Mail', pt_54: 'Sohu Mail', pt_55: '139 Mail', pt_56: '189 Mail', pt_57: 'Sina Mail',
      pt_58: 'Aliyun Mail',

      need_head: 'Please fill in the title',
      head_too_long: 'The title cannot exceed 200 chars',
      no_channel: 'No channel available: set a channel code, or wait for the demo channel to load',
      push_sending: 'Pushing…',
      push_result_ok: 'Pushed (MCP send_push_message response):',
      push_ok: 'Pushed',
      push_ok_ids: ', message IDs: ',
      push_fail: 'Push failed: ',
      url_invalid: 'URL is invalid, ignored',
      avatar_invalid: 'Avatar URL is invalid, ignored',
      url_code_invalid: 'The channelCode in the link is not a valid 32-char code, ignored',
      storage_denied: 'Local storage is blocked; the channel code only lives in this page and is lost on reload',
      copy_fail: 'Copy failed, please copy manually',
      copied_prefix: 'Copied: ',
      copied_code: 'Full channel code copied',
      copied_new_code: 'New channel code copied',
      no_json: 'Response is not JSON',
      nick_ok: 'Nickname updated',
      nick_fail: 'Update failed: ',
      no_test_channel: 'No target channel',
      test_push_ok: 'Pushed, check the push log on the website',
      test_push_ok_browser: 'Pushed',
      need_code_first: 'Set a channel code at the top right first',
      need_name: 'Please fill in the channel name',
      need_webhook: 'This push type requires a valid endpoint URL (http/https)',
      creating: 'Creating…',
      created: 'Channel created, new code: ',
      created_none: '(see the list)',
      create_fail: 'Create failed: ',
      saving: 'Saving…',
      edit_ok: 'Channel updated',
      edit_fail: 'Update failed: ',
      edit_target: 'Target channel: ',
      edit_current_tip: 'Note: this is the bound channel. Keep your MCP config in sync after disabling / resetting.',
      del_target: 'Channel: ',
      del_current_tip: ' (this is the bound channel, the server will refuse)',
      del_ok: 'Channel deleted',
      del_fail: 'Delete failed: ',
      deleting: 'Deleting…',
      reset_self_tip: 'Reset the channel code? The old code stops working and the new one is written to your current MCP config.',
      resetting: 'Resetting…',
      reset_changed: 'Your channel code changed from {old} to {new}',
      reset_ok: 'Channel code reset',
      reset_fail: 'Reset failed: ',
      chat_invalid: 'Chat is not supported for this channel',
      chat_unready: 'Chat widget not loaded, please refresh the page'
    }
  };

  /* localStorage 被禁用（隐私模式/内嵌 WebView）时的内存兜底，避免静默失败 */
  var memCode = '';

  var LANG = 'zh-cn';

  function t(key) {
    var dict = I18N[LANG] || I18N['zh-cn'];
    if (dict[key] !== undefined) { return dict[key]; }
    return I18N['zh-cn'][key] !== undefined ? I18N['zh-cn'][key] : key;
  }
  /** 带占位符的文案：tpl('target_one', {name: 'xx'}) 把 {name} 替换掉 */
  function tpl(key, vars) {
    var s = t(key);
    Object.keys(vars || {}).forEach(function (k) {
      s = s.split('{' + k + '}').join(vars[k]);
    });
    return s;
  }

  var PUSH_TYPE_DEFS = [
    { v: 1, k: 'pt_1' }, { v: 6, k: 'pt_6' }, { v: 7, k: 'pt_7' }, { v: 8, k: 'pt_8' },
    { v: 9, k: 'pt_9' }, { v: 10, k: 'pt_10' }, { v: 11, k: 'pt_11' }, { v: 16, k: 'pt_16' },
    { v: 29, k: 'pt_29' }, { v: 30, k: 'pt_30' }, { v: 50, k: 'pt_50' }, { v: 51, k: 'pt_51' },
    { v: 52, k: 'pt_52' }, { v: 53, k: 'pt_53' }, { v: 54, k: 'pt_54' }, { v: 55, k: 'pt_55' },
    { v: 56, k: 'pt_56' }, { v: 57, k: 'pt_57' }, { v: 58, k: 'pt_58' }
  ];
  var NEED_WEBHOOK = { 6: 1, 7: 1, 8: 1, 11: 1, 16: 1 };
  var NEED_SECRET = { 6: 1, 7: 1, 8: 1 };
  /* 需 corpId/agentId/corpSecret 三件套的类型：
     9=企业微信应用（企业ID/应用ID/应用Secret）；51~58=自定义邮箱（发信人昵称/邮箱地址/授权码）；50 官方邮件不需要 */
  var NEED_EMAIL = { 9: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };

  function threeLabels(type) {
    return type === 9 ? t('three_9') : t('three_email');
  }

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
      throw new Error(t('no_json') + '（HTTP ' + resp.status + '）');
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
    catch (e) { toast(t('storage_denied'), 'err', 7000); }
  }
  function clearCode() {
    memCode = '';
    try { localStorage.removeItem(KEY_NAME); } catch (e) {}
  }
  /** 规范化通道码：去掉所有空白（用户从终端/聊天工具复制时常带换行、空格） */
  function normCode(s) {
    return String(s || '').replace(/\s+/g, '');
  }
  function isCode(s) { return /^[0-9a-fA-F]{32}$/.test(normCode(s)); }
  function maskCode(c) {
    c = String(c || '');
    if (c.length < 14) { return c; }
    return c.slice(0, 6) + '******' + c.slice(-6);
  }

  function copyText(text, tip) {
    var done = function () { toast(tip || (t('copied_prefix') + text), 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast(t('copy_fail'), 'err'); }
    document.body.removeChild(ta);
  }

  /* ---------------- 语言 ---------------- */

  function detectLang() {
    var saved = '';
    try { saved = localStorage.getItem(LANG_KEY) || ''; } catch (e) {}
    if (saved === 'en-us' || saved === 'zh-cn') { return saved; }
    var nav = (navigator.language || '').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh-cn' : 'en-us';
  }

  function applyI18n() {
    LANG = detectLang();
    document.documentElement.lang = LANG;
    document.title = t('app_title');

    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-html]'), function (node) {
      node.innerHTML = t(node.getAttribute('data-i18n-html'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (node) {
      node.setAttribute('placeholder', t(node.getAttribute('data-i18n-ph')));
    });
    /* 标题默认值：仅当字段为空或仍等于任一种语言的默认值时更新，保留用户输入 */
    var defZh = (I18N['zh-cn'] && I18N['zh-cn'].default_head) || '';
    var defEn = (I18N['en-us'] && I18N['en-us'].default_head) || '';
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-value]'), function (node) {
      var cur = node.value || '';
      if (cur === '' || cur === defZh || cur === defEn) {
        node.value = t(node.getAttribute('data-i18n-value'));
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-title]'), function (node) {
      var v = t(node.getAttribute('data-i18n-title'));
      node.setAttribute('title', v);
      node.setAttribute('aria-label', v);
    });
    el('langBtn').textContent = t('lang_btn');
    /* 下拉项文案（状态） */
    var on = el('editStatus').options[0], off = el('editStatus').options[1];
    if (on) { on.textContent = t('status_on'); }
    if (off) { off.textContent = t('status_off'); }
    /* 切换语言会把 data-i18n-ph 的占位符重置，这里把 ping 示例通道码补回设置弹窗 */
    updateCodePlaceholder();
  }

  function toggleLang() {
    LANG = LANG === 'zh-cn' ? 'en-us' : 'zh-cn';
    try { localStorage.setItem(LANG_KEY, LANG); } catch (e) {}
    applyI18n();
    updateCodeBtn();
    renderPushCard();
    if (channelsMeta) { renderChannels(channelsMeta); }
    else { loadChannels(); }
  }

  /* ---------------- 弹窗 ---------------- */

  function openModal(id) {
    el(id).style.display = 'flex';
    var first = el(id).querySelector('input, select, button');
    if (first) { setTimeout(function () { first.focus(); }, 50); }
  }
  function closeModal(id) { el(id).style.display = 'none'; }

  document.addEventListener('click', function (ev) {
    var t2 = ev.target;
    var closer = t2.closest ? t2.closest('[data-close]') : null;
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
    if (biz.code !== 0) { throw new Error(biz.message || ('MCP 业务错误 code=' + biz.code)); }
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
  async function pushSend(channelCode, head, body, url, avatar) {
    var args = { head: head, channelCode: channelCode };
    if (body) { args.body = body; }
    if (url) { args.url = url; }
    if (avatar) { args.avatar = avatar; }
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
  function updateCodePlaceholder() {
    var input = el('codeInput');
    if (!input) { return; }
    var code = demoChannel && demoChannel.channelCode;
    input.placeholder = code ? (t('code_ph') + '，如 ' + code) : t('code_ph');
  }

  /* ---------------- 分享：当前网址 ---------------- */

  /**
   * 拼分享网址：只保留 channelCode 一个参数（忽略 URL 上的其他参数）。
   * 取值顺序：当前 URL 上的 channelCode（合法才用） > LocalStorage 里的通道码 > 都不合法则不拼参数。
   */
  function buildShareUrl() {
    var base = window.location.origin + window.location.pathname;
    var m = new RegExp('[?&]channelCode=([^&#]*)').exec(window.location.search || '');
    var code = m ? normCode(decodeURIComponent((m[1] || '').replace(/\+/g, ' '))) : '';
    if (!isCode(code)) { code = normCode(getCode() || ''); }
    if (!isCode(code)) { return base; }
    return base + '?channelCode=' + encodeURIComponent(code);
  }

  function updateShareBox() {
    var box = el('sharePageUrl');
    if (box) { box.value = buildShareUrl(); }
  }

  function bindShareBox() {
    var btn = el('copyPageUrlBtn');
    if (!btn) { return; }
    btn.addEventListener('click', function () {
      var b = this;
      copyText(el('sharePageUrl').value || buildShareUrl(), t('copied_link'));
      b.classList.add('is-copied');
      setTimeout(function () { b.classList.remove('is-copied'); }, 1500);
    });
  }

  /* ---------------- 推送测试卡片 ---------------- */

  async function loadDemo() {
    if (getCode()) { return; }
    var box = el('demoChannelBox');
    box.style.display = 'flex';
    el('demoName').textContent = t('demo_loading');
    try {
      var resp = await fetch(PING_URL, { headers: { 'Accept': 'application/json' } });
      var biz = await readJson(resp);
      var rows = (biz.data && biz.data.rows) || [];
      if (!rows.length) {
        box.style.display = 'none';
        updateCodePlaceholder();
        toast(t('demo_unavailable'), 'err', 6000);
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
      el('demoTag').textContent = (demoChannel.pushTypeDesc || t('pt_1')) + ' · ' + t('demo_tag');
      el('demoCodeMasked').textContent = maskCode(demoChannel.channelCode);
      el('demoTip').textContent = t('demo_tip');
      el('sendTargetTip').textContent = tpl('target_demo', { name: demoChannel.channelName || '在线体验' });
    } catch (e) {
      box.style.display = 'none';
      updateCodePlaceholder();
      toast(t('demo_offline') + '（' + e.message + '）。若以 file:// 打开请改用 http://localhost 访问', 'err', 6000);
    }
  }

  function renderPushCard() {
    var code = getCode();
    var title = el('pushCardTitle');
    if (code) {
      var curName = '';
      var match = null;
      if (channelsMeta && channelsMeta.channelCode === code) { curName = channelsMeta.channelName; match = channelsMeta; }
      else if (channelRows && channelRows.length) { var found = channelRows.find(function (r) { return r.channelCode === code; }); if (found) { curName = found.channelName; match = found; } }
      title.innerHTML = esc(t('push_title_code')) + '<span class="mono"></span>';
      title.querySelector('.mono').textContent = curName || code;
      el('demoChannelBox').style.display = 'none';
      var targetTip = t('target_mine');
      if (match) {
        if (Number(match.pushType) === 10) {
          targetTip = t('target_all');
        } else {
          targetTip = tpl('target_one', { name: match.channelName || code });
        }
      }
      el('sendTargetTip').textContent = targetTip;
    } else {
      title.textContent = t('push_title_demo');
      if (demoChannel) { el('demoChannelBox').style.display = 'flex'; }
    }
    /* 通道码变化后（保存 / 清除 / 重置）同步刷新可复制的分享网址 */
    updateShareBox();
  }

  function isUrl(s) { return /^https?:\/\/.+/i.test(s || ''); }

  async function onSend() {
    var btn = el('sendBtn');
    var head = el('pushHead').value.trim();
    var body = el('pushBody').value.trim();
    var url = el('pushUrl').value.trim();
    var avatar = el('pushAvatar').value.trim();
    var code = getCode() || (demoChannel && demoChannel.channelCode);
    if (!head) { toast(t('need_head'), 'err'); return; }
    if (head.length > 200) { toast(t('head_too_long'), 'err'); return; }
    if (!code) { toast(t('no_channel'), 'err'); return; }
    /* url / avatar 是可选装饰字段：非法就丢弃，不阻断推送 */
    if (url && !isUrl(url)) { toast(url + t('url_invalid'), 'ok', 6000); url = ''; }
    if (avatar && !isUrl(avatar)) { toast(avatar + t('avatar_invalid'), 'ok', 6000); avatar = ''; }

    btn.disabled = true;
    btn.textContent = t('push_sending');
    try {
      var biz = await pushSend(code, head, body, url, avatar);
      var pre = el('pushResult');
      pre.style.display = 'block';
      pre.textContent = t('push_result_ok') + '\n' + JSON.stringify(biz, null, 2);
      var ids = biz.data && biz.data.messageIdList;
      toast(t('push_ok') + (ids && ids.length ? t('push_ok_ids') + ids.join(', ') : ''), 'ok', 6000);
      if (!getCode()) {
        toast(t('demo_rate_limit'), '', 5000);
      }
    } catch (e) {
      var pre2 = el('pushResult');
      pre2.style.display = 'block';
      pre2.textContent = t('push_fail') + e.message;
      toast(t('push_fail') + e.message, 'err', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = t('btn_send');
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
        '<p>' + esc(t('placeholder_no_code')) + '</p>' +
        '<p class="muted">' + t('placeholder_no_code_hint') + '</p>'
      );
      renderPushCard();
      return;
    }
    el('channelTableWrap').innerHTML = '<div class="load-tip">' + esc(t('loading')) + '</div>';
    try {
      var data = await oauth('/oauth2/push/channel/list');
      renderChannels(data);
    } catch (e) {
      var msg = esc(e.message || String(e));
      var hint = /通道码|令牌|access_token|无效|code|token/i.test(msg)
        ? '<p class="muted">' + esc(t('load_fail_hint')) + '</p>'
        : '';
      showPlaceholder('<p class="err">' + esc(t('load_fail')) + msg + '</p>' + hint +
        '<p><button class="btn btn-ghost" onclick="PS.loadChannels()">' + esc(t('retry')) + '</button></p>');
      renderPushCard();
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
      ? t('parent_tip') + esc(data.channelName) + '（' + esc(data.pushTypeDesc || '') + '）'
      : '';
    el('channelParentInfo').textContent = parentTip;

    if (!rows.length) {
      showPlaceholder('<p>' + esc(t('placeholder_empty')) + '</p>');
      renderPushCard();
      return;
    }

    var hasAnyNickname = rows.some(function (r) { return r.channelMemberRelId; });
    var html = '<div class="table-wrap"><table class="chan"><thead><tr>' +
      '<th class="col-type">' + esc(t('th_type')) + '</th>' +
      '<th class="col-qr">' + esc(t('th_qr')) + '</th>' +
      '<th class="col-name">' + esc(t('th_name')) + '</th>' +
      (hasAnyNickname ? '<th>' + esc(t('th_nickname')) + '</th>' : '') +
      '<th class="col-code">' + esc(t('th_code')) + '</th>' +
      '<th class="col-time">' + esc(t('th_time')) + '</th>' +
      '<th class="col-op">' + esc(t('th_op')) + '</th>' +
      '</tr></thead><tbody>';
    /* 序号预计算：pushType=10（组合）的行显示「父通道」，其余行显示该通道的推送类型 */
    var subSeq = 0;
    rows.forEach(function (r) {
      if (Number(r.pushType) === 10) { r._isParent = true; }
      else { subSeq++; r._subIdx = subSeq; }
    });
    rows.forEach(function (r, i) {
      var isCur = r.channelCode === getCode();
      var isParent = !!r._isParent;
      /* 第一栏：父通道显示「父通道」，其余显示该通道的推送类型 */
      var idxText = isParent ? t('idx_parent') : (r.pushTypeDesc || (t('idx_sub') + (r._subIdx || i)));
      var idxCls = 'idx' + (isParent ? ' idx-parent' : ' idx-type');
      var qr = r.qrCodeUrl
        ? '<img class="qr" src="' + esc(r.qrCodeUrl) + '" alt="QR" title="点击放大" data-qr="' + esc(r.qrCodeUrl) + '" data-url="' + esc(r.pushUrl) + '" data-name="' + esc(r.channelName || '') + '">'
        : '<span class="muted">—</span>';
      var nameBadge = (isCur ? '<span class="badge-cur">' + esc(t('badge_cur')) + '</span>' : '') +
        (Number(r.status) === 0 ? '<span class="badge-off">' + esc(t('badge_off')) + '</span>' : '');
      var name = r.pushUrl
        ? '<a class="name" href="' + esc(r.pushUrl) + '" target="_blank" rel="noopener">' + esc(r.channelName) + '</a>'
        : '<span class="name">' + esc(r.channelName) + '</span>';
      /* 浏览器类型通道（pushType=1）才给「群聊」 */
      var chat = Number(r.pushType) === 1
        ? '<button class="btn btn-sm btn-o-blue btn-chat" data-op="chat" data-i="' + i + '">' + esc(t('op_chat')) + '</button>'
        : '';
      html += '<tr>' +
        '<td class="col-type"><span class="' + idxCls + '" title="' + esc(r.pushTypeDesc || '') + '">' + esc(idxText) + '</span></td>' +
        '<td class="col-qr">' + qr + '</td>' +
        '<td class="col-name">' + name + nameBadge + chat + '</td>' +
        (hasAnyNickname ? '<td>' + (r.channelMemberRelId ? '<span class="nickname" data-i="' + i + '" title="单击修改昵称">' + esc(r.nickname || '-') + '</span>' : '<span class="muted">—</span>') + '</td>' : '') +
        '<td class="code">' + esc(maskCode(r.channelCode)) + '</td>' +
        '<td class="col-time">' + esc(r.createTime || '-') + '</td>' +
        '<td class="col-op"><div class="ops-row">' +
        '<button class="btn btn-sm btn-o-red" data-op="del" data-i="' + i + '">' + esc(t('op_del')) + '</button>' +
        '<button class="btn btn-sm btn-o-green" data-op="edit" data-i="' + i + '">' + esc(t('op_edit')) + '</button>' +
        '<button class="btn btn-sm btn-o-green" data-op="test" data-i="' + i + '">' + esc(t('op_test')) + '</button>' +
        '<button class="btn btn-sm btn-o-green" data-op="copy" data-i="' + i + '">' + esc(t('op_copy')) + '</button>' +
        '<button class="btn btn-sm btn-o-red" data-op="reset" data-i="' + i + '">' + esc(t('op_reset')) + '</button>' +
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
      el('qrTitle').textContent = t('qr_title') + '：' + (qrImg.getAttribute('data-name') || '');
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
          toast(t('nick_ok'), 'ok');
          loadChannels();
        } catch (e) {
          toast(t('nick_fail') + (e.message || e), 'err', 6000);
          nick.textContent = oldVal || '-';
        }
      }
      input.addEventListener('keydown', function (ev2) { if (ev2.key === 'Enter') { ev2.preventDefault(); doSave(); } if (ev2.key === 'Escape') { nick.textContent = oldVal || '-'; } });
      input.addEventListener('blur', function () { doSave(); });
      return;
    }

    var btn = ev.target.closest ? ev.target.closest('button[data-op]') : null;
    if (!btn) { return; }
    var row = channelRows[Number(btn.getAttribute('data-i'))];
    if (!row) { return; }
    var op = btn.getAttribute('data-op');
    if (op === 'chat') {
      openChannelGroupChat(row);
    } else if (op === 'test') {
      openTestModal(row);
    } else if (op === 'copy') {
      copyText(row.channelCode, t('copied_code'));
    } else if (op === 'edit') {
      openEdit(row);
    } else if (op === 'del') {
      el('delTarget').textContent = t('del_target') + (row.channelName || '') + ' · ' + maskCode(row.channelCode);
      el('delSubmit').setAttribute('data-code', row.channelCode);
      if (row.channelCode === getCode()) {
        el('delTarget').textContent += t('del_current_tip');
      }
      openModal('delModal');
    } else if (op === 'reset') {
      openReset(row);
    }
  });

  /**
   * 通道名右侧的「群聊」（仅浏览器类型通道 pushType=1）：
   * 这里没有群成员身份，只用通道名 + 通道码加入通道
   */
  function openChannelGroupChat(r) {
    if (!r || !r.channelCode) { toast(t('chat_invalid'), 'err'); return; }
    if (typeof WebsitePusher === 'undefined' || typeof WebsitePusher.init !== 'function') {
      toast(t('chat_unready'), 'err');
      return;
    }
    WebsitePusher.init({
      appName: r.channelName,
      channelCode: r.channelCode,
      hidePanel: 1,
      hideDialog: 0,
      danMu: 1
    });
  }

  /* -------- 测试推送弹窗（对齐官网：head/body/url/avatar + 实时 API 网址 + GET 推送） -------- */

  var testChannel = null; /* 当前测试目标通道 */

  /** 按推送类型切换三件套标签文案（9=企业微信应用用 企业ID/应用ID/应用Secret，邮箱用默认文案） */
  function setThreeLabels(type) {
    var l = threeLabels(type);
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
      '?head=' + encodeURIComponent(el('testHead').value.trim() || t('default_head'));
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
    el('testTitle').textContent = t('op_test') + (r.channelName || '');
    el('testHead').value = t('default_head');
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
    if (url) { copyText(url, t('copy_api_ok')); }
  });

  /**
   * 推送：GET 拼好的 API 网址直推（/services/push/send/{code}，与官网 testMessageSend 同链路）。
   * head/body/url/avatar 全参数支持，无需登录态。
   */
  async function onTestPush() {
    var btn = el('testPushBtn');
    if (!testChannel) { toast(t('no_test_channel'), 'err'); return; }
    if (!el('testHead').value.trim()) { toast(t('need_head'), 'err'); return; }
    btn.disabled = true; btn.textContent = t('push_sending');
    var link = el('testUrl').value.trim();
    var avatar = el('testAvatar').value.trim();
    if (link && !isUrl(link)) { toast(link + t('url_invalid'), 'ok', 6000); }
    if (avatar && !isUrl(avatar)) { toast(avatar + t('avatar_invalid'), 'ok', 6000); }
    try {
      var resp = await fetch(buildTestApiUrl(), { method: 'GET', headers: { 'Accept': 'application/json' } });
      var biz = await readJson(resp).catch(function (e) { throw new Error(e.message || '接口响应异常'); });
      if (biz.code !== 0) { throw new Error(biz.message || '推送失败'); }
      var isBrowser = (testChannel && testChannel.pushType === 1);
      toast(isBrowser ? t('test_push_ok_browser') : t('test_push_ok'), 'ok', 6000);
      closeModal('testModal');
    } catch (e) {
      toast(t('push_fail') + (e.message || e), 'err', 6000);
    } finally {
      btn.disabled = false; btn.textContent = t('btn_push');
    }
  }
  el('testPushBtn').addEventListener('click', onTestPush);

  /* -------- 新增 -------- */

  function fillTypeSelect() {
    var sel = el('addType');
    if (sel.options.length) { return; }
    PUSH_TYPE_DEFS.forEach(function (d) {
      var o = document.createElement('option');
      o.value = d.v; o.textContent = t(d.k);
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
    if (!getCode()) { toast(t('need_code_first'), 'err'); return; }
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
    if (!name) { err.textContent = t('need_name'); err.style.display = 'block'; return; }
    if (NEED_WEBHOOK[type] && !isUrl(hook)) {
      err.textContent = t('need_webhook');
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
    btn.disabled = true; btn.textContent = t('creating');
    try {
      var ch = await oauth('/oauth2/push/channel/add', params, true);
      closeModal('addModal');
      toast(t('created') + (ch && ch.channelCode || t('created_none')), 'ok', 8000);
      if (ch && ch.channelCode) { copyText(ch.channelCode, t('copied_new_code')); }
      loadChannels();
    } catch (e) {
      err.textContent = t('create_fail') + (e.message || e);
      err.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = t('btn_create');
    }
  }

  /* -------- 修改 -------- */

  var editTarget = null;

  function openEdit(r) {
    editTarget = r;
    el('editTarget').textContent = t('edit_target') + (r.channelName || '') + ' · ' + maskCode(r.channelCode) +
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
      el('editErr').textContent = t('edit_current_tip');
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
    if (!name) { err.textContent = t('need_name'); err.style.display = 'block'; return; }
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
    btn.disabled = true; btn.textContent = t('saving');
    try {
      await oauth('/oauth2/push/channel/edit', params, true);
      closeModal('editModal');
      toast(t('edit_ok'), 'ok');
      loadChannels();
    } catch (e) {
      err.textContent = t('edit_fail') + (e.message || e);
      err.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = t('btn_save');
    }
  }

  /* -------- 重置 -------- */

  var resetTarget = null;

  function openReset(r) {
    resetTarget = r;
    el('resetTarget').textContent = t('del_target') + (r.channelName || '') + ' · ' + maskCode(r.channelCode);
    var isCur = r.channelCode === getCode();
    el('resetTip').textContent = isCur ? t('reset_self_tip') : t('reset_tip');
    openModal('resetModal');
  }

  async function onResetSubmit() {
    if (!resetTarget) { return; }
    var oldCode = resetTarget.channelCode;
    var isCur = normCode(oldCode) === normCode(getCode());
    var btn = el('resetSubmit');
    btn.disabled = true; btn.textContent = t('resetting');
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
          changedTip.textContent = tpl('reset_changed', { old: oldCode, new: newCode });
          changedTip.style.display = 'block';
          el('codeInput').value = newCode;
          openSettings();
          toast(t('reset_ok'), 'ok');
        } else {
          toast(t('reset_ok'), 'ok');
          loadChannels();
        }
      } else {
        toast(t('reset_ok'), 'ok');
        loadChannels();
      }
    } catch (e) {
      toast(t('reset_fail') + (e.message || e), 'err', 6000);
    } finally {
      btn.disabled = false; btn.textContent = t('btn_confirm_reset');
    }
  }

  /* -------- 删除 -------- */

  async function onDelSubmit() {
    var code = el('delSubmit').getAttribute('data-code');
    if (!code) { return; }
    var btn = el('delSubmit');
    btn.disabled = true; btn.textContent = t('deleting');
    try {
      await oauth('/oauth2/push/channel/deleteChannel', { channelCode: code }, true);
      closeModal('delModal');
      toast(t('del_ok'), 'ok');
      loadChannels();
    } catch (e) {
      toast(t('del_fail') + (e.message || e), 'err', 6000);
      if (/当前应用绑定/.test(e.message || '')) { closeModal('delModal'); }
    } finally {
      btn.disabled = false; btn.textContent = t('btn_confirm_del');
    }
  }

  /* ---------------- 设置通道码 ---------------- */

  function updateCodeBtn() {
    var btn = el('codeBtn');
    var code = getCode();
    if (code) {
      btn.textContent = t('btn_code') + maskCode(code);
      btn.classList.add('has');
    } else {
      btn.textContent = t('btn_set_code');
      btn.classList.remove('has');
    }
  }

  function openSettings() {
    el('codeInput').value = getCode() || '';
    el('codeErr').style.display = 'none';
    el('codeChangedTip').style.display = 'none';
    updateCodePlaceholder(); /* 未设置通道码时，占位符带上 ping 返回的示例通道码，方便体验 */
    openModal('settingsModal');
    setTimeout(function () { el('codeInput').focus(); el('codeInput').select(); }, 60);
  }

  function onSaveCode() {
    var code = normCode(el('codeInput').value);
    var err = el('codeErr');
    if (!isCode(code)) {
      err.textContent = t('code_invalid');
      err.style.display = 'block';
      return;
    }
    setCode(code);
    dropToken();
    closeModal('settingsModal');
    updateCodeBtn();
    renderPushCard();
    toast(t('code_saved'), 'ok');
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
    toast(t('code_cleared'), 'ok');
    loadDemo();
    loadChannels();
  }

  /* ---------------- 启动 ---------------- */

  /** 从 URL 读 ?channelCode= 写入 LocalStorage（MCP 配置），然后自动加载子通道列表 */
  function readCodeFromUrl() {
    var m = new RegExp('[?&]channelCode=([^&#]*)').exec(window.location.search || '');
    if (!m) { return; }
    var code = normCode(decodeURIComponent((m[1] || '').replace(/\+/g, ' ')));
    if (!code) { return; }
    if (!isCode(code)) { toast(t('url_code_invalid'), 'err', 6000); return; }
    if (normCode(getCode()) !== code) {
      setCode(code);   /* 写入 LocalStorage['phprm_channel_code'] */
      dropToken();
    }
  }

  /* ---------------- 绑定与启动 ---------------- */

  /* Agent 指南药丸：复制 skill.md 地址（对勾反馈 1.5s，对齐官网 mcp.html） */
  el('agentGuideCopy').addEventListener('click', function () {
    var btn = this;
    var done = function () {
      btn.classList.add('is-copied');
      setTimeout(function () { btn.classList.remove('is-copied'); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(AGENT_GUIDE_URL).then(done, function () { fallbackCopy(AGENT_GUIDE_URL, done); });
    } else { fallbackCopy(AGENT_GUIDE_URL, done); }
  });

  el('langBtn').addEventListener('click', toggleLang);
  el('codeBtn').addEventListener('click', openSettings);
  el('saveCodeBtn').addEventListener('click', onSaveCode);
  el('clearCodeBtn').addEventListener('click', onClearCode);
  el('codeInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { onSaveCode(); } });

  el('sendBtn').addEventListener('click', onSend);
  el('demoQr').addEventListener('click', function () {
    if (demoChannel && demoChannel.qrCodeUrl) {
      el('qrTitle').textContent = t('qr_title') + '：' + (demoChannel.channelName || '');
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

  applyI18n();
  readCodeFromUrl();
  updateCodeBtn();
  updateShareBox();
  bindShareBox();
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
    setCode: function (c) { setCode(c); dropToken(); updateCodeBtn(); renderPushCard(); loadChannels(); },
    setLang: function (l) { LANG = (l === 'en-us' ? 'en-us' : 'zh-cn'); try { localStorage.setItem(LANG_KEY, LANG); } catch (e) {} applyI18n(); updateCodeBtn(); renderPushCard(); if (channelsMeta) { renderChannels(channelsMeta); } else { loadChannels(); } }
  };
})();
