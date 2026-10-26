import { SHORT_NAMES, el, formatWhen, lastRunView, load, onChange, send } from "./shared.js";
import { notFoundList } from "../lib/sync.js";

const $ = (selector) => document.querySelector(selector);

let info = { redirectUri: "", builtInClientId: false, spotifyClientId: "" };
let editingClientId = false;

function renderServices(data) {
  for (const row of document.querySelectorAll(".service")) {
    const service = row.dataset.service;
    const account = data.auth[service];
    const state = row.querySelector(".state");
    state.classList.toggle("ok", Boolean(account));
    if (account) state.textContent = `✓ Подключено: ${account.name}`;
    else if (service === "yandex" && data.yandexLoginPending) state.textContent = "Войдите в открывшейся вкладке";
    else state.textContent = "Не подключено";
    row.querySelector(".connect").classList.toggle("hidden", Boolean(account));
    row.querySelector(".disconnect").classList.toggle("hidden", !account);
  }
  $("#auth-error").textContent = data.authError;
  $("#auth-error").classList.toggle("hidden", !data.authError);

  const needsClientId = !info.builtInClientId && !data.auth.spotify && (!info.spotifyClientId || editingClientId);
  $("#spotify-setup").classList.toggle("hidden", !needsClientId);
  $("#spotify .connect").disabled = !info.builtInClientId && !info.spotifyClientId;
  $("#edit-client-id").classList.toggle("hidden", info.builtInClientId || needsClientId || Boolean(data.auth.spotify));
}

function renderMissing(syncState) {
  const box = $("#missing");
  box.replaceChildren();
  let total = 0;
  for (const [source, target] of [["yandex", "spotify"], ["spotify", "yandex"]]) {
    const list = notFoundList(structuredClone(syncState), source, target);
    if (!list.length) continue;
    total += list.length;
    box.append(el("div", { class: "missing-group" },
      el("div", { class: "head" }, `${SHORT_NAMES[source]} → ${SHORT_NAMES[target]}: ${list.length}`),
      el("ul", { class: "tracks" }, ...list.map((item) => el("li", {},
        el("span", { class: "title", title: item.title }, item.title),
        item.searchUrl
          ? el("a", { href: item.searchUrl, target: "_blank", rel: "noopener" }, `Найти в ${SHORT_NAMES[target]}`)
          : null,
      ))),
    ));
  }
  if (!total) box.append(el("p", { class: "muted small" }, "Все треки нашлись."));
  $("#retry").classList.toggle("hidden", !total);
}

function render(data) {
  renderServices(data);

  $("#auto").checked = data.settings.autoSync;
  $("#interval").value = String(data.settings.intervalMin);
  $("#interval").disabled = !data.settings.autoSync;

  const lastRun = data.status.lastRun;
  $("#last-run").replaceChildren(
    data.status.running
      ? el("div", { class: "muted" }, "Идёт перенос…")
      : lastRun ? lastRunView(lastRun) : el("div", { class: "muted" }, "Перенос ещё не запускался."),
  );
  renderMissing(data.syncState);
  $("#retry").disabled = Boolean(data.status.running) || !(data.auth.yandex && data.auth.spotify);

  $("#recent").replaceChildren(...data.recent.map((item) => el("li", {},
    el("span", { class: "title", title: item.title }, item.title),
    el("span", { class: "meta" }, `${SHORT_NAMES[item.source]} → ${SHORT_NAMES[item.target]}, ${formatWhen(item.at)}`),
  )));
}

async function refresh() {
  render(await load());
}

for (const row of document.querySelectorAll(".service")) {
  const service = row.dataset.service;
  row.querySelector(".connect").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      await send("connect", { service });
    } catch (error) {
      if (error.code === "no_client_id") {
        editingClientId = true;
        $("#client-id").focus();
      }
    } finally {
      event.target.disabled = false;
      refresh();
    }
  });
  row.querySelector(".disconnect").addEventListener("click", () => send("disconnect", { service }));
}

$("#save-yandex-token").addEventListener("click", async () => {
  const token = $("#yandex-token").value.trim();
  if (!token) return;
  try {
    await send("yandexToken", { token });
    $("#yandex-token").value = "";
    $(".manual").open = false;
  } catch (error) {
    await chrome.storage.session.set({ authError: `Яндекс Музыка: ${error.message}` });
  }
});

$("#copy-redirect").addEventListener("click", async (event) => {
  await navigator.clipboard.writeText(info.redirectUri);
  event.target.textContent = "Скопировано ✓";
  setTimeout(() => { event.target.textContent = "Копировать"; }, 1500);
});

$("#save-client-id").addEventListener("click", async () => {
  const spotifyClientId = $("#client-id").value.trim();
  if (!/^[0-9a-f]{32}$/i.test(spotifyClientId)) {
    await chrome.storage.session.set({ authError: "Client ID — это 32 символа из цифр и латинских букв a–f. Проверьте, что скопировали его целиком." });
    return;
  }
  await chrome.storage.session.remove("authError");
  await send("settings", { patch: { spotifyClientId } });
  info = await send("info");
  editingClientId = false;
  refresh();
});

$("#edit-client-id").addEventListener("click", () => {
  editingClientId = true;
  $("#client-id").value = info.spotifyClientId;
  refresh();
});

$("#auto").addEventListener("change", (e) => send("settings", { patch: { autoSync: e.target.checked } }));
$("#interval").addEventListener("change", (e) => send("settings", { patch: { intervalMin: Number(e.target.value) } }));
$("#retry").addEventListener("click", () => send("start", { retryMissing: true }));
$("#reset").addEventListener("click", async () => {
  if (confirm("Сбросить историю переносов? Лайки в сервисах не изменятся.")) await send("resetHistory");
});

onChange(refresh);
info = await send("info");
$("#redirect-uri").textContent = info.redirectUri;
refresh();
