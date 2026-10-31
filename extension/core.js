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
  var RARITY_TIERS = [
    [/神话|神話|mythic|mítico|신화|神話/i, 5],
    [/传说|傳說|legendary|legendario|전설|伝説/i, 4],
    [/史诗|史詩|epic|épico|에픽|エピック/i, 3],
    [/稀有|レア|레어|rare|raro/i, 2],
    [/非凡|uncommon|poco común/i, 1.5],
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
    //    quality 模式（默认）：识别每张卡 .top .rar 的品质文本，选品质最高的；
    //    同品质并列时用"弹窗选第几项"做 tie-break；无品质卡（新招式）排最后。
    //    index 模式：直接选"弹窗选第几项"。
    //    兜底链：按目标按数字键 → 无效则点目标卡 → 仍失败按 Esc。
    if (settings.autoPick && modal.querySelector('.cards .card')) {
      var cards = modal.querySelectorAll('.cards .card');
      pickRetry++;
      var target = 0;
      var pref = Math.min(4, Math.max(1, Math.round(+settings.interactPick || 1))) - 1;
      if (settings.pickMode === 'quality') {
        var bestTier = -1, ties = [];
        for (var q = 0; q < cards.length; q++) {
          var rarEl = null;
          try { rarEl = cards[q].querySelector('.top .rar'); } catch (e) {}
          var tier = rarityTier(rarEl ? rarEl.textContent : '');
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
      if (resume) { try { resume.click(); } catch (e) {} return; }
    }

    // 3) 结算界面（死亡/胜利）→ 点"再来一次"
    if (settings.autoRestart) {
      var rb = findRestartButton();
      if (rb) { try { rb.click(); } catch (e) {} }
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
    if (now - lastTick < 40) return; // Worker(16ms) 与 setInterval(50ms) 双驱动去重
    lastTick = now;

    var seq = settings.dir === 'ccw' ? SEQ_CCW : SEQ_CW;
    var phaseMs = Math.max(80, num(settings.phaseMs, 1000));
    var phase = Math.floor((now - startedAt) / phaseMs) % seq.length;

    var want = new Set();
    seq[phase].forEach(function (d) { want.add(d.code); });
    if (settings.spaceMode === 'hold') {
      want.add(KEY.space.code);
    } else if (settings.spaceMode === 'tap' && now - lastSpace >= num(settings.spaceEvery, 400)) {
      lastSpace = now; tap(KEY.space, num(settings.spaceHold, 90), now); want.add(KEY.space.code);
    }
    if (settings.shiftMode === 'hold') {
      want.add(KEY.shift.code);
    } else if (settings.shiftMode === 'tap' && now - lastShift >= num(settings.shiftEvery, 2000)) {
      lastShift = now; tap(KEY.shift, num(settings.shiftHold, 150), now); want.add(KEY.shift.code);
    }
    // 大招 R：充能好就放（未充能时按了也无副作用，间隔探一次）
    if (settings.ultMode === 'hold') {
      want.add(KEY.r.code);
    } else if (settings.ultMode === 'tap' && now - lastUlt >= num(settings.ultEvery, 900)) {
      lastUlt = now; tap(KEY.r, num(settings.ultHold, 120), now); want.add(KEY.r.code);
    }
    // 交互 E：拾取/激活/捕捉（无目标时按了无副作用，短间隔探；卡死时自动退避延长）
    // 赌场（老虎机）界面里禁按 E——E 会触发抽奖烧钱
    if (settings.interactMode === 'tap' && !inCasino) {
      // 每 15 秒未再触发退避 → 间隔减半，逐步恢复正常
      if (interactBackoff > 0 && now - lastBackoffAt > 15000) {
        interactBackoff = Math.floor(interactBackoff / 2);
        lastBackoffAt = now;
      }
      var effEvery = Math.max(150, num(settings.interactEvery, 1500)) + interactBackoff;
      if (now - lastInteract >= effEvery) {
        lastInteract = now; tap(KEY.e, 90, now); want.add(KEY.e.code);
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
        (settings.interactMode === 'off' ? '' : ' · E拾取')
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
    body.appendChild(selRow('弹窗选择', 'pickMode', [['quality', '品质优先'], ['index', '按序号']]));
    body.appendChild(selRow('弹窗选第几项', 'interactPick', [['1', '第 1 项'], ['2', '第 2 项'], ['3', '第 3 项'], ['4', '第 4 项']]));
    body.appendChild(checkRow('自动关闭暂停(点继续)', 'autoUnpause'));
    body.appendChild(checkRow('结算后自动再来一次', 'autoRestart'));
    body.appendChild(checkRow('断线自动点重试', 'autoReconnect'));
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
