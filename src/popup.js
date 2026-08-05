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

async function handleDownload(video, tab, pageMeta, index, customName) {
  const title = sanitizeFilename(customName) || bestTitle(video, pageMeta, tab);

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
  // O índice evita que vários vídeos da mesma página disputem o mesmo nome,
  // mas um nome digitado pelo usuário é usado como está.
  const suffix = customName || index === 0 ? "" : ` (${index + 1})`;
  const base = sanitizeFilename(title) + suffix;
  const filename = base.endsWith("." + ext) ? base : `${base}.${ext}`;

  // O download é disparado pelo service worker: o popup fecha ao clicar e
  // levaria junto qualquer requisição iniciada aqui.
  const response = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_FILE",
    url: video.url,
    filename,
  });

  if (response && !response.ok) {
    // Fechar aqui esconderia a falha: o usuário veria o popup sumir e nada
    // acontecer. Mostra o erro e deixa o botão pronto para nova tentativa.
    console.error("Falha ao baixar:", response.error);
    showItemError(video, response.error);
    return;
  }
  window.close();
}

// Erro exibido embaixo do item que falhou, sem derrubar o resto da lista.
function showItemError(video, message) {
  const li = listEl.querySelector(`[data-url="${CSS.escape(video.url)}"]`);
  if (!li) return;

  let error = li.querySelector(".item-error");
  if (!error) {
    error = document.createElement("span");
    error.className = "video-sub item-error";
    li.querySelector(".video-meta").appendChild(error);
  }
  error.textContent = `Falhou: ${message}. Clique em Baixar para tentar de novo.`;

  const btn = li.querySelector(".btn-primary");
  if (btn) btn.textContent = "Tentar novamente";
}

// Quão provável é que este seja o vídeo principal da página. A ordem de
// detecção não serve: o primeiro que a rede vê costuma ser um anúncio ou uma
// variante de baixa qualidade.
function mainVideoScore(video) {
  return [
    video.duration || 0, // duração do próprio elemento é o sinal mais forte
    video.size || 0, // tamanho conhecido (só arquivos diretos)
    (video.width || 0) * (video.height || 0),
    video.source === "dom" ? 1 : 0, // um <video> na página vale mais que um XHR
  ];
}

function compareByScore(a, b) {
  const scoreA = mainVideoScore(a);
  const scoreB = mainVideoScore(b);
  for (let i = 0; i < scoreA.length; i++) {
    if (scoreB[i] !== scoreA[i]) return scoreB[i] - scoreA[i];
  }
  return a.detectedAt - b.detectedAt; // empate: mantém a ordem de detecção
}

// Um grupo é o conjunto de URLs do mesmo diretório — as variantes de
// qualidade de um stream. Mostra a melhor de cada grupo e recolhe o resto.
function selectPrincipals(videos) {
  const groups = new Map();
  for (const video of videos) {
    const key = video.group || video.url;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }

  const principals = [];
  const variants = [];
  for (const members of groups.values()) {
    const sorted = [...members].sort(compareByScore);
    principals.push(sorted[0]);
    variants.push(...sorted.slice(1));
  }

  principals.sort(compareByScore);
  variants.sort(compareByScore);
  return { principals, variants };
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

  const { principals, variants } = selectPrincipals(videos);
  const hidden = variants.length;
  const visible = showVariants ? [...principals, ...variants] : principals;
  const variantUrls = new Set(variants.map((v) => v.url));

  emptyEl.classList.toggle("hidden", visible.length > 0);

  visible.forEach((video, index) => {
    const li = document.createElement("li");
    li.className = "video-item";
    li.dataset.url = video.url;

    const thumb = buildThumb(video, pageMeta);
    if (thumb) li.appendChild(thumb);

    const meta = document.createElement("div");
    meta.className = "video-meta";

    // O nome é um campo editável desde o início, sem botão de "editar":
    // basta clicar e digitar. O estilo só ganha borda no foco.
    const name = document.createElement("input");
    name.className = "video-name";
    name.type = "text";
    name.spellcheck = false;
    name.value = bestTitle(video, pageMeta, tab);
    name.title = video.url;
    name.setAttribute("aria-label", "Nome do arquivo");
    // Enter baixa direto, sem precisar ir até o botão.
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleDownload(video, tab, pageMeta, index, name.value);
    });

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
    origin.textContent = [video.source, variantUrls.has(video.url) ? "variante" : ""]
      .filter(Boolean)
      .join(" • ");

    meta.appendChild(name);
    meta.appendChild(specs);
    meta.appendChild(origin);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => handleDownload(video, tab, pageMeta, index, name.value));

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
