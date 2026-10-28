#!/usr/bin/env python3
"""Build a Pages-ready folder. No node build, no Jekyll, no runtime server."""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUTPUT = ROOT / "_site"


def build():
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    shutil.copytree(SITE, OUTPUT)
    data_dir = OUTPUT / "data"
    data_dir.mkdir(exist_ok=True)
    for filename in ["latest.json", "history.json"]:
        src = ROOT / "data" / filename
        if not src.is_file():
            raise FileNotFoundError(f"{src} missing: run python scripts/collect.py first")
        shutil.copy2(src, data_dir / filename)
    # Academic profile, social and GitHub files are optional: the site
    # degrades gracefully when any of them is absent.
    for filename in ["scholar.json", "scholar_history.json", "social.json", "social_history.json",
                     "github.json", "github_history.json", "templates.json", "templates_history.json",
                     "modelscope.json", "modelscope_history.json"]:
        src = ROOT / "data" / filename
        if src.is_file():
            shutil.copy2(src, data_dir / filename)
    (OUTPUT / ".nojekyll").write_text("", encoding="utf-8")
    print(f"Built {OUTPUT}")


if __name__ == "__main__":
    build()
