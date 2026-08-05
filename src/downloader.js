// Página de download HLS: busca a playlist .m3u8, deixa o usuário escolher a
// qualidade (playlist master), baixa todos os segmentos, descriptografa
// AES-128 padrão quando presente e junta tudo em um único arquivo.
//
// Não contorna DRM: streams com SAMPLE-AES / Widevine / FairPlay / PlayReady
// são detectados e recusados com uma mensagem clara.

const CONCURRENCY = 4;
const RETRIES = 2;

const params = new URLSearchParams(location.search);
const srcUrl = params.get("src") || "";
const pageTitle = params.get("title") || "video";
const refererUrl = params.get("referer") || "";

const steps = {
  loading: document.getElementById("step-loading"),
  quality: document.getElementById("step-quality"),
  progress: document.getElementById("step-progress"),
  done: document.getElementById("step-done"),
  error: document.getElementById("step-error"),
};

const qualityListEl = document.getElementById("quality-list");
const progressBarEl = document.getElementById("progress-bar");
const progressTextEl = document.getElementById("progress-text");
const progressLabelEl = document.getElementById("progress-label");
const doneTextEl = document.getElementById("done-text");
const errorTextEl = document.getElementById("error-text");
const notesEl = document.getElementById("notes");

document.getElementById("video-title").textContent = pageTitle;

function showStep(name) {
  for (const [key, el] of Object.entries(steps)) {
    el.classList.toggle("hidden", key !== name);
  }
}

function showNote(text) {
  notesEl.textContent = text;
  notesEl.classList.remove("hidden");
}

function fail(message) {
  errorTextEl.textContent = message;
  showStep("error");
}

function sanitizeFilename(name) {
  return (name || "video")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

// ---------------------------------------------------------------------------
// Parser de playlists M3U8
// ---------------------------------------------------------------------------

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function resolveUrl(url, base) {
  return new URL(url, base).href;
}

function parsePlaylist(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length || !lines[0].startsWith("#EXTM3U")) {
    throw new Error("O conteúdo não é uma playlist M3U8 válida.");
  }

  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF:"));

  if (isMaster) {
    const variants = [];
    const audioRenditions = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
        if (attrs.TYPE === "AUDIO" && attrs.URI) {
          audioRenditions.push({
            groupId: attrs["GROUP-ID"] || "",
            name: attrs.NAME || "áudio",
            isDefault: attrs.DEFAULT === "YES",
            url: resolveUrl(attrs.URI, baseUrl),
          });
        }
      }

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
        // A URI da variante é a próxima linha que não é comentário.
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith("#")) {
            variants.push({
              url: resolveUrl(lines[j], baseUrl),
              bandwidth: parseInt(attrs.BANDWIDTH || "0", 10) || 0,
              resolution: attrs.RESOLUTION || "",
              codecs: attrs.CODECS || "",
              audioGroup: attrs.AUDIO || "",
            });
            break;
          }
        }
      }
    }

    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: "master", variants, audioRenditions };
  }

  // Playlist de mídia (lista de segmentos).
  const segments = [];
  let currentKey = null;
  let map = null;
  let mediaSequence = 0;
  let live = true;

  // Passada sequencial: uma linha sem "#" logo após um #EXTINF é a URI do
  // segmento; a chave em vigor (#EXT-X-KEY) se aplica aos segmentos seguintes.
  let expectingSegment = false;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.split(":")[1], 10) || 0;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      live = false;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) map = { url: resolveUrl(attrs.URI, baseUrl) };
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
      const method = attrs.METHOD || "NONE";
      if (method === "NONE") {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : "",
          iv: attrs.IV || "",
          keyFormat: attrs.KEYFORMAT || "identity",
        };
      }
    } else if (line.startsWith("#EXTINF:")) {
      expectingSegment = true;
    } else if (expectingSegment && !line.startsWith("#")) {
      segments.push({
        url: resolveUrl(line, baseUrl),
        key: currentKey,
        sequence: mediaSequence + segments.length,
      });
      expectingSegment = false;
    }
  }

  return { type: "media", segments, map, live };
}

function checkDrm(playlist) {
  for (const seg of playlist.segments) {
    if (!seg.key) continue;
    const method = seg.key.method.toUpperCase();
    const format = (seg.key.keyFormat || "identity").toLowerCase();
    if (method !== "AES-128" || format !== "identity") {
      throw new Error(
        "Este vídeo é protegido por DRM (" +
          seg.key.method +
          "). A extensão não baixa conteúdo protegido."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cabeçalhos anti-hotlink
// ---------------------------------------------------------------------------
// Muitos servidores de vídeo só respondem se o pedido vier com o
// Referer/Origin da página original (proteção contra hotlink) — sem isso o
// retorno é HTTP 403. Como fetch() não permite definir esses cabeçalhos,
// usamos uma regra de sessão do declarativeNetRequest, restrita às
// requisições feitas por esta aba.

let headerRuleId = null;

async function setupHeaderRule() {
  if (!refererUrl || !chrome.declarativeNetRequest) return;

  let origin;
  try {
    origin = new URL(refererUrl).origin;
  } catch (e) {
    return;
  }

  const tab = await chrome.tabs.getCurrent();
  if (!tab) return;

  headerRuleId = tab.id; // único por aba de download
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [headerRuleId],
    addRules: [
      {
        id: headerRuleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: refererUrl },
            { header: "Origin", operation: "set", value: origin },
          ],
        },
        condition: {
          tabIds: [tab.id],
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },
    ],
  });
}

function removeHeaderRule() {
  if (headerRuleId !== null && chrome.declarativeNetRequest) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [headerRuleId] });
    headerRuleId = null;
  }
}

window.addEventListener("pagehide", removeHeaderRule);

function friendlyError(e) {
  const message = e && e.message ? e.message : String(e);
  if (/HTTP 40[13]/.test(message)) {
    return (
      "O servidor recusou o download (" + message + "). " +
      "Isso costuma acontecer quando o link do vídeo expira. " +
      "Volte à página, recarregue-a, dê play no vídeo e tente baixar logo em seguida."
    );
  }
  return message;
}

// ---------------------------------------------------------------------------
// Download de segmentos
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, asText) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return asText ? await res.text() : await res.arrayBuffer();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

const keyCache = new Map();

async function getKey(uri) {
  if (!keyCache.has(uri)) {
    const raw = await fetchWithRetry(uri, false);
    const cryptoKey = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
    keyCache.set(uri, cryptoKey);
  }
  return keyCache.get(uri);
}

function ivForSegment(segment) {
  if (segment.key.iv) {
    // IV explícito em hexadecimal ("0x...").
    const hex = segment.key.iv.replace(/^0x/i, "").padStart(32, "0");
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    return iv;
  }
  // Sem IV explícito: usa o número de sequência em big-endian (padrão HLS).
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, segment.sequence);
  return iv;
}

async function fetchSegment(segment) {
  let data = await fetchWithRetry(segment.url, false);
  if (segment.key) {
    const key = await getKey(segment.key.uri);
    data = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivForSegment(segment) }, key, data);
  }
  return data;
}

async function downloadSegments(segments, onProgress) {
  const results = new Array(segments.length);
  let next = 0;
  let done = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, segments.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= segments.length) return;
      results[i] = await fetchSegment(segments[i]);
      done++;
      onProgress(done, segments.length, results);
    }
  });

  await Promise.all(workers);
  return results;
}

function outputExtension(playlist, audioOnly) {
  const firstUrl = (playlist.map && playlist.map.url) || (playlist.segments[0] && playlist.segments[0].url) || "";
  const isFmp4 = !!playlist.map || /\.(m4s|mp4|m4a)(\?|#|$)/i.test(firstUrl);
  if (audioOnly) return isFmp4 ? "m4a" : "ts";
  return isFmp4 ? "mp4" : "ts";
}

async function downloadMediaPlaylist(url, { audioOnly = false, suffix = "" } = {}) {
  const text = await fetchWithRetry(url, true);
  const playlist = parsePlaylist(text, url);

  if (playlist.type === "master") {
    throw new Error("Playlist inesperada (master dentro de master).");
  }
  if (!playlist.segments.length) {
    throw new Error("A playlist não contém segmentos de vídeo.");
  }

  checkDrm(playlist);

  if (playlist.live) {
    showNote(
      "Este stream parece ser uma transmissão ao vivo: será baixado apenas o trecho disponível agora."
    );
  }

  showStep("progress");
  progressLabelEl.textContent = audioOnly ? "Baixando áudio…" : "Baixando segmentos…";

  const parts = [];
  if (playlist.map) {
    parts.push(await fetchWithRetry(playlist.map.url, false));
  }

  let downloadedBytes = parts.reduce((acc, b) => acc + b.byteLength, 0);
  const segmentData = await downloadSegments(playlist.segments, (done, total, results) => {
    downloadedBytes = results.reduce((acc, b) => acc + (b ? b.byteLength : 0), 0);
    const pct = Math.round((done / total) * 100);
    progressBarEl.style.width = pct + "%";
    progressTextEl.textContent = `${done} de ${total} segmentos • ${formatSize(downloadedBytes)}`;
  });

  parts.push(...segmentData);

  const ext = outputExtension(playlist, audioOnly);
  const mime = ext === "ts" ? "video/mp2t" : audioOnly ? "audio/mp4" : "video/mp4";
  const blob = new Blob(parts, { type: mime });
  const filename = `${sanitizeFilename(pageTitle)}${suffix}.${ext}`;

  const objectUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({ url: objectUrl, filename });

  return { filename, size: blob.size, ext };
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------

async function startDownload(variantUrl, audioUrl) {
  try {
    const result = await downloadMediaPlaylist(variantUrl);

    let doneText = `Arquivo "${result.filename}" (${formatSize(result.size)}) enviado para a pasta de downloads.`;

    if (audioUrl) {
      const audio = await downloadMediaPlaylist(audioUrl, { audioOnly: true, suffix: "_audio" });
      doneText +=
        ` O áudio deste stream é separado do vídeo e foi salvo como "${audio.filename}".` +
        " Para juntar os dois em um arquivo só é preciso um conversor como o FFmpeg.";
    }

    if (result.ext === "ts") {
      doneText += " Arquivos .ts abrem no VLC; para .mp4 use um conversor.";
    }

    doneTextEl.textContent = doneText;
    showStep("done");
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

function labelForVariant(variant) {
  const parts = [];
  if (variant.resolution) parts.push(variant.resolution);
  if (variant.bandwidth) parts.push(Math.round(variant.bandwidth / 1000) + " kbps");
  return parts.join(" • ") || "Qualidade padrão";
}

function pickAudioUrl(variant, audioRenditions) {
  if (!variant.audioGroup || !audioRenditions.length) return null;
  const group = audioRenditions.filter((a) => a.groupId === variant.audioGroup);
  if (!group.length) return null;
  const chosen = group.find((a) => a.isDefault) || group[0];
  return chosen.url;
}

function renderQualityChoices(master) {
  showStep("quality");
  qualityListEl.innerHTML = "";

  master.variants.forEach((variant) => {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = labelForVariant(variant);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => {
      startDownload(variant.url, pickAudioUrl(variant, master.audioRenditions));
    });

    li.appendChild(label);
    li.appendChild(btn);
    qualityListEl.appendChild(li);
  });
}

async function init() {
  if (!srcUrl) {
    fail("Nenhuma URL de stream informada.");
    return;
  }

  try {
    // Instala a regra de Referer/Origin antes de qualquer requisição.
    await setupHeaderRule();

    const text = await fetchWithRetry(srcUrl, true);
    const playlist = parsePlaylist(text, srcUrl);

    if (playlist.type === "master") {
      if (!playlist.variants.length) {
        fail("A playlist master não contém variantes de vídeo.");
        return;
      }
      renderQualityChoices(playlist);
    } else {
      // Playlist de mídia direta: baixa sem escolha de qualidade.
      await startDownload(srcUrl, null);
    }
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

init();
