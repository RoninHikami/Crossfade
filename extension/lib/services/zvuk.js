// Звук (zvuk.com). Официального API нет — используем тот же GraphQL, что и сайт.

import { baseTitle } from "../matching.js";
import { ensureHeaderRules } from "../headers.js";
import { ApiError, request } from "../http.js";

const GRAPHQL = "https://zvuk.com/api/v1/graphql";
const PROFILE_URLS = ["https://zvuk.com/api/v2/tiny/profile", "https://zvuk.com/api/tiny/profile"];
const FETCH_BATCH = 100;
const SEARCH_LIMIT = 5;

const TRACK_FIELDS = "id title duration artists { title } release { title }";

const LIKED_TRACKS = `query userTracks($orderBy: TrackOrderByType, $orderDirection: OrderDirectionType) {
  collection { tracks(orderBy: $orderBy, orderDirection: $orderDirection) { id collectionItemData { lastModified } } }
}`;
const GET_TRACKS = `query getTracks($ids: [ID!]!) { getTracks(ids: $ids) { ${TRACK_FIELDS} } }`;
const SEARCH = `query search($query: String, $limit: Int) {
  search(query: $query) { tracks(limit: $limit) { items { ${TRACK_FIELDS} } } }
}`;
const ADD_TO_COLLECTION = `mutation addItemToCollection($id: ID, $type: CollectionItemType) {
  collection { addItem(id: $id, type: $type) }
}`;

function toTrack(item, likedAt = null) {
  return {
    service: "zvuk",
    id: String(item.id),
    title: item.title || "",
    artists: (item.artists || []).map((a) => a.title).filter(Boolean),
    album: item.release?.title ?? null,
    version: null,
    durationMs: item.duration ? item.duration * 1000 : null,
    isrc: null,
    likedAt,
  };
}

// Профиль текущего пользователя zvuk.com. Без токена запрос идёт с cookies
// браузера — так расширение «видит», что вы вошли на сайт.
export async function fetchZvukProfile(token = null) {
  await ensureHeaderRules();
  let lastError;
  for (const url of PROFILE_URLS) {
    try {
      const data = await request(url, {
        credentials: token ? "omit" : "include",
        headers: token ? { "X-Auth-Token": token } : {},
      }, { service: "Звук", retries: 1 });
      const result = data?.result || {};
      const profile = result.profile || result;
      const authToken = profile.token || result.token;
      if (!authToken) continue;
      // null — сайт не сообщил, гость это или нет.
      const anonymous = profile.isAnonymous ?? profile.is_anonymous ?? null;
      return {
        token: authToken,
        anonymous,
        name: profile.name || profile.username || profile.email || profile.phone || "Звук",
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new ApiError("Звук: не удалось получить профиль");
}

export class ZvukService {
  name = "zvuk";

  constructor({ token }) {
    this.token = token;
  }

  async call(query, operationName, variables = {}) {
    await ensureHeaderRules();
    const data = await request(GRAPHQL, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", "X-Auth-Token": this.token },
      body: JSON.stringify({ query, operationName, variables }),
    }, { service: "Звук" });
    if (data?.errors?.length) {
      const message = data.errors.map((e) => e.message).join("; ");
      const unauthorized = /auth|token|unauthori|forbidden/i.test(message);
      throw new ApiError(
        unauthorized ? "Звук: вход устарел, подключите сервис заново" : `Звук: ${message}`,
        { fatal: unauthorized },
      );
    }
    return data?.data || {};
  }

  async getLikedTracks() {
    const data = await this.call(LIKED_TRACKS, "userTracks", { orderBy: "dateAdded", orderDirection: "desc" });
    const liked = data.collection?.tracks || [];
    const likedAt = new Map(liked.map((t) => [String(t.id), t.collectionItemData?.lastModified ?? null]));
    const ids = liked.map((t) => String(t.id));
    const tracks = [];
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      const batch = await this.call(GET_TRACKS, "getTracks", { ids: ids.slice(i, i + FETCH_BATCH) });
      for (const item of batch.getTracks || []) {
        if (item) tracks.push(toTrack(item, likedAt.get(String(item.id))));
      }
    }
    // Сохраняем порядок коллекции: от новых к старым.
    const order = new Map(ids.map((id, index) => [id, index]));
    return tracks.sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  async searchText(query) {
    const data = await this.call(SEARCH, "search", { query, limit: SEARCH_LIMIT });
    return (data.search?.tracks?.items || []).filter(Boolean).map((item) => toTrack(item));
  }

  // Запросы от точных к общим; поиск останавливается на первом удачном.
  searchQueries(track) {
    const title = baseTitle(track.title);
    const [artist = "", second] = track.artists;
    return [`${artist} ${title}`, second && `${second} ${title}`, title].filter(Boolean);
  }

  searchUrl(track) {
    const text = `${track.artists[0] || ""} ${baseTitle(track.title)}`.trim();
    return `https://zvuk.com/search?query=${encodeURIComponent(text)}`;
  }

  // Звук не умеет лайкать пачкой, поэтому по одному треку.
  async like(tracks) {
    for (const track of tracks) {
      await this.call(ADD_TO_COLLECTION, "addItemToCollection", { id: String(track.id), type: "track" });
    }
  }
}
