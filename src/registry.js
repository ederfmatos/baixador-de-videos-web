// Registro de downloads HLS, compartilhado pela página de download e pela
// página de lista.
//
// Downloads HLS não passam pelo chrome.downloads (a gravação é feita pela
// aba via File System Access API), então o Chrome não sabe que eles existem.
// Este módulo mantém o estado deles em dois lugares:
//
//   - chrome.storage.local, uma chave por download ("dl:<id>"). Uma chave por
//     registro em vez de um array único evita que duas abas gravando ao mesmo
//     tempo percam atualizações uma da outra.
//   - IndexedDB, para o que o storage.local não aceita: os handles de
//     diretório e de arquivo da File System Access API, que são
//     estruturalmente clonáveis mas não serializáveis em JSON. São eles que
//     permitem retomar um download depois de fechar a aba.

const PREFIX = "dl:";
const DB_NAME = "video-downloader";
const DB_VERSION = 1;
const STORE = "resume";

// ---------------------------------------------------------------------------
// Registro em chrome.storage.local
// ---------------------------------------------------------------------------

function newDownloadId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function saveRecord(record) {
  const updated = { ...record, updatedAt: Date.now() };
  await chrome.storage.local.set({ [PREFIX + record.id]: updated });
  return updated;
}

async function getRecord(id) {
  const key = PREFIX + id;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function listRecords() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([, value]) => value)
    .sort((a, b) => b.startedAt - a.startedAt);
}

async function deleteRecord(id) {
  await chrome.storage.local.remove(PREFIX + id);
  await deleteResumeState(id);
}

// ---------------------------------------------------------------------------
// Handles da File System Access API em IndexedDB
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(mode, operation) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = operation(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : undefined);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

// Guarda tudo que é preciso para continuar de onde parou: os handles, a URL
// da playlist, o índice do próximo segmento e quantos bytes já foram gravados.
function saveResumeState(state) {
  return runTransaction("readwrite", (store) => store.put(state));
}

function getResumeState(id) {
  return runTransaction("readonly", (store) => store.get(id));
}

function deleteResumeState(id) {
  return runTransaction("readwrite", (store) => store.delete(id)).catch(() => {});
}

// ---------------------------------------------------------------------------

const Registry = {
  newDownloadId,
  saveRecord,
  getRecord,
  listRecords,
  deleteRecord,
  saveResumeState,
  getResumeState,
  deleteResumeState,
};

// Carregado como script clássico por downloader.html e downloads.html.
globalThis.Registry = Registry;
