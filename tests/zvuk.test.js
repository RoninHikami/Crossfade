import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { ZvukService, fetchZvukProfile } from "../extension/lib/services/zvuk.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Подменяем fetch: отвечаем по имени GraphQL-операции и запоминаем запросы.
function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    const key = body?.operationName || String(url);
    const result = handlers[key];
    if (!result) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(typeof result === "function" ? result(body) : result), { status: 200 });
  };
  return calls;
}

const track = (id, title, artist, duration = 200) => ({
  id, title, duration, artists: [{ title: artist }], release: { title: "Альбом" },
});

test("лайкнутые треки: id из коллекции, данные из getTracks, порядок от новых", async () => {
  const calls = mockFetch({
    userTracks: { data: { collection: { tracks: [
      { id: 2, collectionItemData: { lastModified: "2024-02" } },
      { id: 1, collectionItemData: { lastModified: "2024-01" } },
    ] } } },
    getTracks: (body) => ({ data: { getTracks: body.variables.ids.reverse().map((id) => track(id, `T${id}`, "A")) } }),
  });

  const tracks = await new ZvukService({ token: "tok" }).getLikedTracks();

  assert.deepEqual(tracks.map((t) => t.id), ["2", "1"]);
  assert.equal(tracks[0].durationMs, 200_000);
  assert.deepEqual(tracks[0].artists, ["A"]);
  assert.equal(tracks[0].likedAt, "2024-02");
  assert.equal(calls[0].init.headers["X-Auth-Token"], "tok");
  assert.deepEqual(calls[0].body.variables, { orderBy: "dateAdded", orderDirection: "desc" });
});

test("поиск и лайк по одному треку", async () => {
  const calls = mockFetch({
    search: { data: { search: { tracks: { items: [track(7, "Song", "Artist")] } } } },
    addItemToCollection: { data: { collection: { addItem: true } } },
  });
  const zvuk = new ZvukService({ token: "tok" });

  const found = await zvuk.search({ title: "Song (Remastered)", artists: ["Artist"] });
  await zvuk.like(found);

  assert.equal(found[0].id, "7");
  assert.equal(calls[0].body.variables.query, "Artist song");
  assert.deepEqual(calls[1].body.variables, { id: "7", type: "track" });
});

test("ошибка авторизации в GraphQL останавливает перенос", async () => {
  mockFetch({ userTracks: { errors: [{ message: "Unauthorized" }] } });
  await assert.rejects(new ZvukService({ token: "bad" }).getLikedTracks(), (e) => e.fatal === true);
});

test("профиль: токен и признак гостя", async () => {
  mockFetch({
    "https://zvuk.com/api/v2/tiny/profile": { result: { profile: { token: "abc", isAnonymous: false, name: "Аня" } } },
  });
  assert.deepEqual(await fetchZvukProfile(), { token: "abc", anonymous: false, name: "Аня" });
});

test("профиль: запасной адрес и гость", async () => {
  mockFetch({
    "https://zvuk.com/api/tiny/profile": { result: { token: "anon", is_anonymous: true } },
  });
  const profile = await fetchZvukProfile();
  assert.equal(profile.token, "anon");
  assert.equal(profile.anonymous, true);
});
