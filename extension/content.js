// MAIN world 入口：core.js 已定义 PB_AFK_CORE，这里直接执行。
// world: "MAIN" 保证脚本与游戏同处一个 JS 世界，覆写 document.hidden /
// requestAnimationFrame 才能真正影响游戏。
PB_AFK_CORE();
