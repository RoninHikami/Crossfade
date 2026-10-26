// Подмена заголовков в запросах расширения к API сервисов.
//
// Браузер добавляет к запросам расширения заголовок Origin: chrome-extension://…,
// а API некоторых сервисов отвечают на такие запросы ошибкой. Правила касаются
// только фоновых запросов (без вкладки), поэтому сами сайты сервисов не затрагиваются.

const RULES = [
  {
    // Яндекс Музыка отвечает 403 на чужой Origin — убираем его, как у мобильного приложения.
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "origin", operation: "remove" }],
    },
    condition: { requestDomains: ["api.music.yandex.net"] },
  },
  {
    // Звук пропускает только запросы, пришедшие со своего сайта (иначе — 418).
    id: 2,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "origin", operation: "set", value: "https://zvuk.com" },
        { header: "referer", operation: "set", value: "https://zvuk.com/" },
      ],
    },
    condition: { requestDomains: ["zvuk.com"] },
  },
];

let installed = null;

export function ensureHeaderRules() {
  if (!globalThis.chrome?.declarativeNetRequest) return Promise.resolve();
  installed ??= chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: RULES.map((rule) => rule.id),
    addRules: RULES.map((rule) => ({
      ...rule,
      condition: { ...rule.condition, tabIds: [chrome.tabs.TAB_ID_NONE] },
    })),
  });
  return installed;
}
