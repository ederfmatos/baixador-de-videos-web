// Content script: varre a DOM em busca de tags <video>/<source> com arquivos
// diretos e reporta ao service worker. Observa mudanças para pegar vídeos
// adicionados dinamicamente.
//
// Também extrai metadados: os do próprio elemento (duração, resolução,
// poster) e os da página (og:title, JSON-LD VideoObject). Os da página são
// enviados à parte porque a maioria dos streams é detectada pela rede, com
// uma URL que nunca aparece na DOM — nesses casos o título da página é a
// única identificação disponível.

const VIDEO_EXT_RE = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i;
const HLS_EXT_RE = /\.m3u8(\?|#|$)/i;

// Elementos cujo 'loadedmetadata' já foi assinado: scan() roda a cada
// mutação da DOM e não pode empilhar listeners no mesmo <video>.
const watched = new WeakSet();

// "PT1H42M30S" -> 6150
function parseIsoDuration(value) {
  const match = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(String(value || "").trim());
  if (!match) return 0;
  const [, h, m, s] = match;
  return (parseInt(h || "0", 10) * 3600) + (parseInt(m || "0", 10) * 60) + Math.round(parseFloat(s || "0"));
}

function metaContent(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const value = el && (el.content || el.getAttribute("content"));
    if (value && value.trim()) return value.trim();
  }
  return "";
}

// Procura um VideoObject em qualquer profundidade: sites publicam ora o objeto
// direto, ora dentro de @graph, ora num array solto.
function findVideoObject(node, depth = 0) {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findVideoObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;

  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("VideoObject")) return node;

  for (const key of ["@graph", "video", "mainEntity", "itemListElement"]) {
    const found = findVideoObject(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function readJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const found = findVideoObject(JSON.parse(script.textContent));
      if (found) return found;
    } catch (e) {
      // JSON-LD malformado é comum; ignora e tenta o próximo.
    }
  }
  return null;
}

// Título limpo: document.title costuma vir com sufixo do site
// ("Nome do vídeo - Categoria | Site"), enquanto og:title e o JSON-LD trazem
// só o nome do vídeo.
function collectPageMeta() {
  const jsonLd = readJsonLd();

  const title =
    (jsonLd && typeof jsonLd.name === "string" && jsonLd.name.trim()) ||
    metaContent(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    document.title ||
    "";

  const poster =
    (jsonLd && typeof jsonLd.thumbnailUrl === "string" && jsonLd.thumbnailUrl) ||
    (jsonLd && Array.isArray(jsonLd.thumbnailUrl) && jsonLd.thumbnailUrl[0]) ||
    metaContent(['meta[property="og:image"]', 'meta[name="twitter:image"]']) ||
    "";

  let duration = 0;
  if (jsonLd && jsonLd.duration) duration = parseIsoDuration(jsonLd.duration);
  if (!duration) {
    const ogDuration = metaContent(['meta[property="og:video:duration"]', 'meta[property="video:duration"]']);
    if (ogDuration) duration = Math.round(parseFloat(ogDuration)) || 0;
  }

  return {
    title: title.trim().slice(0, 300),
    pageTitle: document.title,
    poster: poster || "",
    duration,
    uploadDate: (jsonLd && jsonLd.uploadDate) || "",
    siteName: metaContent(['meta[property="og:site_name"]']) || location.hostname,
  };
}

// Rótulo específico do elemento, quando a página oferece um.
function labelFor(video) {
  const own = video.getAttribute("title") || video.getAttribute("aria-label");
  if (own && own.trim()) return own.trim();

  // Um heading próximo costuma ser o nome do vídeo em players embutidos.
  const container = video.closest("figure, article, section, div");
  const heading = container && container.querySelector("h1, h2, h3, figcaption");
  const text = heading && heading.textContent.trim();
  return text && text.length <= 200 ? text : "";
}

function reportUrl(url, video) {
  if (!url) return;
  // Ignora blobs e data URIs — não são baixáveis diretamente.
  if (url.startsWith("blob:") || url.startsWith("data:")) return;

  let absolute;
  try {
    absolute = new URL(url, location.href).href;
  } catch (e) {
    return;
  }

  let kind = null;
  if (HLS_EXT_RE.test(absolute)) kind = "hls";
  else if (VIDEO_EXT_RE.test(absolute)) kind = "file";
  if (!kind) return;

  const message = {
    type: "VIDEO_FOUND",
    url: absolute,
    kind,
    title: document.title,
  };

  if (video) {
    // duration é NaN enquanto os metadados não carregam; só reporta o que já vale.
    if (Number.isFinite(video.duration) && video.duration > 0) {
      message.duration = Math.round(video.duration);
    }
    if (video.videoWidth && video.videoHeight) {
      message.width = video.videoWidth;
      message.height = video.videoHeight;
    }
    if (video.poster) {
      try {
        message.poster = new URL(video.poster, location.href).href;
      } catch (e) {
        /* poster inválido */
      }
    }
    const label = labelFor(video);
    if (label) message.label = label;
  }

  chrome.runtime.sendMessage(message).catch(() => {});
}

function scan() {
  document.querySelectorAll("video").forEach((video) => {
    // Duração e resolução só existem depois que os metadados carregam.
    if (!watched.has(video)) {
      watched.add(video);
      video.addEventListener("loadedmetadata", () => scan(), { once: true });
    }

    if (video.currentSrc) reportUrl(video.currentSrc, video);
    if (video.src) reportUrl(video.src, video);
    video.querySelectorAll("source").forEach((source) => reportUrl(source.src, video));
  });
}

// Os metadados da página valem para qualquer vídeo desta aba, inclusive os
// que só a detecção de rede enxerga.
function reportPageMeta() {
  chrome.runtime.sendMessage({ type: "PAGE_META", meta: collectPageMeta() }).catch(() => {});
}

// Varredura inicial + varreduras a cada mudança na DOM.
reportPageMeta();
scan();

let metaTimer = null;
const observer = new MutationObserver(() => {
  scan();
  // Muito site preenche og:/JSON-LD só depois da hidratação; reavalia em lote.
  if (metaTimer === null) {
    metaTimer = setTimeout(() => {
      metaTimer = null;
      reportPageMeta();
    }, 1000);
  }
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"],
});
