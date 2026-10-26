from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Track:
    """Трек в нейтральном (не зависящем от сервиса) виде."""

    service: str
    id: str
    title: str
    artists: tuple[str, ...]
    album: str | None = None
    version: str | None = None
    duration_ms: int | None = None
    isrc: str | None = None
    liked_at: str | None = None
    # Идентификатор, который нужно передать сервису при лайке
    # (у Яндекса это "track_id:album_id"). По умолчанию совпадает с id.
    ref: str | None = field(default=None, compare=False)

    @property
    def like_ref(self) -> str:
        return self.ref or self.id

    @property
    def main_artist(self) -> str:
        return self.artists[0] if self.artists else ""

    def display(self) -> str:
        title = f"{self.title} ({self.version})" if self.version else self.title
        return f"{', '.join(self.artists)} — {title}"
