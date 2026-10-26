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
    const batch = pending.splice(0);
    if (!dryRun) {
      await target.like(batch.map((p) => p.target));
      for (const p of batch) markMatched(state, src, dst, p.source.id, p.target.id, displayTrack(p.source));
      await saveState(state);
    }
    report.liked.push(...batch);
  };

  // Применяем результат поиска к отчёту, состоянию и очереди лайков.
  const commit = async (track, result) => {
    if (result.error) {
      // Сеть, лимиты API и т.п. — попробуем в следующий раз.
      report.errors.push({ track, message: String(result.error.message || result.error) });
      return;
    }
    const match = result.existing || result.found.match;
    if (!match) {
      report.notFound.push(track);
      if (!dryRun) markNotFound(state, src, dst, track.id, displayTrack(track), target.searchUrl(track));
      return;
    }
    if (result.existing || index.ids.has(match.id)) {
      report.alreadyLiked++;
      if (!dryRun) markMatched(state, src, dst, track.id, match.id, displayTrack(track));
      return;
    }
    index.add(match);
    pending.push({ source: track, target: match, score: result.found.score });
    if (pending.length >= FLUSH_EVERY) await flush();
  };

  // Ищем треки в несколько потоков (сколько выдерживает сервис), а результаты
  // применяем строго по порядку: так лайки по-прежнему ставятся от старых
  // к новым, а поиск не ждёт, пока ставятся лайки.
  const results = new Array(todo.length);
  let nextToSearch = 0;
  let committed = 0;
  let fatal = null;
  let commitChain = Promise.resolve();

  const drain = () => {
    commitChain = commitChain.then(async () => {
      while (!fatal && committed < todo.length && results[committed]) {
        const i = committed++;
        await commit(todo[i], results[i]);
        results[i] = true;
        // Периодически сохраняем прогресс, чтобы не искать заново после перерыва.
        if (!dryRun && committed % 25 === 0) await saveState(state);
      }
    }).catch((error) => { fatal ??= error; });
    return commitChain;
  };

  const worker = async () => {
    while (!fatal && nextToSearch < todo.length) {
      if (shouldStop()) {
        report.stopped = true;
        return;
      }
      const i = nextToSearch++;
      const track = todo[i];
      onProgress({ phase: "matching", processed: committed, todo: todo.length, current: displayTrack(track) });
      const existing = index.find(track, threshold);
      if (existing) {
        results[i] = { existing };
      } else {
        try {
          results[i] = { found: await findMatch(target, track, threshold) };
        } catch (error) {
          if (error.fatal) {
            fatal ??= error;
            return;
          }
          results[i] = { error };
        }
      }
      drain();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, target.concurrency || 1) }, worker));
  await drain();
  if (!fatal) {
    try {
      await flush();
    } catch (error) {
      fatal = error;
    }
  }
  if (fatal) {
    if (!dryRun) await saveState(state);
    throw fatal;
  }
  if (!dryRun) await saveState(state);
  onProgress({ phase: "done", processed: todo.length, todo: todo.length });
  return report;
}
