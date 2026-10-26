from __future__ import annotations

import os

import spotipy
from spotipy.oauth2 import SpotifyOAuth

from ..matching import base_title, transliterate
from ..models import Track
from .base import MusicService

# Только чтение и добавление в «Любимые треки»; удаление программа не делает.
SCOPES = "user-library-read user-library-modify"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:8888/callback"
PAGE_SIZE = 50
LIKE_BATCH = 40
SEARCH_LIMIT = 5


def _to_track(item: dict, liked_at: str | None = None) -> Track:
    return Track(
        service="spotify",
        id=item["id"],
        title=item["name"],
        artists=tuple(a["name"] for a in item.get("artists", [])),
        album=(item.get("album") or {}).get("name"),
        duration_ms=item.get("duration_ms"),
        isrc=(item.get("external_ids") or {}).get("isrc"),
        liked_at=liked_at,
    )


class SpotifyService(MusicService):
    name = "spotify"

    def __init__(self, client: spotipy.Spotify):
        self.client = client

    @classmethod
    def from_env(cls, cache_path: str) -> SpotifyService:
        client_id = os.environ.get("SPOTIFY_CLIENT_ID")
        client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
        if not client_id or not client_secret:
            raise RuntimeError(
                "Не заданы SPOTIFY_CLIENT_ID и SPOTIFY_CLIENT_SECRET (см. README)."
            )
        auth = SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=os.environ.get("SPOTIFY_REDIRECT_URI", DEFAULT_REDIRECT_URI),
            scope=SCOPES,
            cache_path=cache_path,
            open_browser=False,
        )
        return cls(spotipy.Spotify(auth_manager=auth, retries=5, status_retries=5))

    def whoami(self) -> str:
        user = self.client.current_user()
        return user.get("display_name") or user["id"]

    def get_liked_tracks(self) -> list[Track]:
        tracks: list[Track] = []
        offset = 0
        while True:
            page = self.client.current_user_saved_tracks(limit=PAGE_SIZE, offset=offset)
            for entry in page["items"]:
                item = entry.get("track")
                # Локальные файлы и удалённые из каталога треки пропускаем.
                if not item or not item.get("id") or item.get("is_local"):
                    continue
                tracks.append(_to_track(item, entry.get("added_at")))
            if not page.get("next"):
                return tracks
            offset += PAGE_SIZE

    def _search(self, query: str) -> list[Track]:
        result = self.client.search(q=query, type="track", limit=SEARCH_LIMIT)
        return [_to_track(item) for item in result["tracks"]["items"] if item]

    def search(self, track: Track) -> list[Track]:
        candidates: list[Track] = []
        if track.isrc:
            candidates += self._search(f"isrc:{track.isrc}")
        title = base_title(track.title)
        candidates += self._search(f'track:"{title}" artist:"{track.main_artist}"')
        if not candidates:
            candidates += self._search(f"{track.main_artist} {title}")
        query = transliterate(f"{track.main_artist} {title}")
        if not candidates and query != f"{track.main_artist} {title}".lower():
            # Кириллические названия в Spotify часто записаны латиницей.
            candidates += self._search(query)
        return candidates

    def like(self, tracks: list[Track]) -> None:
        ids = [t.like_ref for t in tracks]
        for start in range(0, len(ids), LIKE_BATCH):
            self.client.current_user_saved_tracks_add(ids[start:start + LIKE_BATCH])
