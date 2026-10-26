import {
  ACCUSATIVE_NAMES, LOGIN_HINTS, SERVICES, SERVICE_NAMES, SHORT_NAMES, lastRunView, load, onChange, send,
} from "./shared.js";

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
      state.textContent = data.loginPending[service] ? LOGIN_HINTS[service] : "Не подключено";
      button.classList.remove("hidden");
    }
  }
  $("#auth-error").textContent = data.authError;
  $("#auth-error").classList.toggle("hidden", !data.authError);
}

function fillServiceSelect(select, value) {
  if (!select.options.length) {
    select.append(...SERVICES.map((s) => new Option(SHORT_NAMES[s], s)));
  }
  select.value = value;
}

function renderRoute(settings, running) {
  fillServiceSelect($("#source"), settings.source);
  fillServiceSelect($("#target"), settings.target);
  $("#both-ways").checked = settings.bothWays;
  for (const control of [$("#source"), $("#target"), $("#swap"), $("#both-ways")]) control.disabled = running;
}

function renderProgress(status) {
  const target = SERVICE_NAMES[status.target] || "";
  const steps = status.steps > 1 ? ` (шаг ${status.step} из ${status.steps})` : "";
  const bar = $(".bar");
  if (status.phase === "matching" && status.todo) {
    $("#phase").textContent = `Ищу треки: ${target}${steps}`;
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
  const { settings, status } = data;
  renderServices(data);

  const running = Boolean(status.running);
  renderRoute(settings, running);
  $("#idle").classList.toggle("hidden", running);
  $("#running").classList.toggle("hidden", !running);

  if (running) {
    renderProgress(status);
  } else {
    const missing = [settings.source, settings.target].filter((s) => !data.auth[s]);
    $("#start").disabled = missing.length > 0;
    $("#start-hint").textContent = missing.length
      ? `Сначала подключите ${missing.map((s) => ACCUSATIVE_NAMES[s]).join(" и ")}`
      : "";
    const lastRun = status.lastRun;
    const box = $("#last-run");
    box.classList.toggle("hidden", !lastRun);
    box.replaceChildren(lastRun ? lastRunView(lastRun, { onMore: () => openSettings("#history") }) : "");
  }

  $("#auto").checked = settings.autoSync;
  $("#interval").value = String(settings.intervalMin);
  $("#interval").disabled = !settings.autoSync;
}

let current = null;

async function refresh() {
  current = await load();
  render(current);
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

// Если выбрать в «Откуда» тот же сервис, что и в «Куда», меняем их местами.
function setRoute(source, target) {
  send("settings", { patch: { source, target } });
}
$("#source").addEventListener("change", (e) => {
  const { source, target } = current.settings;
  const value = e.target.value;
  setRoute(value, value === target ? source : target);
});
$("#target").addEventListener("change", (e) => {
  const { source, target } = current.settings;
  const value = e.target.value;
  setRoute(value === source ? target : source, value);
});
$("#swap").addEventListener("click", () => setRoute(current.settings.target, current.settings.source));
$("#both-ways").addEventListener("change", (e) => send("settings", { patch: { bothWays: e.target.checked } }));

$("#start").addEventListener("click", () => send("start"));
$("#stop").addEventListener("click", () => send("stop"));
$("#open-settings").addEventListener("click", () => openSettings());
$("#auto").addEventListener("change", (e) => send("settings", { patch: { autoSync: e.target.checked } }));
$("#interval").addEventListener("change", (e) => send("settings", { patch: { intervalMin: Number(e.target.value) } }));

onChange(refresh);
refresh();
