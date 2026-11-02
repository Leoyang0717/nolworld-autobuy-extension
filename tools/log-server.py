#!/usr/bin/env python3
"""Receive log batches from the extension and append them to logs/YYYY-MM-DD.jsonl.

Usage: python3 tools/log-server.py [port]   (default 8793, must match background.js)
"""
import json
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8793
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != "/log":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            entries = json.loads(self.rfile.read(length) or b"[]")
            if isinstance(entries, dict):
                entries = [entries]
        except (ValueError, json.JSONDecodeError):
            self.send_response(400)
            self.end_headers()
            return

        LOG_DIR.mkdir(exist_ok=True)
        path = LOG_DIR / f"{datetime.now():%Y-%m-%d}.jsonl"
        with path.open("a", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, *args):
        pass  # keep the terminal quiet; one line per batch would be noise


if __name__ == "__main__":
    print(f"Logging to {LOG_DIR}/ on http://127.0.0.1:{PORT}/log (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
