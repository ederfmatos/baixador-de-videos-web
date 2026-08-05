// Página de download HLS: busca a playlist .m3u8, deixa o usuário escolher a
// qualidade (playlist master) e a pasta de destino, baixa todos os segmentos,
// descriptografa AES-128 padrão quando presente e grava direto no disco.
//
// Os segmentos são gravados em ordem, um a um, via File System Access API —
// nada é acumulado em memória, então o tamanho do vídeo não é limitado pela
// RAM disponível. Segmentos MPEG-TS passam pelo mux.js e saem como MP4.
//
// Não contorna DRM: streams com SAMPLE-AES / Widevine / FairPlay / PlayReady
// são detectados e recusados com uma mensagem clara.

const CONCURRENCY = 4;
const RETRIES = 2;
// Quantos segmentos podem estar baixados à frente do que já foi gravado.
// Segura o consumo de memória sem deixar os workers ociosos.
const MAX_LOOKAHEAD = 16;

const params = new URLSearchParams(location.search);
const srcUrl = params.get("src") || "";
const pageTitle = params.get("title") || "video";
const refererUrl = params.get("referer") || "";

const steps = {
  loading: document.getElementById("step-loading"),
  start: document.getElementById("step-start"),
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
const cancelBtn = document.getElementById("cancel-btn");
const startBtn = document.getElementById("start-btn");

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

  // O número de sequência precisa de um contador próprio: usar o índice do
  // array quebra em playlists com #EXT-X-DISCONTINUITY, e é ele que gera o IV
  // padrão da descriptografia AES-128.
  let sequence = null;

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
      if (sequence === null) sequence = mediaSequence;
      segments.push({
        url: resolveUrl(line, baseUrl),
        key: currentKey,
        sequence: sequence++,
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

  // O id vem de um contador na sessão: usar tab.id colidiria com regras de
  // outras abas de download e com regras deixadas para trás por abas mortas.
  const response = await chrome.runtime.sendMessage({ type: "NEXT_RULE_ID" });
  headerRuleId = (response && response.id) || tab.id;

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

async function fetchWithRetry(url, asText, signal) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (signal && signal.aborted) throw new DOMException("Cancelado", "AbortError");
    try {
      const res = await fetch(url, { credentials: "include", signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return asText ? await res.text() : await res.arrayBuffer();
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      lastError = e;
    }
  }
  throw lastError;
}

const keyCache = new Map();

async function getKey(uri, signal) {
  if (!keyCache.has(uri)) {
    const raw = await fetchWithRetry(uri, false, signal);
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

async function fetchSegment(segment, signal) {
  let data = await fetchWithRetry(segment.url, false, signal);
  if (segment.key) {
    const key = await getKey(segment.key.uri, signal);
    data = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivForSegment(segment) }, key, data);
  }
  return data;
}

// Portão de notificação: acorda quem estiver esperando e se rearma.
function createGate() {
  let release;
  let promise = new Promise((r) => (release = r));
  return {
    wait: () => promise,
    signal: () => {
      const previous = release;
      promise = new Promise((r) => (release = r));
      previous();
    },
  };
}

// Baixa em paralelo, mas entrega os segmentos ao `write` em ordem estrita e
// descarta cada buffer logo após gravá-lo. Falha na primeira exceção em vez de
// esperar a fila inteira terminar.
async function streamSegments(segments, { signal, write, onProgress }) {
  const buffers = new Map();
  let nextToFetch = 0;
  let nextToWrite = 0;
  let failure = null;

  const produced = createGate();
  const consumed = createGate();

  const stop = () => {
    produced.signal();
    consumed.signal();
  };
  signal.addEventListener("abort", stop);

  const halted = () => failure !== null || signal.aborted;

  async function worker() {
    while (true) {
      while (nextToFetch - nextToWrite >= MAX_LOOKAHEAD && !halted()) {
        await consumed.wait();
      }
      if (halted()) return;

      const i = nextToFetch++;
      if (i >= segments.length) return;

      try {
        buffers.set(i, await fetchSegment(segments[i], signal));
      } catch (e) {
        if (!failure) failure = e;
      }
      produced.signal();
    }
  }

  const writer = (async () => {
    while (nextToWrite < segments.length) {
      while (!buffers.has(nextToWrite)) {
        if (halted()) return;
        await produced.wait();
      }
      const data = buffers.get(nextToWrite);
      buffers.delete(nextToWrite);
      await write(data, segments[nextToWrite]);
      nextToWrite++;
      consumed.signal();
      onProgress(nextToWrite, segments.length, data.byteLength);
    }
  })();

  try {
    await Promise.all([
      ...Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker),
      writer,
    ]);
  } finally {
    signal.removeEventListener("abort", stop);
  }

  if (failure) throw failure;
  if (signal.aborted) throw new DOMException("Cancelado", "AbortError");
}

// ---------------------------------------------------------------------------
// Saída: MP4 direto (fMP4) ou remux de MPEG-TS via mux.js
// ---------------------------------------------------------------------------

function isFragmentedMp4(playlist) {
  if (playlist.map) return true;
  const first = playlist.segments[0] && playlist.segments[0].url;
  return /\.(m4s|mp4|m4a)(\?|#|$)/i.test(first || "");
}

// Envolve o Transmuxer do mux.js: recebe um segmento TS e devolve os pedaços
// de MP4 fragmentado correspondentes. O init segment sai só na primeira vez.
function createRemuxer() {
  if (typeof muxjs === "undefined") {
    throw new Error("mux.js não pôde ser carregado; o remux para MP4 está indisponível.");
  }
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  let output = [];
  let initSent = false;

  transmuxer.on("data", (segment) => {
    if (!initSent) {
      output.push(segment.initSegment);
      initSent = true;
    }
    output.push(segment.data);
  });

  return {
    // mux.js é síncrono: os eventos 'data' saem durante o flush().
    push(buffer) {
      output = [];
      transmuxer.push(new Uint8Array(buffer));
      transmuxer.flush();
      return output;
    },
  };
}

// Nome livre dentro da pasta escolhida — não sobrescreve o que já existe.
async function uniqueFileHandle(dirHandle, baseName, ext) {
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? `${baseName}.${ext}` : `${baseName} (${i}).${ext}`;
    try {
      await dirHandle.getFileHandle(name);
      // Existe: tenta o próximo sufixo.
    } catch (e) {
      if (e && e.name === "NotFoundError") {
        return { handle: await dirHandle.getFileHandle(name, { create: true }), name };
      }
      throw e;
    }
  }
  throw new Error("Não foi possível criar um nome de arquivo livre na pasta escolhida.");
}

async function downloadMediaPlaylist(url, dirHandle, signal, { audioOnly = false, suffix = "", baseName } = {}) {
  const text = await fetchWithRetry(url, true, signal);
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

  const fmp4 = isFragmentedMp4(playlist);
  const remuxer = fmp4 ? null : createRemuxer();
  const ext = fmp4 && audioOnly ? "m4a" : "mp4";

  const { handle, name } = await uniqueFileHandle(dirHandle, `${baseName}${suffix}`, ext);
  const writable = await handle.createWritable();

  showStep("progress");
  progressLabelEl.textContent = audioOnly ? "Baixando áudio…" : "Baixando segmentos…";
  progressBarEl.style.width = "0%";

  let written = 0;

  try {
    // fMP4 precisa do init segment (#EXT-X-MAP) antes de tudo; o TS carrega o
    // cabeçalho no próprio fluxo e o init sai do remuxer.
    if (playlist.map) {
      const init = await fetchWithRetry(playlist.map.url, false, signal);
      await writable.write(init);
      written += init.byteLength;
    }

    await streamSegments(playlist.segments, {
      signal,
      write: async (data) => {
        if (remuxer) {
          for (const chunk of remuxer.push(data)) {
            await writable.write(chunk);
            written += chunk.byteLength;
          }
        } else {
          await writable.write(data);
          written += data.byteLength;
        }
      },
      onProgress: (done, total) => {
        const pct = Math.round((done / total) * 100);
        progressBarEl.style.width = pct + "%";
        progressTextEl.textContent = `${done} de ${total} segmentos • ${formatSize(written)} gravados`;
      },
    });

    await writable.close();
    return { filename: name, size: written, remuxed: !fmp4 };
  } catch (e) {
    // Fecha o handle e remove o arquivo parcial para não deixar lixo na pasta.
    try {
      await writable.abort();
    } catch (_) {
      /* já fechado */
    }
    try {
      await dirHandle.removeEntry(name);
    } catch (_) {
      /* pode não existir */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------

let controller = null;

cancelBtn.addEventListener("click", () => {
  if (controller) controller.abort();
});

// Enquanto o download roda a aba não pode ser fechada: a gravação em disco
// acontece aqui, não no service worker.
window.addEventListener("beforeunload", (e) => {
  if (controller && !controller.signal.aborted) {
    e.preventDefault();
    e.returnValue = "";
  }
});

async function pickDirectory() {
  try {
    return await window.showDirectoryPicker({ mode: "readwrite", id: "video-downloads" });
  } catch (e) {
    if (e && e.name === "AbortError") return null; // usuário fechou o seletor
    throw e;
  }
}

async function startDownload(variantUrl, audioUrl, label) {
  const dirHandle = await pickDirectory();
  if (!dirHandle) return;

  controller = new AbortController();
  const baseName = sanitizeFilename(pageTitle) + (label ? ` ${label}` : "");

  try {
    const result = await downloadMediaPlaylist(variantUrl, dirHandle, controller.signal, { baseName });

    let doneText = `Arquivo "${result.filename}" (${formatSize(result.size)}) salvo na pasta escolhida.`;
    if (result.remuxed) {
      doneText += " Os segmentos MPEG-TS foram convertidos para MP4 automaticamente.";
    }

    if (audioUrl) {
      const audio = await downloadMediaPlaylist(audioUrl, dirHandle, controller.signal, {
        audioOnly: true,
        suffix: " (áudio)",
        baseName,
      });
      doneText +=
        ` O áudio deste stream é uma faixa separada e foi salvo como "${audio.filename}".` +
        " Para juntar os dois em um arquivo só é preciso um conversor como o FFmpeg:" +
        ` ffmpeg -i "${result.filename}" -i "${audio.filename}" -c copy saida.mp4`;
    }

    doneTextEl.textContent = doneText;
    showStep("done");
  } catch (e) {
    if (e && e.name === "AbortError") {
      fail("Download cancelado. O arquivo parcial foi removido da pasta.");
      return;
    }
    console.error(e);
    fail(friendlyError(e));
  } finally {
    controller = null;
  }
}

function labelForVariant(variant) {
  const parts = [];
  if (variant.resolution) parts.push(variant.resolution);
  if (variant.bandwidth) parts.push(Math.round(variant.bandwidth / 1000) + " kbps");
  return parts.join(" • ") || "Qualidade padrão";
}

// Sufixo curto para o nome do arquivo: a altura da resolução, quando houver.
function filenameLabelFor(variant) {
  const match = /(\d+)x(\d+)/.exec(variant.resolution || "");
  if (match) return match[2] + "p";
  if (variant.bandwidth) return Math.round(variant.bandwidth / 1000) + "kbps";
  return "";
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
    btn.textContent = "Escolher pasta e baixar";
    btn.addEventListener("click", () => {
      startDownload(variant.url, pickAudioUrl(variant, master.audioRenditions), filenameLabelFor(variant));
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

  if (!window.showDirectoryPicker) {
    fail("Este navegador não oferece a File System Access API, necessária para gravar o vídeo em disco.");
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
      // Playlist de mídia direta: não há qualidade a escolher, mas o seletor
      // de pasta exige um clique do usuário.
      showStep("start");
      startBtn.addEventListener("click", () => startDownload(srcUrl, null, ""));
    }
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

init();
