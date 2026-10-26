from crossfade.matching import base_title, best_match, score
from crossfade.models import Track


def t(title, *artists, service="x", id="1", duration_ms=200_000, isrc=None, version=None):
    return Track(service=service, id=id, title=title, artists=artists,
                 duration_ms=duration_ms, isrc=isrc, version=version)


def test_base_title_strips_versions():
    assert base_title("Yesterday - Remastered 2009") == "yesterday"
    assert base_title("Song (feat. Someone) [Bonus]") == "song"


def test_isrc_match_wins():
    assert score(t("A", "X", isrc="USABC123"), t("Completely different", "Y", isrc="usabc123")) == 1.0


def test_same_track_with_remaster_suffix():
    assert score(t("Yesterday", "The Beatles"), t("Yesterday - Remastered 2009", "The Beatles")) > 0.9


def test_cyrillic_vs_latin_artist():
    assert score(t("Gruppa krovi", "Кино"), t("Gruppa krovi", "Kino")) > 0.75


def test_live_version_penalized():
    studio = t("Song", "Artist")
    live = t("Song", "Artist", version="Live")
    assert score(studio, t("Song", "Artist")) > score(studio, live)


def test_different_artist_rejected():
    assert score(t("Hello", "Adele"), t("Hello", "Lionel Richie")) == 0.0


def test_best_match_picks_closest_duration():
    source = t("Song", "Artist", duration_ms=200_000)
    far = t("Song", "Artist", id="far", duration_ms=260_000)
    near = t("Song", "Artist", id="near", duration_ms=201_000)
    match, _ = best_match(source, [far, near])
    assert match.id == "near"


def test_best_match_none_below_threshold():
    match, _ = best_match(t("Song", "Artist"), [t("Other thing", "Artist")])
    assert match is None
