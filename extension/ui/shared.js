// Общие помощники для окна расширения и страницы настроек.

import { SHORT_NAMES, normalizeSettings } from "../lib/catalog.js";

export { ACCUSATIVE_NAMES, LOCATIVE_NAMES, SERVICES, SERVICE_NAMES, SHORT_NAMES, allPairs } from "../lib/catalog.js";

export async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) {
    throw Object.assign(new Error(response?.error || "Неизвестная ошибка"), { code: response?.code });
  }
  return response.result;
}

export async function load() {
  const local = await chrome.storage.local.get(["auth", "settings", "status", "syncState", "recent"]);
  const session = await chrome.storage.session.get(["authError", "yandexLoginPending", "siteLogin"]);
  return {
    auth: local.auth || {},
    settings: normalizeSettings(local.settings),
    status: local.status || {},
    syncState: local.syncState || {},
    recent: local.recent || [],
    authError: session.authError || "",
    loginPending: {
      yandex: Boolean(session.yandexLoginPending),
      zvuk: session.siteLogin?.service === "zvuk",
      youtube: session.siteLogin?.service === "youtube",
    },
  };
}

export const LOGIN_HINTS = {
  yandex: "Войдите в открывшейся вкладке",
  zvuk: "Войдите на zvuk.com в открывшейся вкладке",
  youtube: "Войдите на music.youtube.com в открывшейся вкладке",
};

export function onChange(callback) {
  chrome.storage.onChanged.addListener(() => callback());
}

export function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `сегодня в ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `вчера в ${time}`;
  return `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} в ${time}`;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// Карточка с итогами последнего переноса.
export function lastRunView(lastRun, { onMore } = {}) {
  const box = el("div");
  const prefix = lastRun.auto ? "Автосинхронизация" : "Последний перенос";
  box.append(el("div", { class: "when" },
    el("span", {}, `${prefix}: ${formatWhen(lastRun.finishedAt)}`),
    onMore ? el("button", { class: "link more", onclick: onMore }, "Подробнее") : null,
  ));
  for (const r of lastRun.results || []) {
    if (!r.liked && !r.alreadyLiked && !r.notFound && !r.errors) {
      box.append(el("div", { class: "stats" },
        el("span", {}, `${SHORT_NAMES[r.source]} → ${SHORT_NAMES[r.target]}:`),
        el("span", { class: "muted" }, "новых лайков нет"),
      ));
      continue;
    }
    const stats = el("div", { class: "stats" },
      el("span", {}, `${SHORT_NAMES[r.source]} → ${SHORT_NAMES[r.target]}:`),
      el("span", { class: "added" }, "добавлено ", el("b", {}, String(r.liked))),
      el("span", {}, "уже были ", el("b", {}, String(r.alreadyLiked))),
      r.notFound ? el("span", { class: "missing" }, "не найдено ", el("b", {}, String(r.notFound))) : null,
    );
    box.append(stats);
  }
  if (lastRun.stopped) box.append(el("div", { class: "muted small" }, "Остановлено вручную — продолжится с того же места."));
  if (lastRun.error) box.append(el("div", { class: "error" }, lastRun.error));
  return box;
}
