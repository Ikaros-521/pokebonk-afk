// ==UserScript==
// @name         PokéBonk 后台挂机助手 (AFK Auto-Player)
// @namespace    pokebonk-afk
// @version      2.2.4
// @description  阻止切屏自动暂停、后台持续运行，并自动 WASD 绕圈 + 空格 + Shift 打怪；F8 启停，F9 面板显隐。仅在 pokebonk.com 生效。
// @author       ZCode
// @match        https://pokebonk.com/*
// @match        https://*.pokebonk.com/*
// @run-at       document-start
// @noframes
// @grant        none
// @inject-into  page
// @license MIT
// ==/UserScript==

(function () {
  'use strict';
/* ============================================================
 * PokéBonk 后台挂机助手 · 核心逻辑
 * 油猴脚本与 Chrome 扩展共用这一份代码。
 * 必须在 document-start（游戏脚本之前）运行。
 * ============================================================ */
function PB_AFK_CORE() {
  'use strict';
  var PB_AFK_VERSION = '2.2.4'; // 与油猴 @version / 扩展 manifest 同步（build.js 校验）
  if (window.__PB_AFK_ACTIVE__) return;
  window.__PB_AFK_ACTIVE__ = true;

  /* ---------------- 配置 ---------------- */
  var LS_KEY = 'pbafk.settings.v1';
  var DEFAULTS = {
    enabled: false,
    dir: 'cw',                                  // cw 顺时针 / ccw 逆时针
    phaseMs: 1000,                              // 绕圈每步时长（即圈大小）
    spaceMode: 'tap', spaceEvery: 400, spaceHold: 90,   // 空格：点按/长按/关
    shiftMode: 'tap', shiftEvery: 2000, shiftHold: 150, // Shift：点按/长按/关
    ultMode: 'tap', ultEvery: 900, ultHold: 120,        // 大招 R：有就放（间隔探一次）
    interactMode: 'tap', interactEvery: 1500,           // 交互 E：拾取/激活/捕捉（短间隔探）
    interactPick: 1,                                    // 交互弹窗选第几项（1-4；没有该项则兜底 1 → Esc）
    pickMode: 'quality',                                // 弹窗选择：quality=品质最高优先 / index=按序号
    pickLog: true,                                      // 自动选择时在屏幕上短暂提示选了什么
    circleMode: 'spring',                               // 绕圈模式：spring=弹簧前进扫图 / circle=原地闭合圆
    catchPriority: true,                                // 有等待捕捉的虚弱精灵时：停攻击、按罗盘方位追过去、E 扔球
    navMode: 'safe',                                    // 自动寻路：safe=走向安全可交互点(按下方多选+优先级) / off=关
    navItems: { altar: true, freechest: true, meowth: true, challenge: true, shrine: true, trick: true, ditto: true, magnet: true, snorlax: true, berry: true, hypno: false, egg: true },
    navOrder: ['altar', 'freechest', 'meowth', 'challenge', 'shrine', 'trick', 'ditto', 'magnet', 'snorlax', 'berry', 'hypno', 'egg'],
    autoUnpause: true,                          // 自动点"继续"关闭暂停
    autoRestart: true,                          // 死亡/胜利结算后自动再来一次
    autoReconnect: true,                        // 断线后自动点"重试"
    autoPick: true,                             // 自动选升级（第 1 项）
    keepAlive: true,                            // 近无声保活音频，防后台限流
    panelVisible: true,
    collapsed: false,
    panelX: null, panelY: null
  };
  var settings = Object.assign({}, DEFAULTS);
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) {}
  // v1.7.0→v1.8.1 一次性迁移：旧配置里新增点位（百变怪/磁铁/卡比兽/树果/引梦貘人）默认关，
  // 用户反馈"就在边上却没追踪"——未迁移的旧配置自动补开（手动关过的用户会打上 navMigrated 标记不受影响）
  if (settings.navItems && !settings.navMigrated && settings.navItems.snorlax === false) {
    ['ditto', 'magnet', 'snorlax', 'berry', 'hypno'].forEach(function (k) { settings.navItems[k] = true; });
  }
  settings.navMigrated = true;
  // v1.8.2 迁移：引梦貘人点位交互是"忘招式换钱"商店（有卡死风险且误删招式），默认改为不追踪
  if (!settings.navHypnoFixed) {
    if (settings.navItems) settings.navItems.hypno = false;
    settings.navHypnoFixed = true;
  }
  // v2.2.0 迁移：宝可梦蛋点位加入追踪（旧配置无此键默认开）
  if (settings.navItems && settings.navItems.egg === undefined) settings.navItems.egg = true;
  // enabled 会持久化：刷新/断线重连后若之前在挂机则自动恢复（见文件末尾）
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {} }

  /* ---------------- 1. rAF 后台接力（Web Worker 驱动） ----------------
   * 标签页被切到后台/被完全遮挡时，浏览器会停止派发 requestAnimationFrame，
   * 游戏主循环随之冻结。这里把 rAF 换成自家实现：
   * 前台走原生 rAF；后台改由 Worker 的 16ms 定时器驱动回调。 */
  var nativeRAF = window.requestAnimationFrame.bind(window);
  var nativeCAF = window.cancelAnimationFrame.bind(window);
  var byNative = new Map();   // myId -> nativeId（前台的映射）
  var byWorker = new Map();   // myId -> callback（后台排队的回调）
  var lastRafCb = null;       // 最近一次请求的回调，用于在切后台瞬间“踢醒”冻结的循环
  var rafSeq = 1;
  var worker = null, workerOn = false;
  var controllerTick = null;  // 自动化 tick 钩子，Worker 消息会驱动它（后台时 setInterval 被限流）
  var controllerTimer = null; // 前台 setInterval 备用驱动（Worker 不可用时兜底）

  function ensureWorker() {
    if (worker) return worker;
    var src = 'let on=false,t=null;onmessage=function(e){var d=e.data;' +
      'if(d&&d.on===true&&!on){on=true;t=setInterval(function(){postMessage(0)},16)}' +
      'else if(d&&d.on===false&&on){on=false;clearInterval(t)}}';
    try {
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch (e) { worker = null; return null; } // Worker 被禁用时走 setInterval 兜底
    worker.onmessage = function () {
      var now = performance.now();
      var jobs = [];
      byWorker.forEach(function (cb, id) { jobs.push([id, cb]); });
      byWorker.clear();
      for (var i = 0; i < jobs.length; i++) {
        try { jobs[i][1](now); } catch (e) {}
      }
      if (controllerTick) { try { controllerTick(now); } catch (e) {} }
      syncWorker();
    };
    return worker;
  }
  function syncWorker() {
    var need = !!controllerTick || byWorker.size > 0;
    if (need) {
      try { ensureWorker(); } catch (e) {}
      if (worker && !workerOn) { workerOn = true; worker.postMessage({ on: true }); }
    } else if (worker && workerOn) {
      workerOn = false; worker.postMessage({ on: false });
    }
  }

  window.requestAnimationFrame = function (cb) {
    var myId = rafSeq++;
    lastRafCb = cb;
    if (realHidden) {
      byWorker.set(myId, cb);
      syncWorker();
      return myId;
    }
    var nid = nativeRAF(function (t) { byNative.delete(myId); cb(t); });
    byNative.set(myId, nid);
    return myId;
  };
  window.cancelAnimationFrame = function (id) {
    if (byWorker.delete(id)) { syncWorker(); return; }
    var nid = byNative.get(id);
    if (nid != null) { byNative.delete(id); nativeCAF(nid); }
  };

  /* ---------------- 2. 真实可见性跟踪 + 防自动暂停 ----------------
   * 注意顺序：先注册“真实可见性跟踪器”，再注册事件拦截器，
   * 这样 visibilitychange 到达时我们仍能感知真实的 hidden 值。 */
  var realHidden = document.hidden;
  document.addEventListener('visibilitychange', function () {
    var was = realHidden;
    realHidden = document.hidden;
    if (realHidden && !was) {
      // 刚切到后台：踢醒被冻结的游戏循环，让它经由 Worker 继续跑
      var cb = lastRafCb; lastRafCb = null;
      if (cb) { try { cb(performance.now()); } catch (e) {} }
      syncWorker();
    } else if (!realHidden && was) {
      // 回到前台：把 Worker 排队的回调迁回原生 rAF
      var jobs = [];
      byWorker.forEach(function (cb2, id) { jobs.push([id, cb2]); });
      byWorker.clear();
      for (var i = 0; i < jobs.length; i++) {
        var nid = nativeRAF((function (id2, cb2) {
          return function (t) { byNative.delete(id2); cb2(t); };
        })(jobs[i][0], jobs[i][1]));
        byNative.set(jobs[i][0], nid);
      }
      syncWorker();
    }
  }, true);

  // 让游戏认为页面永远可见、永远聚焦（自动暂停的判断依据全部失效）
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
  } catch (e) {}
  try { document.hasFocus = function () { return true; }; } catch (e) {}

  // 拦截会触发暂停/清空按键的事件（我们注册在前，游戏监听器收不到）
  ['visibilitychange', 'blur', 'pagehide'].forEach(function (type) {
    window.addEventListener(type, function (e) { e.stopImmediatePropagation(); }, true);
    document.addEventListener(type, function (e) { e.stopImmediatePropagation(); }, true);
  });

  // 真实焦点跟踪（注册在拦截器之前，能收到真实事件）：
  // 用于"挂机未启动 + 页面在前台"时不打扰用户手动暂停
  var realFocused = true;
  window.addEventListener('focus', function () { realFocused = true; }, true);
  window.addEventListener('blur', function () { realFocused = false; }, true);

  /* ---------------- 3. 近无声保活音频 ----------------
   * 正在播放声音的标签页不受 Chrome 后台定时器限流。
   * 用极低振幅的音频（约 -40dB，基本听不见）骗过 audibility 检测。 */
  var ka = { on: false, ctx: null, aud: null, uri: null };
  function quietWavURI() {
    if (ka.uri) return ka.uri;
    var sr = 8000, n = 12000, amp = 2; // 8kHz 单声道 1.5 秒，振幅 2/128 ≈ -42dB
    var buf = new ArrayBuffer(44 + n);
    var dv = new DataView(buf);
    function w(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    w(36, 'data'); dv.setUint32(40, n, true);
    for (var i = 0; i < n; i++) dv.setUint8(44 + i, 128 + Math.round(amp * Math.sin(2 * Math.PI * 90 * i / sr)));
    var bin = '';
    var CHUNK = 0x8000;
    for (var j = 0; j < buf.byteLength; j += CHUNK) {
      bin += String.fromCharCode.apply(null, new Uint8Array(buf.slice(j, j + CHUNK)));
    }
    ka.uri = 'data:audio/wav;base64,' + btoa(bin);
    return ka.uri;
  }
  function startKeepAlive() {
    if (!settings.keepAlive || ka.on) return;
    ka.on = true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        var ctx = new AC();
        var osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 90;
        var g = ctx.createGain(); g.gain.value = 0.003;
        osc.connect(g); g.connect(ctx.destination); osc.start(0);
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume()['catch'](function () {});
        ka.ctx = ctx;
      }
    } catch (e) {}
    try {
      if (!ka.aud) {
        var a = new Audio(quietWavURI());
        a.loop = true; a.volume = 1;
        var p = a.play(); if (p && p['catch']) p['catch'](function () {});
        ka.aud = a;
      }
    } catch (e) {}
  }
  function stopKeepAlive() {
    try { if (ka.ctx) ka.ctx.close()['catch'](function () {}); } catch (e) {}
    try { if (ka.aud) { ka.aud.pause(); ka.aud.src = ''; } } catch (e) {}
    ka.ctx = null; ka.aud = null; ka.on = false;
  }
  // 音频启动需要一次真实用户手势；若通过弹窗/消息启动失败，等下次点击/按键时补上
  function armKeepAlive() {
    if (settings.enabled && settings.keepAlive) startKeepAlive();
  }
  window.addEventListener('pointerdown', armKeepAlive, true);
  window.addEventListener('keydown', armKeepAlive, true);

  /* ---------------- 4. 合成按键 ----------------
   * 游戏用 window 捕获阶段的监听器把 e.code 存进 Set（keydown 加 / keyup 删），
   * 不校验 isTrusted，合成事件完全可用。按键派发到 #game canvas 上，靠冒泡覆盖
   * window/document/body 上的所有监听器。 */
  var KEY = {
    w: { key: 'w', code: 'KeyW', keyCode: 87 },
    a: { key: 'a', code: 'KeyA', keyCode: 65 },
    s: { key: 's', code: 'KeyS', keyCode: 83 },
    d: { key: 'd', code: 'KeyD', keyCode: 68 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
    r: { key: 'r', code: 'KeyR', keyCode: 82 },
    e: { key: 'e', code: 'KeyE', keyCode: 69 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    one: { key: '1', code: 'Digit1', keyCode: 49 }
  };
  var DEF_BY_CODE = {};
  Object.keys(KEY).forEach(function (k) { DEF_BY_CODE[KEY[k].code] = KEY[k]; });

  var held = new Set();          // 当前按住的 code
  var pendingRelease = [];       // 点按模式下的待松开 {def, at}

  function fireTarget() {
    return document.getElementById('game') || document.querySelector('canvas') || document;
  }
  function makeKey(type, def, repeat) {
    var ev = new KeyboardEvent(type, {
      key: def.key, code: def.code,
      bubbles: true, cancelable: true, composed: true,
      repeat: !!repeat, location: def.location || 0
    });
    try {
      Object.defineProperty(ev, 'keyCode', { get: function () { return def.keyCode; } });
      Object.defineProperty(ev, 'which', { get: function () { return def.keyCode; } });
      Object.defineProperty(ev, 'charCode', { get: function () { return 0; } });
    } catch (e) {}
    return ev;
  }
  function fire(def, type, repeat) {
    try { fireTarget().dispatchEvent(makeKey(type, def, repeat)); } catch (e) {}
  }
  function press(def) { if (!held.has(def.code)) { held.add(def.code); fire(def, 'keydown'); } }
  function release(def) { if (held.has(def.code)) { held.delete(def.code); fire(def, 'keyup'); } }
  function tap(def, ms, now) { press(def); pendingRelease.push({ def: def, at: now + ms }); }
  function releaseAll() {
    Array.from(held).forEach(function (code) { var d = DEF_BY_CODE[code]; if (d) release(d); });
    pendingRelease.length = 0;
  }

  /* ---------------- 5. 自动化策略引擎 ----------------
   * 绕圈 = 八方向序列（W→WD→D→DS→…），每步 phaseMs 毫秒；
   * 空格/Shift 可独立设为 点按（间隔+按压时长）/ 长按 / 关闭。
   * 每个tick计算“期望按键集合”，与当前按住的做差量同步。 */
  var SEQ_CW  = ['w', 'wd', 'd', 'ds', 's', 'sa', 'a', 'aw'].map(function (g) {
    return g.split('').map(function (c) { return KEY[c]; });
  });
  var SEQ_CCW = ['w', 'wa', 'a', 'as', 's', 'sd', 'd', 'dw'].map(function (g) {
    return g.split('').map(function (c) { return KEY[c]; });
  });
  var startedAt = 0, lastTick = 0, lastAssert = 0;
  var lastSpace = 0, lastShift = 0, lastUlt = 0, lastInteract = 0, pickRetry = 0;
  // E 交互自适应退避：Esc 兜底触发（= E 弹窗选不了、人还在触发区）时翻倍延长 E 间隔，
  // 每 15 秒未再卡则减半，逐步恢复正常间隔，避免"弹窗→Esc→又弹"死循环
  var interactBackoff = 0, lastBackoffAt = 0;
  // 赌场（老虎机）逃逸标志：true 时 tick 停按 E，防止误触发抽奖烧钱
  var inCasino = false;
  // 自动寻路：游戏在 6-18m 内的可交互点（祭坛/宝箱/商店/挑战/圣地等）会显示 .wlabel
  // DOM 标签（含屏幕坐标）。检测到白名单点位时，把移动方向从绕圈覆盖为"朝标签走"，
  // 到达后 E 交互拾取，标签消失 1s 后恢复绕圈。老虎机/传送门/守护者等排除。
  // 自动寻路点位定义：words = 标签文本匹配词（当前语言），fn = 结构匹配（class 等）。
  // 官方中文名实证自 zh 语言包：供品(祭坛祝福)/免费(宝箱·精灵球)/商店(喵喵)/挑战/圣地/捣蛋/
  // 百变怪/磁力(磁铁)/卡比兽/树果/引梦貘人。老虎机(₽)/彼岸(传送门)/守护者/诅咒类排除。
  var NAV_DEFS = [
    { key: 'altar', name: '祭坛祝福', words: ['祭坛'], fn: function (el) { return el.classList.contains('charge'); } },
    { key: 'freechest', name: '免费宝箱·精灵球', words: ['免费', 'gratis'] },
    { key: 'meowth', name: '喵喵商店', words: ['商店', 'tienda'] },
    { key: 'challenge', name: '挑战', words: ['剩余', '挑战', 'desafío'] },
    { key: 'shrine', name: '圣地', words: ['圣地', 'santuario'] },
    { key: 'trick', name: '捣蛋', words: ['捣蛋', 'truco'] },
    { key: 'ditto', name: '百变怪', words: ['百变怪', 'ditto'] },
    { key: 'magnet', name: '磁铁', words: ['磁力', '磁铁', 'imán', 'magnet'] },
    { key: 'snorlax', name: '卡比兽', words: ['卡比兽', 'snorlax'] },
    { key: 'berry', name: '树果', words: ['树果', 'bayas', 'berry'] },
    { key: 'hypno', name: '引梦貘人', words: ['引梦', 'hypno'] },
    { key: 'egg', name: '宝可梦蛋', words: ['宝可梦蛋', '宠物蛋', 'egg'] }
  ];
  var NAV_DEFS_BY_KEY = {};
  NAV_DEFS.forEach(function (d) { NAV_DEFS_BY_KEY[d.key] = d; });
  function navLabelMatch(el, def) {
    if (def.fn && def.fn(el)) return true;
    var tx = (el.textContent || '').toLowerCase();
    var words = def.words || [];
    for (var i = 0; i < words.length; i++) {
      if (tx.indexOf(words[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }
  function navTargetText(el, def) { // 状态/toast 里的点位名：有名称定义用名称，否则标签原文
    return (def && def.name) ? def.name : (el.textContent || '').replace(/\s+/g, ' ').slice(0, 24);
  }
  var navTarget = null, lastNavSeen = 0, navWasActive = false;
  var navActiveState = false, navTextState = ''; // 供 updateStatus 读取
  var navArrivedAt = 0; // 到达点位（标签贴中心）时刻，超时拉黑放弃
  var navBlacklist = []; // 放弃过的标签位置 [{x,y,at}]，20s 内不再选中（防到达死循环）
  // 捕捉追捕：游戏罗盘（.compass）最高优先级指向"等待捕捉的虚弱精灵"（dataset.k 以
  // capture 专属色 #5af0ff 结尾；boss/友球/宝箱/totem/召唤点为其他颜色可排除）。
  // .cp-tip 的 rotate 角 = 目标屏幕方位，.cp-d 文本 = 距离。追捕模式：停攻击、按方位
  // 走过去、靠近后提示"[E] 投掷精灵球"亮起时 350ms 快按 E 扔球；罗盘消失 1.5s 后恢复。
  var CATCH_COLOR = '#5af0ff';
  var catchMode = false, lastCatchSeen = 0, wasCatchMode = false;
  var catchDir = null, catchDist = '';
  var compassVisibleStreak = 0; // 罗盘连续可见计数（防游戏帧重置 display 的竞态误判）
  var catchMemory = null; // 罗盘消失后的延续追捕记忆 {dir, distLeft, at}
  function parseMeters(txt) { // "48 米"/"48m" → 48；解析失败返回 999（视为很远，走满 10s）
    var m = String(txt || '').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 999;
  }
  // 弹簧绕圈（circleMode='spring'）：绕圈相位加权漂移——漂移方向的相位时长 ×2.5、
  // 相反方向 ×0.4，圈心缓慢朝漂移方向移动扫图；漂移方向每 12s 轮换，
  // 小地图画面静止（卡墙）×2 次立即轮换。导航/追捕接管时冻结相位。
  var DRIFT_PERIOD = 12000;
  var DRIFT_AXES = ['n', 'e', 's', 'w'];
  var DRIFT_NAMES = { n: '上', e: '右', s: '下', w: '左' };
  var driftIdx = 0, lastDriftChange = 0, wallHits = 0, lastWallCheck = 0, lastChecksum = -1;
  var springPhase = 0, lastPhaseAt = 0, curPhaseDur = 1000;
  var driftNameNow = '';
  function phaseAxis(phase, ccw) {
    var ccwA = ['n', 'nw', 'w', 'sw', 's', 'se', 'e', 'ne'];
    var cwA = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    return (ccw ? ccwA : cwA)[phase % 8];
  }
  var OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' };
  function phaseWeight(phase, driftAxis, ccw) {
    var axis = phaseAxis(phase, ccw);
    if (axis === driftAxis) return 2.5;
    if (axis === OPPOSITE[driftAxis]) return 0.4;
    return 1;
  }
  function mmChecksum() { // 小地图静止检测：多区域采样 + 加权哈希（避免求和碰撞误判"静止"）
    try {
      var mm = document.querySelector('.minimap');
      if (!mm || !mm.getContext) return -1;
      var ctx = mm.getContext('2d');
      if (!ctx) return -1;
      var W = mm.width || 400;
      // 采样 4 个角区域（避开中心玩家图标），每区域 40x40
      var h = 2166136261; // FNV 偏移基数
      var regions = [[40, 40], [W - 80, 40], [40, W - 80], [W - 80, W - 80]];
      for (var r = 0; r < 4; r++) {
        var d = ctx.getImageData(regions[r][0], regions[r][1], 40, 40).data;
        for (var i = 0; i < d.length; i += 61) {
          h = (h ^ (d[i] + (d[i + 1] << 8) + (d[i + 2] << 16) + r * 131)) >>> 0;
          h = (h * 16777619) >>> 0; // FNV 素数乘
        }
      }
      return h;
    } catch (e) { return -1; }
  }
  // 捕捉检测只信罗盘（.compass dataset.k capture 色 = 游戏官方判定的可捕捉信号，零误判）。
  // 小地图 canvas 像素识别方案已移除——画面高光/白点会误判，用户实测不可靠。
  function mmFindCapture() { return null; }
  // 地图标记追踪：玩家在 Tab 大地图点击放置的标记（最多 3 个）会生成 .compass.mkpin
  // DOM 元素（dataset.k=点位类型、.cp-tip rotate=方位、.cp-d=距离），4 米内自动清除。
  // 有标记时最高优先级响应：按方位走过去（用户手动放的标记=明确意图，类型不设限，
  // 卡比兽/宝可梦蛋/百变怪/任意点位均可）。
  var pinActive = false, pinDir = null, pinDist = '', pinKind = '', wasPinActive = false;
  function dirFromAngle(deg) { // 屏幕方位角(deg) → 八方向 WASD
    var o = { w: false, a: false, s: false, d: false };
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;
    if (deg > -22.5 && deg <= 22.5) o.d = true;
    else if (deg > 22.5 && deg <= 67.5) { o.d = true; o.s = true; }
    else if (deg > 67.5 && deg <= 112.5) o.s = true;
    else if (deg > 112.5 && deg <= 157.5) { o.a = true; o.s = true; }
    else if (deg > 157.5 || deg <= -157.5) o.a = true;
    else if (deg > -157.5 && deg <= -112.5) { o.a = true; o.w = true; }
    else if (deg > -112.5 && deg <= -67.5) o.w = true;
    else { o.d = true; o.w = true; }
    return o;
  }

  function num(v, d) { v = +v; return isFinite(v) && v > 0 ? v : d; }

  // ---- 自动恢复暂停 ----
  // 暂停界面（.modal）里的恢复途径是"继续"按钮（btn green big，onclick=run.resume()），
  // 类名随版本会变（v0.8.83 已无 .mp-pause），所以用多语言按钮文本匹配，Esc 不作为手段
  // （Esc 在部分界面是"返回"）。
  var RESUME_WORDS = ['continuar', 'continue', 'resume', 'reanudar', '继续', '繼續', '계속', '続き', 'продолж'];
  function findResumeButton(scope) {
    var list;
    try { list = (scope || document).querySelectorAll('button'); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) {
      var t = (list[i].textContent || '').trim().toLowerCase();
      if (!t) continue;
      for (var j = 0; j < RESUME_WORDS.length; j++) {
        if (t.indexOf(RESUME_WORDS[j]) !== -1) return list[i];
      }
    }
    return null;
  }

  // 结算界面（死亡/胜利）的"再来一次"按钮：modal 里的绿色大按钮
  var RESTART_WORDS = ['otra vez', '再来一次', '再來一次', 'again', 'retry', 'restart', 'nochmal'];
  function findRestartButton() {
    var list;
    try { list = document.querySelectorAll('.modal button.btn.green'); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) {
      var t = (list[i].textContent || '').trim().toLowerCase();
      for (var j = 0; j < RESTART_WORDS.length; j++) {
        if (t.indexOf(RESTART_WORDS[j]) !== -1) return list[i];
      }
    }
    return null;
  }

  function fireDigit(n) { // Digit1..4：选择弹窗快捷键
    var code = 'Digit' + n;
    var t = fireTarget();
    ['keydown', 'keyup'].forEach(function (type) {
      var ev = new KeyboardEvent(type, { key: String(n), code: code, bubbles: true, cancelable: true, composed: true, repeat: false });
      try {
        Object.defineProperty(ev, 'keyCode', { get: function () { return 48 + n; } });
        Object.defineProperty(ev, 'which', { get: function () { return 48 + n; } });
      } catch (e) {}
      try { t.dispatchEvent(ev); } catch (e) {}
    });
  }

  // ---- 品质识别：.top .rar 文本 → 等级分（越高越好），多语言表按"先具体后宽泛"排列 ----
  // 官方中文品质名（zh 语言包实证）：普通/少见/稀有/史诗/特殊/传说/神话/活动限定
  var RARITY_TIERS = [
    [/神话|神話|mythic|mítico/i, 5],
    [/传说|傳說|legendary|legendario/i, 4],
    [/史诗|史詩|epic|épico|에픽|エピック/i, 3],
    [/活动限定|活動限定|特殊|especial|special/i, 2.5],
    [/稀有|レア|레어|rare|raro/i, 2],
    [/少见|少見|非凡|uncommon|poco común|insólito/i, 1.5],
    [/普通|common|común|コモン|일반/i, 1]
  ];
  function rarityTier(text) {
    if (!text) return null;
    var t = String(text).toLowerCase();
    for (var i = 0; i < RARITY_TIERS.length; i++) {
      if (RARITY_TIERS[i][0].test(t)) return RARITY_TIERS[i][1];
    }
    return null; // 新招式卡显示"招式/Movimiento"等，无品质
  }
  // "已满"卡判定（百变怪复制等）：.kind 文本"已满/Máx."或半透明 opacity 0.45（点击无效）
  function cardFull(card) {
    var k = null;
    try { k = card.querySelector('.top .kind'); } catch (e) {}
    if (k) {
      var t = (k.textContent || '').trim();
      if (t === '已满' || /máx|max|full/i.test(t)) return true;
    }
    var op = parseFloat(card.style.opacity);
    return isFinite(op) && op < 0.9;
  }

  var watcherRetry = 0;
  // 轻量提示：屏幕上方短暂显示自动动作（~2s 自动消失），可关
  var toastBox = null;
  function pbToast(msg, color) {
    if (!settings.pickLog) return;
    try {
      if (!toastBox || !toastBox.isConnected) {
        toastBox = document.createElement('div');
        toastBox.id = 'pb-toasts';
        toastBox.style.cssText = 'position:fixed;top:12%;left:50%;transform:translateX(-50%);z-index:2147483646;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;';
        (document.body || document.documentElement).appendChild(toastBox);
      }
      var el = document.createElement('div');
      el.style.cssText = 'background:rgba(16,16,26,.92);color:#f4f1ff;border:2px solid ' + (color || '#3fd769') +
        ';border-radius:8px;padding:6px 16px;font:bold 15px/1.4 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.5);opacity:0;transition:opacity .18s;white-space:nowrap;';
      el.textContent = msg;
      toastBox.appendChild(el);
      while (toastBox.children.length > 3) toastBox.firstChild.remove();
      requestAnimationFrame(function () { el.style.opacity = '1'; });
      setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 300); }, 3500);
    } catch (e) {}
  }
  var toastAt = {};
  function pbToastOnce(key, ms, msg, color) {
    var now = performance.now();
    if (toastAt[key] && now - toastAt[key] < ms) return;
    toastAt[key] = now;
    pbToast(msg, color);
  }
  function overlayWatcherTick() {
    if (!settings.autoUnpause && !settings.autoRestart && !settings.autoPick && !settings.autoReconnect) { watcherRetry = 0; pickRetry = 0; return; }
    // 挂机运行中始终处理；挂机关闭时只在页面不在前台（用户切走了）才处理，
    // 避免用户本人正在操作界面时被抢点。
    if (!(settings.enabled || !realFocused)) { watcherRetry = 0; pickRetry = 0; return; }

    // 取最上层的游戏弹窗（升级三选一 / 暂停 / 结算 都是 .modal，类名随版本会变，
    // 所以只依赖 .modal 容器和按钮文本，不依赖具体面板类名）
    var modals;
    try { modals = document.querySelectorAll('.modal'); } catch (e) { return; }
    if (!modals.length) { watcherRetry = 0; pickRetry = 0; inCasino = false; return; }
    var modal = modals[modals.length - 1];

    // 0) 已知"只有退出键"的弹窗 → 自动点退出（合成 Esc 对这些弹窗无效）。
    //    遍历所有 .modal（多个弹窗共存时不再只看最后一个，避免选错元素漏处理）：
    //    a) 赌场/老虎机（.sl-*）→ 停按 E（防抽奖烧钱）+ 点"离开"
    //    b) 商店类（引梦貘人忘招商店等，.shop-exit"就绪"）
    //    c) 融合机器（正辉的机器，.fu-actions"以后再说"，Esc 标注但合成无效）
    var mi, mEl;
    for (mi = 0; mi < modals.length; mi++) {
      mEl = modals[mi];
      var casinoEl = null;
      try { casinoEl = mEl.querySelector('.sl-cab, .sl-lever, .sl-logo, .sl-window'); } catch (e) {}
      if (casinoEl) {
        inCasino = true;
        pbToastOnce('casino', 10000, '🎰 检测到赌场，自动离开（停按 E 防抽奖）', '#e94756');
        var cbtns = mEl.querySelectorAll('button');
        for (var ci = 0; ci < cbtns.length; ci++) {
          var ct = (cbtns[ci].textContent || '').trim();
          if (ct === '离开' || ct === '離開' || /^(salir|leave|exit)$/i.test(ct)) {
            try { cbtns[ci].click(); } catch (e) {}
            break;
          }
        }
        return;
      }
      var shopExit = null;
      try { shopExit = mEl.querySelector('.shop-exit'); } catch (e) {}
      if (shopExit) {
        pbToastOnce('shopExit', 5000, '🛍 商店弹窗，已自动点"就绪"关闭', '#ffc83a');
        try { shopExit.click(); } catch (e) {}
        return;
      }
      var laterBtn = null;
      try { laterBtn = mEl.querySelector('.fu-actions .btn, .dj-acts .btn.ghost'); } catch (e) {}
      if (laterBtn && /以后再说|más tarde|later/i.test((laterBtn.textContent || '').trim())) {
        pbToastOnce('fuExit', 5000, '🥋 挑战弹窗，已自动点"以后再说"', '#a35cff');
        try { laterBtn.click(); } catch (e) {}
        return;
      }
    }
    inCasino = false;
    for (mi = 0; mi < modals.length; mi++) {
      try { if (modals[mi].querySelector('.sl-cab, .sl-lever, .sl-logo, .sl-window')) { inCasino = true; break; } } catch (e) {}
    }

    // 1) 选择弹窗（升级三选一 / 百变怪复制 / 祭坛祝福等 cards 卡片）→ 自动选：
    //    品质优先作用于两类卡：.card.offer（升级卡，品质在 .top .rar 文本，5 档）和
    //    .card.mini（百变怪复制卡，品质在 --rc: var(--rN) 变量，r0-r4 同 5 档）。
    //    "已满"卡（.kind=已满/Máx. 或 opacity 0.45）自动跳过降级，全满按 Esc。
    //    融合/契约等弹窗（品质无法解析）fall through 按序号选。
    //    兜底链：按目标按数字键（有 .key 时）→ 无效则点目标卡 → 仍失败按 Esc。
    if (settings.autoPick && modal.querySelector('.cards .card')) {
      var cards = modal.querySelectorAll('.cards .card');
      pickRetry++;
      var pref = Math.min(4, Math.max(1, Math.round(+settings.interactPick || 1))) - 1;
      var qualityCapable = !!modal.querySelector('.cards .card.offer, .cards .card.mini');
      var target = 0;
      if (settings.pickMode === 'quality' && qualityCapable) {
        var bestTier = -1, ties = [];
        var fullCount = 0, scoreCount = 0;
        for (var q = 0; q < cards.length; q++) {
          var card = cards[q];
          var isOffer = card.classList.contains('offer');
          var isMini = card.classList.contains('mini');
          if (!isOffer && !isMini) continue; // 融合/契约等非品质卡不计
          if (cardFull(card)) { fullCount++; continue; }   // 已满卡跳过（自动降级）
          var tier = null;
          if (isOffer) {
            var rarEl = null;
            try { rarEl = card.querySelector('.top .rar'); } catch (e) {}
            tier = rarityTier(rarEl ? rarEl.textContent : '');
            if (tier == null) { // .rar 缺失/新招式卡 → 扫 .top 全文兜底
              var topEl = null;
              try { topEl = card.querySelector('.top'); } catch (e) {}
              tier = rarityTier(topEl ? topEl.textContent : '');
            }
          } else { // mini 卡：--rc: var(--rN) → N 即档位（r0 普通 ... r4 传说）
            var rc = card.style.getPropertyValue('--rc') || '';
            var mRC = rc.match(/--r(\d)/);
            tier = mRC ? (+mRC[1] + 1) : null;
          }
          if (tier == null) tier = -1;
          scoreCount++;
          if (tier > bestTier) { bestTier = tier; ties = [q]; }
          else if (tier === bestTier) ties.push(q);
        }
        if (scoreCount === 0 && fullCount > 0) {
          // 全部已满 → Esc 关闭（点了也无效）
          fire(KEY.esc, 'keydown'); fire(KEY.esc, 'keyup');
          pickRetry = 0;
          return;
        }
        target = ties.length ? (pref < ties.length ? ties[pref] : ties[0]) : 0;
      } else {
        target = Math.min(cards.length - 1, pref);
      }
      // mini 卡（百变怪复制等）无数字键，直接点卡；offer 卡优先数字键（更快）
      var useKey = !!cards[target].querySelector('.key');
      if (pickRetry === 1) {
        if (useKey) fireDigit(target + 1);
        else { try { cards[target].click(); } catch (e) {} }
        // 选择日志：品质 + 卡名（颜色用卡片自身品质色 --rc）
        var pickCard = cards[target];
        var pickRar = pickCard.querySelector('.top .rar') || pickCard.querySelector('.top .kind');
        var pickName = pickCard.querySelector('.bd h3');
        var pickColor = pickCard.style.getPropertyValue('--rc') || '#3fd769';
        var rcTier = (pickColor.match(/--r(\d)/) || [])[1];
        var rarName = pickRar ? pickRar.textContent : (rcTier ? ['普通', '少见', '稀有', '史诗', '传说'][+rcTier] || '' : '');
        pbToastOnce('pick' + Math.floor(performance.now() / 1000), 900,
          '自动选：' + (rarName || '奖励') + ' · ' + (pickName ? pickName.textContent : '未知'), pickColor.trim());
      } else if (pickRetry === 2) {
        try { if (cards[target] && cards[target].click) cards[target].click(); } catch (e) {}
      } else if (pickRetry >= 3) {
        try { if (cards[target] && cards[target].click) cards[target].click(); } catch (e) {}
      } else if (pickRetry >= 3) {
        fire(KEY.esc, 'keydown'); fire(KEY.esc, 'keyup'); // 最终兜底 Esc
        pickRetry = 0;
        // 弹窗选不了（多为 E 交互弹窗、人还在触发区）→ E 间隔翻倍退避，上限 60s
        var nb = interactBackoff ? interactBackoff * 2 : 3000;
        if (nb > 60000) nb = 60000;
        if (nb !== interactBackoff) console.log('[PokéBonk AFK] E 弹窗卡死，交互间隔延长至', Math.round((num(settings.interactEvery, 1500) + nb) / 100) / 10 + 's');
        interactBackoff = nb;
        lastBackoffAt = performance.now();
      }
      return;
    }
    pickRetry = 0;

    // 2) 暂停界面 → 点"继续"（多语言文本匹配；比 Esc 稳，Esc 在部分界面是返回）
    if (settings.autoUnpause) {
      var resume = findResumeButton(modal);
      if (resume) {
        pbToastOnce('resume', 5000, '▶ 检测到暂停，已自动继续', '#3fd769');
        try { resume.click(); } catch (e) {}
        return;
      }
    }

    // 3) 结算界面（死亡/胜利）→ 点"再来一次"
    if (settings.autoRestart) {
      var rb = findRestartButton();
      if (rb) {
        pbToastOnce('restart', 5000, '↺ 结算完成，自动再来一次', '#ffd23f');
        try { rb.click(); } catch (e) {}
      }
    }

    // 4) 断线界面（body>.loading 下的"重试"按钮）→ 自动重连
    if (settings.autoReconnect) {
      var lbtns = null;
      try { lbtns = document.querySelectorAll('.loading button'); } catch (e) {}
      if (lbtns) {
        for (var k = 0; k < lbtns.length; k++) {
          var lt = (lbtns[k].textContent || '').trim().toLowerCase();
          if (lt.indexOf('重试') !== -1 || lt.indexOf('reintentar') !== -1 || lt.indexOf('retry') !== -1 || lt.indexOf('reconnect') !== -1) {
            try { lbtns[k].click(); } catch (e) {}
            break;
          }
        }
      }
    }
  }

  function tick(now) {
    if (!settings.enabled) return;
    now = now || performance.now();
    if (now - lastTick < 40) return;
    lastTick = now;

    // ---- 自动寻路检测：多选点位按优先级排队，可见即导航 ----
    var navActive = false, navDir = null, navText = '';
    if (settings.navMode === 'safe') {
      try {
        var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        var labels = document.querySelectorAll('.wlabel');
        // 按优先级顺序（navOrder）遍历启用的点位类型，第一个有可见标签的类型即目标；
        // 同类型多个标签取离屏幕中心最近
        var order = settings.navOrder || [];
        var items = settings.navItems || {};
        for (var oi = 0; oi < order.length; oi++) {
          var key = order[oi];
          if (!items[key]) continue;
          var def = NAV_DEFS_BY_KEY[key];
          if (!def) continue;
          var best = null, bestD = 1e9;
          for (var li = 0; li < labels.length; li++) {
            var lb = labels[li];
            if (lb.style.display === 'none') continue;
            var op = parseFloat(lb.style.opacity);
            if (isFinite(op) && op < 0.15) continue;
            if (!navLabelMatch(lb, def)) continue;
            var lx = parseFloat(lb.style.left), ly = parseFloat(lb.style.top);
            if (!isFinite(lx) || !isFinite(ly)) continue;
            var d = Math.hypot(lx - cx, ly - cy);
            if (d < bestD) { bestD = d; best = { x: lx, y: ly, text: navTargetText(lb, def) }; }
          }
          if (best) { navTarget = best; lastNavSeen = now; break; } // 高优先级可见即选，排队语义
        }
        if (navTarget && now - lastNavSeen > 1200) navTarget = null; // 点位消失（已交互/走远）1.2s 后恢复
        // 兜底：白名单没匹配到 → 追踪任意可见可交互标签（排除要花钱的 ₽ 点位）
        if (!navTarget && settings.navAll) {
          var bd = null, bdD = 1e9;
          for (var bj = 0; bj < labels.length; bj++) {
            var bl = labels[bj];
            if (bl.style.display === 'none') continue;
            var bop = parseFloat(bl.style.opacity);
            if (isFinite(bop) && bop < 0.15) continue;
            var btx = bl.textContent || '';
            if (btx.indexOf('₽') !== -1) continue; // 老虎机/付费宝箱排除
            var bx = parseFloat(bl.style.left), by = parseFloat(bl.style.top);
            if (!isFinite(bx) || !isFinite(by)) continue;
            var bdd = Math.hypot(bx - cx, by - cy);
            if (bdd < bdD) { bdD = bdd; bd = { x: bx, y: by, text: btx.replace(/\s+/g, ' ').slice(0, 24) }; }
          }
          if (bd) { navTarget = bd; lastNavSeen = now; }
        }
      } catch (e) {}
      navActive = !!navTarget;
      if (navActive) {
        var dx = navTarget.x - cx, dy = navTarget.y - cy;
        var dead = 44; // 屏幕像素死区
        var dCenter = Math.hypot(dx, dy);
        // 黑名单：放弃过的标签位置（±60px 内）本轮不再选中，防止"到达→放弃→再选中"死循环
        for (var bl2 = navBlacklist.length - 1; bl2 >= 0; bl2--) {
          if (now - navBlacklist[bl2].at > 20000) { navBlacklist.splice(bl2, 1); continue; } // 20s 后解禁
          if (Math.hypot(navTarget.x - navBlacklist[bl2].x, navTarget.y - navBlacklist[bl2].y) < 60) {
            navTarget = null;
            break;
          }
        }
      }
      navActive = !!navTarget;
      if (navActive) {
        var dx = navTarget.x - cx, dy = navTarget.y - cy;
        var dead = 44; // 屏幕像素死区
        var dCenter = Math.hypot(dx, dy);
        if (dCenter < 70) {
          // 已到达点位（标签贴近屏幕中心）：站定不动，交给 E 定时拾取/激活；
          // 否则死区边缘抖动导致方向乱切 = 原地乱走
          navDir = null;
          if (!navArrivedAt) navArrivedAt = now;
          if (now - navArrivedAt > 6000) { // 6s 未交互完成 → 拉黑该位置并放弃
            navBlacklist.push({ x: navTarget.x, y: navTarget.y, at: now });
            navTarget = null;
          }
        } else {
          navArrivedAt = 0;
          navDir = {
            a: dx < -dead, d: dx > dead,
            w: dy < -dead, s: dy > dead
          };
        }
        if (navTarget !== null && !navWasActive) pbToastOnce('nav', 3000, '🧭 发现可交互点位，寻路前往：' + navTarget.text, '#36c96a');
      } else {
        navArrivedAt = 0;
        if (navWasActive) pbToastOnce('navDone', 3000, '🧭 点位交互完成，恢复转圈策略', '#3fd769');
      }
      navWasActive = navActive;
    } else {
      navTarget = null; navWasActive = false;
    }
    navActiveState = navActive;
    navTextState = navActive && navTarget ? navTarget.text : '';

    // ---- 地图标记追踪（最高优先级）：.compass.mkpin = 用户在 Tab 地图放的标记 ----
    pinActive = false; pinDir = null; pinDist = ''; pinKind = '';
    try {
      var pins = document.querySelectorAll('.compass.mkpin');
      for (var pi = 0; pi < pins.length; pi++) {
        var pin = pins[pi];
        if (pin.style.display === 'none') continue;
        var ptip = pin.querySelector('.cp-tip');
        var prot = parseFloat((ptip && ptip.style.transform || '').replace('rotate(', '').replace('rad)', ''));
        if (!isFinite(prot)) continue;
        pinKind = pin.dataset.k || '标记';
        var pdEl = pin.querySelector('.cp-d');
        pinDist = (pdEl && pdEl.textContent || '').trim();
        pinDir = dirFromAngle((prot - Math.PI / 2) * 180 / Math.PI);
        pinActive = true;
        break;
      }
    } catch (e) {}
    if (pinActive && !wasPinActive) pbToastOnce('pinEnter', 3000, '📍 前往地图标记：' + (pinKind || '目标') + (pinDist ? '（' + pinDist + '）' : ''), '#ffd23a');
    if (!pinActive && wasPinActive) pbToastOnce('pinExit', 3000, '📍 到达地图标记，恢复转圈策略', '#ffd23a');
    wasPinActive = pinActive;

    // ---- 捕捉追捕检测（双源）----
    //   a) 罗盘指向 capture 色 marker = 有**已虚弱**精灵等待捕捉（近距离，prompt 可扔球）
    //   b) 小地图青色环 = **未虚弱**的可捕捉目标（蛋/野生精灵等，60m 全径，超范围钳到边缘）
    //   追捕时朝目标方向走；未虚弱目标不停攻击（打残它触发 weakened）；靠近后扔球。
    var catchDirActive = false, catchSource = '';
    try {
      var comp = document.querySelector('.compass');
      if (comp && comp.style.display !== 'none' &&
          typeof comp.dataset.k === 'string' &&
          comp.dataset.k.lastIndexOf(CATCH_COLOR) === comp.dataset.k.length - CATCH_COLOR.length) {
        compassVisibleStreak++; // 连续可见计数：游戏帧会闪断重置 display，单次可见是竞态噪声
        if (compassVisibleStreak >= 2) {
          var tip = comp.querySelector('.cp-tip');
          var rot = parseFloat((tip && tip.style.transform || '').replace('rotate(', '').replace('rad)', ''));
          if (isFinite(rot)) {
            var dir = dirFromAngle((rot - Math.PI / 2) * 180 / Math.PI);
            var dEl = comp.querySelector('.cp-d');
            catchDir = dir; catchDist = (dEl ? dEl.textContent : '').trim();
            catchDirActive = true; catchSource = 'compass';
            lastCatchSeen = now;
          }
        }
      } else {
        compassVisibleStreak = 0;
      }
    } catch (e) {}
    if (!catchDirActive && settings.catchPriority) { // 罗盘无信号 → 小地图找青色捕捉环
      var mmR = mmFindCapture();
      if (mmR) {
        catchDir = dirFromAngle(mmR.deg);
        catchDist = mmR.dist + '米';
        catchDirActive = true; catchSource = 'mm';
        lastCatchSeen = now;
      }
    }
    // 停攻击仅针对"已虚弱等球"的罗盘追捕（防误杀其他怪）；小地图追捕继续攻击（打残目标触发 weakened）
    catchMode = settings.catchPriority && catchDirActive;
    if (catchMode) {
      // 罗盘可见时：记录最后方向与剩余距离（"48 米" → 米数），供信号消失后延续追捕
      catchMemory = { dir: catchDir, distLeft: parseMeters(catchDist), at: now };
    } else if (catchMemory && settings.catchPriority && now - catchMemory.at < 10000 && catchMemory.distLeft > 2) {
      // 罗盘消失（目标进入屏幕后 HUD 常会消失）：沿最后方向延续追捕，最长 10 秒或剩余距离走完；
      // 期间若 prompt"[E] 投掷精灵球"亮起（真正进入 E 范围）会在 E 分支处理
      var movedM = (now - catchMemory.at) / 1000 * 6; // 估算速度 6m/s
      if (movedM < catchMemory.distLeft) {
        catchDir = catchMemory.dir;
        catchDist = Math.max(1, Math.round(catchMemory.distLeft - movedM)) + '米(延续)';
        catchMode = true;
        catchSource = 'memory';
        pbToastOnce('catchMemory', 4000, '🎯 HUD 消失，按最后方向延续追捕（' + catchDist + '）', '#36c96a');
      } else {
        catchMemory = null; // 距离走完仍未捕获 → 放弃
      }
    } else if (catchMemory && (now - catchMemory.at >= 10000)) {
      catchMemory = null; // 10 秒超时放弃
    }
    if (catchMode && !wasCatchMode) pbToastOnce('catchEnter', 3000, '🎯 发现可捕捉目标，追捕中' + (catchDist ? '（' + catchDist + '）' : '') + (catchSource === 'mm' ? ' · 保持攻击打残它' : ''), '#36c96a');
    if (!catchMode && wasCatchMode) pbToastOnce('catchExit', 3000, '捕捉结束，恢复转圈策略', '#3fd769');
    wasCatchMode = catchMode;


    var seq = settings.dir === 'ccw' ? SEQ_CCW : SEQ_CW;
    var basePhaseMs = Math.max(80, num(settings.phaseMs, 1000));
    var springActive = settings.circleMode === 'spring';

    // ---- 弹簧绕圈：漂移方向相位加权（同向 ×2.5 / 反向 ×0.4 → 圈心缓慢漂移扫图），
    //      卡墙检测（小地图画面 0.8s 无变化×2 次 = 顶着墙）→ 自动轮换漂移方向；
    //      12s 无卡墙也定期轮换；导航/追捕/标记接管时冻结相位推进。 ----
    var DRIFT_AXES = ['n', 'e', 's', 'w'];
    var DRIFT_NAMES = { n: '上', e: '右', s: '下', w: '左' };
    if (springActive) {
      if (now - lastDriftChange > DRIFT_PERIOD) {
        driftIdx = (driftIdx + 1) % 4;
        lastDriftChange = now;
        wallHits = 0;
      }
      if (now - lastWallCheck > 800) {
        lastWallCheck = now;
        // 转向后 3s 冷却：贴新方向正常移动的画面变化期不判墙
        if (now - lastDriftChange > 3000) {
          var sum = mmChecksum();
          if (sum >= 0) {
            if (sum === lastChecksum) wallHits++; else wallHits = 0;
            lastChecksum = sum;
            if (wallHits >= 3) { // 连续 3 次静止（2.4s）才判碰壁，画面抖动不触发
              driftIdx = (driftIdx + 1) % 4;
              wallHits = 0;
              lastDriftChange = now;
              pbToastOnce('wall' + driftIdx + Math.floor(now / 30000), 8000, '🧱 疑似碰壁，弹簧漂移已转向' + DRIFT_NAMES[DRIFT_AXES[driftIdx]], '#a35cff');
            }
          }
        }
      }
      // 导航/追捕/标记接管移动时冻结相位推进（恢复后从原相位继续）
      if (pinActive || catchMode || navActive) lastPhaseAt = now;
      else if (now - lastPhaseAt >= curPhaseDur) {
        lastPhaseAt += curPhaseDur;
        springPhase = (springPhase + 1) % 8;
        curPhaseDur = basePhaseMs * phaseWeight(springPhase, DRIFT_AXES[driftIdx], settings.dir === 'ccw');
      }
    }
    var phase = springActive ? springPhase : Math.floor((now - startedAt) / basePhaseMs) % seq.length;
    var phaseMs = springActive ? curPhaseDur : basePhaseMs;

    var want = new Set();
    if (pinActive && pinDir) {
      // 地图标记（最高优先级）：用户手动放置，按方位走过去；保留攻击（路过清怪）
      if (pinDir.w) want.add(KEY.w.code);
      if (pinDir.s) want.add(KEY.s.code);
      if (pinDir.a) want.add(KEY.a.code);
      if (pinDir.d) want.add(KEY.d.code);
    } else if (catchMode && catchDir) {
      // 追捕模式：按罗盘方位走向虚弱精灵（覆盖绕圈）；
      // 延续追捕（memory）时沿最后方向走，不停攻击（打残触发虚弱）
      if (catchDir.w) want.add(KEY.w.code);
      if (catchDir.s) want.add(KEY.s.code);
      if (catchDir.a) want.add(KEY.a.code);
      if (catchDir.d) want.add(KEY.d.code);
    } else if (navActive) {
      // 寻路模式：朝标签走；已到达（标签贴屏幕中心）时站定等 E 拾取，不乱按方向键
      if (navDir) {
        if (navDir.w) want.add(KEY.w.code);
        if (navDir.s) want.add(KEY.s.code);
        if (navDir.a) want.add(KEY.a.code);
        if (navDir.d) want.add(KEY.d.code);
      }
    } else {
      seq[phase].forEach(function (d) { want.add(d.code); });
    }
    // 追捕期间停空格/Shift/R 仅限"已虚弱等球"的罗盘追捕（防误杀其他怪）；
    // 小地图追捕（目标未虚弱）不停攻击——攻击正是把目标打残进 weakened 的手段
    var holdAttacks = catchMode && catchSource === 'compass';
    if (!holdAttacks && settings.spaceMode === 'hold') {
      want.add(KEY.space.code);
    } else if (!holdAttacks && settings.spaceMode === 'tap' && now - lastSpace >= num(settings.spaceEvery, 400)) {
      lastSpace = now; tap(KEY.space, num(settings.spaceHold, 90), now); want.add(KEY.space.code);
    }
    if (!holdAttacks && settings.shiftMode === 'hold') {
      want.add(KEY.shift.code);
    } else if (!holdAttacks && settings.shiftMode === 'tap' && now - lastShift >= num(settings.shiftEvery, 2000)) {
      lastShift = now; tap(KEY.shift, num(settings.shiftHold, 150), now); want.add(KEY.shift.code);
    }
    // 大招 R：充能好就放（未充能时按了也无副作用，间隔探一次）
    if (!holdAttacks && settings.ultMode === 'hold') {
      want.add(KEY.r.code);
    } else if (!holdAttacks && settings.ultMode === 'tap' && now - lastUlt >= num(settings.ultEvery, 900)) {
      lastUlt = now; tap(KEY.r, num(settings.ultHold, 120), now); want.add(KEY.r.code);
    }
    // 交互 E：拾取/激活/捕捉（无目标时按了无副作用，短间隔探；卡死时自动退避延长）
    // 赌场（老虎机）界面里禁按 E——E 会触发抽奖烧钱
    // 追捕模式："[E] 投掷精灵球"提示可见（精灵进 E 范围）时 350ms 快按扔球
    var promptCatch = false;
    try {
      var pEl = document.querySelector('#ui .prompt, .prompt');
      if (pEl && pEl.style.display !== 'none') {
        var ptxt = pEl.textContent || '';
        promptCatch = ptxt.indexOf('投掷精灵球') !== -1 || /pok[eé]\s* ?ball/i.test(ptxt);
      }
    } catch (e) {}
    if (settings.interactMode === 'tap' && !inCasino) {
      // 每 15 秒未再触发退避 → 间隔减半，逐步恢复正常
      if (interactBackoff > 0 && now - lastBackoffAt > 15000) {
        interactBackoff = Math.floor(interactBackoff / 2);
        lastBackoffAt = now;
      }
      var effEvery = catchMode ? 350 : ((navActive || pinActive) ? 500 : (Math.max(150, num(settings.interactEvery, 1500)) + interactBackoff));
      if (!catchMode || promptCatch) {
        if (now - lastInteract >= effEvery) {
          lastInteract = now; tap(KEY.e, 60, now); want.add(KEY.e.code);
        }
      }
    }

    // 先处理到期的松开
    for (var i = pendingRelease.length - 1; i >= 0; i--) {
      if (now >= pendingRelease[i].at) {
        var pd = pendingRelease[i].def;
        pendingRelease.splice(i, 1);
        release(pd);
      }
    }
    // 差量同步：多按的松开（点按中等待松开的除外），缺的按下
    var releasing = new Set(pendingRelease.map(function (p) { return p.def.code; }));
    Array.from(held).forEach(function (code) {
      if (!want.has(code) && !releasing.has(code)) {
        var d = DEF_BY_CODE[code]; if (d) release(d);
      }
    });
    want.forEach(function (code) {
      if (!held.has(code)) {
        var d = DEF_BY_CODE[code]; if (d) press(d);
      }
    });

    // 定期重发 keydown，兜底游戏内部清空按键集合（如失焦 clear）
    if (now - lastAssert > 2000) {
      lastAssert = now;
      Array.from(held).forEach(function (code) {
        var d = DEF_BY_CODE[code]; if (d) fire(d, 'keydown', false);
      });
    }

    updateStatus();
  }

  // 悬浮层守护器：暂停自动恢复 + 结算自动重开，独立于挂机开关，每 800ms 检查一次
  setInterval(function () { try { overlayWatcherTick(); } catch (e) {} }, 800);

  /* ---------------- 6. 启停控制 ---------------- */
  function startAutomation() {
    if (settings.enabled) return;
    settings.enabled = true; save();
    startedAt = performance.now();
    lastTick = 0; lastSpace = 0; lastShift = 0; lastUlt = 0; pickRetry = 0; watcherRetry = 0;
    // 弹簧相位重置（从当前相位重新开始）
    springPhase = 0; lastPhaseAt = performance.now(); curPhaseDur = Math.max(80, num(settings.phaseMs, 1000));
    wallHits = 0; lastChecksum = -1; lastWallCheck = 0;
    controllerTick = tick;
    try { if (settings.keepAlive) startKeepAlive(); } catch (e) {}
    try { syncWorker(); } catch (e) {}
    // setInterval 备用驱动：Worker 失效/被禁时前台节奏不中断（后台仍靠 Worker）
    if (!controllerTimer) {
      controllerTimer = setInterval(function () { try { tick(); } catch (e) {} }, 50);
    }
    updateStatus();
  }
  function stopAutomation() {
    if (!settings.enabled) return;
    settings.enabled = false; save();
    controllerTick = null;
    if (controllerTimer) { clearInterval(controllerTimer); controllerTimer = null; }
    releaseAll();
    stopKeepAlive();
    syncWorker();
    updateStatus();
  }
  function toggleAutomation() { settings.enabled ? stopAutomation() : startAutomation(); }

  // 扩展弹窗/外部通过 postMessage 触发启停
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.__pbafk === 'toggle') toggleAutomation();
  });

  // 快捷键：F8 启停挂机，F9 显隐面板
  window.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return;
    if (e.code === 'F8' && !e.repeat) {
      e.preventDefault(); e.stopPropagation();
      toggleAutomation();
    } else if (e.code === 'F9' && !e.repeat) {
      e.preventDefault(); e.stopPropagation();
      setPanelVisible(!settings.panelVisible);
    }
  }, true);

  /* ---------------- 7. 控制面板 UI ---------------- */
  var panelEl, statusEl, dotEl, toggleBtn;
  var lastStatusText = '';

  function modeText(m) { return m === 'tap' ? '点按' : (m === 'hold' ? '长按' : '关'); }

  function updateStatus() {
    if (!statusEl) return;
    var txt = settings.enabled
      ? '运行中 · ' + (settings.dir === 'ccw' ? '逆时针' : '顺时针') +
        (settings.circleMode === 'spring' ? ' · 🌀弹簧(' + (DRIFT_NAMES[DRIFT_AXES[driftIdx]] || '') + '漂)' : ' · 闭合圆') +
        ' · 空格' + modeText(settings.spaceMode) + ' · Shift' + modeText(settings.shiftMode) +
        (settings.ultMode === 'off' ? '' : ' · R有就放') +
        (settings.interactMode === 'off' ? '' : ' · E拾取') +
        (pinActive ? ' · 📍标记:' + (pinKind || '') + (pinDist || '') : '') +
        (catchMode ? ' · 🎯追捕' + (catchSource === 'mm' ? '(小地图)' : '') + (catchDist || '') : '') +
        (navActiveState ? ' · 🧭寻路:' + navTextState : '')
      : '已停止 · 按 F8 或点按钮启动';
    if (txt !== lastStatusText) { lastStatusText = txt; statusEl.textContent = txt; }
    if (dotEl) dotEl.className = 'pb-dot' + (settings.enabled ? ' on' : '');
    if (toggleBtn) {
      toggleBtn.textContent = settings.enabled ? '⏹ 停止挂机' : '▶ 启动挂机';
      toggleBtn.className = 'pb-toggle' + (settings.enabled ? ' on' : '');
    }
  }

  function row(labelText, control) {
    var r = document.createElement('div'); r.className = 'pb-row';
    var l = document.createElement('span'); l.textContent = labelText; l.className = 'pb-lb';
    r.appendChild(l); r.appendChild(control);
    return r;
  }
  function checkRow(labelText, key) {
    var wrap = document.createElement('label'); wrap.className = 'pb-row pb-chk';
    var box = document.createElement('input'); box.type = 'checkbox';
    box.checked = !!settings[key];
    box.addEventListener('change', function () { settings[key] = box.checked; save(); });
    var span = document.createElement('span'); span.textContent = labelText;
    wrap.appendChild(box); wrap.appendChild(span);
    return wrap;
  }
  function numRow(labelText, key, min, max, step) {
    var input = document.createElement('input');
    input.type = 'number'; input.className = 'pb-num';
    input.min = min; input.max = max; input.step = step || 10;
    input.value = settings[key];
    input.addEventListener('change', function () {
      var v = +input.value; if (!isFinite(v)) v = DEFAULTS[key];
      v = Math.min(max, Math.max(min, v));
      input.value = v; settings[key] = v; save();
    });
    return row(labelText, input);
  }
  function selRow(labelText, key, opts) {
    var sel = document.createElement('select'); sel.className = 'pb-sel';
    opts.forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op);
    });
    sel.value = settings[key];
    sel.addEventListener('change', function () { settings[key] = sel.value; save(); updateStatus(); });
    return row(labelText, sel);
  }

  function injectStyles() {
    var css = [
      '#pbafk-panel{position:fixed;z-index:2147483647;top:12px;right:12px;width:238px;',
      'font:12px/1.55 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8e8f0;',
      'background:rgba(16,16,26,.93);border:1px solid rgba(255,255,255,.16);',
      'border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.5);user-select:none}',
      '#pbafk-panel *{box-sizing:border-box;margin:0}',
      '.pb-head{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:move;font-weight:700;font-size:12.5px}',
      '.pb-dot{width:9px;height:9px;border-radius:50%;background:#5a5a6a;flex:none}',
      '.pb-dot.on{background:#3fd769;box-shadow:0 0 7px #3fd769}',
      '.pb-title{flex:1;pointer-events:none}',
      '.pb-min{cursor:pointer;border:none;background:rgba(255,255,255,.08);color:#e8e8f0;',
      'width:20px;height:20px;border-radius:6px;line-height:1;font-size:12px}',
      '.pb-body{padding:2px 10px 8px;display:grid;gap:6px;max-height:calc(100vh - 120px);overflow-y:auto;overscroll-behavior:contain}',
      '.pb-sec{border-top:1px solid rgba(255,255,255,.08)}',
      '.pb-sechd{display:flex;align-items:center;justify-content:space-between;padding:7px 10px 3px;cursor:pointer;font-weight:700;font-size:12px;color:#b8b8d0;user-select:none}',
      '.pb-sechd:hover{color:#fff}',
      '.pb-arr{font-style:normal;font-size:10px}',
      '.pb-seccb{display:grid;gap:6px;padding:2px 10px 8px}',
      '.pb-toggle{width:100%;padding:8px;border:none;border-radius:8px;font-weight:800;font-size:13px;',
      'cursor:pointer;background:#2fae4f;color:#fff}',
      '.pb-toggle.on{background:#d64545}',
      '.pb-status{opacity:.72;text-align:center;font-size:11.5px}',
      '.pb-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.pb-lb{opacity:.85;flex:none}',
      '.pb-sel,.pb-num{background:#22222f;color:#e8e8f0;border:1px solid rgba(255,255,255,.18);',
      'border-radius:6px;padding:3px 5px;font:12px system-ui;width:106px}',
      '.pb-num{width:78px;text-align:right}',
      '.pb-chk{cursor:pointer}',
      '.pb-chk input{accent-color:#2fae4f}',
      '.pb-navlist{display:grid;gap:3px;max-height:132px;overflow-y:auto;border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:4px;background:rgba(0,0,0,.25)}',
      '.pb-navrow{display:flex;align-items:center;gap:5px;font-size:11.5px}',
      '.pb-navrow input{accent-color:#36c96a}',
      '.pb-navnm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.pb-navbtn{width:18px;height:16px;flex:none;border:none;border-radius:3px;background:rgba(255,255,255,.1);color:#e8e8f0;font-size:9px;cursor:pointer;padding:0;line-height:1}',
      '.pb-navbtn:hover{background:rgba(255,255,255,.22)}',
      '.pb-tip{padding:6px 10px 9px;opacity:.5;font-size:10.5px;border-top:1px solid rgba(255,255,255,.08)}'
    ].join('');
    var st = document.createElement('style');
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function setPanelVisible(v) {
    settings.panelVisible = !!v; save();
    if (panelEl) panelEl.style.display = v ? '' : 'none';
  }

  var navListEl = null;
  function renderNavList() {
    if (!navListEl) return;
    navListEl.innerHTML = '';
    var order = settings.navOrder || [];
    order.forEach(function (key) {
      var def = NAV_DEFS_BY_KEY[key];
      if (!def) return;
      var row = document.createElement('div');
      row.className = 'pb-navrow';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!(settings.navItems && settings.navItems[key]);
      cb.addEventListener('change', function () {
        if (!settings.navItems) settings.navItems = {};
        settings.navItems[key] = cb.checked;
        save();
      });
      var nm = document.createElement('span');
      nm.className = 'pb-navnm';
      nm.textContent = def.name;
      nm.title = '勾选追踪，▲▼ 调优先级（越靠上越优先）';
      var up = document.createElement('button');
      up.className = 'pb-navbtn';
      up.textContent = '▲';
      up.addEventListener('click', function () { moveNav(key, -1); });
      var dn = document.createElement('button');
      dn.className = 'pb-navbtn';
      dn.textContent = '▼';
      dn.addEventListener('click', function () { moveNav(key, 1); });
      row.appendChild(cb);
      row.appendChild(nm);
      row.appendChild(up);
      row.appendChild(dn);
      navListEl.appendChild(row);
    });
  }
  function moveNav(key, dir) {
    var arr = settings.navOrder || [];
    var i = arr.indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    arr.splice(i, 1);
    arr.splice(j, 0, key);
    save();
    renderNavList();
  }

  function buildPanel() {
    if (panelEl || !document.body) return;
    injectStyles();

    panelEl = document.createElement('div');
    panelEl.id = 'pbafk-panel';

    var head = document.createElement('div'); head.className = 'pb-head';
    dotEl = document.createElement('span'); dotEl.className = 'pb-dot';
    var title = document.createElement('span'); title.className = 'pb-title'; title.textContent = 'PokéBonk 挂机助手';
    var minBtn = document.createElement('button'); minBtn.className = 'pb-min'; minBtn.textContent = '—';
    minBtn.addEventListener('click', function () {
      var body = panelEl.querySelector('.pb-body');
      var collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      settings.collapsed = !collapsed; save();
      minBtn.textContent = collapsed ? '—' : '+';
    });
    head.appendChild(dotEl); head.appendChild(title); head.appendChild(minBtn);

    var body = document.createElement('div'); body.className = 'pb-body';
    if (settings.collapsed) { body.style.display = 'none'; minBtn.textContent = '+'; }

    toggleBtn = document.createElement('button'); toggleBtn.className = 'pb-toggle';
    toggleBtn.addEventListener('click', toggleAutomation);

    statusEl = document.createElement('div'); statusEl.className = 'pb-status';

    body.appendChild(toggleBtn);
    body.appendChild(statusEl);

    // 分组折叠布局：避免配置项过多溢出屏幕，每组可独立展开/收起
    var GROUPS = [
      { key: 'atk', name: '移动与攻击', defOpen: true, build: function (b) {
        b.appendChild(selRow('绕圈模式', 'circleMode', [['spring', '弹簧前进(扫图)'], ['circle', '原地闭合圆']]));
        b.appendChild(selRow('绕圈方向', 'dir', [['cw', '顺时针 ↻'], ['ccw', '逆时针 ↺']]));
        b.appendChild(numRow('圈大小(ms/步)', 'phaseMs', 80, 3000, 10));
        b.appendChild(selRow('空格攻击', 'spaceMode', [['tap', '点按'], ['hold', '长按'], ['off', '关']]));
        b.appendChild(numRow('空格间隔', 'spaceEvery', 100, 5000, 50));
        b.appendChild(selRow('Shift 技能', 'shiftMode', [['tap', '点按'], ['hold', '长按'], ['off', '关']]));
        b.appendChild(numRow('Shift间隔', 'shiftEvery', 300, 10000, 50));
        b.appendChild(selRow('大招 R', 'ultMode', [['tap', '有就放'], ['hold', '长按'], ['off', '关']]));
        b.appendChild(numRow('R间隔', 'ultEvery', 200, 10000, 50));
      } },
      { key: 'inter', name: '交互 · 捕捉 · 寻路', defOpen: true, build: function (b) {
        b.appendChild(selRow('交互 E', 'interactMode', [['tap', '点按'], ['off', '关']]));
        b.appendChild(numRow('E间隔', 'interactEvery', 150, 5000, 50));
        b.appendChild(checkRow('优先追捕可捕捉目标', 'catchPriority'));
        b.appendChild(selRow('自动寻路点位', 'navMode', [['safe', '开启(按下方多选)'], ['off', '关']]));
        navListEl = document.createElement('div');
        navListEl.className = 'pb-navlist';
        b.appendChild(navListEl);
        renderNavList();
      } },
      { key: 'auto', name: '弹窗与自动化', defOpen: false, build: function (b) {
        b.appendChild(selRow('弹窗选择', 'pickMode', [['quality', '品质优先'], ['index', '按序号']]));
        b.appendChild(selRow('弹窗选第几项', 'interactPick', [['1', '第 1 项'], ['2', '第 2 项'], ['3', '第 3 项'], ['4', '第 4 项']]));
        b.appendChild(checkRow('自动选升级(第1项)', 'autoPick'));
        b.appendChild(checkRow('自动关闭暂停(点继续)', 'autoUnpause'));
        b.appendChild(checkRow('结算后自动再来一次', 'autoRestart'));
        b.appendChild(checkRow('断线自动点重试', 'autoReconnect'));
        b.appendChild(checkRow('选择日志提示', 'pickLog'));
        b.appendChild(checkRow('后台保活音(近无声)', 'keepAlive'));
      } }
    ];
    var uiGroup = settings.uiGroup || {};
    GROUPS.forEach(function (g) {
      var sec = document.createElement('div'); sec.className = 'pb-sec';
      var hd = document.createElement('div'); hd.className = 'pb-sechd';
      var nm = document.createElement('span'); nm.textContent = g.name;
      var arr = document.createElement('i'); arr.className = 'pb-arr';
      hd.appendChild(nm); hd.appendChild(arr);
      var cnt = document.createElement('div'); cnt.className = 'pb-seccb';
      g.build(cnt);
      var open = uiGroup[g.key] !== undefined ? !!uiGroup[g.key] : !!g.defOpen;
      function apply() {
        cnt.style.display = open ? '' : 'none';
        arr.textContent = open ? '▾' : '▸';
      }
      hd.addEventListener('click', function () {
        open = !open;
        uiGroup[g.key] = open;
        save();
        apply();
      });
      apply();
      sec.appendChild(hd);
      sec.appendChild(cnt);
      body.appendChild(sec);
    });

    var tip = document.createElement('div'); tip.className = 'pb-tip';
    tip.textContent = 'v' + PB_AFK_VERSION + ' · F8 启停 · F9 显隐面板 · 仅 pokebonk.com 生效';

    panelEl.appendChild(head); panelEl.appendChild(body); panelEl.appendChild(tip);
    document.body.appendChild(panelEl);

    // 面板拖动
    var dragX = 0, dragY = 0, dragging = false;
    head.addEventListener('pointerdown', function (e) {
      if (e.target === minBtn) return;
      dragging = true;
      var rect = panelEl.getBoundingClientRect();
      dragX = e.clientX - rect.left; dragY = e.clientY - rect.top;
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var x = Math.min(window.innerWidth - 60, Math.max(4, e.clientX - dragX));
      var y = Math.min(window.innerHeight - 30, Math.max(4, e.clientY - dragY));
      panelEl.style.left = x + 'px'; panelEl.style.top = y + 'px';
      panelEl.style.right = 'auto';
    });
    head.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      settings.panelX = parseInt(panelEl.style.left, 10) || null;
      settings.panelY = parseInt(panelEl.style.top, 10) || null;
      save();
    });

    if (settings.panelX != null && settings.panelY != null) {
      panelEl.style.left = settings.panelX + 'px';
      panelEl.style.top = settings.panelY + 'px';
      panelEl.style.right = 'auto';
    }
    setPanelVisible(settings.panelVisible !== false);
    updateStatus();
  }

  function whenBody(cb) {
    if (document.body) { cb(); return; }
    document.addEventListener('DOMContentLoaded', cb, { once: true });
    var iv = setInterval(function () {
      if (document.body) { clearInterval(iv); cb(); }
    }, 200);
    setTimeout(function () { clearInterval(iv); }, 30000);
  }
  whenBody(function () {
    try { buildPanel(); } catch (e) { console.warn('[PokéBonk AFK] UI 构建失败:', e); }
  });

  // 断线重连/刷新后自动恢复挂机：上一局会话里挂机是开着的，就继续开着
  // （手动停止会把 enabled 存为 false，所以不会违背用户意愿）
  if (settings.enabled) {
    setTimeout(function () { try { startAutomation(); } catch (e) {} }, 1500);
  }

  console.log('%c[PokéBonk AFK]%c v' + PB_AFK_VERSION + ' 已加载 · F8 启停 · F9 面板显隐',
    'color:#3fd769;font-weight:bold', '');

  // 控制句柄：可在控制台用 __PBAFK__.start() / .stop() / .toggle() 直接操作
  window.__PBAFK__ = {
    start: startAutomation,
    stop: stopAutomation,
    toggle: toggleAutomation,
    settings: settings,
    status: function () {
      return { enabled: settings.enabled, held: Array.from(held), pendingRelease: pendingRelease.length };
    }
  };
}

  /* ---------------- 注入保障 ----------------
  * 防暂停覆写（document.hidden 等）必须发生在页面主世界才能影响游戏。
  * Tampermonkey/Violentmonkey 配合 @inject-into page 通常已直接在主世界运行；
  * 若脚本被放进隔离沙箱（浏览器未开开发者模式等），则用 <script> 标签把核心
  * 注入主世界重跑一次。 */
  function runInPageWorld() {
    try {
      var probe = document.createElement('script');
      probe.textContent = 'window.__pbafk_probe=(window.__pbafk_probe||0)+1;';
      (document.head || document.documentElement).appendChild(probe);
      probe.remove();
      if (window.__pbafk_probe === 1) { PB_AFK_CORE(); return; } // 已在主世界
    } catch (e) {}
    try {
      var s = document.createElement('script');
      s.textContent = '(' + PB_AFK_CORE.toString() + ')();';
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      return;
    } catch (e) {}
    try { PB_AFK_CORE(); } catch (e2) {}
    console.warn('[PokéBonk AFK] 无法注入页面主世界，功能受限。');
  }
  runInPageWorld();
})();
