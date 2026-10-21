#!/usr/bin/env python3
"""Local preview server for the built site.

Uses a threading HTTP server so several browser tabs can be open at once:
the stdlib single-threaded server blocks a second page behind the first
page's keep-alive connection.

    python scripts/serve.py --port 8765
"""
from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "_site"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Always serve the freshest build during local preview.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):  # keep the console quiet
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the built site locally")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    if not ROOT.is_dir():
        raise SystemExit(f"{ROOT} not found; run python scripts/build.py first")
    handler = functools.partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {ROOT} at http://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
