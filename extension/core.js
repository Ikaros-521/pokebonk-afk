/* ============================================================
 * PokéBonk 后台挂机助手 · 核心逻辑
 * 油猴脚本与 Chrome 扩展共用这一份代码。
 * 必须在 document-start（游戏脚本之前）运行。
 * ============================================================ */
function PB_AFK_CORE() {
  'use strict';
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
    catchPriority: true,                                // 有等待捕捉的虚弱精灵时：停攻击、按罗盘方位追过去、E 扔球
    navMode: 'safe',                                    // 自动寻路：safe=走向安全可交互点(按下方多选+优先级) / off=关
    navItems: { altar: true, freechest: true, meowth: true, challenge: true, shrine: true, trick: true, ditto: false, magnet: false, snorlax: false, berry: false, hypno: false },
    navOrder: ['altar', 'freechest', 'meowth', 'challenge', 'shrine', 'trick', 'ditto', 'magnet', 'snorlax', 'berry', 'hypno'],
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
    { key: 'hypno', name: '引梦貘人', words: ['引梦', 'hypno'] }
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
  // 捕捉追捕：游戏罗盘（.compass）最高优先级指向"等待捕捉的虚弱精灵"（dataset.k 以
  // capture 专属色 #5af0ff 结尾；boss/友球/宝箱/totem/召唤点为其他颜色可排除）。
  // .cp-tip 的 rotate 角 = 目标屏幕方位，.cp-d 文本 = 距离。追捕模式：停攻击、按方位
  // 走过去、靠近后提示"[E] 投掷精灵球"亮起时 350ms 快按 E 扔球；罗盘消失 1.5s 后恢复。
  var CATCH_COLOR = '#5af0ff';
  var catchMode = false, lastCatchSeen = 0, wasCatchMode = false;
  var catchDir = null, catchDist = '';
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

    // 0) 赌场/老虎机界面（.sl-* 专属类名）→ 停按 E（E 会触发抽奖烧钱），
    //    自动点"离开"退出（Esc 在该界面无效）。此步优先级最高。
    var casinoEl = null;
    try { casinoEl = modal.querySelector('.sl-cab, .sl-lever, .sl-logo, .sl-window'); } catch (e) {}
    if (casinoEl) {
      inCasino = true;
      pbToastOnce('casino', 10000, '🎰 检测到赌场，自动离开（停按 E 防抽奖）', '#e94756');
      var cbtns = modal.querySelectorAll('button');
      for (var ci = 0; ci < cbtns.length; ci++) {
        var ct = (cbtns[ci].textContent || '').trim();
        if (ct === '离开' || ct === '離開' || /^(salir|leave|exit)$/i.test(ct)) {
          try { cbtns[ci].click(); } catch (e) {}
          break;
        }
      }
      return;
    }
    inCasino = false;

    // 1) 选择弹窗（升级三选一 / 祭坛祝福等 cards 卡片）→ 自动选：
    //    品质优先只作用于 .card.offer（升级卡：技能强化/新招式/维生素/道具统一结构，
    //    品质在 .top .rar，5 档：普通<少见<稀有<史诗<传说）；融合/契约等弹窗的 .rar
    //    是别的语义，fall through 按序号选。同品质并列用"弹窗选第几项"tie-break。
    //    兜底链：按目标按数字键 → 无效则点目标卡 → 仍失败按 Esc。
    if (settings.autoPick && modal.querySelector('.cards .card')) {
      var cards = modal.querySelectorAll('.cards .card');
      pickRetry++;
      var pref = Math.min(4, Math.max(1, Math.round(+settings.interactPick || 1))) - 1;
      var hasOffer = !!modal.querySelector('.cards .card.offer');
      var target = 0;
      if (settings.pickMode === 'quality' && hasOffer) {
        var bestTier = -1, ties = [];
        for (var q = 0; q < cards.length; q++) {
          var card = cards[q];
          if (!card.classList.contains('offer')) continue; // 融合/契约等非品质卡不计
          var rarEl = null;
          try { rarEl = card.querySelector('.top .rar'); } catch (e) {}
          var tier = rarityTier(rarEl ? rarEl.textContent : '');
          if (tier == null) { // .rar 缺失/新招式卡 → 扫 .top 全文兜底
            var topEl = null;
            try { topEl = card.querySelector('.top'); } catch (e) {}
            tier = rarityTier(topEl ? topEl.textContent : '');
          }
          if (tier == null) tier = -1;
          if (tier > bestTier) { bestTier = tier; ties = [q]; }
          else if (tier === bestTier) ties.push(q);
        }
        target = ties.length ? (pref < ties.length ? ties[pref] : ties[0]) : 0;
      } else {
        target = Math.min(cards.length - 1, pref);
      }
      if (pickRetry === 1) {
        fireDigit(target + 1);
        // 选择日志：品质 + 卡名（颜色用卡片自身品质色 --rc）
        var pickCard = cards[target];
        var pickRar = pickCard.querySelector('.top .rar');
        var pickName = pickCard.querySelector('.bd h3');
        var pickColor = pickCard.style.getPropertyValue('--rc') || '#3fd769';
        pbToastOnce('pick' + Math.floor(performance.now() / 1000), 900,
          '自动选：' + ((pickRar ? pickRar.textContent : '') || '新招式') + ' · ' + (pickName ? pickName.textContent : '未知'), pickColor.trim());
      } else if (pickRetry === 2) {
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
      } catch (e) {}
      navActive = !!navTarget;
      if (navActive) {
        var dx = navTarget.x - cx, dy = navTarget.y - cy;
        var dead = 44; // 屏幕像素死区，防止贴近时抖动
        navDir = {
          a: dx < -dead, d: dx > dead,
          w: dy < -dead, s: dy > dead
        };
        if (navTarget !== null && !navWasActive) pbToastOnce('nav', 3000, '🧭 发现可交互点位，寻路前往：' + navTarget.text, '#36c96a');
      } else if (navWasActive) {
        pbToastOnce('navDone', 3000, '🧭 点位交互完成，恢复转圈策略', '#3fd769');
      }
      navWasActive = navActive;
    } else {
      navTarget = null; navWasActive = false;
    }
    navActiveState = navActive;
    navTextState = navActive && navTarget ? navTarget.text : '';

    // ---- 捕捉追捕检测：罗盘指向 capture 色 marker = 有等待捕捉的虚弱精灵 ----
    var catchDirActive = false;
    try {
      var comp = document.querySelector('.compass');
      if (comp && comp.style.display !== 'none' &&
          typeof comp.dataset.k === 'string' &&
          comp.dataset.k.lastIndexOf(CATCH_COLOR) === comp.dataset.k.length - CATCH_COLOR.length) {
        var tip = comp.querySelector('.cp-tip');
        var rot = parseFloat((tip && tip.style.transform || '').replace('rotate(', '').replace('rad)', ''));
        if (isFinite(rot)) {
          var dir = dirFromAngle((rot - Math.PI / 2) * 180 / Math.PI);
          var dEl = comp.querySelector('.cp-d');
          catchDir = dir; catchDist = (dEl ? dEl.textContent : '').trim();
          catchDirActive = true;
          lastCatchSeen = now;
        }
      }
    } catch (e) {}
    catchMode = settings.catchPriority && (now - lastCatchSeen < 1500);
    if (catchMode && !wasCatchMode) pbToastOnce('catchEnter', 3000, '🎯 发现等待捕捉的精灵，追捕中' + (catchDist ? '（' + catchDist + '）' : ''), '#36c96a');
    if (!catchMode && wasCatchMode) pbToastOnce('catchExit', 3000, '捕捉结束，恢复转圈策略', '#3fd769');
    wasCatchMode = catchMode;


    var seq = settings.dir === 'ccw' ? SEQ_CCW : SEQ_CW;
    var phaseMs = Math.max(80, num(settings.phaseMs, 1000));
    var phase = Math.floor((now - startedAt) / phaseMs) % seq.length;

    var want = new Set();
    if (catchMode && catchDirActive && catchDir) {
      // 追捕模式：按罗盘方位走向虚弱精灵（覆盖绕圈），停攻击防误杀
      if (catchDir.w) want.add(KEY.w.code);
      if (catchDir.s) want.add(KEY.s.code);
      if (catchDir.a) want.add(KEY.a.code);
      if (catchDir.d) want.add(KEY.d.code);
    } else if (navActive && navDir) {
      // 寻路模式：移动方向覆盖绕圈，朝屏幕上的点位标签走
      if (navDir.w) want.add(KEY.w.code);
      if (navDir.s) want.add(KEY.s.code);
      if (navDir.a) want.add(KEY.a.code);
      if (navDir.d) want.add(KEY.d.code);
    } else {
      seq[phase].forEach(function (d) { want.add(d.code); });
    }
    // 追捕/寻路期间停空格/Shift/R——防止打死要抓的精灵
    if (!catchMode && settings.spaceMode === 'hold') {
      want.add(KEY.space.code);
    } else if (settings.spaceMode === 'tap' && now - lastSpace >= num(settings.spaceEvery, 400)) {
      lastSpace = now; tap(KEY.space, num(settings.spaceHold, 90), now); want.add(KEY.space.code);
    }
    if (settings.shiftMode === 'hold') {
      want.add(KEY.shift.code);
    } else if (!catchMode && settings.shiftMode === 'tap' && now - lastShift >= num(settings.shiftEvery, 2000)) {
      lastShift = now; tap(KEY.shift, num(settings.shiftHold, 150), now); want.add(KEY.shift.code);
    }
    // 大招 R：充能好就放（未充能时按了也无副作用，间隔探一次）
    if (!catchMode && settings.ultMode === 'hold') {
      want.add(KEY.r.code);
    } else if (!catchMode && settings.ultMode === 'tap' && now - lastUlt >= num(settings.ultEvery, 900)) {
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
      var effEvery = catchMode ? 350 : (navActive ? 500 : (Math.max(150, num(settings.interactEvery, 1500)) + interactBackoff));
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
        ' · 空格' + modeText(settings.spaceMode) + ' · Shift' + modeText(settings.shiftMode) +
        (settings.ultMode === 'off' ? '' : ' · R有就放') +
        (settings.interactMode === 'off' ? '' : ' · E拾取') +
        (catchMode ? ' · 🎯追捕' + (catchDist || '') : '') +
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
      '.pb-body{padding:2px 10px 8px;display:grid;gap:6px}',
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
    body.appendChild(selRow('绕圈方向', 'dir', [['cw', '顺时针 ↻'], ['ccw', '逆时针 ↺']]));
    body.appendChild(numRow('圈大小(ms/步)', 'phaseMs', 80, 3000, 10));
    body.appendChild(selRow('空格攻击', 'spaceMode', [['tap', '点按'], ['hold', '长按'], ['off', '关']]));
    body.appendChild(numRow('空格间隔', 'spaceEvery', 100, 5000, 50));
    body.appendChild(selRow('Shift 技能', 'shiftMode', [['tap', '点按'], ['hold', '长按'], ['off', '关']]));
    body.appendChild(numRow('Shift间隔', 'shiftEvery', 300, 10000, 50));
    body.appendChild(selRow('大招 R', 'ultMode', [['tap', '有就放'], ['hold', '长按'], ['off', '关']]));
    body.appendChild(numRow('R间隔', 'ultEvery', 200, 10000, 50));
    body.appendChild(selRow('交互 E', 'interactMode', [['tap', '点按'], ['off', '关']]));
    body.appendChild(numRow('E间隔', 'interactEvery', 150, 5000, 50));
    body.appendChild(checkRow('优先追捕虚弱精灵', 'catchPriority'));
    body.appendChild(selRow('自动寻路点位', 'navMode', [['safe', '开启(按下方多选)'], ['off', '关']]));
    navListEl = document.createElement('div');
    navListEl.className = 'pb-navlist';
    body.appendChild(navListEl);
    renderNavList();
    body.appendChild(selRow('弹窗选择', 'pickMode', [['quality', '品质优先'], ['index', '按序号']]));
    body.appendChild(selRow('弹窗选第几项', 'interactPick', [['1', '第 1 项'], ['2', '第 2 项'], ['3', '第 3 项'], ['4', '第 4 项']]));
    body.appendChild(checkRow('自动关闭暂停(点继续)', 'autoUnpause'));
    body.appendChild(checkRow('结算后自动再来一次', 'autoRestart'));
    body.appendChild(checkRow('断线自动点重试', 'autoReconnect'));
    body.appendChild(checkRow('选择日志提示', 'pickLog'));
    body.appendChild(checkRow('自动选升级(第1项)', 'autoPick'));
    body.appendChild(checkRow('后台保活音(近无声)', 'keepAlive'));

    var tip = document.createElement('div'); tip.className = 'pb-tip';
    tip.textContent = 'F8 启停 · F9 显隐面板 · 仅 pokebonk.com 生效';

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

  console.log('%c[PokéBonk AFK]%c 已加载 · F8 启停 · F9 面板显隐',
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
