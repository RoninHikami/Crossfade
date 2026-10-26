from crossfade.models import Track
from crossfade.services.base import MusicService
from crossfade.state import NOT_FOUND, SyncState
from crossfade.sync import sync_likes


def tr(service, id, title, artist, liked_at=None):
    return Track(service=service, id=id, title=title, artists=(artist,),
                 duration_ms=200_000, liked_at=liked_at)


class FakeService(MusicService):
    def __init__(self, name, liked, catalog):
        self.name = name
        self.liked = list(liked)  # от новых к старым
        self.catalog = catalog
        self.searches = 0

    def get_liked_tracks(self):
        return list(self.liked)

    def search(self, track):
        self.searches += 1
        return [c for c in self.catalog if c.title.lower() == track.title.lower()]

    def like(self, tracks):
        for track in tracks:
            self.liked.insert(0, track)


def make(tmp_path):
    source = FakeService("yandex", [
        tr("yandex", "3", "Third", "C", "2024-03"),
        tr("yandex", "2", "Missing", "B", "2024-02"),
        tr("yandex", "1", "First", "A", "2024-01"),
    ], [])
    already = tr("spotify", "s3", "Third", "C")
    target = FakeService("spotify", [already, tr("spotify", "own", "Own like", "Z")], [
        tr("spotify", "s1", "First", "A"),
        already,
    ])
    return source, target, SyncState(str(tmp_path / "state.json"))


def test_sync_adds_new_likes_and_keeps_existing(tmp_path):
    source, target, state = make(tmp_path)
    before = {t.id for t in target.liked}

    report = sync_likes(source, target, state)

    assert [m.id for _, m in report.liked] == ["s1"]
    assert report.already_liked == 1
    assert [t.id for t in report.not_found] == ["2"]
    # Существующие лайки остались на месте, ничего не удалено.
    assert before <= {t.id for t in target.liked}
    assert {t.id for t in target.liked} == before | {"s1"}


def test_second_run_is_incremental(tmp_path):
    source, target, state = make(tmp_path)
    sync_likes(source, target, state)
    searches = target.searches

    state = SyncState(str(tmp_path / "state.json"))
    report = sync_likes(source, target, state)

    assert report.skipped == 3
    assert not report.liked
    assert target.searches == searches


def test_retry_missing(tmp_path):
    source, target, state = make(tmp_path)
    sync_likes(source, target, state)
    assert state.get("yandex", "spotify", "2")["status"] == NOT_FOUND

    target.catalog.append(tr("spotify", "s2", "Missing", "B"))
    report = sync_likes(source, target, state, retry_missing=True)

    assert [m.id for _, m in report.liked] == ["s2"]


def test_dry_run_changes_nothing(tmp_path):
    source, target, state = make(tmp_path)
    before = list(target.liked)

    report = sync_likes(source, target, state, dry_run=True)

    assert [m.id for _, m in report.liked] == ["s1"]
    assert target.liked == before
    assert not (tmp_path / "state.json").exists()


def test_reverse_direction_reuses_pairs(tmp_path):
    source, target, state = make(tmp_path)
    sync_likes(source, target, state)

    report = sync_likes(target, source, state)

    # s1 пришёл из Яндекса, s3 сопоставлен с уже лайкнутым — их не ищем снова;
    # переносится только собственный лайк Spotify (в каталоге Яндекса его нет).
    assert report.skipped == 2
    assert [t.id for t in report.not_found] == ["own"]
