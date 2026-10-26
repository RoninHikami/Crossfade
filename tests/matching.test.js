import { test } from "node:test";
import assert from "node:assert/strict";
import { baseTitle, bestMatch, score } from "../extension/lib/matching.js";

const t = (title, artists, extra = {}) => ({
  service: "x", id: extra.id || "1", title, artists: [].concat(artists), durationMs: 200_000, ...extra,
});

test("baseTitle убирает пометки версии", () => {
  assert.equal(baseTitle("Yesterday - Remastered 2009"), "yesterday");
  assert.equal(baseTitle("Song (feat. Someone) [Bonus]"), "song");
});

test("совпадение ISRC решает", () => {
  assert.equal(score(t("A", "X", { isrc: "USABC123" }), t("Совсем другое", "Y", { isrc: "usabc123" })), 1);
});

test("ремастер — тот же трек", () => {
  assert.ok(score(t("Yesterday", "The Beatles"), t("Yesterday - Remastered 2009", "The Beatles")) > 0.9);
});

test("кириллица и латиница", () => {
  assert.ok(score(t("Группа крови", "Кино"), t("Gruppa krovi", "Kino")) > 0.75);
});

test("живая версия хуже студийной", () => {
  const studio = t("Song", "Artist");
  assert.ok(score(studio, t("Song", "Artist")) > score(studio, t("Song", "Artist", { version: "Live" })));
});

test("другой исполнитель отбрасывается", () => {
  assert.equal(score(t("Hello", "Adele"), t("Hello", "Lionel Richie")), 0);
});

test("выбирается кандидат с ближайшей длительностью", () => {
  const source = t("Song", "Artist");
  const far = t("Song", "Artist", { id: "far", durationMs: 260_000 });
  const near = t("Song", "Artist", { id: "near", durationMs: 201_000 });
  assert.equal(bestMatch(source, [far, near]).match.id, "near");
});

test("ниже порога — ничего", () => {
  assert.equal(bestMatch(t("Song", "Artist"), [t("Other thing", "Artist")]).match, null);
});
