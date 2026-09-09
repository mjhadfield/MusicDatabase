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
import shutil
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PAGE_PATH = Path(__file__).resolve().parent / "index.html"
DATA_DB = ROOT / "data" / "music.sqlite"
BACKUP_DIR = ROOT / "data" / ".refresh_backups"
PORT = 8643

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
        if self.path == "/":
            self._send_file(PAGE_PATH, "text/html; charset=utf-8")
        elif self.path == "/imports":
            imports_dir = ROOT / "imports"
            csvs = sorted(p.name for p in imports_dir.glob("*.csv")) if imports_dir.exists() else []
            self._send_json({"files": csvs})
        elif self.path.startswith("/status/"):
            job_id, _, query = self.path.split("/status/", 1)[1].partition("?")
            since = int(dict(p.split("=") for p in query.split("&") if "=" in p).get("since", "0")) if query else 0
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
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/run":
            return self._handle_run()
        if self.path == "/build":
            return self._handle_build()
        if self.path.startswith("/decision/"):
            return self._handle_decision(self.path.split("/decision/", 1)[1])
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
