// Lógica do popup: busca a lista de vídeos da aba ativa, renderiza e
// dispara downloads.

const listEl = document.getElementById("video-list");
const emptyEl = document.getElementById("empty");
const toggleEl = document.getElementById("toggle-variants");
const optionsEl = document.getElementById("open-options");
const downloadsEl = document.getElementById("open-downloads");

let showVariants = false;

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

async function handleDownload(video, tab, index) {
  const pageTitle = tab.title;

  if (video.kind === "hls") {
    // Streams HLS são baixados em uma página própria, com escolha de
    // qualidade, gravação em disco e barra de progresso.
    // A URL da página original vai junto para que o downloader envie o
    // Referer correto (evita HTTP 403 em servidores com anti-hotlink).
    const url =
      chrome.runtime.getURL("src/downloader.html") +
      `?src=${encodeURIComponent(video.url)}` +
      `&title=${encodeURIComponent(video.title || pageTitle || "video")}` +
      `&referer=${encodeURIComponent(tab.url || "")}`;
    chrome.tabs.create({ url });
    window.close();
    return;
  }

  const ext = extensionFromUrl(video.url);
  // O índice evita que vários vídeos da mesma página disputem o mesmo nome.
  const base = sanitizeFilename(video.title || pageTitle || "video") + (index > 0 ? ` (${index + 1})` : "");
  const filename = base.endsWith("." + ext) ? base : `${base}.${ext}`;

  // O download é disparado pelo service worker: o popup fecha ao clicar e
  // levaria junto qualquer requisição iniciada aqui.
  const response = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_FILE",
    url: video.url,
    filename,
  });

  if (response && !response.ok) {
    console.error("Falha ao baixar:", response.error);
  }
  window.close();
}

function renderVideos(videos, tab) {
  listEl.innerHTML = "";

  const hidden = videos.filter((v) => v.variant).length;
  const visible = showVariants ? videos : videos.filter((v) => !v.variant);

  if (!visible.length) {
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }

  visible.forEach((video, index) => {
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
    const parts = [size, video.source, video.variant ? "variante" : ""].filter(Boolean);
    sub.textContent = parts.join(" • ");

    meta.appendChild(name);
    meta.appendChild(sub);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => handleDownload(video, tab, index));

    li.appendChild(meta);
    li.appendChild(btn);
    listEl.appendChild(li);
  });

  // Variantes de qualidade do mesmo stream ficam recolhidas para não poluir a
  // lista, mas continuam acessíveis.
  if (hidden > 0) {
    toggleEl.classList.remove("hidden");
    toggleEl.textContent = showVariants
      ? "Ocultar variantes do mesmo vídeo"
      : `Mostrar mais ${hidden} link(s) do mesmo vídeo`;
  } else {
    toggleEl.classList.add("hidden");
  }
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

  toggleEl.addEventListener("click", () => {
    showVariants = !showVariants;
    renderVideos(videos, tab);
  });

  optionsEl.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  downloadsEl.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("src/downloads.html") });
    window.close();
  });
}

init();
