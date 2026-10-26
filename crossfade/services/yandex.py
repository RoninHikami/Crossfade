from __future__ import annotations

import os
import time

from yandex_music import Client

from ..matching import base_title
from ..models import Track
from .base import MusicService

FETCH_BATCH = 200
LIKE_BATCH = 100
SEARCH_LIMIT = 5


def _to_track(item, liked_at: str | None = None) -> Track:
    album = item.albums[0] if item.albums else None
    return Track(
        service="yandex",
        id=str(item.id),
        title=item.title or "",
        artists=tuple(a.name for a in item.artists if a.name),
        album=album.title if album else None,
        version=item.version,
        duration_ms=item.duration_ms,
        isrc=getattr(item, "isrc", None),
        liked_at=liked_at,
        ref=item.track_id,
    )


class YandexService(MusicService):
    name = "yandex"

    def __init__(self, client: Client, request_delay: float = 0.2):
        self.client = client
        self.request_delay = request_delay

    @classmethod
    def from_env(cls) -> YandexService:
        token = os.environ.get("YANDEX_MUSIC_TOKEN")
        if not token:
            raise RuntimeError("Не задан YANDEX_MUSIC_TOKEN (см. README).")
        return cls(Client(token).init())

    def whoami(self) -> str:
        account = self.client.me.account
        return account.login or account.display_name or str(account.uid)

    def get_liked_tracks(self) -> list[Track]:
        likes = self.client.users_likes_tracks()
        if likes is None:
            return []
        shorts = likes.tracks
        liked_at = {str(s.id): s.timestamp for s in shorts}
        tracks: list[Track] = []
        for start in range(0, len(shorts), FETCH_BATCH):
            batch = [s.track_id for s in shorts[start:start + FETCH_BATCH]]
            for item in self.client.tracks(batch):
                tracks.append(_to_track(item, liked_at.get(str(item.id))))
        tracks.sort(key=lambda t: t.liked_at or "", reverse=True)
        return tracks

    def _search(self, query: str) -> list[Track]:
        time.sleep(self.request_delay)
        result = self.client.search(query, type_="track")
        if not result or not result.tracks:
            return []
        return [_to_track(item) for item in result.tracks.results[:SEARCH_LIMIT]]

    def search(self, track: Track) -> list[Track]:
        title = base_title(track.title)
        candidates = self._search(f"{track.main_artist} {title}")
        if not candidates:
            candidates = self._search(title)
        return candidates

    def like(self, tracks: list[Track]) -> None:
        ids = [t.like_ref for t in tracks]
        for start in range(0, len(ids), LIKE_BATCH):
            self.client.users_likes_tracks_add(ids[start:start + LIKE_BATCH])
