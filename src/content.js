// Content script: varre a DOM em busca de tags <video>/<source> com arquivos
// diretos e reporta ao service worker. Observa mudanças para pegar vídeos
// adicionados dinamicamente.

const VIDEO_EXT_RE = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i;
const HLS_EXT_RE = /\.m3u8(\?|#|$)/i;

function reportUrl(url) {
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

  chrome.runtime.sendMessage({
    type: "VIDEO_FOUND",
    url: absolute,
    kind,
    title: document.title,
  });
}

function scan() {
  const videos = document.querySelectorAll("video");
  videos.forEach((video) => {
    if (video.currentSrc) reportUrl(video.currentSrc);
    if (video.src) reportUrl(video.src);
    video.querySelectorAll("source").forEach((source) => reportUrl(source.src));
  });
}

// Varredura inicial + varreduras periódicas curtas para pegar carregamentos tardios.
scan();

const observer = new MutationObserver(() => scan());
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"],
});
