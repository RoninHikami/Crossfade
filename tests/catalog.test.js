import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICES, allPairs, directionPairs, normalizeSettings } from "../extension/lib/catalog.js";

test("старые настройки направления переводятся в новые", () => {
  assert.deepEqual(
    [normalizeSettings({ direction: "spotify->yandex" })].map(({ source, target, bothWays }) => [source, target, bothWays]),
    [["spotify", "yandex", false]],
  );
  const both = normalizeSettings({ direction: "both", autoSync: true });
  assert.equal(both.bothWays, true);
  assert.equal(both.autoSync, true);
  assert.equal("direction" in both, false);
});

test("источник и цель не совпадают", () => {
  const settings = normalizeSettings({ source: "zvuk", target: "zvuk" });
  assert.equal(settings.source, "zvuk");
  assert.notEqual(settings.target, "zvuk");
});

test("пары направлений", () => {
  assert.deepEqual(directionPairs({ source: "zvuk", target: "spotify", bothWays: true }), [["zvuk", "spotify"], ["spotify", "zvuk"]]);
  assert.equal(allPairs().length, SERVICES.length * (SERVICES.length - 1));
});
