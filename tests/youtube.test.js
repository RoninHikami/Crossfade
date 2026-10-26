import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  YouTubeService, cleanArtist, cleanVideoTitle, parseListItem,
} from "../extension/lib/services/youtube.js";

// --- Образцы ответов youtubei (в том виде, как их разбирает ytmusicapi) -------

const artistRun = (name) => ({
  text: name,
  navigationEndpoint: { browseEndpoint: { browseId: `UC${name}`, browseEndpointContextSupportedConfigs: {
    browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } },
});
const albumRun = (name) => ({
  text: name,
  navigationEndpoint: { browseEndpoint: { browseId: "MPREb_1", browseEndpointContextSupportedConfigs: {
    browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } } } },
});
const column = (...runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } });

// Строка плейлиста «Понравившиеся»: название | исполнители | альбом, длительность в fixedColumns.
const playlistItem = (videoId, title, artists, album, duration) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    flexColumns: [
      column({ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }),
      column(...artists.flatMap((a, i) => (i ? [{ text: " & " }, artistRun(a)] : [artistRun(a)]))),
      column(albumRun(album)),
    ],
    fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: duration }] } } }],
  },
});

// Результат поиска песен: название | исполнитель • альбом • длительность.
const searchItem = (videoId, title, artist, album, duration) => ({
  musicResponsiveListItemRenderer: {
    flexColumns: [
      column({ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }),
      column(artistRun(artist), { text: " • " }, albumRun(album), { text: " • " }, { text: duration }),
    ],
  },
});

test("строка плейлиста", () => {
  const track = parseListItem(playlistItem("v1", "Группа крови", ["Кино"], "Группа крови", "4:47").musicResponsiveListItemRenderer);
  assert.deepEqual(
    { id: track.id, title: track.title, artists: track.artists, album: track.album, durationMs: track.durationMs },
    { id: "v1", title: "Группа крови", artists: ["Кино"], album: "Группа крови", durationMs: 287_000 },
  );
});

test("результат поиска: исполнитель, альбом и длительность из одной колонки", () => {
  const track = parseListItem(searchItem("v2", "Yesterday", "The Beatles", "Help!", "2:05").musicResponsiveListItemRenderer);
  assert.deepEqual([track.artists, track.album, track.durationMs], [["The Beatles"], "Help!", 125_000]);
});

test("исполнитель без ссылки", () => {
  const item = {
    flexColumns: [
      column({ text: "Song", navigationEndpoint: { watchEndpoint: { videoId: "v3" } } }),
      column({ text: "Unknown Artist" }, { text: " • " }, { text: "3:00" }),
    ],
  };
  assert.deepEqual(parseListItem(item).artists, ["Unknown Artist"]);
});

test("названия клипов и каналов очищаются", () => {
  assert.equal(cleanArtist("Rick Astley - Topic"), "Rick Astley");
  assert.equal(cleanArtist("RickAstleyVEVO"), "RickAstley");
  assert.equal(cleanVideoTitle("Rick Astley - Never Gonna Give You Up (Official Video)", ["Rick Astley"]), "Never Gonna Give You Up (Official Video)");
  assert.equal(cleanVideoTitle("The Beatles - Yesterday (Official Video)", [cleanArtist("TheBeatlesVEVO")]), "Yesterday (Official Video)");
  // Тире внутри названия песни не трогаем.
  assert.equal(cleanVideoTitle("Mr. Brightside - Remastered", ["The Killers"]), "Mr. Brightside - Remastered");
});

// --- Запросы ------------------------------------------------------------------

const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  globalThis.chrome = { cookies: { get: async ({ name }) => (name === "__Secure-3PAPISID" ? { value: "SID" } : null) } };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
});

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    return new Response(JSON.stringify(handler(String(url), body)), { status: 200 });
  };
}

test("понравившиеся: обе страницы, подпись запроса и cookies", async () => {
  mockFetch((url, body) => {
    if (body.browseId === "VLLM") {
      return { contents: { shelf: [playlistItem("a", "One", ["A"], "X", "3:00"),
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "NEXT" } } } }] } };
    }
    if (body.continuation === "NEXT") {
      return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
        playlistItem("b", "Two", ["B"], "Y", "4:00")] } }] };
    }
    return {};
  });

  const tracks = await new YouTubeService().getLikedTracks();

  assert.deepEqual(tracks.map((t) => t.id), ["a", "b"]);
  const { url, init, body } = calls[0];
  assert.ok(url.startsWith("https://music.youtube.com/youtubei/v1/browse?alt=json&key="));
  assert.equal(init.credentials, "include");
  assert.match(init.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.equal(body.context.client.clientName, "WEB_REMIX");
});

test("поиск только по песням и лайк по videoId", async () => {
  mockFetch((url) => (url.includes("/search?")
    ? { contents: [searchItem("s1", "Song", "Artist", "Album", "3:20")] }
    : { actions: [] }));
  const youtube = new YouTubeService();

  const found = await youtube.searchText("Artist song");
  await youtube.like(found);

  assert.equal(calls[0].body.params, "EgWKAQIIAWoMEA4QChADEAQQCRAF");
  assert.ok(calls[1].url.includes("/like/like?"));
  assert.deepEqual(calls[1].body.target, { videoId: "s1" });
});

test("без входа в Google — понятная ошибка", async () => {
  globalThis.chrome.cookies.get = async () => null;
  await assert.rejects(new YouTubeService().getLikedTracks(), (e) => e.fatal && /music\.youtube\.com/.test(e.message));
});
