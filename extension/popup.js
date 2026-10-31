document.getElementById('toggle').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      await chrome.tabs.sendMessage(tab.id, { type: 'pbafk-toggle' });
    }
  } catch (e) {
    // 当前标签页不是 pokebonk.com（没有 content script）时忽略
  }
  window.close();
});
