// Página de download HLS: busca a playlist .m3u8, deixa o usuário escolher a
// qualidade (playlist master) e a pasta de destino, baixa todos os segmentos,
// descriptografa AES-128 padrão quando presente e grava direto no disco.
//
// Os segmentos são gravados em ordem, um a um, via File System Access API —
// nada é acumulado em memória, então o tamanho do vídeo não é limitado pela
// RAM disponível. Segmentos MPEG-TS passam pelo mux.js e saem como MP4.
//
// O download pode ser pausado, e sobrevive ao fechamento da aba: a cada
// checkpoint o arquivo é fechado (o que confirma os bytes no disco) e o
// estado vai para o IndexedDB, de onde a página de downloads o retoma.
//
// Não contorna DRM: streams com SAMPLE-AES / Widevine / FairPlay / PlayReady
// são detectados e recusados com uma mensagem clara.

const CONCURRENCY = 4;
const RETRIES = 2;
// Quantos segmentos podem estar baixados à frente do que já foi gravado.
// Segura o consumo de memória sem deixar os workers ociosos.
const MAX_LOOKAHEAD = 16;
// De quantos em quantos segmentos o arquivo é fechado e reaberto. Um
// FileSystemWritableFileStream grava num arquivo temporário e só transfere
// para o destino no close() — sem esses checkpoints, uma aba encerrada no
// meio perderia tudo e não haveria o que retomar.
const CHECKPOINT_SEGMENTS = 25;
// Frequência máxima de atualização do registro compartilhado.
const RECORD_THROTTLE_MS = 500;

const params = new URLSearchParams(location.search);
const srcUrl = params.get("src") || "";
const pageTitle = params.get("title") || "video";
const refererUrl = params.get("referer") || "";
const resumeId = params.get("resume") || "";

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
const pauseBtn = document.getElementById("pause-btn");
const startBtn = document.getElementById("start-btn");
const startSummaryEl = document.getElementById("start-summary");

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
    const subtitles = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
        if (attrs.TYPE === "AUDIO" && attrs.URI) {
          audioRenditions.push({
            groupId: attrs["GROUP-ID"] || "",
            name: attrs.NAME || "áudio",
            language: attrs.LANGUAGE || "",
            isDefault: attrs.DEFAULT === "YES",
            url: resolveUrl(attrs.URI, baseUrl),
          });
        }
        if (attrs.TYPE === "SUBTITLES") {
          subtitles.push({ name: attrs.NAME || "legenda", language: attrs.LANGUAGE || "" });
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
              frameRate: parseFloat(attrs["FRAME-RATE"] || "0") || 0,
              videoRange: attrs["VIDEO-RANGE"] || "",
              audioGroup: attrs.AUDIO || "",
            });
            break;
          }
        }
      }
    }

    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: "master", variants, audioRenditions, subtitles };
  }

  // Playlist de mídia (lista de segmentos).
  const segments = [];
  let currentKey = null;
  let map = null;
  let mediaSequence = 0;
  let live = true;

  // O número de sequência precisa de um contador próprio: é ele que gera o IV
  // padrão da descriptografia AES-128.
  let sequence = null;

  // Passada sequencial: uma linha sem "#" logo após um #EXTINF é a URI do
  // segmento; a chave em vigor (#EXT-X-KEY) se aplica aos segmentos seguintes.
  let expectingSegment = false;
  // A duração declarada em cada #EXTINF; somada, dá a duração do vídeo.
  let pendingDuration = 0;
  let duration = 0;

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
      // "#EXTINF:9.009,título opcional"
      pendingDuration = parseFloat(line.slice("#EXTINF:".length).split(",")[0]) || 0;
    } else if (expectingSegment && !line.startsWith("#")) {
      if (sequence === null) sequence = mediaSequence;
      segments.push({
        url: resolveUrl(line, baseUrl),
        key: currentKey,
        sequence: sequence++,
      });
      duration += pendingDuration;
      expectingSegment = false;
    }
  }

  return { type: "media", segments, map, live, duration };
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

async function setupHeaderRule(referer) {
  if (!referer || !chrome.declarativeNetRequest) return;

  let origin;
  try {
    origin = new URL(referer).origin;
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
            { header: "Referer", operation: "set", value: referer },
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

// Controle de pausa: workers e gravador passam por aqui antes de cada unidade
// de trabalho, então pausar interrompe tanto o download quanto a gravação.
function createPauseControl() {
  let paused = false;
  const gate = createGate();
  return {
    get paused() {
      return paused;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      gate.signal();
    },
    // Acorda quem estiver bloqueado, para que um cancelamento não fique preso
    // esperando um resume que nunca vem.
    wake() {
      gate.signal();
    },
    async wait(halted) {
      while (paused && !halted()) await gate.wait();
    },
  };
}

// Baixa em paralelo, mas entrega os segmentos ao `write` em ordem estrita e
// descarta cada buffer logo após gravá-lo. Falha na primeira exceção em vez de
// esperar a fila inteira terminar.
async function streamSegments(segments, { signal, write, onProgress, onPause, pause, startIndex = 0 }) {
  const buffers = new Map();
  let nextToFetch = startIndex;
  let nextToWrite = startIndex;
  let failure = null;

  const produced = createGate();
  const consumed = createGate();

  const stop = () => {
    produced.signal();
    consumed.signal();
    if (pause) pause.wake();
  };
  signal.addEventListener("abort", stop);

  const halted = () => failure !== null || signal.aborted;

  async function worker() {
    while (true) {
      while (nextToFetch - nextToWrite >= MAX_LOOKAHEAD && !halted()) {
        await consumed.wait();
      }
      if (pause) await pause.wait(halted);
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
      // Ao pausar, grava um checkpoint antes de bloquear: assim o arquivo é
      // confirmado no disco e a aba pode ser fechada sem perder o progresso.
      if (pause && pause.paused) {
        if (onPause) await onPause(nextToWrite);
        await pause.wait(halted);
      }
      if (halted()) return;

      const data = buffers.get(nextToWrite);
      buffers.delete(nextToWrite);
      await write(data, segments[nextToWrite], nextToWrite);
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
  return nextToWrite;
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
// de MP4 fragmentado correspondentes. O init segment sai só na primeira vez —
// ao retomar um download já existe um no arquivo, e um segundo no meio o
// corromperia, daí o parâmetro.
function createRemuxer(initAlreadyWritten = false) {
  if (typeof muxjs === "undefined") {
    throw new Error("mux.js não pôde ser carregado; o remux para MP4 está indisponível.");
  }
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  let output = [];
  let initSent = initAlreadyWritten;

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

// ---------------------------------------------------------------------------
// Registro compartilhado (lista de downloads)
// ---------------------------------------------------------------------------

let record = null;
let lastRecordWrite = 0;

async function updateRecord(patch, { force = false } = {}) {
  if (!record) return;
  record = { ...record, ...patch };
  const now = Date.now();
  if (!force && now - lastRecordWrite < RECORD_THROTTLE_MS) return;
  lastRecordWrite = now;
  await Registry.saveRecord(record);
}

// ---------------------------------------------------------------------------
// Núcleo do download
// ---------------------------------------------------------------------------

// `resume` traz os handles e o índice salvos no IndexedDB; sem ele o download
// começa do zero e o arquivo é criado na pasta escolhida.
async function downloadMediaPlaylist(playlistUrl, dirHandle, signal, options) {
  const { audioOnly = false, suffix = "", baseName, pause, resume = null, onFileReady } = options;

  const text = await fetchWithRetry(playlistUrl, true, signal);
  const playlist = parsePlaylist(text, playlistUrl);

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
  const ext = fmp4 && audioOnly ? "m4a" : "mp4";

  let fileHandle;
  let name;
  let startIndex = 0;
  let written = 0;

  if (resume) {
    fileHandle = resume.fileHandle;
    name = resume.filename;
    startIndex = resume.nextIndex;
    written = resume.bytesWritten;

    if (startIndex >= playlist.segments.length) {
      throw new Error("A playlist mudou desde a pausa e não há mais o que baixar.");
    }
  } else {
    const created = await uniqueFileHandle(dirHandle, `${baseName}${suffix}`, ext);
    fileHandle = created.handle;
    name = created.name;
  }

  if (onFileReady) await onFileReady(name, playlist.segments.length);

  const remuxer = fmp4 ? null : createRemuxer(startIndex > 0);

  // keepExistingData + seek preservam o que já foi gravado antes da pausa.
  let writable = await fileHandle.createWritable({ keepExistingData: startIndex > 0 });
  if (written > 0) await writable.seek(written);

  showStep("progress");
  progressLabelEl.textContent = audioOnly ? "Baixando áudio…" : "Baixando segmentos…";

  // Fecha o arquivo (confirmando os bytes no disco) e o reabre no ponto certo.
  async function checkpoint(nextIndex) {
    await writable.close();
    await Registry.saveResumeState({
      id: record.id,
      dirHandle,
      fileHandle,
      filename: name,
      playlistUrl,
      audioOnly,
      suffix,
      baseName,
      nextIndex,
      bytesWritten: written,
      referer: refererUrl,
      title: pageTitle,
    });
    writable = await fileHandle.createWritable({ keepExistingData: true });
    await writable.seek(written);
  }

  try {
    // fMP4 precisa do init segment (#EXT-X-MAP) antes de tudo; o TS carrega o
    // cabeçalho no próprio fluxo e o init sai do remuxer.
    if (playlist.map && startIndex === 0) {
      const init = await fetchWithRetry(playlist.map.url, false, signal);
      await writable.write(init);
      written += init.byteLength;
    }

    let sinceCheckpoint = 0;

    await streamSegments(playlist.segments, {
      signal,
      pause,
      startIndex,
      onPause: (index) => checkpoint(index),
      write: async (data, segment, index) => {
        if (remuxer) {
          for (const chunk of remuxer.push(data)) {
            await writable.write(chunk);
            written += chunk.byteLength;
          }
        } else {
          await writable.write(data);
          written += data.byteLength;
        }

        if (++sinceCheckpoint >= CHECKPOINT_SEGMENTS) {
          sinceCheckpoint = 0;
          await checkpoint(index + 1);
        }
      },
      onProgress: (done, total) => {
        const pct = Math.round((done / total) * 100);
        progressBarEl.style.width = pct + "%";
        progressTextEl.textContent = `${done} de ${total} segmentos • ${formatSize(written)} gravados`;
        updateRecord({ done, total, bytes: written, filename: name });
      },
    });

    await writable.close();
    await Registry.deleteResumeState(record.id);
    return { filename: name, size: written, remuxed: !fmp4 };
  } catch (e) {
    // Cancelamento ou falha: fecha o handle e remove o arquivo parcial.
    // Pausar não passa por aqui — a pausa bloqueia o gravador depois de um
    // checkpoint, deixando arquivo e estado de retomada intactos.
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
    await Registry.deleteResumeState(record.id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------

let controller = null;
let pauseControl = null;

function setPauseButton(paused) {
  pauseBtn.textContent = paused ? "Retomar" : "Pausar";
  progressLabelEl.textContent = paused ? "Pausado" : "Baixando segmentos…";
}

pauseBtn.addEventListener("click", async () => {
  if (!pauseControl) return;
  if (pauseControl.paused) {
    pauseControl.resume();
    setPauseButton(false);
    await updateRecord({ state: "running" }, { force: true });
  } else {
    pauseControl.pause();
    setPauseButton(true);
    await updateRecord({ state: "paused" }, { force: true });
  }
});

cancelBtn.addEventListener("click", () => {
  if (controller) controller.abort();
});

// Enquanto o download roda a aba não pode ser fechada: a gravação em disco
// acontece aqui, não no service worker. O progresso até o último checkpoint
// sobrevive e aparece como retomável na lista de downloads.
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

async function runDownload({ dirHandle, variantUrl, audioUrl, label, resume = null }) {
  controller = new AbortController();
  pauseControl = createPauseControl();
  const tab = await chrome.tabs.getCurrent();

  const baseName = resume
    ? resume.baseName
    : sanitizeFilename(pageTitle) + (label ? ` ${label}` : "");

  record = {
    id: resume ? resume.id : Registry.newDownloadId(),
    title: pageTitle,
    quality: label || "",
    filename: resume ? resume.filename : "",
    state: "running",
    done: resume ? resume.nextIndex : 0,
    total: 0,
    bytes: resume ? resume.bytesWritten : 0,
    error: "",
    startedAt: resume ? resume.startedAt || Date.now() : Date.now(),
    tabId: tab ? tab.id : null,
    playlistUrl: variantUrl,
    referer: refererUrl,
  };
  await Registry.saveRecord(record);

  setPauseButton(false);
  pauseBtn.classList.remove("hidden");

  try {
    const result = await downloadMediaPlaylist(variantUrl, dirHandle, controller.signal, {
      baseName,
      pause: pauseControl,
      resume,
      onFileReady: (name, total) => updateRecord({ filename: name, total }, { force: true }),
    });

    let doneText = `Arquivo "${result.filename}" (${formatSize(result.size)}) salvo na pasta escolhida.`;
    if (result.remuxed) {
      doneText += " Os segmentos MPEG-TS foram convertidos para MP4 automaticamente.";
    }

    if (audioUrl) {
      const audio = await downloadMediaPlaylist(audioUrl, dirHandle, controller.signal, {
        audioOnly: true,
        suffix: " (áudio)",
        baseName,
        pause: pauseControl,
      });
      doneText +=
        ` O áudio deste stream é uma faixa separada e foi salvo como "${audio.filename}".` +
        " Para juntar os dois em um arquivo só é preciso um conversor como o FFmpeg:" +
        ` ffmpeg -i "${result.filename}" -i "${audio.filename}" -c copy saida.mp4`;
    }

    await updateRecord({ state: "done", bytes: result.size }, { force: true });
    doneTextEl.textContent = doneText;
    showStep("done");
  } catch (e) {
    if (e && e.name === "AbortError") {
      await updateRecord({ state: "canceled" }, { force: true });
      fail("Download cancelado. O arquivo parcial foi removido da pasta.");
      return;
    }
    console.error(e);
    await updateRecord({ state: "error", error: friendlyError(e) }, { force: true });
    fail(friendlyError(e));
  } finally {
    controller = null;
    pauseControl = null;
    pauseBtn.classList.add("hidden");
  }
}

async function startDownload(variantUrl, audioUrl, label) {
  const dirHandle = await pickDirectory();
  if (!dirHandle) return;
  await runDownload({ dirHandle, variantUrl, audioUrl, label });
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

// Nome legível do codec de vídeo a partir do atributo CODECS.
function codecName(codecs) {
  const value = (codecs || "").toLowerCase();
  if (/av01/.test(value)) return "AV1";
  if (/hvc1|hev1/.test(value)) return "HEVC";
  if (/avc1|h264/.test(value)) return "H.264";
  if (/vp0?9/.test(value)) return "VP9";
  return "";
}

function labelForVariant(variant) {
  const parts = [];
  if (variant.resolution) parts.push(variant.resolution);
  if (variant.bandwidth) parts.push(Math.round(variant.bandwidth / 1000) + " kbps");
  return parts.join(" • ") || "Qualidade padrão";
}

// Linha secundária: duração real (quando a playlist já foi lida), tamanho
// estimado, codec, taxa de quadros e HDR.
function detailsForVariant(variant) {
  const parts = [];
  if (variant.duration) parts.push(formatDuration(variant.duration));
  if (variant.duration && variant.bandwidth) {
    parts.push("~" + formatSize((variant.bandwidth / 8) * variant.duration));
  }
  const codec = codecName(variant.codecs);
  if (codec) parts.push(codec);
  if (variant.frameRate) parts.push(Math.round(variant.frameRate) + " fps");
  if (variant.videoRange && variant.videoRange !== "SDR") parts.push(variant.videoRange);
  return parts.join(" • ");
}

// Lê a playlist de cada variante só para somar os #EXTINF. São requisições
// pequenas e paralelas; qualquer falha é silenciosa, porque isso é enfeite —
// a tela precisa continuar utilizável se o servidor recusar.
async function loadVariantDurations(variants, onUpdate) {
  await Promise.all(
    variants.map(async (variant) => {
      try {
        const text = await fetchWithRetry(variant.url, true);
        const parsed = parsePlaylist(text, variant.url);
        if (parsed.type === "media" && parsed.duration > 0) {
          variant.duration = parsed.duration;
          variant.segmentCount = parsed.segments.length;
          onUpdate(variant);
        }
      } catch (e) {
        /* sem duração para esta variante */
      }
    })
  );
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

  const detailNodes = new Map();

  master.variants.forEach((variant) => {
    const li = document.createElement("li");

    const meta = document.createElement("div");
    meta.className = "variant-meta";

    const label = document.createElement("span");
    label.className = "variant-label";
    label.textContent = labelForVariant(variant);

    const details = document.createElement("span");
    details.className = "variant-details";
    details.textContent = detailsForVariant(variant) || "lendo duração…";
    detailNodes.set(variant, details);

    meta.appendChild(label);
    meta.appendChild(details);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Escolher pasta e baixar";
    btn.addEventListener("click", () => {
      startDownload(variant.url, pickAudioUrl(variant, master.audioRenditions), filenameLabelFor(variant));
    });

    li.appendChild(meta);
    li.appendChild(btn);
    qualityListEl.appendChild(li);
  });

  // Faixas de áudio e legendas presentes no stream.
  const extras = [];
  if (master.audioRenditions.length > 1) {
    const names = master.audioRenditions.map((a) => a.language || a.name).filter(Boolean);
    if (names.length) extras.push(`Faixas de áudio: ${[...new Set(names)].join(", ")}`);
  }
  if (master.subtitles && master.subtitles.length) {
    const names = master.subtitles.map((s) => s.language || s.name).filter(Boolean);
    if (names.length) {
      extras.push(`Legendas disponíveis no stream: ${[...new Set(names)].join(", ")} (não são baixadas)`);
    }
  }
  if (extras.length) showNote(extras.join(" · "));

  // As durações chegam depois; cada uma atualiza sua linha assim que sai.
  loadVariantDurations(master.variants, (variant) => {
    const node = detailNodes.get(variant);
    if (node) node.textContent = detailsForVariant(variant);
  }).then(() => {
    for (const [variant, node] of detailNodes) {
      if (!variant.duration) node.textContent = detailsForVariant(variant);
    }
  });
}

// Retomada: os handles vêm do IndexedDB, mas a permissão de escrita precisa
// ser reconcedida depois que o navegador reinicia — e isso exige um gesto do
// usuário, que é o clique em "Retomar" na lista de downloads.
async function resumeDownload(id) {
  const state = await Registry.getResumeState(id);
  if (!state) {
    fail("Não há mais estado salvo para retomar este download.");
    return;
  }

  const stored = await Registry.getRecord(id);
  document.getElementById("video-title").textContent = state.title || pageTitle;

  const permission = await state.dirHandle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    const granted = await state.dirHandle.requestPermission({ mode: "readwrite" });
    if (granted !== "granted") {
      fail("Sem permissão de escrita na pasta original. Conceda o acesso para retomar o download.");
      return;
    }
  }

  await setupHeaderRule(state.referer);

  await runDownload({
    dirHandle: state.dirHandle,
    variantUrl: state.playlistUrl,
    audioUrl: null,
    label: stored ? stored.quality : "",
    resume: { ...state, startedAt: stored ? stored.startedAt : Date.now(), baseName: state.baseName },
  });
}

async function init() {
  if (!window.showDirectoryPicker) {
    fail("Este navegador não oferece a File System Access API, necessária para gravar o vídeo em disco.");
    return;
  }

  if (resumeId) {
    // A retomada precisa de um gesto do usuário para a permissão da pasta.
    showStep("start");
    startBtn.textContent = "Retomar download";
    startBtn.addEventListener("click", () => resumeDownload(resumeId));
    return;
  }

  if (!srcUrl) {
    fail("Nenhuma URL de stream informada.");
    return;
  }

  try {
    // Instala a regra de Referer/Origin antes de qualquer requisição.
    await setupHeaderRule(refererUrl);

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
      const facts = [`${playlist.segments.length} segmentos`];
      if (playlist.duration) facts.unshift(formatDuration(playlist.duration));
      facts.push(isFragmentedMp4(playlist) ? "fMP4" : "MPEG-TS → MP4");
      if (playlist.segments.some((s) => s.key)) facts.push("AES-128");
      startSummaryEl.textContent = facts.join(" • ");

      showStep("start");
      startBtn.addEventListener("click", () => startDownload(srcUrl, null, ""));
    }
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

init();
