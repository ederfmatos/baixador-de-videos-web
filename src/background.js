// Service worker: detecta vídeos por aba observando o tráfego de rede,
// persiste o estado em chrome.storage.session (o worker MV3 é encerrado
// quando fica ocioso) e expõe mensagens para o popup e o content script.

const VIDEO_EXTENSIONS = ["mp4", "webm", "ogg", "ogv", "mov", "m4v"];
const VIDEO_CONTENT_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v"];
const HLS_CONTENT_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
];

// Respostas de vídeo menores que isto quase sempre são anúncios, pré-visualizações
// ou sprites de thumbnail. Só filtramos quando o Content-Length é conhecido.
const MIN_VIDEO_BYTES = 100 * 1024;

const STORAGE_KEY = "videosByTab";
const META_KEY = "pageMetaByTab";

// Map<tabId, Map<url, videoInfo>> — espelhado em chrome.storage.session.
const videosByTab = new Map();

// Map<tabId, pageMeta> — título limpo, poster e duração vindos do content
// script. Vale para todos os vídeos da aba, inclusive os que só a detecção de
// rede enxerga (streams cuja URL nunca aparece na DOM).
const pageMetaByTab = new Map();

// O worker pode ser reiniciado a qualquer momento; nenhum handler pode ler o
// estado antes que o snapshot da sessão tenha sido recarregado.
const ready = (async () => {
  try {
    const stored = await chrome.storage.session.get([STORAGE_KEY, META_KEY]);
    const snapshot = stored[STORAGE_KEY];
    if (snapshot) {
      for (const [tabId, videos] of Object.entries(snapshot)) {
        videosByTab.set(Number(tabId), new Map(videos.map((v) => [v.url, v])));
      }
    }
    const meta = stored[META_KEY];
    if (meta) {
      for (const [tabId, value] of Object.entries(meta)) {
        pageMetaByTab.set(Number(tabId), value);
      }
    }
  } catch (e) {
    console.warn("Não foi possível restaurar o estado da sessão:", e);
  }
})();

let persistTimer = null;

// Serializa em lote: onHeadersReceived dispara muitas vezes em sequência e
// gravar a cada chamada geraria contenção desnecessária no storage.
function persist() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = {};
    for (const [tabId, map] of videosByTab) {
      snapshot[tabId] = Array.from(map.values());
    }
    const meta = {};
    for (const [tabId, value] of pageMetaByTab) {
      meta[tabId] = value;
    }
    chrome.storage.session.set({ [STORAGE_KEY]: snapshot, [META_KEY]: meta }).catch(() => {});
  }, 500);
}

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

// Nome real do arquivo, quando o servidor o informa. Cobre as duas formas:
// filename*=UTF-8''nome%20real.mp4 (RFC 5987) e filename="nome real.mp4".
function filenameFromDisposition(value) {
  if (!value) return "";
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(value);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch (e) {
      /* codificação inválida */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return plain ? plain[1].trim() : "";
}

// Diretório da URL (sem query nem nome do arquivo). Variantes de qualidade de
// um mesmo stream HLS quase sempre compartilham o prefixo, o que permite
// agrupá-las no popup em vez de listar dez entradas para o mesmo vídeo.
function directoryKey(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/[^/]*$/, "/");
    return parsed.origin + path;
  } catch (e) {
    return url;
  }
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
  // A aba pode ter sido fechada entre a detecção e esta chamada.
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e11d48" }).catch(() => {});
}

async function addVideo(tabId, info) {
  await ready;
  if (tabId < 0 || !info.url) return;
  if (info.kind === "file" && info.size > 0 && info.size < MIN_VIDEO_BYTES) return;
  if (await isDomainBlacklisted(info.url)) return;

  const map = getTabMap(tabId);
  const existing = map.get(info.url) || {};

  // Detecção de rede e DOM veem o mesmo vídeo e cada uma sabe de coisas
  // diferentes. Campos vazios não podem apagar o que a outra já preencheu.
  const incoming = Object.fromEntries(
    Object.entries(info).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );

  // A primeira URL vista de um diretório é a "principal"; as seguintes são
  // tratadas como variantes e ficam recolhidas no popup.
  const dir = directoryKey(info.url);
  const isFirstOfGroup =
    existing.group !== undefined
      ? !existing.variant
      : !Array.from(map.values()).some((v) => v.group === dir);

  map.set(info.url, {
    ...existing,
    ...incoming,
    group: dir,
    variant: !isFirstOfGroup,
    detectedAt: existing.detectedAt || Date.now(),
  });
  updateBadge(tabId);
  persist();
}

// Detecção principal: inspeciona os headers da resposta (Content-Type / Content-Length).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = details.responseHeaders || [];
    let contentType = "";
    let contentLength = 0;
    let disposition = "";
    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === "content-type") contentType = (h.value || "").split(";")[0].trim().toLowerCase();
      if (name === "content-length") contentLength = parseInt(h.value || "0", 10) || 0;
      if (name === "content-disposition") disposition = h.value || "";
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
        serverFilename: filenameFromDisposition(disposition),
      });
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// Limpa o estado quando a aba navega para uma nova página ou é fechada.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    await ready;
    videosByTab.delete(tabId);
    pageMetaByTab.delete(tabId);
    updateBadge(tabId);
    persist();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  videosByTab.delete(tabId);
  pageMetaByTab.delete(tabId);
  persist();
});

// Regras de sessão do declarativeNetRequest são criadas pela página de
// download para enviar Referer/Origin. Se uma aba morre antes de removê-las,
// a regra fica órfã. Só removemos as que apontam para abas inexistentes —
// apagar todas derrubaria um download em andamento quando o worker reinicia.
async function cleanupOrphanRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (!rules.length) return;

    const openTabs = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const stale = rules
      .filter((r) => {
        const tabIds = (r.condition && r.condition.tabIds) || [];
        return tabIds.length > 0 && tabIds.every((id) => !openTabs.has(id));
      })
      .map((r) => r.id);

    if (stale.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
    }
  } catch (e) {
    /* nada a fazer */
  }
}

cleanupOrphanRules();
chrome.tabs.onRemoved.addListener(cleanupOrphanRules);

// Mensagens do popup, do content script e da página de download.
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

  // Metadados da página valem para a aba inteira: um stream detectado pela
  // rede não tem título próprio, mas herda o da página que o reproduz.
  if (message.type === "PAGE_META" && sender.tab) {
    ready.then(() => {
      const current = pageMetaByTab.get(sender.tab.id) || {};
      const incoming = Object.fromEntries(
        Object.entries(message.meta || {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
      );
      // Só o frame principal define o título; iframes de player costumam ter
      // título genérico e sobrescreveriam o bom.
      if (sender.frameId !== 0 && current.title) delete incoming.title;
      pageMetaByTab.set(sender.tab.id, { ...current, ...incoming });
      persist();
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_VIDEOS") {
    ready.then(() => {
      const map = videosByTab.get(message.tabId);
      sendResponse({
        videos: map ? Array.from(map.values()) : [],
        pageMeta: pageMetaByTab.get(message.tabId) || null,
      });
    });
    return true;
  }

  // O popup fecha assim que o usuário clica, o que cancelaria um download
  // iniciado a partir dele. O worker é quem dispara o download.
  if (message.type === "DOWNLOAD_FILE") {
    chrome.downloads
      .download({ url: message.url, filename: message.filename })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  // Reserva um id de regra do declarativeNetRequest que não colida com o de
  // outra aba de download aberta ao mesmo tempo.
  if (message.type === "NEXT_RULE_ID") {
    chrome.storage.session
      .get("nextRuleId")
      .then(({ nextRuleId = 1 }) => {
        const id = (nextRuleId % 100000) + 1;
        return chrome.storage.session.set({ nextRuleId: id }).then(() => sendResponse({ id }));
      })
      .catch(() => sendResponse({ id: Math.floor(Math.random() * 100000) + 1 }));
    return true;
  }

  return false;
});
