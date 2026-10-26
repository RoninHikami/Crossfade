// YouTube Music. Официального API для музыки нет — используем тот же внутренний
// API (youtubei), что и сайт music.youtube.com, с вашей сессией в браузере.
// Устройство запросов взято из открытой библиотеки ytmusicapi.

import { baseTitle } from "../matching.js";
import { ensureHeaderRules } from "../headers.js";
import { ApiError, request } from "../http.js";

const ORIGIN = "https://music.youtube.com";
const API = `${ORIGIN}/youtubei/v1/`;
const API_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
// Фильтр поиска «Только песни» (как во вкладке «Песни» на сайте).
const SONGS_FILTER = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
const LIKED_PLAYLIST = "VLLM";
const SEARCH_LIMIT = 5;
const MAX_PAGES = 200;

// --- Авторизация по cookie --------------------------------------------------

async function sha1Hex(text) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Значение cookie, которым сайт подписывает запросы. null — пользователь не вошёл в Google.
export async function youtubeSapisid() {
  for (const name of ["__Secure-3PAPISID", "SAPISID"]) {
    const cookie = await chrome.cookies.get({ url: ORIGIN, name });
    if (cookie?.value) return cookie.value;
  }
  return null;
}

async function authorization(sapisid) {
  const timestamp = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${timestamp}_${await sha1Hex(`${timestamp} ${sapisid} ${ORIGIN}`)}`;
}

function context() {
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return { client: { clientName: "WEB_REMIX", clientVersion: `1.${today}.01.00`, hl: "ru" }, user: {} };
}

// --- Разбор ответов ---------------------------------------------------------
// Ответы youtubei — глубоко вложенные «рендереры». Вместо жёстких путей ищем
// нужные узлы рекурсивно: так разбор переживёт мелкие изменения разметки.

function findAll(node, key, found = []) {
  if (Array.isArray(node)) node.forEach((item) => findAll(item, key, found));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) found.push(v);
      else findAll(v, key, found);
    }
  }
  return found;
}

const DURATION_RE = /^(\d+:)?\d+:\d{2}$/;
const SEPARATORS = new Set([" • ", " & ", ", ", " и ", " x ", " X "]);
const TYPE_WORDS = new Set(["song", "video", "песня", "трек", "видео", "клип", "episode", "эпизод"]);

function pageType(run) {
  return run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
    ?.browseEndpointContextMusicConfig?.pageType;
}

function parseDuration(text) {
  if (!text || !DURATION_RE.test(text)) return null;
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}

// «ArtistVEVO», «Artist - Topic» → «Artist».
export function cleanArtist(name) {
  return name.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").trim();
}

// Название клипа «Artist - Song (Official Video)» → «Song (Official Video)».
export function cleanVideoTitle(title, artists) {
  const match = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!match) return title;
  // Сравниваем без пробелов и знаков: канал «TheBeatlesVEVO» пишет имя слитно.
  const squash = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const prefix = squash(match[1]);
  const byArtist = artists.some((a) => {
    const name = squash(a || "");
    return name && (prefix.includes(name) || name.includes(prefix));
  });
  return byArtist ? match[2] : title;
}

export function parseListItem(item) {
  const columns = (item.flexColumns || []).map(
    (column) => column.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [],
  );
  const runs = columns.flat();
  const titleRun = runs.find((run) => run.navigationEndpoint?.watchEndpoint) || columns[0]?.[0];
  const videoId = item.playlistItemData?.videoId
    || titleRun?.navigationEndpoint?.watchEndpoint?.videoId
    || findAll(item.overlay, "watchEndpoint")[0]?.videoId;
  if (!videoId || !titleRun?.text) return null;

  const linkedArtists = [];
  const plainArtists = [];
  let album = null;
  let durationMs = null;
  for (const [index, column] of columns.entries()) {
    let beforeFirstDot = true;
    for (const run of column) {
      if (run === titleRun) continue;
      const text = run.text || "";
      const type = pageType(run);
      if (type === "MUSIC_PAGE_TYPE_ARTIST" || type === "MUSIC_PAGE_TYPE_UNKNOWN" || type === "MUSIC_PAGE_TYPE_USER_CHANNEL") {
        linkedArtists.push(text);
      } else if (type === "MUSIC_PAGE_TYPE_ALBUM") {
        album = text;
      } else if (!run.navigationEndpoint) {
        if (DURATION_RE.test(text)) durationMs = parseDuration(text);
        else if (text === " • ") beforeFirstDot = false;
        else if (index > 0 && beforeFirstDot && !SEPARATORS.has(text) && !TYPE_WORDS.has(text.toLowerCase())) {
          plainArtists.push(text);
        }
      }
    }
  }
  const fixed = item.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;
  durationMs ??= parseDuration(fixed);

  const artists = (linkedArtists.length ? linkedArtists : plainArtists).map(cleanArtist).filter(Boolean);
  return {
    service: "youtube",
    id: videoId,
    title: cleanVideoTitle(titleRun.text, artists),
    artists,
    album,
    version: null,
    durationMs,
    isrc: null,
    likedAt: null,
  };
}

function parseItems(response) {
  return findAll(response, "musicResponsiveListItemRenderer").map(parseListItem).filter(Boolean);
}

// Токен следующей страницы: в новом формате — continuationCommand, в старом — nextContinuationData.
function nextPage(response) {
  const command = findAll(response, "continuationCommand")[0]?.token;
  if (command) return { body: { continuation: command } };
  const legacy = findAll(response, "nextContinuationData")[0]?.continuation;
  if (legacy) return { params: `&ctoken=${legacy}&continuation=${legacy}` };
  return null;
}

// --- Сервис -----------------------------------------------------------------

export class YouTubeService {
  name = "youtube";

  async call(endpoint, body = {}, params = "") {
    await ensureHeaderRules();
    const sapisid = await youtubeSapisid();
    if (!sapisid) {
      throw new ApiError("YouTube Music: войдите на music.youtube.com и подключите сервис заново", { fatal: true });
    }
    return request(`${API}${endpoint}?alt=json&key=${API_KEY}${params}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: await authorization(sapisid),
        "X-Origin": ORIGIN,
        "X-Goog-AuthUser": "0",
      },
      body: JSON.stringify({ ...body, context: context() }),
    }, { service: "YouTube Music" });
  }

  // Имя аккаунта — заодно проверка, что вход рабочий.
  async accountName() {
    const response = await this.call("account/account_menu");
    const name = findAll(response, "accountName")[0]?.runs?.[0]?.text;
    if (!name) throw new ApiError("YouTube Music: не удалось войти — откройте music.youtube.com и войдите в аккаунт");
    return name;
  }

  async getLikedTracks() {
    const tracks = [];
    const seen = new Set();
    let response = await this.call("browse", { browseId: LIKED_PLAYLIST });
    for (let page = 0; page < MAX_PAGES; page++) {
      for (const track of parseItems(response)) {
        if (!seen.has(track.id)) {
          seen.add(track.id);
          tracks.push(track);
        }
      }
      const next = nextPage(response);
      if (!next) break;
      response = next.body ? await this.call("browse", next.body) : await this.call("browse", {}, next.params);
    }
    // Плейлист «Понравившиеся» уже идёт от новых к старым.
    return tracks;
  }

  async searchText(query) {
    const response = await this.call("search", { query, params: SONGS_FILTER });
    return parseItems(response).slice(0, SEARCH_LIMIT);
  }

  // Запросы от точных к общим; поиск останавливается на первом удачном.
  searchQueries(track) {
    const title = baseTitle(track.title);
    const [artist = "", second] = track.artists;
    return [`${artist} ${title}`, second && `${second} ${title}`, title].filter(Boolean);
  }

  searchUrl(track) {
    const text = `${track.artists[0] || ""} ${baseTitle(track.title)}`.trim();
    return `${ORIGIN}/search?q=${encodeURIComponent(text)}`;
  }

  // Лайк ставится по одному треку, как кнопкой «Нравится» на сайте.
  async like(tracks) {
    for (const track of tracks) {
      await this.call("like/like", { target: { videoId: track.id } });
    }
  }
}
