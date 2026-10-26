// Фоновая часть расширения: вход в сервисы, запуск переноса,
// автоматическая синхронизация по расписанию.

import {
  connectSpotify, connectYandex, connectYouTube, connectZvuk, disconnect, getAuth,
  handleSiteTabUpdate, handleYandexTabUpdate, saveYandexToken, saveZvukToken, spotifyAccessToken,
  spotifyClientId, spotifyRedirectUri,
} from "./lib/auth.js";
import { SPOTIFY_CLIENT_ID } from "./config.js";
import { ACCUSATIVE_NAMES, directionPairs, normalizeSettings } from "./lib/catalog.js";
import { SpotifyService } from "./lib/services/spotify.js";
import { YandexService } from "./lib/services/yandex.js";
import { YouTubeService } from "./lib/services/youtube.js";
import { ZvukService } from "./lib/services/zvuk.js";
import { displayTrack } from "./lib/matching.js";
import { syncLikes } from "./lib/sync.js";

const AUTO_ALARM = "auto-sync";
const RECENT_LIMIT = 200;

let job = null;
let stopRequested = false;

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}

async function getStatus() {
  return (await chrome.storage.local.get("status")).status || {};
}

// Записи статуса выстраиваем в очередь, чтобы запоздавшее обновление
// прогресса не затёрло итог.
let statusCache = null;
let statusWrite = Promise.resolve();

async function setStatus(patch) {
  statusCache = { ...(statusCache ?? (await getStatus())), ...patch };
  const snapshot = statusCache;
  statusWrite = statusWrite.then(() => chrome.storage.local.set({ status: snapshot }));
  return statusWrite;
}

async function createService(name) {
  const auth = await getAuth();
  if (!auth[name]) throw new Error(`Подключите ${ACCUSATIVE_NAMES[name]}`);
  if (name === "yandex") return new YandexService(auth.yandex);
  if (name === "zvuk") return new ZvukService(auth.zvuk);
  if (name === "youtube") return new YouTubeService();
  return new SpotifyService({ getToken: spotifyAccessToken });
}

// Пока идёт перенос, регулярно обращаемся к API расширений, чтобы браузер
// не усыпил фоновый скрипт посреди работы.
function keepAlive() {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  return () => clearInterval(timer);
}

function summarize(report) {
  return {
    source: report.source,
    target: report.target,
    total: report.total,
    skipped: report.skipped,
    alreadyLiked: report.alreadyLiked,
    liked: report.liked.length,
    notFound: report.notFound.length,
    errors: report.errors.length,
    stopped: report.stopped,
  };
}

async function rememberAdded(report) {
  if (!report.liked.length) return;
  const { recent = [] } = await chrome.storage.local.get("recent");
  const at = new Date().toISOString();
  const added = report.liked.map((p) => ({
    title: displayTrack(p.source), source: report.source, target: report.target, at,
  }));
  await chrome.storage.local.set({ recent: [...added.reverse(), ...recent].slice(0, RECENT_LIMIT) });
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Crossfade",
    message,
  });
}

async function runSync({ auto = false, retryMissing = false } = {}) {
  if (job) return job;
  stopRequested = false;
  job = (async () => {
    const release = keepAlive();
    const settings = await getSettings();
    const pairs = directionPairs(settings);
    const results = [];
    let error = null;
    await setStatus({
      running: true, auto, retryMissing, startedAt: new Date().toISOString(),
      phase: "loading", step: 1, steps: pairs.length, processed: 0, todo: 0, current: "",
    });
    chrome.action.setBadgeBackgroundColor({ color: "#7c5cff" });
    chrome.action.setBadgeText({ text: "…" });

    let lastProgress = 0;
    try {
      const { syncState = {} } = await chrome.storage.local.get("syncState");
      for (let i = 0; i < pairs.length && !stopRequested; i++) {
        const [src, dst] = pairs[i];
        const report = await syncLikes(await createService(src), await createService(dst), syncState, {
          retryMissing,
          shouldStop: () => stopRequested,
          saveState: (state) => chrome.storage.local.set({ syncState: state }),
          onProgress: (progress) => {
            // Не чаще трёх раз в секунду, чтобы не дёргать хранилище.
            const now = Date.now();
            if (progress.phase === "matching" && now - lastProgress < 300) return;
            lastProgress = now;
            setStatus({ step: i + 1, source: src, target: dst, current: "", ...progress });
          },
        });
        results.push(summarize(report));
        await rememberAdded(report);
      }
    } catch (e) {
      error = e.message || String(e);
    } finally {
      release();
    }

    const added = results.reduce((sum, r) => sum + r.liked, 0);
    await setStatus({
      running: false, phase: "idle", current: "",
      lastRun: { finishedAt: new Date().toISOString(), auto, results, error, stopped: stopRequested },
    });
    chrome.action.setBadgeBackgroundColor({ color: error ? "#e5484d" : "#7c5cff" });
    chrome.action.setBadgeText({ text: error ? "!" : "" });
    if (auto && added > 0) notify(`Перенесено новых лайков: ${added}`);
    if (auto && error) notify(`Автосинхронизация не удалась: ${error}`);
  })().finally(() => {
    job = null;
  });
  return job;
}

async function scheduleAutoSync() {
  const settings = await getSettings();
  await chrome.alarms.clear(AUTO_ALARM);
  if (settings.autoSync) {
    await chrome.alarms.create(AUTO_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: Math.max(15, settings.intervalMin),
    });
  }
}

// --- Сообщения от окна расширения и страницы настроек -----------------------

const handlers = {
  async info() {
    return {
      redirectUri: spotifyRedirectUri(),
      builtInClientId: Boolean(SPOTIFY_CLIENT_ID),
      spotifyClientId: await spotifyClientId(),
    };
  },
  async connect({ service }) {
    await chrome.storage.session.remove("authError");
    if (service === "yandex") return connectYandex();
    if (service === "zvuk") return connectZvuk();
    if (service === "youtube") return connectYouTube();
    const release = keepAlive();
    try {
      return await connectSpotify();
    } catch (error) {
      // Окно расширения могло закрыться, пока шёл вход, — сохраняем ошибку,
      // чтобы показать её при следующем открытии.
      if (error.code !== "no_client_id") {
        await chrome.storage.session.set({ authError: error.message });
      }
      throw error;
    } finally {
      release();
    }
  },
  async disconnect({ service }) {
    return disconnect(service);
  },
  async yandexToken({ token }) {
    return saveYandexToken(token);
  },
  async zvukToken({ token }) {
    return saveZvukToken(token);
  },
  async start({ retryMissing }) {
    runSync({ retryMissing });
  },
  async stop() {
    stopRequested = true;
    if (!job) await setStatus({ running: false, phase: "idle" });
  },
  async settings({ patch }) {
    const settings = normalizeSettings({ ...(await getSettings()), ...patch });
    await chrome.storage.local.set({ settings });
    await scheduleAutoSync();
    return settings;
  },
  async resetHistory() {
    await chrome.storage.local.remove(["syncState", "recent"]);
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error.message || String(error), code: error.code }),
  );
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  handleYandexTabUpdate(tabId, change.url || tab.url);
  handleSiteTabUpdate(tabId, change, tab);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_ALARM) return;
  const [auth, settings] = await Promise.all([getAuth(), getSettings()]);
  if (auth[settings.source] && auth[settings.target]) runSync({ auto: true });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await scheduleAutoSync();
  if (reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(scheduleAutoSync);

// Если браузер усыпил или закрыл расширение посреди переноса — продолжаем.
// Уже сделанное сохранено, поэтому повторно ничего искать не придётся.
getStatus().then((status) => {
  if (status.running && !job) runSync({ auto: status.auto, retryMissing: status.retryMissing });
});
