# Crossfade

Автоматический перенос лайкнутых треков между стриминговыми сервисами.
Сейчас поддерживаются **Яндекс Музыка** и **Spotify**, в любом направлении.

- Программа **только добавляет** лайки. Существующие лайки в обоих сервисах
  никогда не снимаются, а треки, уже лайкнутые в целевом сервисе, повторно не трогаются.
- Треки сопоставляются по ISRC, если он есть, иначе по названию, исполнителям
  и длительности. Учитываются транслитерация (Кино ↔ Kino), пометки вроде
  «Remastered» и отличия версий (Live, Remix и т.п.).
- Прогресс хранится в файле состояния, поэтому повторные запуски обрабатывают
  только новые лайки. В режиме `--watch` синхронизация повторяется по расписанию.
- Лайки переносятся от старых к новым, так что порядок в целевом сервисе
  примерно сохраняется.

## Установка

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env   # и заполните ключи
```

### Spotify

1. Создайте приложение на <https://developer.spotify.com/dashboard>.
2. В настройках приложения добавьте Redirect URI `http://127.0.0.1:8888/callback`
   (Web API).
3. Пропишите `SPOTIFY_CLIENT_ID` и `SPOTIFY_CLIENT_SECRET` в `.env`.
4. Выполните `crossfade auth spotify`: откройте показанную ссылку, разрешите доступ
   и вставьте в терминал адрес, на который вас перенаправило. Токен сохранится
   в `~/.config/crossfade/spotify_token.json` и дальше будет обновляться сам.

Пока приложение в режиме разработки, его аккаунт Spotify нужно добавить
в User Management на панели разработчика.

### Яндекс Музыка

Нужен OAuth-токен Яндекс Музыки. Способы его получить описаны в документации
библиотеки [yandex-music](https://yandex-music.readthedocs.io/en/main/token.html).
Пропишите его в `YANDEX_MUSIC_TOKEN` и проверьте вход: `crossfade auth yandex`.

## Использование

```bash
# Посмотреть, что будет перенесено, ничего не меняя
crossfade -v sync yandex spotify --dry-run

# Перенести лайки из Яндекса в Spotify
crossfade -v sync yandex spotify

# И обратно
crossfade -v sync spotify yandex

# Автоматический режим: проверять новые лайки каждые 30 минут
crossfade sync yandex spotify --watch 30

# Какие треки не удалось найти
crossfade missing yandex spotify

# Повторно поискать ненайденные (например, с более мягким порогом)
crossfade sync yandex spotify --retry-missing --threshold 0.7
```

Без установки пакета можно запускать как `python -m crossfade ...`.

Для запуска по расписанию без `--watch` можно добавить задачу в cron:

```cron
*/30 * * * * cd /path/to/Crossfade && .venv/bin/crossfade sync yandex spotify >> crossfade.log 2>&1
```

## Как это устроено

```
crossfade/
  models.py         — Track: трек в нейтральном виде
  matching.py       — нормализация названий и оценка похожести
  services/         — клиенты сервисов (общий интерфейс MusicService)
    yandex.py
    spotify.py
  state.py          — файл состояния (что перенесено / не найдено)
  sync.py           — сам перенос
  cli.py            — командная строка
```

Чтобы добавить новый сервис, реализуйте `MusicService`
(`get_liked_tracks`, `search`, `like`) и зарегистрируйте его в
`crossfade/services/__init__.py`.

## Разработка

```bash
pip install -e '.[dev]'
pytest
```
