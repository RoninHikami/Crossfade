import { SERVICE_NAMES, lastRunView, load, onChange, send } from "./shared.js";

const $ = (selector) => document.querySelector(selector);

function openSettings(hash = "") {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/options.html${hash}`) });
  window.close();
}

function renderServices(data) {
  for (const row of document.querySelectorAll(".service")) {
    const service = row.dataset.service;
    const account = data.auth[service];
    const state = row.querySelector(".state");
    const button = row.querySelector(".connect");
    state.classList.toggle("ok", Boolean(account));
    if (account) {
      state.textContent = `✓ ${account.name}`;
      button.classList.add("hidden");
    } else {
      const waiting = service === "yandex" && data.yandexLoginPending;
      state.textContent = waiting ? "Войдите в открывшейся вкладке" : "Не подключено";
      button.classList.remove("hidden");
    }
  }
  $("#auth-error").textContent = data.authError;
  $("#auth-error").classList.toggle("hidden", !data.authError);
}

function renderDirection(direction) {
  for (const button of document.querySelectorAll("#direction button")) {
    button.setAttribute("aria-checked", String(button.dataset.value === direction));
  }
}

function renderProgress(status) {
  const target = SERVICE_NAMES[status.target] || "";
  const steps = status.steps > 1 ? ` (шаг ${status.step} из ${status.steps})` : "";
  const bar = $(".bar");
  if (status.phase === "matching" && status.todo) {
    $("#phase").textContent = `Ищу треки в ${target}${steps}`;
    $("#counter").textContent = `${status.processed} из ${status.todo}`;
    bar.classList.remove("indeterminate");
    $("#bar-fill").style.width = `${Math.round((status.processed / status.todo) * 100)}%`;
    $("#current").textContent = status.current || "";
  } else {
    const service = SERVICE_NAMES[status.service];
    $("#phase").textContent = service ? `Загружаю лайки: ${service}${steps}` : "Подготовка…";
    $("#counter").textContent = "";
    bar.classList.add("indeterminate");
    $("#bar-fill").style.width = "";
    $("#current").textContent = "";
  }
}

function render(data) {
  renderServices(data);
  renderDirection(data.settings.direction);

  const running = Boolean(data.status.running);
  $("#idle").classList.toggle("hidden", running);
  $("#running").classList.toggle("hidden", !running);
  for (const button of document.querySelectorAll("#direction button")) button.disabled = running;

  if (running) {
    renderProgress(data.status);
  } else {
    const ready = data.auth.yandex && data.auth.spotify;
    $("#start").disabled = !ready;
    $("#start-hint").textContent = ready ? "" : "Сначала подключите оба сервиса";
    const lastRun = data.status.lastRun;
    const box = $("#last-run");
    box.classList.toggle("hidden", !lastRun);
    box.replaceChildren(lastRun ? lastRunView(lastRun, { onMore: () => openSettings("#history") }) : "");
  }

  $("#auto").checked = data.settings.autoSync;
  $("#interval").value = String(data.settings.intervalMin);
  $("#interval").disabled = !data.settings.autoSync;
}

async function refresh() {
  render(await load());
}

for (const row of document.querySelectorAll(".service")) {
  row.querySelector(".connect").addEventListener("click", async (event) => {
    const service = row.dataset.service;
    event.target.disabled = true;
    try {
      await send("connect", { service });
    } catch (error) {
      if (error.code === "no_client_id") openSettings("#spotify");
    } finally {
      event.target.disabled = false;
      refresh();
    }
  });
}

for (const button of document.querySelectorAll("#direction button")) {
  button.addEventListener("click", () => send("settings", { patch: { direction: button.dataset.value } }));
}

$("#start").addEventListener("click", () => send("start"));
$("#stop").addEventListener("click", () => send("stop"));
$("#open-settings").addEventListener("click", () => openSettings());
$("#auto").addEventListener("change", (e) => send("settings", { patch: { autoSync: e.target.checked } }));
$("#interval").addEventListener("change", (e) => send("settings", { patch: { intervalMin: Number(e.target.value) } }));

onChange(refresh);
refresh();
