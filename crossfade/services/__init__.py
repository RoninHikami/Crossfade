from .base import MusicService

SERVICES = ("yandex", "spotify")


def create_service(name: str, data_dir: str) -> MusicService:
    """Создать клиент сервиса по имени, читая ключи из переменных окружения."""
    import os

    if name == "yandex":
        from .yandex import YandexService

        return YandexService.from_env()
    if name == "spotify":
        from .spotify import SpotifyService

        return SpotifyService.from_env(os.path.join(data_dir, "spotify_token.json"))
    raise ValueError(f"Неизвестный сервис: {name}. Доступны: {', '.join(SERVICES)}")


__all__ = ["MusicService", "SERVICES", "create_service"]
