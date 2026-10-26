// Яндекс Музыка: тот же API, что у мобильного приложения (api.music.yandex.net).

import { baseTitle } from "../matching.js";
import { form, request } from "../http.js";

const API = "https://api.music.yandex.net";
const FETCH_BATCH = 200;
const LIKE_BATCH = 100;
const SEARCH_LIMIT = 5;

function toTrack(item, likedAt = null) {
  const album = item.albums?.[0];
  return {
    service: "yandex",
    id: String(item.id),
    title: item.title || "",
    artists: (item.artists || []).map((a) => a.name).filter(Boolean),
    album: album?.title ?? null,
    version: item.version ?? null,
    durationMs: item.durationMs ?? null,
    isrc: item.isrc ?? null,
    likedAt,
    // Для лайка Яндекс ждёт идентификатор вида "трек:альбом".
    ref: album ? `${item.id}:${album.id}` : String(item.id),
  };
}

export class YandexService {
  name = "yandex";

  constructor({ token, uid }) {
    this.token = token;
    this.uid = uid;
  }

  async call(path, { method = "GET", params, body } = {}) {
    const url = new URL(API + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const data = await request(url, {
      method,
      body,
      headers: {
        Authorization: `OAuth ${this.token}`,
        "X-Yandex-Music-Client": "YandexMusicAndroid/24023621",
        "Accept-Language": "ru",
      },
    }, { service: "Яндекс Музыка" });
    return data?.result;
  }

  static async account(token) {
    const result = await new YandexService({ token }).call("/account/status");
    const account = result.account;
    return { uid: account.uid, name: account.displayName || account.login || String(account.uid) };
  }

  async getLikedTracks() {
    const result = await this.call(`/users/${this.uid}/likes/tracks`);
    const shorts = result?.library?.tracks || [];
    const likedAt = new Map(shorts.map((s) => [String(s.id), s.timestamp]));
    const tracks = [];
    for (let i = 0; i < shorts.length; i += FETCH_BATCH) {
      const ids = shorts.slice(i, i + FETCH_BATCH).map((s) => (s.albumId ? `${s.id}:${s.albumId}` : String(s.id)));
      const items = await this.call("/tracks", {
        method: "POST",
        body: form({ "track-ids": ids.join(","), "with-positions": "true" }),
      });
      for (const item of items || []) tracks.push(toTrack(item, likedAt.get(String(item.id)) ?? null));
    }
    // От новых к старым.
    return tracks.sort((a, b) => String(b.likedAt).localeCompare(String(a.likedAt)));
  }

  async searchText(text) {
    const result = await this.call("/search", {
      params: { text, type: "track", page: 0, nocorrect: "false" },
    });
    return (result?.tracks?.results || []).slice(0, SEARCH_LIMIT).map((item) => toTrack(item));
  }

  async search(track) {
    const title = baseTitle(track.title);
    const artist = track.artists[0] || "";
    let candidates = await this.searchText(`${artist} ${title}`);
    if (!candidates.length) candidates = await this.searchText(title);
    return candidates;
  }

  searchUrl(track) {
    const text = `${track.artists[0] || ""} ${baseTitle(track.title)}`.trim();
    return `https://music.yandex.ru/search?text=${encodeURIComponent(text)}`;
  }

  async like(tracks) {
    for (let i = 0; i < tracks.length; i += LIKE_BATCH) {
      const ids = tracks.slice(i, i + LIKE_BATCH).map((t) => t.ref || t.id);
      await this.call(`/users/${this.uid}/likes/tracks/add-multiple`, {
        method: "POST",
        body: form({ "track-ids": ids.join(",") }),
      });
    }
  }
}
