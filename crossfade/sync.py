"""Перенос лайков из одного сервиса в другой.

Программа только добавляет лайки: существующие лайки в обоих сервисах
никогда не снимаются.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .matching import MATCH_THRESHOLD, base_title, best_match
from .models import Track
from .services.base import MusicService
from .state import MATCHED, NOT_FOUND, SyncState

log = logging.getLogger(__name__)

FLUSH_EVERY = 20


@dataclass
class SyncReport:
    total: int = 0
    skipped: int = 0
    already_liked: int = 0
    liked: list[tuple[Track, Track]] = field(default_factory=list)
    not_found: list[Track] = field(default_factory=list)
    errors: list[tuple[Track, str]] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"Всего лайков в источнике: {self.total}; "
            f"уже обработаны ранее: {self.skipped}; "
            f"уже лайкнуты в цели: {self.already_liked}; "
            f"новых лайков: {len(self.liked)}; "
            f"не найдено: {len(self.not_found)}; "
            f"ошибок: {len(self.errors)}"
        )


class _TargetIndex:
    """Быстрый поиск среди уже лайкнутых треков целевого сервиса."""

    def __init__(self, tracks: list[Track]):
        self.ids = {t.id for t in tracks}
        self.by_isrc = {t.isrc.upper(): t for t in tracks if t.isrc}
        self.by_title: dict[str, list[Track]] = {}
        for t in tracks:
            self.by_title.setdefault(base_title(t.title), []).append(t)

    def find(self, track: Track, threshold: float) -> Track | None:
        if track.isrc and track.isrc.upper() in self.by_isrc:
            return self.by_isrc[track.isrc.upper()]
        match, _ = best_match(track, self.by_title.get(base_title(track.title), []), threshold)
        return match

    def add(self, track: Track) -> None:
        self.ids.add(track.id)
        self.by_title.setdefault(base_title(track.title), []).append(track)
        if track.isrc:
            self.by_isrc[track.isrc.upper()] = track


def sync_likes(
    source: MusicService,
    target: MusicService,
    state: SyncState,
    *,
    dry_run: bool = False,
    retry_missing: bool = False,
    limit: int | None = None,
    threshold: float = MATCH_THRESHOLD,
) -> SyncReport:
    report = SyncReport()
    src, dst = source.name, target.name

    log.info("Загружаю лайки из %s...", src)
    # Идём от старых лайков к новым, чтобы в цели сохранился похожий порядок.
    source_tracks = list(reversed(source.get_liked_tracks()))
    report.total = len(source_tracks)
    log.info("Загружаю лайки из %s...", dst)
    index = _TargetIndex(target.get_liked_tracks())
    log.info("В %s: %d лайков, в %s: %d лайков", src, report.total, dst, len(index.ids))

    pending: list[tuple[Track, Track]] = []

    def flush() -> None:
        if not pending:
            return
        if not dry_run:
            target.like([match for _, match in pending])
            for original, match in pending:
                state.mark_matched(src, dst, original.id, match.id, original.display())
            state.save()
        report.liked.extend(pending)
        pending.clear()

    processed = 0
    for track in source_tracks:
        entry = state.get(src, dst, track.id)
        if entry and (entry["status"] == MATCHED
                      or (entry["status"] == NOT_FOUND and not retry_missing)):
            report.skipped += 1
            continue
        if limit is not None and processed >= limit:
            break
        processed += 1

        existing = index.find(track, threshold)
        if existing is not None:
            report.already_liked += 1
            if not dry_run:
                state.mark_matched(src, dst, track.id, existing.id, track.display())
            continue

        try:
            match, value = best_match(track, target.search(track), threshold)
        except Exception as exc:  # сеть, лимиты API и т.п. — попробуем в следующий раз
            log.warning("Ошибка поиска «%s»: %s", track.display(), exc)
            report.errors.append((track, str(exc)))
            continue

        if match is None:
            log.info("Не найдено: %s", track.display())
            report.not_found.append(track)
            if not dry_run:
                state.mark_not_found(src, dst, track.id, track.display())
            continue

        if match.id in index.ids:
            report.already_liked += 1
            if not dry_run:
                state.mark_matched(src, dst, track.id, match.id, track.display())
            continue

        log.info("Найдено (%.2f): %s  =>  %s", value, track.display(), match.display())
        index.add(match)
        pending.append((track, match))
        if len(pending) >= FLUSH_EVERY:
            flush()

    flush()
    if not dry_run:
        state.save()
    return report
