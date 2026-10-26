import { test } from "node:test";
import assert from "node:assert/strict";
import { NOT_FOUND, syncLikes } from "../extension/lib/sync.js";

const tr = (service, id, title, artist) => ({
  service, id, title, artists: [artist], durationMs: 200_000,
});

class FakeService {
  constructor(name, liked, catalog) {
    this.name = name;
    this.liked = [...liked]; // от новых к старым
    this.catalog = catalog;
    this.searches = 0;
  }
  async getLikedTracks() { return [...this.liked]; }
  searchQueries(track) { return [track.title]; }
  async searchText(query) {
    this.searches++;
    return this.catalog.filter((c) => c.title.toLowerCase() === query.toLowerCase());
  }
  searchUrl(track) { return `https://example.test/?q=${track.title}`; }
  async like(tracks) { this.liked.unshift(...[...tracks].reverse()); }
}

function make() {
  const source = new FakeService("yandex", [
    tr("yandex", "3", "Third", "C"),
    tr("yandex", "2", "Missing", "B"),
    tr("yandex", "1", "First", "A"),
  ], []);
  const already = tr("spotify", "s3", "Third", "C");
  const target = new FakeService("spotify", [already, tr("spotify", "own", "Own like", "Z")], [
    tr("spotify", "s1", "First", "A"),
    already,
  ]);
  return { source, target, state: {} };
}

const ids = (tracks) => new Set(tracks.map((t) => t.id));

test("добавляет новые лайки и не трогает существующие", async () => {
  const { source, target, state } = make();
  const before = ids(target.liked);

  const report = await syncLikes(source, target, state);

  assert.deepEqual(report.liked.map((p) => p.target.id), ["s1"]);
  assert.equal(report.alreadyLiked, 1);
  assert.deepEqual(report.notFound.map((t) => t.id), ["2"]);
  assert.deepEqual(ids(target.liked), new Set([...before, "s1"]));
  assert.equal(state["yandex->spotify"]["2"].searchUrl, "https://example.test/?q=Missing");
});

test("повторный запуск обрабатывает только новое", async () => {
  const { source, target, state } = make();
  await syncLikes(source, target, state);
  const searches = target.searches;

  const report = await syncLikes(source, target, state);

  assert.equal(report.skipped, 3);
  assert.equal(report.liked.length, 0);
  assert.equal(target.searches, searches);
});

test("повторный поиск ненайденных", async () => {
  const { source, target, state } = make();
  await syncLikes(source, target, state);
  assert.equal(state["yandex->spotify"]["2"].status, NOT_FOUND);

  target.catalog.push(tr("spotify", "s2", "Missing", "B"));
  const report = await syncLikes(source, target, state, { retryMissing: true });

  assert.deepEqual(report.liked.map((p) => p.target.id), ["s2"]);
});

test("пробный запуск ничего не меняет", async () => {
  const { source, target, state } = make();
  const before = [...target.liked];

  const report = await syncLikes(source, target, state, { dryRun: true });

  assert.deepEqual(report.liked.map((p) => p.target.id), ["s1"]);
  assert.deepEqual(target.liked, before);
  assert.deepEqual(state, {});
});

test("обратное направление не ищет уже сопоставленные пары", async () => {
  const { source, target, state } = make();
  await syncLikes(source, target, state);

  const report = await syncLikes(target, source, state);

  assert.equal(report.skipped, 2);
  assert.deepEqual(report.notFound.map((t) => t.id), ["own"]);
});

test("остановка сохраняет сделанное и продолжается с того же места", async () => {
  const { source, target, state } = make();
  let calls = 0;
  const report = await syncLikes(source, target, state, { shouldStop: () => calls++ >= 1 });
  assert.equal(report.stopped, true);
  assert.deepEqual(report.liked.map((p) => p.target.id), ["s1"]);
  assert.deepEqual(Object.keys(state["yandex->spotify"]), ["1"]);

  const next = await syncLikes(source, target, state);
  assert.equal(next.skipped, 1);
  assert.equal(next.liked.length, 0);
  assert.equal(next.alreadyLiked, 1);
  assert.deepEqual(next.notFound.map((t) => t.id), ["2"]);
});

test("поиск не останавливается, если первый запрос вернул не то", async () => {
  const { findMatch } = await import("../extension/lib/sync.js");
  const queries = [];
  const target = {
    searchQueries: () => ["track:exact", "plain", "title only"],
    async searchText(query) {
      queries.push(query);
      if (query === "track:exact") return [tr("spotify", "k", "Song (Karaoke Version)", "Artist")];
      if (query === "plain") return [tr("spotify", "real", "Song", "Artist")];
      return [];
    },
  };
  const { match } = await findMatch(target, tr("zvuk", "1", "Song", "Artist"));
  assert.equal(match.id, "real");
  assert.deepEqual(queries, ["track:exact", "plain"]);
});

test("поиск идёт параллельно, а лайки ставятся по порядку", async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const count = 12;
  const source = new FakeService("yandex",
    Array.from({ length: count }, (_, i) => tr("yandex", `y${i}`, `Song ${i}`, "A")).reverse(), []);
  const target = new FakeService("youtube", [],
    Array.from({ length: count }, (_, i) => tr("youtube", `t${i}`, `Song ${i}`, "A")));
  target.concurrency = 4;
  let active = 0;
  let maxActive = 0;
  const searchText = target.searchText.bind(target);
  target.searchText = async (query) => {
    active++;
    maxActive = Math.max(maxActive, active);
    // Ответы приходят вразнобой: у разных треков разная задержка.
    await sleep(5 + ((Number(query.split(" ")[1]) * 7) % 13));
    active--;
    return searchText(query);
  };
  const likedOrder = [];
  target.like = async (tracks) => { likedOrder.push(...tracks.map((t) => t.id)); };

  const report = await syncLikes(source, target, {});

  assert.equal(maxActive, 4);
  assert.deepEqual(likedOrder, Array.from({ length: count }, (_, i) => `t${i}`));
  assert.equal(report.liked.length, count);
});

test("ошибка входа посреди переноса сохраняет сделанное и прерывает перенос", async () => {
  const { source, target, state } = make();
  target.searchText = async () => { throw Object.assign(new Error("вход устарел"), { fatal: true }); };
  let saved = null;
  await assert.rejects(
    syncLikes(source, target, state, { saveState: async (s) => { saved = structuredClone(s); } }),
    /вход устарел/,
  );
  assert.ok(saved);
});
