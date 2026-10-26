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

// --- Случаи, которые раньше не находились ------------------------------------

test("саундтрек-версия совпадает с треком «From …»", () => {
  const source = t("Playing With The Big Boys (The Prince Of Egypt/Soundtrack Version)", ["Steve Martin", "Martin Short"], { durationMs: 200_000 });
  const candidate = t('Playing With The Big Boys - From "The Prince of Egypt" Soundtrack', ["Steve Martin", "Martin Short"], { durationMs: 205_000 });
  assert.ok(score(source, candidate) >= 0.9);
});

test("та же песня другого исполнителя не подходит", () => {
  const source = t("When You Believe (The Prince Of Egypt/Soundtrack Version)", ["Michelle Pfeiffer", "Sally Dworsky"]);
  assert.equal(bestMatch(source, [t("When You Believe", ["Whitney Houston", "Mariah Carey"])]).match, null);
  assert.ok(bestMatch(source, [t("When You Believe - From The Prince Of Egypt", ["Michelle Pfeiffer", "Sally Dworsky"])]).match);
});

test("классика с длинным названием в другом сервисе", () => {
  const source = t("Le Cygne, R. 125", ["Camille Saint-Saëns", "Michael McHale", "Michael Collins"], { durationMs: 170_000 });
  const candidate = t("Le carnaval des animaux, R. 125: XIII. Le cygne", ["Camille Saint-Saëns", "Michael Collins", "Michael McHale"], { durationMs: 172_000 });
  assert.ok(bestMatch(source, [candidate]).match);
});

test("название из одного символа", () => {
  assert.equal(baseTitle("∞"), "∞");
  assert.ok(bestMatch(t("∞", "Земфира"), [t("∞", "Zemfira")]).match);
});

test("караоке и живые версии по-прежнему отличаются", () => {
  const studio = t("I Almost Told You That I Loved You", "Papa Roach");
  assert.equal(bestMatch(studio, [t("I Almost Told You That I Loved You (Karaoke Version)", "Papa Roach")]).match, null);
  assert.equal(bestMatch(studio, [t("I Almost Told You That I Loved You (Live at Wembley)", "Papa Roach")]).match, null);
});

test("короткое название внутри длинного не совпадает при другой длительности", () => {
  const source = t("Love Me", "The Beatles", { durationMs: 150_000 });
  assert.equal(bestMatch(source, [t("Love Me Do", "The Beatles", { durationMs: 230_000 })]).match, null);
});
