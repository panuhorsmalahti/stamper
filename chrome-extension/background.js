// Sends a URL to the stamper native messaging host, which opens it in a new
// iTerm2 tab with `stamper <url>`. Install the host with:
//   stamper --install-chrome-extension
const HOST = 'com.panuhorsmalahti.stamper';

async function openInStamper(url, tabId) {
  if (!url || !/^https?:\/\//.test(url)) {
    return report(tabId, 'Only http(s) pages can be opened in stamper');
  }
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, { url });
    if (!res?.ok) return report(tabId, res?.error ?? 'stamper host failed');
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'Open in stamper' });
  } catch (e) {
    const msg = String(e?.message ?? e);
    report(tabId, /not found/i.test(msg) ? 'Run `stamper --install-chrome-extension` first' : msg);
  }
}

/** Errors show as a "!" badge; the tooltip says what went wrong. */
async function report(tabId, message) {
  console.warn('stamper:', message);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d33' });
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setTitle({ tabId, title: `stamper: ${message}` });
}

chrome.action.onClicked.addListener((tab) => openInStamper(tab.url, tab.id));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'page', title: 'Open page in stamper', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'link', title: 'Open link in stamper', contexts: ['link'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  openInStamper(info.menuItemId === 'link' ? info.linkUrl : info.pageUrl, tab?.id);
});
