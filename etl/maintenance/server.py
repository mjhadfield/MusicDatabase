"""
Local-only web UI for etl/refresh.py -- a nicer way to trigger a data
refresh, read its report, and then actually decide whether to keep it,
than scrolling terminal output and hoping for the best.

This binds to 127.0.0.1 deliberately and must never be exposed beyond
localhost: it executes local scripts (which hit your Last.fm/Setlist.fm
API keys and can import an arbitrary CSV from imports/) on request, with
no authentication of its own. Fine for a tool only you can reach on your
own machine; dangerous for anything else.

Usage:
    python3 etl/maintenance/server.py
    open http://localhost:8643/
"""
import json
import re
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import requests
from rapidfuzz import fuzz, process

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "etl"))
from common import connect as db_connect  # noqa: E402
from musicbrainz import search_artists  # noqa: E402

PAGE_PATH = Path(__file__).resolve().parent / "index.html"
ARTISTS_PAGE_PATH = Path(__file__).resolve().parent / "artists.html"
SHARED_JS_PATH = Path(__file__).resolve().parent / "shared.js"
DATA_DB = ROOT / "data" / "music.sqlite"
BACKUP_DIR = ROOT / "data" / ".refresh_backups"
MERGE_BACKUP_DIR = ROOT / "data" / ".artist_merge_backups"
PORT = 8643

MBID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

# job_id -> {
#   "lines": [str, ...] (append-only),
#   "done": bool, "returncode": int|None,
#   "kind": "refresh" | "build",
#   "backup": Path|None,   -- only for "refresh" jobs; the pre-run copy of
#                              data/music.sqlite, so a rejection has
#                              something to restore
#   "decision": "accepted" | "rejected" | None,
# }
# Lines are append-only + the client tracks its own offset (rather than
# "read and clear" server-side), so a missed poll can never silently
# drop output.
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


def run_job(job_id: str, cmd_args: list[str]) -> None:
    proc = subprocess.Popen(
        [sys.executable, *cmd_args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    for line in proc.stdout:
        with jobs_lock:
            jobs[job_id]["lines"].append(line)
    proc.wait()
    with jobs_lock:
        jobs[job_id]["done"] = True
        jobs[job_id]["returncode"] = proc.returncode


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # keep the terminal quiet -- the web UI is the point

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, content_type: str):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        # Used only by the new /api/artists/... routes below -- the
        # pre-existing routes keep parsing self.path themselves, untouched.
        path = urlsplit(self.path).path
        query = parse_qs(urlsplit(self.path).query)

        if self.path == "/":
            self._send_file(PAGE_PATH, "text/html; charset=utf-8")
        elif self.path == "/artists.html":
            self._send_file(ARTISTS_PAGE_PATH, "text/html; charset=utf-8")
        elif self.path == "/shared.js":
            self._send_file(SHARED_JS_PATH, "application/javascript; charset=utf-8")
        elif self.path == "/imports":
            imports_dir = ROOT / "imports"
            csvs = sorted(p.name for p in imports_dir.glob("*.csv")) if imports_dir.exists() else []
            self._send_json({"files": csvs})
        elif self.path.startswith("/status/"):
            job_id, _, jquery = self.path.split("/status/", 1)[1].partition("?")
            since = int(dict(p.split("=") for p in jquery.split("&") if "=" in p).get("since", "0")) if jquery else 0
            with jobs_lock:
                job = jobs.get(job_id)
                if not job:
                    return self._send_json({"error": "unknown job"}, status=404)
                payload = {
                    "lines": job["lines"][since:],
                    "total": len(job["lines"]),
                    "done": job["done"],
                    "returncode": job["returncode"],
                    "kind": job["kind"],
                    "decision": job["decision"],
                }
            self._send_json(payload)
        elif path == "/api/artists/missing-mbid":
            self._handle_missing_mbid(query)
        elif path == "/api/artists/mb-search":
            self._handle_mb_search(query)
        elif path == "/api/artists/local-search":
            self._handle_local_search(query)
        elif path == "/api/artists/detail":
            self._handle_artist_detail(query)
        elif path == "/api/artists/top-songs":
            self._handle_top_songs(query)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/run":
            return self._handle_run()
        if self.path == "/build":
            return self._handle_build()
        if self.path.startswith("/decision/"):
            return self._handle_decision(self.path.split("/decision/", 1)[1])
        if self.path == "/api/artists/assign-mbid":
            return self._handle_assign_mbid()
        if self.path == "/api/artists/merge":
            return self._handle_merge_artists()
        return self.send_error(404)

    def _handle_run(self):
        body = self._read_json_body()

        args = []
        if body.get("lastfm"):
            args.append("--lastfm")
        if body.get("setlistfm"):
            args.append("--setlistfm")
        if body.get("discogsFile"):
            csv_path = ROOT / "imports" / body["discogsFile"]
            if not csv_path.is_file():
                return self._send_json({"error": f"{csv_path} not found"}, status=400)
            args += ["--discogs", str(csv_path)]

        if not args:
            return self._send_json({"error": "Select at least one source to refresh."}, status=400)

        if not DATA_DB.is_file():
            return self._send_json({"error": f"{DATA_DB} doesn't exist -- run the ETL scripts first."}, status=400)

        # Snapshot the working database before touching it, so a rejection
        # has something concrete to restore -- refresh.py's own report is
        # informative, but this is what actually makes "reject" real.
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        job_id = uuid.uuid4().hex
        backup_path = BACKUP_DIR / f"{job_id}.sqlite"
        shutil.copy2(DATA_DB, backup_path)

        with jobs_lock:
            jobs[job_id] = {
                "lines": [], "done": False, "returncode": None,
                "kind": "refresh", "backup": backup_path, "decision": None,
            }
        threading.Thread(target=run_job, args=(job_id, ["etl/refresh.py", *args]), daemon=True).start()
        self._send_json({"jobId": job_id})

    def _handle_build(self):
        job_id = uuid.uuid4().hex
        with jobs_lock:
            jobs[job_id] = {
                "lines": [], "done": False, "returncode": None,
                "kind": "build", "backup": None, "decision": None,
            }
        threading.Thread(target=run_job, args=(job_id, ["etl/build_public_db.py"]), daemon=True).start()
        self._send_json({"jobId": job_id})

    def _handle_decision(self, job_id: str):
        body = self._read_json_body()
        action = body.get("action")
        if action not in ("accept", "reject"):
            return self._send_json({"error": "action must be 'accept' or 'reject'"}, status=400)

        with jobs_lock:
            job = jobs.get(job_id)
            if not job or job["kind"] != "refresh":
                return self._send_json({"error": "unknown refresh job"}, status=404)
            if not job["done"]:
                return self._send_json({"error": "job still running"}, status=409)
            if job["decision"] is not None:
                return self._send_json({"error": f"already {job['decision']}"}, status=409)
            backup_path = job["backup"]

        if action == "reject":
            if not backup_path or not backup_path.is_file():
                return self._send_json({"error": "backup no longer available"}, status=500)
            shutil.copy2(backup_path, DATA_DB)

        # Either way the backup has done its job -- accepted means we're
        # keeping the new state, rejected means we've already restored it.
        if backup_path and backup_path.is_file():
            backup_path.unlink()

        with jobs_lock:
            jobs[job_id]["decision"] = "accepted" if action == "accept" else "rejected"
        self._send_json({"decision": jobs[job_id]["decision"]})

    # -- Artist MBID resolution / merge -----------------------------------
    # Unlike /run and /build above, these are fast synchronous DB
    # operations on data/music.sqlite -- no job/log/poll machinery needed.
    # Each mutating handler opens its own connection (sqlite3.Connection
    # isn't safe to share across ThreadingHTTPServer's request threads)
    # and wraps writes in an explicit transaction; common.connect() already
    # turns PRAGMA foreign_keys = ON, so a merge that forgets to move a FK
    # reference off the absorbed row before deleting it fails loudly
    # instead of leaving orphaned rows.

    def _handle_missing_mbid(self, query):
        try:
            min_count = int((query.get("minCount") or ["5"])[0])
        except ValueError:
            return self._send_json({"error": "minCount must be an integer"}, status=400)

        conn = db_connect()
        try:
            rows = conn.execute(
                """
                SELECT ar.id, ar.name, count(ar.id) AS cnt
                FROM scrobbles s2
                JOIN songs s ON s.id = s2.song_id
                JOIN artists ar ON ar.id = s.artist_id
                WHERE ar.mbid IS NULL
                GROUP BY ar.id, ar.name
                HAVING cnt >= ?
                ORDER BY cnt DESC
                LIMIT 500
                """,
                (min_count,),
            ).fetchall()
            total_missing = conn.execute("SELECT count(*) FROM artists WHERE mbid IS NULL").fetchone()[0]
        finally:
            conn.close()

        self._send_json({
            "minCount": min_count,
            "totalMissing": total_missing,
            "queueCount": len(rows),
            "rows": [{"artistId": r[0], "name": r[1], "scrobbleCount": r[2]} for r in rows],
        })

    def _handle_mb_search(self, query):
        q = (query.get("q") or [""])[0].strip()
        if not q:
            return self._send_json({"error": "q is required"}, status=400)
        try:
            limit = int((query.get("limit") or ["10"])[0])
        except ValueError:
            limit = 10

        try:
            candidates = search_artists(q, limit=limit)
        except requests.RequestException as exc:
            return self._send_json({"error": f"MusicBrainz request failed: {exc}"}, status=502)
        self._send_json({"candidates": candidates})

    def _handle_local_search(self, query):
        q = (query.get("q") or [""])[0].strip()
        if not q:
            return self._send_json({"results": []})
        exclude_id = (query.get("excludeId") or [None])[0]
        try:
            limit = int((query.get("limit") or ["10"])[0])
        except ValueError:
            limit = 10

        conn = db_connect()
        try:
            rows = conn.execute("SELECT id, name FROM artists").fetchall()
        finally:
            conn.close()

        choices = {r[0]: r[1] for r in rows if exclude_id is None or str(r[0]) != str(exclude_id)}
        matches = process.extract(q, choices, scorer=fuzz.WRatio, limit=limit, score_cutoff=55)
        self._send_json({
            "results": [
                {"artistId": artist_id, "name": name, "score": round(score, 1)}
                for name, score, artist_id in matches
            ]
        })

    def _handle_artist_detail(self, query):
        try:
            artist_id = int((query.get("id") or [""])[0])
        except ValueError:
            return self._send_json({"error": "id is required"}, status=400)

        conn = db_connect()
        try:
            row = conn.execute("SELECT id, name, mbid FROM artists WHERE id = ?", (artist_id,)).fetchone()
            if not row:
                return self._send_json({"error": "artist not found"}, status=404)
            scrobble_count = conn.execute(
                "SELECT count(*) FROM scrobbles WHERE artist_id = ?", (artist_id,)
            ).fetchone()[0]
        finally:
            conn.close()

        self._send_json({"artistId": row[0], "name": row[1], "mbid": row[2], "scrobbleCount": scrobble_count})

    def _handle_top_songs(self, query):
        try:
            artist_id = int((query.get("id") or [""])[0])
        except ValueError:
            return self._send_json({"error": "id is required"}, status=400)
        try:
            limit = int((query.get("limit") or ["5"])[0])
        except ValueError:
            limit = 5

        conn = db_connect()
        try:
            rows = conn.execute(
                """
                SELECT s.id, s.title, count(*) AS cnt
                FROM scrobbles sc
                JOIN songs s ON s.id = sc.song_id
                WHERE sc.artist_id = ?
                GROUP BY s.id, s.title
                ORDER BY cnt DESC
                LIMIT ?
                """,
                (artist_id, limit),
            ).fetchall()
        finally:
            conn.close()

        self._send_json({
            "artistId": artist_id,
            "songs": [{"songId": r[0], "title": r[1], "scrobbleCount": r[2]} for r in rows],
        })

    def _handle_assign_mbid(self):
        body = self._read_json_body()
        artist_id = body.get("artistId")
        mbid = (body.get("mbid") or "").strip()
        if not artist_id or not mbid:
            return self._send_json({"error": "artistId and mbid are required"}, status=400)
        if not MBID_RE.match(mbid):
            return self._send_json({"error": "mbid doesn't look like a MusicBrainz id (expected a UUID)"}, status=400)

        conn = db_connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conflict = conn.execute(
                "SELECT id, name, mbid FROM artists WHERE mbid = ? AND id != ?", (mbid, artist_id)
            ).fetchone()
            if conflict:
                conn.rollback()
                return self._send_json({
                    "error": "mbid_conflict",
                    "message": f"That MusicBrainz id is already linked to \"{conflict[1]}\" in your library.",
                    "conflictingArtist": {"artistId": conflict[0], "name": conflict[1], "mbid": conflict[2]},
                }, status=409)

            row = conn.execute("SELECT id, name FROM artists WHERE id = ?", (artist_id,)).fetchone()
            if not row:
                conn.rollback()
                return self._send_json({"error": "artist not found"}, status=404)

            conn.execute("UPDATE artists SET mbid = ? WHERE id = ?", (mbid, artist_id))
            conn.commit()
            self._send_json({"artistId": row[0], "name": row[1], "mbid": mbid})
        except Exception as exc:
            conn.rollback()
            self._send_json({"error": str(exc)}, status=500)
        finally:
            conn.close()

    def _handle_merge_artists(self):
        body = self._read_json_body()
        absorbed_id = body.get("absorbedId")
        canonical_id = body.get("canonicalId")
        if not absorbed_id or not canonical_id:
            return self._send_json({"error": "absorbedId and canonicalId are required"}, status=400)
        if absorbed_id == canonical_id:
            return self._send_json({"error": "absorbedId and canonicalId must differ"}, status=400)

        conn = db_connect()
        try:
            absorbed = conn.execute("SELECT id, name, mbid FROM artists WHERE id = ?", (absorbed_id,)).fetchone()
            canonical = conn.execute("SELECT id, name FROM artists WHERE id = ?", (canonical_id,)).fetchone()
        finally:
            conn.close()
        if not absorbed or not canonical:
            return self._send_json({"error": "absorbedId and canonicalId must both be existing artists"}, status=404)

        # Safety copy before anything destructive -- this merge is the
        # already-reviewed action (the UI confirms before calling this),
        # so no separate accept/reject dance, just an undo-by-hand path.
        MERGE_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        backup_path = MERGE_BACKUP_DIR / f"{datetime.now():%Y%m%d-%H%M%S}-artist-{absorbed_id}-into-{canonical_id}.sqlite"
        shutil.copy2(DATA_DB, backup_path)

        conn = db_connect()
        rows_moved = {}
        try:
            conn.execute("BEGIN IMMEDIATE")

            # album_artists: PK is (album_id, artist_id) -- drop the
            # absorbed artist's credit wherever the canonical artist is
            # ALREADY credited on the same album (a blind UPDATE would
            # collide on that PK), then reassign what's left.
            rows_moved["album_artists_collisions_dropped"] = conn.execute(
                """
                DELETE FROM album_artists
                WHERE artist_id = ?
                  AND album_id IN (SELECT album_id FROM album_artists WHERE artist_id = ?)
                """,
                (absorbed_id, canonical_id),
            ).rowcount
            rows_moved["album_artists_reassigned"] = conn.execute(
                "UPDATE album_artists SET artist_id = ? WHERE artist_id = ?", (canonical_id, absorbed_id)
            ).rowcount

            for table in ("albums", "songs", "scrobbles", "setlists"):
                rows_moved[table] = conn.execute(
                    f"UPDATE {table} SET artist_id = ? WHERE artist_id = ?", (canonical_id, absorbed_id)
                ).rowcount

            rows_moved["notes"] = conn.execute(
                "UPDATE notes SET entity_id = ? WHERE entity_type = 'artist' AND entity_id = ?",
                (canonical_id, absorbed_id),
            ).rowcount

            # absorbed may itself have previously been a merge *target* --
            # repoint so an older override chain doesn't dangle on a
            # deleted id.
            rows_moved["alias_overrides_repointed"] = conn.execute(
                "UPDATE alias_overrides SET canonical_id = ? WHERE canonical_type = 'artist' AND canonical_id = ?",
                (canonical_id, absorbed_id),
            ).rowcount

            # Close the loop for future imports: one row per known source,
            # keyed on the absorbed artist's own raw name text, so
            # re-encountering that exact string resolves straight to
            # canonical instead of recreating the duplicate.
            absorbed_key = absorbed[1].strip().lower()
            note = f"merged from duplicate artist id {absorbed_id} on {datetime.now():%Y-%m-%d}"
            for source in ("lastfm", "setlistfm", "discogs"):
                conn.execute(
                    """
                    INSERT INTO alias_overrides (source, source_key, canonical_type, canonical_id, note)
                    VALUES (?, ?, 'artist', ?, ?)
                    ON CONFLICT (source, source_key, canonical_type) DO UPDATE SET canonical_id = excluded.canonical_id
                    """,
                    (source, absorbed_key, canonical_id, note),
                )

            conn.execute(
                """
                INSERT INTO merge_log (entity_type, absorbed_id, absorbed_name, absorbed_mbid,
                                        canonical_id, canonical_name, rows_moved_json)
                VALUES ('artist', ?, ?, ?, ?, ?, ?)
                """,
                (absorbed_id, absorbed[1], absorbed[2], canonical_id, canonical[1], json.dumps(rows_moved)),
            )

            conn.execute("DELETE FROM artists WHERE id = ?", (absorbed_id,))  # last -- every FK is moved off by now
            conn.commit()
        except Exception as exc:
            conn.rollback()
            return self._send_json({"error": str(exc), "backup": str(backup_path)}, status=500)
        finally:
            conn.close()

        self._send_json({
            "absorbedId": absorbed_id,
            "absorbedName": absorbed[1],
            "canonicalId": canonical_id,
            "canonicalName": canonical[1],
            "rowsMoved": rows_moved,
            "backup": str(backup_path),
        })


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Maintenance UI: http://localhost:{PORT}/")
    print("Local only -- do not expose this port. Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
