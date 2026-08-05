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
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m > 0) return `${m}min ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Melhor nome disponível, do mais específico para o mais genérico.
function bestTitle(video, pageMeta, tab) {
  if (video.serverFilename) return video.serverFilename.replace(/\.[a-z0-9]+$/i, "");
  if (video.label) return video.label;
  if (pageMeta && pageMeta.title) return pageMeta.title;
  return video.title || (tab && tab.title) || "video";
}

async function handleDownload(video, tab, pageMeta, index) {
  const title = bestTitle(video, pageMeta, tab);

  if (video.kind === "hls") {
    // Streams HLS são baixados em uma página própria, com escolha de
    // qualidade, gravação em disco e barra de progresso.
    // A URL da página original vai junto para que o downloader envie o
    // Referer correto (evita HTTP 403 em servidores com anti-hotlink).
    const url =
      chrome.runtime.getURL("src/downloader.html") +
      `?src=${encodeURIComponent(video.url)}` +
      `&title=${encodeURIComponent(title)}` +
      `&referer=${encodeURIComponent(tab.url || "")}`;
    chrome.tabs.create({ url });
    window.close();
    return;
  }

  const ext = extensionFromUrl(video.url);
  // O índice evita que vários vídeos da mesma página disputem o mesmo nome.
  const base = sanitizeFilename(title) + (index > 0 ? ` (${index + 1})` : "");
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

function buildThumb(video, pageMeta) {
  const src = video.poster || (pageMeta && pageMeta.poster);
  if (!src) return null;
  const img = document.createElement("img");
  img.className = "thumb";
  img.src = src;
  img.alt = "";
  img.loading = "lazy";
  // Poster quebrado não pode deixar um buraco no layout.
  img.addEventListener("error", () => img.remove());
  return img;
}

function renderVideos(videos, tab, pageMeta) {
  listEl.innerHTML = "";

  const hidden = videos.filter((v) => v.variant).length;
  const visible = showVariants ? videos : videos.filter((v) => !v.variant);

  emptyEl.classList.toggle("hidden", visible.length > 0);

  visible.forEach((video, index) => {
    const li = document.createElement("li");
    li.className = "video-item";

    const thumb = buildThumb(video, pageMeta);
    if (thumb) li.appendChild(thumb);

    const meta = document.createElement("div");
    meta.className = "video-meta";

    const name = document.createElement("span");
    name.className = "video-name";
    name.textContent = bestTitle(video, pageMeta, tab);
    name.title = video.url;

    // Linha técnica: o que se sabe do vídeo, sem repetir o óbvio.
    const facts = [];
    facts.push(video.kind === "hls" ? "stream HLS" : "." + extensionFromUrl(video.url));
    const duration = video.duration || (pageMeta && pageMeta.duration);
    if (duration) facts.push(formatDuration(duration));
    if (video.width && video.height) facts.push(`${video.width}×${video.height}`);
    const size = formatSize(video.size);
    if (size) facts.push(size);

    const specs = document.createElement("span");
    specs.className = "video-sub";
    specs.textContent = facts.join(" • ");

    const origin = document.createElement("span");
    origin.className = "video-sub faint";
    origin.textContent = [video.source, video.variant ? "variante" : ""].filter(Boolean).join(" • ");

    meta.appendChild(name);
    meta.appendChild(specs);
    meta.appendChild(origin);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => handleDownload(video, tab, pageMeta, index));

    li.appendChild(meta);
    li.appendChild(btn);
    listEl.appendChild(li);
  });

  // Variantes de qualidade do mesmo stream ficam recolhidas para não poluir a
  // lista, mas continuam acessíveis.
  toggleEl.classList.toggle("hidden", hidden === 0);
  if (hidden > 0) {
    toggleEl.textContent = showVariants
      ? "Ocultar variantes do mesmo vídeo"
      : `Mostrar mais ${hidden} link(s) do mesmo vídeo`;
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
  const pageMeta = (response && response.pageMeta) || null;
  renderVideos(videos, tab, pageMeta);

  toggleEl.addEventListener("click", () => {
    showVariants = !showVariants;
    renderVideos(videos, tab, pageMeta);
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
