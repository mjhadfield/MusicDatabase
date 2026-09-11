"""
Thin client for MusicBrainz's web service -- used by the maintenance tool
to help resolve artists (and later albums/songs) that have no mbid yet.

No API key required, but MusicBrainz's usage etiquette asks for two
things from unauthenticated callers: an identifying User-Agent (so they
can reach you if a script misbehaves) and no more than ~1 request/second.
Both are enforced here centrally so every search function gets them for
free.
"""
import threading
import time

import requests

USER_AGENT = "MusicDatabaseMaintenance/1.0 (mikehadfield89@gmail.com)"
BASE_URL = "https://musicbrainz.org/ws/2"
MIN_INTERVAL_SECONDS = 1.0
TIMEOUT_SECONDS = 10

_rate_lock = threading.Lock()
_last_request_at = 0.0


def _throttle() -> None:
    """Block until at least MIN_INTERVAL_SECONDS has passed since the last
    outbound request. Guarded by a lock so this is safe even though the
    maintenance server handles requests on multiple threads."""
    global _last_request_at
    with _rate_lock:
        wait = MIN_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        _last_request_at = time.monotonic()


MAX_RETRIES = 2  # on top of the initial attempt
RETRY_BACKOFF_SECONDS = 1.5


def _mb_get(path: str, params: dict) -> dict:
    # MB's search endpoint returns a 503 "currently busy" fairly often
    # under load -- it's explicitly asking the caller to try again, not
    # reporting a problem with the request -- and the odd connection
    # reset/timeout is just normal internet flakiness. A short
    # retry-with-backoff smooths both over instead of surfacing them as
    # an error every time. A non-503 HTTP error (a genuinely bad request)
    # still raises immediately -- retrying that would just fail the same
    # way three times instead of once.
    for attempt in range(MAX_RETRIES + 1):
        _throttle()
        try:
            resp = requests.get(
                f"{BASE_URL}/{path}",
                params={**params, "fmt": "json"},
                headers={"User-Agent": USER_AGENT},
                timeout=TIMEOUT_SECONDS,
            )
        except requests.exceptions.RequestException:
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                continue
            raise
        if resp.status_code == 503 and attempt < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
            continue
        resp.raise_for_status()
        return resp.json()


def search_artists(query: str, limit: int = 10) -> list[dict]:
    """Fuzzy-search MusicBrainz for artists matching `query`. Returns
    candidates ordered by MB's own relevance score (best first)."""
    data = _mb_get("artist", {"query": query, "limit": limit})
    candidates = []
    for artist in data.get("artists", []):
        life_span = artist.get("life-span") or {}
        candidates.append({
            "mbid": artist.get("id"),
            "name": artist.get("name"),
            "disambiguation": artist.get("disambiguation") or None,
            "type": artist.get("type"),
            "country": artist.get("country"),
            # MB returns this as a string attribute on each match, not a number.
            "score": int(artist.get("score", 0)),
            "beginDate": life_span.get("begin"),
            "endDate": life_span.get("end"),
            "ended": life_span.get("ended", False),
        })
    return candidates


# search_release_groups(query, artist_mbid=None, limit=10) and
# search_recordings(query, artist_mbid=None, limit=10) slot in here later
# for the albums/songs maintenance passes, reusing _mb_get/_throttle as-is.
