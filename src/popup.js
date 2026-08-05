// Lógica do popup: busca a lista de vídeos da aba ativa, renderiza e
// dispara downloads.

const listEl = document.getElementById("video-list");
const emptyEl = document.getElementById("empty");

function sanitizeFilename(name) {
  return (name || "video")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function extensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "mp4";
  } catch (e) {
    return "mp4";
  }
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function handleDownload(video, tab) {
  const pageTitle = tab.title;

  if (video.kind === "hls") {
    // Streams HLS são baixados em uma página própria, com escolha de
    // qualidade e barra de progresso (o contador é incrementado lá).
    // A URL da página original vai junto para que o downloader envie o
    // Referer correto (evita HTTP 403 em servidores com anti-hotlink).
    const url =
      chrome.runtime.getURL("src/downloader.html") +
      `?src=${encodeURIComponent(video.url)}` +
      `&title=${encodeURIComponent(video.title || pageTitle || "video")}` +
      `&referer=${encodeURIComponent(tab.url || "")}`;
    chrome.tabs.create({ url });
    return;
  }

  const ext = extensionFromUrl(video.url);
  const base = sanitizeFilename(video.title || pageTitle || "video");
  const filename = base.endsWith("." + ext) ? base : `${base}.${ext}`;

  try {
    await chrome.downloads.download({ url: video.url, filename });
  } catch (e) {
    console.error("Falha ao baixar:", e);
  }
}

function renderVideos(videos, tab) {
  listEl.innerHTML = "";

  if (!videos.length) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  videos.forEach((video, index) => {
    const li = document.createElement("li");
    li.className = "video-item";

    const meta = document.createElement("div");
    meta.className = "video-meta";

    const name = document.createElement("span");
    name.className = "video-name";
    name.textContent =
      video.kind === "hls"
        ? `Vídeo ${index + 1} (stream HLS)`
        : `Vídeo ${index + 1} (.${extensionFromUrl(video.url)})`;
    name.title = video.url;

    const sub = document.createElement("span");
    sub.className = "video-sub";
    const size = formatSize(video.size);
    sub.textContent = size ? `${size} • ${video.source}` : video.source;

    meta.appendChild(name);
    meta.appendChild(sub);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => handleDownload(video, tab));

    li.appendChild(meta);
    li.appendChild(btn);
    listEl.appendChild(li);
  });
}

async function init() {
  const tab = await getActiveTab();
  if (!tab) return;

  const response = await chrome.runtime.sendMessage({
    type: "GET_VIDEOS",
    tabId: tab.id,
  });

  const videos = (response && response.videos) || [];
  renderVideos(videos, tab);
}

init();
