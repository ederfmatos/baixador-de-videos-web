// Service worker: detecta vídeos por aba observando o tráfego de rede,
// mantém o estado em memória e expõe mensagens para o popup e content script.

const VIDEO_EXTENSIONS = ["mp4", "webm", "ogg", "ogv", "mov", "m4v"];
const VIDEO_CONTENT_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v"];
const HLS_CONTENT_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
];

// Map<tabId, Map<url, videoInfo>>
const videosByTab = new Map();

function getTabMap(tabId) {
  let map = videosByTab.get(tabId);
  if (!map) {
    map = new Map();
    videosByTab.set(tabId, map);
  }
  return map;
}

function extensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "";
  } catch (e) {
    return "";
  }
}

function looksLikeVideoUrl(url) {
  const ext = extensionFromUrl(url);
  return VIDEO_EXTENSIONS.includes(ext);
}

async function isDomainBlacklisted(url) {
  try {
    const host = new URL(url).hostname;
    const { blacklist = [] } = await chrome.storage.local.get("blacklist");
    return blacklist.some((d) => host === d || host.endsWith("." + d));
  } catch (e) {
    return false;
  }
}

function updateBadge(tabId) {
  const map = videosByTab.get(tabId);
  const count = map ? map.size : 0;
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e11d48" });
}

async function addVideo(tabId, info) {
  if (tabId < 0 || !info.url) return;
  if (await isDomainBlacklisted(info.url)) return;

  const map = getTabMap(tabId);
  const existing = map.get(info.url) || {};
  map.set(info.url, { ...existing, ...info });
  updateBadge(tabId);
}

// Detecção principal: inspeciona os headers da resposta (Content-Type / Content-Length).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = details.responseHeaders || [];
    let contentType = "";
    let contentLength = 0;
    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === "content-type") contentType = (h.value || "").split(";")[0].trim().toLowerCase();
      if (name === "content-length") contentLength = parseInt(h.value || "0", 10) || 0;
    }

    const ext = extensionFromUrl(details.url);
    const isHls = HLS_CONTENT_TYPES.includes(contentType) || ext === "m3u8";
    const isVideoType = VIDEO_CONTENT_TYPES.includes(contentType) || contentType.startsWith("video/");

    if (isHls) {
      addVideo(details.tabId, {
        url: details.url,
        contentType: "application/vnd.apple.mpegurl",
        size: 0,
        source: "network",
        kind: "hls",
      });
    } else if (isVideoType || looksLikeVideoUrl(details.url)) {
      addVideo(details.tabId, {
        url: details.url,
        contentType: contentType || "video/" + (ext || "mp4"),
        size: contentLength,
        source: "network",
        kind: "file",
      });
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// Limpa o estado quando a aba navega para uma nova página ou é fechada.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    videosByTab.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  videosByTab.delete(tabId);
});

// Mensagens do popup e do content script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VIDEO_FOUND" && sender.tab) {
    // Vídeo detectado na DOM pelo content script.
    addVideo(sender.tab.id, {
      url: message.url,
      contentType: message.contentType || "",
      size: 0,
      source: "dom",
      kind: message.kind || "file",
      title: message.title || "",
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_VIDEOS") {
    const tabId = message.tabId;
    const map = videosByTab.get(tabId);
    const videos = map ? Array.from(map.values()) : [];
    sendResponse({ videos });
    return false;
  }

  return false;
});
