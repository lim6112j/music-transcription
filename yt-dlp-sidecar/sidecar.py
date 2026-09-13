#!/usr/bin/env python3
"""yt-dlp sidecar speaking cobalt's API shape.

POST / {url: <youtube url>} -> {status: 'tunnel', url, filename}
GET  /tunnel?id=...          -> audio bytes (mp3), file deleted after serving

The StaffScribe app treats this exactly like a cobalt instance.
"""
import http.server
import json
import secrets
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from pathlib import Path

PORT = 4940
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != "/":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            body = {}
        url = str(body.get("url", ""))
        try:
            parsed = urllib.parse.urlparse(url)
            is_yt = parsed.hostname in YOUTUBE_HOSTS
        except ValueError:
            is_yt = False
        if not is_yt:
            self._json(400, {"status": "error", "error": {"code": "error.api.youtube.no_url"}})
            return

        job_id = secrets.token_urlsafe(8)
        out = Path(tempfile.gettempdir()) / f"ytdl-{secrets.token_hex(8)}.mp3"
        try:
            subprocess.run(
                ["yt-dlp", "-x", "--audio-format", "mp3", "--audio-quality", "128",
                 "--no-playlist", "--no-warnings", "-o", str(out.with_suffix(".%(ext)s")), url],
                check=True, capture_output=True, timeout=300,
            )
        except subprocess.CalledProcessError as e:
            err = e.stderr.decode(errors="replace")[-300:]
            print(f"yt-dlp failed: {err}", file=sys.stderr)
            self._json(400, {"status": "error", "error": {"code": "error.api.youtube.download_failed"}})
            return
        if not out.exists() or out.stat().st_size == 0:
            self._json(400, {"status": "error", "error": {"code": "error.api.youtube.download_failed"}})
            return
        job = secrets.token_hex(8)
        JOBS[job] = {"path": out, "filename": f"youtube-{job}.mp3"}
        self._json(200, {"status": "tunnel", "url": f"http://localhost:{PORT}/tunnel?id={job}", "filename": JOBS[job]["filename"]})

    def do_GET(self):
        q = urllib.parse.urlparse(self.path)
        if q.path != "/tunnel":
            self._json(404, {"status": "error", "error": {"code": "not_found"}})
            return
        job = urllib.parse.parse_qs(q.query).get("id", [""])[0]
        info = JOBS.pop(job, None)
        if not info or not info["path"].exists():
            self.send_response(404)
            self.end_headers()
            return
        data = info["path"].read_bytes()
        info["path"].unlink(missing_ok=True)
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"yt-dlp sidecar on :{PORT}", flush=True)
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
