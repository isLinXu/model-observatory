#!/usr/bin/env python3
"""Build a Pages-ready folder. No node build, no Jekyll, no runtime server."""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUTPUT = ROOT / "_site"

# The two files every board needs, and the panel payloads that may be absent.
# test_wiring.py fails when a script fetches a data file that is not listed
# here, because that request is a 404 on the deployed page rather than an error
# at build time.
CORE_DATA = ("latest.json", "history.json")
OPTIONAL_DATA = ("scholar.json", "scholar_history.json", "social.json", "social_history.json",
                 "github.json", "github_history.json", "templates.json", "templates_history.json",
                 "modelscope.json", "modelscope_history.json", "conferences.json",
                 "stars.json", "stars_repos.json", "stars_history.json",
                 "entities.json", "entities_history.json",
                 "tasks.json", "tasks_history.json",
                 "awesome.json", "awesome_history.json", "runs.json")
SHIPPED_DATA = CORE_DATA + OPTIONAL_DATA


def build():
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    shutil.copytree(SITE, OUTPUT)
    data_dir = OUTPUT / "data"
    data_dir.mkdir(exist_ok=True)
    for filename in CORE_DATA:
        src = ROOT / "data" / filename
        if not src.is_file():
            raise FileNotFoundError(f"{src} missing: run python scripts/collect.py first")
        shutil.copy2(src, data_dir / filename)
    # Secondary panels (academic, social, GitHub, templates, ModelScope,
    # conferences, stars, entity registry, task board, list tracking) are
    # optional: the site degrades gracefully when any of them is absent.
    # data/awesome_ledger.json is deliberately not copied: the collector reads
    # it back from the repository the next day, and no browser ever asks for it.
    for filename in OPTIONAL_DATA:
        src = ROOT / "data" / filename
        if src.is_file():
            shutil.copy2(src, data_dir / filename)
    (OUTPUT / ".nojekyll").write_text("", encoding="utf-8")
    print(f"Built {OUTPUT}")


if __name__ == "__main__":
    build()
