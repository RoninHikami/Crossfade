from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Track


class MusicService(ABC):
    """Общий интерфейс стримингового сервиса."""

    name: str

    @abstractmethod
    def get_liked_tracks(self) -> list[Track]:
        """Все лайкнутые треки, от новых к старым."""

    @abstractmethod
    def search(self, track: Track) -> list[Track]:
        """Кандидаты в этом сервисе, похожие на трек из другого сервиса."""

    @abstractmethod
    def like(self, tracks: list[Track]) -> None:
        """Поставить лайк трекам этого сервиса (в переданном порядке)."""
