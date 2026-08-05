// Lista de downloads de streams HLS. Lê o registro que as abas de download
// mantêm em chrome.storage.local e se atualiza sozinha quando ele muda.

const listEl = document.getElementById("download-list");
const emptyEl = document.getElementById("empty");
const clearBtn = document.getElementById("clear-btn");

const FINISHED = new Set(["done", "canceled", "error", "interrupted"]);

const STATE_LABELS = {
  running: "Baixando",
  paused: "Pausado",
  done: "Concluído",
  canceled: "Cancelado",
  error: "Falhou",
  interrupted: "Interrompido",
};

function formatSize(bytes) {
  if (!bytes) return "0 KB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Um registro "running" cuja aba já não existe ficou órfão: a aba foi fechada
// ou o navegador reiniciou sem passar pelo caminho de cancelamento.
async function reconcile(records) {
  const openTabs = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const fixed = [];

  for (const record of records) {
    const orphan =
      (record.state === "running" || record.state === "paused") &&
      (record.tabId === null || !openTabs.has(record.tabId));

    if (orphan) {
      const updated = { ...record, state: "interrupted" };
      await Registry.saveRecord(updated);
      fixed.push(updated);
    } else {
      fixed.push(record);
    }
  }
  return fixed;
}

function makeButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function renderRow(record) {
  const li = document.createElement("li");
  li.className = "download-item state-" + record.state;

  const top = document.createElement("div");
  top.className = "row-top";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = record.filename || record.title || "(sem nome)";
  name.title = record.playlistUrl || "";

  const state = document.createElement("span");
  state.className = "badge";
  state.textContent = STATE_LABELS[record.state] || record.state;

  top.appendChild(name);
  top.appendChild(state);

  const track = document.createElement("div");
  track.className = "progress-track";
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  bar.style.width = record.total ? Math.round((record.done / record.total) * 100) + "%" : "0%";
  track.appendChild(bar);

  const sub = document.createElement("p");
  sub.className = "sub";
  const bits = [];
  if (record.total) bits.push(`${record.done} de ${record.total} segmentos`);
  bits.push(formatSize(record.bytes));
  if (record.quality) bits.push(record.quality);
  bits.push(formatTime(record.startedAt));
  sub.textContent = bits.filter(Boolean).join(" • ");

  li.appendChild(top);
  if (record.state !== "done") li.appendChild(track);
  li.appendChild(sub);

  if (record.error) {
    const err = document.createElement("p");
    err.className = "sub error";
    err.textContent = record.error;
    li.appendChild(err);
  }

  const actions = document.createElement("div");
  actions.className = "actions";

  // Retomar e tentar novamente são a mesma operação: continuar do último
  // checkpoint. Só muda o rótulo, conforme o download parou por si ou falhou.
  if (record.state === "interrupted" || record.state === "error") {
    const state = await Registry.getResumeState(record.id);
    if (state) {
      const label = record.state === "error" ? "Tentar novamente" : "Retomar";
      actions.appendChild(
        makeButton(label, "btn-primary", () => {
          chrome.tabs.create({
            url: chrome.runtime.getURL("src/downloader.html") + `?resume=${encodeURIComponent(record.id)}`,
          });
        })
      );
    } else if (record.state === "error" && record.playlistUrl) {
      // Sem estado salvo (falhou antes do primeiro checkpoint): recomeça.
      actions.appendChild(
        makeButton("Baixar de novo", "btn-primary", () => {
          const url =
            chrome.runtime.getURL("src/downloader.html") +
            `?src=${encodeURIComponent(record.playlistUrl)}` +
            `&title=${encodeURIComponent(record.title || "video")}` +
            `&referer=${encodeURIComponent(record.referer || "")}`;
          chrome.tabs.create({ url });
        })
      );
    }
  }

  if (record.state === "running" || record.state === "paused") {
    actions.appendChild(
      makeButton("Ir para a aba", "btn-secondary", () => {
        if (record.tabId !== null) chrome.tabs.update(record.tabId, { active: true });
      })
    );
  }

  if (FINISHED.has(record.state)) {
    actions.appendChild(
      makeButton("Remover da lista", "btn-secondary", async () => {
        await Registry.deleteRecord(record.id);
        render();
      })
    );
  }

  if (actions.childElementCount) li.appendChild(actions);
  return li;
}

async function render() {
  const records = await reconcile(await Registry.listRecords());

  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", records.length > 0);

  for (const record of records) {
    listEl.appendChild(await renderRow(record));
  }
}

clearBtn.addEventListener("click", async () => {
  const records = await Registry.listRecords();
  for (const record of records) {
    // Com estado salvo ainda dá para retomar ou tentar de novo do ponto onde
    // parou; esses não somem no "limpar".
    if (
      (record.state === "interrupted" || record.state === "error") &&
      (await Registry.getResumeState(record.id))
    ) {
      continue;
    }
    if (FINISHED.has(record.state)) await Registry.deleteRecord(record.id);
  }
  render();
});

// As abas de download escrevem no storage a cada meio segundo; reagir ao
// evento evita ficar consultando em intervalo fixo.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("dl:"))) render();
});

render();
