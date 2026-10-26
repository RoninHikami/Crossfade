// Spotify Web API.

import { baseTitle, transliterate } from "../matching.js";
import { request } from "../http.js";

const API = "https://api.spotify.com/v1";
const PAGE_SIZE = 50;
const LIKE_BATCH = 40;
const SEARCH_LIMIT = 5;

function toTrack(item, likedAt = null) {
  return {
    service: "spotify",
    id: item.id,
    title: item.name,
    artists: (item.artists || []).map((a) => a.name),
    album: item.album?.name ?? null,
    version: null,
    durationMs: item.duration_ms ?? null,
    isrc: item.external_ids?.isrc ?? null,
    likedAt,
    ref: `spotify:track:${item.id}`,
  };
}

export class SpotifyService {
  name = "spotify";

  // getToken — функция, возвращающая действующий access token (обновляет его при необходимости).
  constructor({ getToken }) {
    this.getToken = getToken;
  }

  async call(path, { method = "GET", params } = {}) {
    const url = new URL(API + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const token = await this.getToken();
    return request(url, { method, headers: { Authorization: `Bearer ${token}` } }, { service: "Spotify" });
  }

  async getLikedTracks() {
    const tracks = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.call("/me/tracks", { params: { limit: PAGE_SIZE, offset } });
      for (const entry of page.items || []) {
        const item = entry.track;
        // Локальные файлы и удалённые из каталога треки пропускаем.
        if (!item?.id || item.is_local) continue;
        tracks.push(toTrack(item, entry.added_at));
      }
      if (!page.next) return tracks;
    }
  }

  async searchText(q) {
    const result = await this.call("/search", { params: { q, type: "track", limit: SEARCH_LIMIT } });
    return (result?.tracks?.items || []).filter(Boolean).map((item) => toTrack(item));
  }

  async search(track) {
    const title = baseTitle(track.title);
    const artist = track.artists[0] || "";
    const candidates = [];
    if (track.isrc) candidates.push(...(await this.searchText(`isrc:${track.isrc}`)));
    candidates.push(...(await this.searchText(`track:"${title}" artist:"${artist}"`)));
    if (!candidates.length) candidates.push(...(await this.searchText(`${artist} ${title}`)));
    const latin = transliterate(`${artist} ${title}`);
    if (!candidates.length && latin !== `${artist} ${title}`.toLowerCase()) {
      // Кириллические названия в Spotify часто записаны латиницей.
      candidates.push(...(await this.searchText(latin)));
    }
    return candidates;
  }

  searchUrl(track) {
    const text = `${track.artists[0] || ""} ${baseTitle(track.title)}`.trim();
    return `https://open.spotify.com/search/${encodeURIComponent(text)}`;
  }

  async like(tracks) {
    for (let i = 0; i < tracks.length; i += LIKE_BATCH) {
      const uris = tracks.slice(i, i + LIKE_BATCH).map((t) => t.ref || `spotify:track:${t.id}`);
      await this.call("/me/library", { method: "PUT", params: { uris: uris.join(",") } });
    }
  }
}
