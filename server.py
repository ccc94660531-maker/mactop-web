#!/usr/bin/env python3
"""mactop-web — standalone dashboard around the mactop CLI.

Data path (kept identical to mactop itself):
  mactop --headless --format json  ->  this server  ->  SSE  ->  browser UI

The server forwards each raw mactop sample unchanged (same keys, same values);
it only adds a small transport envelope (event id / server timestamp).

Zero third-party dependencies: Python standard library only.
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler

# When frozen by PyInstaller, resources unpack under sys._MEIPASS and the
# bundle itself must stay read-only-friendly: private HOME goes to App Support.
FROZEN = getattr(sys, "frozen", False)
APP_DIR = sys._MEIPASS if FROZEN else os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
HOME_DIR = (os.path.join(os.path.expanduser("~"), "Library", "Application Support", "mactop-web")
            if FROZEN else os.path.join(APP_DIR, ".home"))  # private HOME so mactop's log/config never clashes

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}


def find_mactop(explicit: str | None) -> str:
    if explicit:
        if os.path.isfile(explicit) and os.access(explicit, os.X_OK):
            return explicit
        sys.exit(f"mactop executable not found at {explicit}")
    found = shutil.which("mactop")
    # bundle first (standalone .app ships its own mactop), then system installs
    for candidate in (os.path.join(APP_DIR, "mactop"), found,
                      "/opt/homebrew/bin/mactop", "/usr/local/bin/mactop"):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    sys.exit("mactop executable not found. Install it (brew install mactop) or pass --mactop <path>")


class Monitor:
    """Owns the mactop subprocess, keeps history, fans samples out to SSE clients."""

    def __init__(self, mactop_path: str, interval_ms: int, history: int) -> None:
        self.mactop_path = mactop_path
        self.interval_ms = interval_ms
        self.history: deque[dict] = deque(maxlen=history)
        self.subscribers: set[queue] = set()  # type: ignore[valid-type]
        self.lock = threading.Lock()
        self._procs: list[subprocess.Popen] = []
        self._stopping = False
        self.last_error: str | None = None
        self.started_at = time.time()
        self.samples_total = 0

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        t = threading.Thread(target=self._run_forever, daemon=True)
        t.start()

    def stop(self) -> None:
        self._stopping = True
        for p in self._procs:
            try:
                p.terminate()
            except OSError:
                pass

    def _run_forever(self) -> None:
        while not self._stopping:
            env = dict(os.environ, HOME=HOME_DIR)
            try:
                proc = subprocess.Popen(
                    [self.mactop_path, "--headless", "--format", "json",
                     "--interval", str(self.interval_ms)],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                    bufsize=1024 * 1024,
                )
                self._procs.append(proc)
                self.last_error = None
                self._pump(proc)
                proc.wait()
                if not self._stopping:
                    self.last_error = f"mactop exited ({proc.returncode}); restarting in 2s"
            except OSError as exc:
                self.last_error = f"failed to start mactop: {exc}"
            if not self._stopping:
                time.sleep(2.0 if self.last_error else 0)

    def _pump(self, proc: subprocess.Popen) -> None:
        """Read mactop's stdout. It flushes one top-level JSON array per interval;
        decode incrementally (utf-8 may split across reads) and publish each array."""
        stdout = proc.stdout
        assert stdout is not None
        fd = stdout.fileno()
        stdin_round = codecs.getincrementaldecoder("utf-8")(errors="replace")
        decoder = json.JSONDecoder()
        text = ""
        while not self._stopping:
            try:
                data = os.read(fd, 65536)  # returns as soon as anything is available
            except OSError:
                break
            if not data:
                break  # EOF
            text += stdin_round.decode(data)
            # drain every complete JSON document from the decoded text
            while True:
                s = text.lstrip(" \t\r\n")
                gap = len(text) - len(s)
                if not s:
                    text = ""
                    break
                try:
                    value, idx = decoder.raw_decode(s)
                except ValueError:
                    text = s
                    break  # incomplete document, wait for more bytes
                text = s[idx:]
                self._publish(value)
            # guard: text should not grow unboundedly if mactop stalls
            if len(text) > 4 * 1024 * 1024:
                text = text[-256:]

    def _publish(self, value) -> None:
        items = value if isinstance(value, list) else [value]
        samples = [it for it in items if isinstance(it, dict)]
        if not samples:
            return
        with self.lock:
            for s in samples:
                self.history.append(s)
            self.samples_total += len(samples)
            payload = json.dumps({"samples": samples,
                                  "server_ts": round(time.time() * 1000)}).encode()
            subs = list(self.subscribers)
        for q in subs:
            q.put_nowait(payload)

    def snapshot(self, limit: int | None = None) -> dict:
        with self.lock:
            data = list(self.history)
        if limit is not None and limit > 0:
            data = data[-limit:]
        return {
            "samples": data,
            "interval_ms": self.interval_ms,
            "server_ts": round(time.time() * 1000),
        }

    def subscribe(self, q) -> None:  # type: ignore[valid-type]
        with self.lock:
            self.subscribers.add(q)

    def unsubscribe(self, q) -> None:  # type: ignore[valid-type]
        with self.lock:
            self.subscribers.discard(q)


class Handler(BaseHTTPRequestHandler):
    monitor: Monitor = None  # injected below
    server_version = "mactop-web/1.0"

    # ------------------------------------------------------------ helpers
    def _send(self, code: int, ctype: str, body: bytes, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, rel: str) -> None:
        path = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            self._send(404, "text/plain; charset=utf-8", b"404")
            return
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as fh:
            self._send(200, MIME.get(ext, "application/octet-stream"), fh.read())

    # ------------------------------------------------------------ routing
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self._send_file("index.html")
        elif path in ("/style.css", "/app.js", "/favicon.svg"):
            self._send_file(path.lstrip("/"))
        elif path == "/api/stream":
            self._sse()
        elif path == "/api/snapshot":
            self._send(200, "application/json; charset=utf-8",
                      json.dumps(self.monitor.snapshot()).encode())
        elif path == "/api/status":
            with self.monitor.lock:
                body = {
                    "up": True,
                    "mactop": self.monitor.mactop_path,
                    "interval_ms": self.monitor.interval_ms,
                    "samples_total": self.monitor.samples_total,
                    "subscribers": len(self.monitor.subscribers),
                    "uptime_s": round(time.time() - self.monitor.started_at),
                    "error": self.monitor.last_error,
                }
            self._send(200, "application/json; charset=utf-8", json.dumps(body).encode())
        else:
            self._send(404, "text/plain; charset=utf-8", b"404")

    def _sse(self) -> None:
        import queue as _queue
        q: _queue.Queue = _queue.Queue(maxsize=256)
        self.monitor.subscribe(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            # prime: latest window only (charts show last 48 points) so first paint is light
            snap = self.monitor.snapshot(limit=48)
            if snap["samples"]:
                self.wfile.write(b"event: snapshot\ndata: " + json.dumps(snap).encode() + b"\n\n")
            last_beat = time.time()
            while True:
                try:
                    payload = q.get(timeout=3.0)
                    if payload:
                        self.wfile.write(b"data: " + payload + b"\n\n")
                except _queue.Empty:
                    pass
                if time.time() - last_beat > 5.0:
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        last_beat = time.time()
                    except OSError:
                        break
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.monitor.unsubscribe(q)

    def log_message(self, fmt, *args) -> None:  # quieter logs
        if self.path.startswith("/api/stream"):
            return
        super().log_message(fmt, *args)


class ThreadedHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    ap = argparse.ArgumentParser(description="mactop-web: standalone web dashboard for mactop")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--interval", type=int, default=1000, help="mactop refresh interval (ms)")
    ap.add_argument("--history", type=int, default=300, help="samples kept in server-side history")
    ap.add_argument("--mactop", default=None, help="path to mactop executable")
    ap.add_argument("--no-browser", action="store_true",
                    help="do not open the dashboard in a browser on start")
    args = ap.parse_args()

    os.makedirs(HOME_DIR, exist_ok=True)
    monitor = Monitor(find_mactop(args.mactop), max(250, args.interval), args.history)
    Handler.monitor = monitor

    url = f"http://{args.host}:{args.port}"
    httpd = ThreadedHTTPServer((args.host, args.port), Handler)
    monitor.start()
    print(f"mactop-web → {url}  (interval {monitor.interval_ms}ms)", flush=True)

    if FROZEN:
        # App bundle: serve on a daemon thread, show a dedicated native window
        # (WKWebView). Closing the window quits the whole app.
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            if args.no_browser:
                threading.Event().wait()  # headless service: SIGTERM to stop
            else:
                # wait until the listener is accepting so the window never 404s
                for _ in range(50):
                    try:
                        with socket.create_connection((args.host, args.port), 0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                import webview
                webview.create_window("Mac 状态监控中心", url,
                                      width=1512, height=950, min_size=(1024, 720))
                webview.start()  # blocks until the window is closed
        finally:
            monitor.stop()
            httpd.shutdown()
    else:
        def _shutdown(signum, frame):  # noqa: ARG001
            monitor.stop()
            threading.Timer(1.0, httpd.shutdown).start()

        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)
        if not args.no_browser:
            # socket is already listening; hand the URL to the default browser
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        finally:
            monitor.stop()
            httpd.server_close()


if __name__ == "__main__":
    main()
