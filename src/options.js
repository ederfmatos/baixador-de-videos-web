// Página de opções: gerencia a lista de domínios ignorados que o service
// worker consulta em chrome.storage.local antes de registrar um vídeo.

const form = document.getElementById("add-form");
const input = document.getElementById("domain-input");
const errorEl = document.getElementById("input-error");
const listEl = document.getElementById("domain-list");
const emptyEl = document.getElementById("empty");
const askWhereEl = document.getElementById("ask-where");

// Aceita "exemplo.com", "cdn.exemplo.com.br"; rejeita URLs completas, portas e
// caminhos, que nunca casariam com o hostname comparado no background.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

async function getBlacklist() {
  const { blacklist = [] } = await chrome.storage.local.get("blacklist");
  return blacklist;
}

async function setBlacklist(list) {
  await chrome.storage.local.set({ blacklist: list });
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError() {
  errorEl.classList.add("hidden");
}

function render(list) {
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", list.length > 0);

  list.forEach((domain) => {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.textContent = domain;

    const remove = document.createElement("button");
    remove.className = "btn-remove";
    remove.textContent = "Remover";
    remove.addEventListener("click", async () => {
      const updated = (await getBlacklist()).filter((d) => d !== domain);
      await setBlacklist(updated);
      render(updated);
    });

    li.appendChild(name);
    li.appendChild(remove);
    listEl.appendChild(li);
  });
}

// Tolera que o usuário cole uma URL inteira em vez de só o domínio.
function normalize(value) {
  let text = value.trim().toLowerCase();
  if (!text) return "";
  if (text.includes("://")) {
    try {
      text = new URL(text).hostname;
    } catch (e) {
      return "";
    }
  }
  return text.replace(/^www\./, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();

  const domain = normalize(input.value);
  if (!domain || !DOMAIN_RE.test(domain)) {
    showError("Informe um domínio válido, como exemplo.com.");
    return;
  }

  const list = await getBlacklist();
  if (list.includes(domain)) {
    showError("Esse domínio já está na lista.");
    return;
  }

  const updated = [...list, domain].sort();
  await setBlacklist(updated);
  input.value = "";
  render(updated);
});

askWhereEl.addEventListener("change", () => {
  chrome.storage.local.set({ askWhereToSave: askWhereEl.checked });
});

chrome.storage.local.get("askWhereToSave").then(({ askWhereToSave = false }) => {
  askWhereEl.checked = !!askWhereToSave;
});

getBlacklist().then(render);
