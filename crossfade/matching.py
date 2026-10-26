"""Сопоставление треков между сервисами.

Сначала сравниваем ISRC (если он есть у обоих треков), иначе считаем
взвешенную похожесть названия, исполнителей и длительности.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from .models import Track

MATCH_THRESHOLD = 0.75

_TRANSLIT = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "",
    "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})

# Пометки версии, которые делают трек «другим» (живое исполнение, ремикс...).
_VERSION_MARKERS = (
    "live", "remix", "acoustic", "instrumental", "karaoke", "cover",
    "demo", "edit", "mix", "version", "unplugged",
    "концерт", "живое", "ремикс", "акустика", "инструментал",
)
# Пометки, которые можно игнорировать.
_NEUTRAL_MARKERS = ("remaster", "feat", "ft.", "with ", "radio edit", "explicit", "bonus")

_BRACKETS_RE = re.compile(r"[(\[{].*?[)\]}]")
_DASH_SUFFIX_RE = re.compile(r"\s+[-–—]\s+.*$")
_NON_WORD_RE = re.compile(r"[^\w\s]+")
_SPACES_RE = re.compile(r"\s+")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower().replace("ё", "е")
    text = text.replace("&", " and ")
    text = _NON_WORD_RE.sub(" ", text)
    return _SPACES_RE.sub(" ", text).strip()


def transliterate(text: str) -> str:
    return text.lower().translate(_TRANSLIT)


def base_title(title: str) -> str:
    """Название без скобок и суффиксов вида « - Remastered 2011»."""
    stripped = _DASH_SUFFIX_RE.sub("", _BRACKETS_RE.sub(" ", title))
    return normalize(stripped) or normalize(title)


def version_tags(track: Track) -> frozenset[str]:
    """Значимые пометки версии из названия и поля version."""
    extra = [m.group(0) for m in _BRACKETS_RE.finditer(track.title)]
    dash = _DASH_SUFFIX_RE.search(track.title)
    if dash:
        extra.append(dash.group(0))
    if track.version:
        extra.append(track.version)
    tags = set()
    for chunk in extra:
        chunk = chunk.lower()
        if any(n in chunk for n in _NEUTRAL_MARKERS):
            continue
        tags.update(m for m in _VERSION_MARKERS if m in chunk)
    return frozenset(tags)


def _similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    direct = SequenceMatcher(None, a, b).ratio()
    translit = SequenceMatcher(None, a.translate(_TRANSLIT), b.translate(_TRANSLIT)).ratio()
    return max(direct, translit)


def artist_similarity(a: Track, b: Track) -> float:
    left = [normalize(x) for x in a.artists if x]
    right = [normalize(x) for x in b.artists if x]
    if not left or not right:
        return 0.0
    # Лучшее совпадение для каждого исполнителя исходного трека; главный
    # исполнитель весит больше, чем приглашённые.
    best = [max(_similarity(x, y) for y in right) for x in left]
    if len(best) == 1:
        return best[0]
    return 0.7 * best[0] + 0.3 * max(best[1:] + [best[0]])


def duration_similarity(a: Track, b: Track) -> float:
    if not a.duration_ms or not b.duration_ms:
        return 0.5
    diff = abs(a.duration_ms - b.duration_ms) / 1000
    if diff <= 3:
        return 1.0
    if diff >= 30:
        return 0.0
    return 1.0 - (diff - 3) / 27


def score(source: Track, candidate: Track) -> float:
    """Похожесть треков от 0 до 1."""
    if source.isrc and candidate.isrc and source.isrc.upper() == candidate.isrc.upper():
        return 1.0

    title = _similarity(base_title(source.title), base_title(candidate.title))
    artist = artist_similarity(source, candidate)
    if title < 0.6 or artist < 0.5:
        return 0.0

    result = 0.5 * title + 0.35 * artist + 0.15 * duration_similarity(source, candidate)
    if version_tags(source) != version_tags(candidate):
        result -= 0.2
    return max(result, 0.0)


def best_match(source: Track, candidates: list[Track],
               threshold: float = MATCH_THRESHOLD) -> tuple[Track | None, float]:
    best, best_score = None, 0.0
    for candidate in candidates:
        value = score(source, candidate)
        if value > best_score:
            best, best_score = candidate, value
    if best_score < threshold:
        return None, best_score
    return best, best_score
