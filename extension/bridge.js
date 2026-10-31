// 桥接：扩展弹窗（隔离世界）↔ 页面脚本（MAIN world）。
// 弹窗发 chrome.tabs.sendMessage → 这里转成 window.postMessage → 页面脚本接收。
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'pbafk-toggle') {
    window.postMessage({ __pbafk: 'toggle' }, '*');
  }
});
