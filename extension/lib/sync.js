// Перенос лайков из одного сервиса в другой.
//
// Расширение только добавляет лайки: существующие лайки в обоих сервисах
// никогда не снимаются.

import { MATCH_THRESHOLD, baseTitle, bestMatch, displayTrack } from "./matching.js";

export const MATCHED = "matched";
export const NOT_FOUND = "not_found";

const FLUSH_EVERY = 20;

// --- Состояние: какие треки уже перенесены или не найдены -------------------
// state = { "yandex->spotify": { [sourceId]: { status, targetId?, title, at } } }

export function directionKey(source, target) {
  return `${source}->${target}`;
}

function entries(state, source, target) {
  const key = directionKey(source, target);
  state[key] ??= {};
  return state[key];
}

export function markMatched(state, source, target, sourceId, targetId, title) {
  const at = new Date().toISOString();
  entries(state, source, target)[sourceId] = { status: MATCHED, targetId, title, at };
  // Запоминаем пару и для обратного направления, чтобы при переносе
  // обратно этот трек не искался заново.
  entries(state, target, source)[targetId] ??= { status: MATCHED, targetId: sourceId, title, at };
}

export function markNotFound(state, source, target, sourceId, title, searchUrl) {
  entries(state, source, target)[sourceId] = {
    status: NOT_FOUND, title, searchUrl, at: new Date().toISOString(),
  };
}

export function notFoundList(state, source, target) {
  return Object.entries(entries(state, source, target))
    .filter(([, value]) => value.status === NOT_FOUND)
    .map(([id, value]) => ({ id, ...value }));
}

// --- Быстрый поиск среди уже лайкнутых треков целевого сервиса --------------

class TargetIndex {
  constructor(tracks) {
    this.ids = new Set();
    this.byIsrc = new Map();
    this.byTitle = new Map();
    tracks.forEach((t) => this.add(t));
  }

  add(track) {
    this.ids.add(track.id);
    if (track.isrc) this.byIsrc.set(track.isrc.toUpperCase(), track);
    const key = baseTitle(track.title);
    if (!this.byTitle.has(key)) this.byTitle.set(key, []);
    this.byTitle.get(key).push(track);
  }

  find(track, threshold) {
    if (track.isrc && this.byIsrc.has(track.isrc.toUpperCase())) {
      return this.byIsrc.get(track.isrc.toUpperCase());
    }
    return bestMatch(track, this.byTitle.get(baseTitle(track.title)) || [], threshold).match;
  }
}

// --- Поиск трека в целевом сервисе -----------------------------------------
// Сервис предлагает несколько запросов, от самых точных к самым общим. Пробуем
// их по очереди и останавливаемся, как только нашёлся подходящий трек: первый
// запрос мог вернуть, например, только караоке-версии.

export async function findMatch(target, track, threshold = MATCH_THRESHOLD) {
  const candidates = [];
  const tried = new Set();
  let best = { match: null, score: 0 };
  for (const query of target.searchQueries(track)) {
    const key = query.trim().toLowerCase();
    if (!key || tried.has(key)) continue;
    tried.add(key);
    candidates.push(...(await target.searchText(query)));
    best = bestMatch(track, candidates, threshold);
    if (best.match) break;
  }
  return best;
}

// --- Сам перенос ------------------------------------------------------------

export async function syncLikes(source, target, state, options = {}) {
  const {
    dryRun = false,
    retryMissing = false,
    threshold = MATCH_THRESHOLD,
    onProgress = () => {},
    shouldStop = () => false,
    saveState = async () => {},
  } = options;
  const src = source.name;
  const dst = target.name;
  const report = {
    source: src, target: dst, total: 0, skipped: 0, alreadyLiked: 0,
    liked: [], notFound: [], errors: [], stopped: false,
  };

  onProgress({ phase: "loading", service: src });
  // Идём от старых лайков к новым, чтобы в цели сохранился похожий порядок.
  const sourceTracks = (await source.getLikedTracks()).reverse();
  report.total = sourceTracks.length;
  onProgress({ phase: "loading", service: dst });
  const index = new TargetIndex(await target.getLikedTracks());

  const done = state[directionKey(src, dst)] || {};
  const todo = sourceTracks.filter((track) => {
    const entry = done[track.id];
    const skip = entry && (entry.status === MATCHED || (entry.status === NOT_FOUND && !retryMissing));
    if (skip) report.skipped++;
    return !skip;
  });

  const pending = [];
  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      await target.like(pending.map((p) => p.target));
      for (const p of pending) markMatched(state, src, dst, p.source.id, p.target.id, displayTrack(p.source));
      await saveState(state);
    }
    report.liked.push(...pending);
    pending.length = 0;
  };

  for (let i = 0; i < todo.length; i++) {
    if (shouldStop()) {
      report.stopped = true;
      break;
    }
    // Периодически сохраняем прогресс, чтобы не искать заново после перерыва.
    if (!dryRun && i > 0 && i % 25 === 0) await saveState(state);
    const track = todo[i];
    onProgress({ phase: "matching", processed: i, todo: todo.length, current: displayTrack(track) });

    const existing = index.find(track, threshold);
    if (existing) {
      report.alreadyLiked++;
      if (!dryRun) markMatched(state, src, dst, track.id, existing.id, displayTrack(track));
      continue;
    }

    let found;
    try {
      found = await findMatch(target, track, threshold);
    } catch (error) {
      // Сеть, лимиты API и т.п. — попробуем в следующий раз.
      if (error.fatal) throw error;
      report.errors.push({ track, message: String(error.message || error) });
      continue;
    }

    if (!found.match) {
      report.notFound.push(track);
      if (!dryRun) markNotFound(state, src, dst, track.id, displayTrack(track), target.searchUrl(track));
      continue;
    }

    if (index.ids.has(found.match.id)) {
      report.alreadyLiked++;
      if (!dryRun) markMatched(state, src, dst, track.id, found.match.id, displayTrack(track));
      continue;
    }

    index.add(found.match);
    pending.push({ source: track, target: found.match, score: found.score });
    if (pending.length >= FLUSH_EVERY) await flush();
  }

  await flush();
  if (!dryRun) await saveState(state);
  onProgress({ phase: "done", processed: todo.length, todo: todo.length });
  return report;
}
