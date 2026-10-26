// Список поддерживаемых сервисов и настройки направления переноса.
// Используется и фоновой частью, и интерфейсом.

export const SERVICES = ["yandex", "spotify", "zvuk", "youtube"];

export const SERVICE_NAMES = { yandex: "Яндекс Музыка", spotify: "Spotify", zvuk: "Звук", youtube: "YouTube Music" };
export const SHORT_NAMES = { yandex: "Яндекс", spotify: "Spotify", zvuk: "Звук", youtube: "YouTube" };
// «Подключите …»
export const ACCUSATIVE_NAMES = { yandex: "Яндекс Музыку", spotify: "Spotify", zvuk: "Звук", youtube: "YouTube Music" };
// «Найти в …»
export const LOCATIVE_NAMES = { yandex: "Яндексе", spotify: "Spotify", zvuk: "Звуке", youtube: "YouTube Music" };

export const DEFAULT_SETTINGS = {
  source: "yandex",
  target: "spotify",
  bothWays: false,
  autoSync: false,
  intervalMin: 60,
};

export function normalizeSettings(raw = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  // Настройки первой версии хранили направление одной строкой.
  if (raw.direction && !raw.source) {
    const [source, target] = raw.direction === "both" ? ["yandex", "spotify"] : raw.direction.split("->");
    Object.assign(settings, { source, target, bothWays: raw.direction === "both" });
  }
  delete settings.direction;
  if (!SERVICES.includes(settings.source)) settings.source = DEFAULT_SETTINGS.source;
  if (!SERVICES.includes(settings.target) || settings.target === settings.source) {
    settings.target = SERVICES.find((s) => s !== settings.source);
  }
  return settings;
}

export function directionPairs(settings) {
  const pairs = [[settings.source, settings.target]];
  if (settings.bothWays) pairs.push([settings.target, settings.source]);
  return pairs;
}

// Все направления между сервисами — для списка ненайденных треков.
export function allPairs() {
  return SERVICES.flatMap((a) => SERVICES.filter((b) => b !== a).map((b) => [a, b]));
}
