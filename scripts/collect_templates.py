#!/usr/bin/env python3
"""Index the local skill and prompt library as daily UTC snapshots.

The library itself is plain Markdown under ``templates/``:

* ``templates/skills/<slug>.md``   - a reusable skill definition
* ``templates/prompts/<slug>.md``  - a reusable prompt template

Each file starts with a small YAML-ish frontmatter block (``---`` fenced) that
carries the metadata the dashboard renders: name, description, tags, version
and an optional category. The body is stored verbatim so the site can show and
copy the full text without another round trip.

Two artefacts are produced:

* ``data/templates.json``        - the current index with full bodies
* ``data/templates_history.json`` - one small snapshot per UTC day so the board
  can chart how the library grows

The collector only reads the working tree, so it never fails because of the
network. When ``templates/`` is missing entirely the run is reported as
unavailable and the previous snapshot is preserved.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

try:  # executed as a script (python scripts/collect_templates.py)
    from collect import atomic_json_write
except ImportError:  # imported as a module (from scripts.collect_templates import ...)
    from scripts.collect import atomic_json_write

SCHEMA_VERSION = 1
ROOT = Path(__file__).resolve().parent.parent

# A daily snapshot only stores counts and identities, so the series stays tiny.
# A cap keeps history.json bounded for repositories that run for years.
HISTORY_RETENTION_DAYS = 1100

# Prompt bodies are markdown and occasionally embed a long reference document.
# Anything past this is truncated in the published payload but still counted in
# the byte total, so the dashboard can flag that a body was shortened.
MAX_BODY_CHARS = 20000

# A slug has to survive being a GitHub path segment, so it stays deliberately
# narrow: lowercase letters, digits and single separators.
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:[-_][a-z0-9]+)*$")

KIND_DIRECTORIES = {"skill": "skills", "prompt": "prompts"}


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split a leading ``---`` block into a metadata dict plus the body.

    A tiny subset of YAML is supported on purpose: ``key: value`` pairs, inline
    ``[a, b]`` lists and ``- item`` blocks. Anything more exotic would need a
    YAML dependency for no benefit here.
    """
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    if lines[0].strip() != "---":
        return {}, text
    try:
        end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
    except StopIteration:
        # An unterminated block is treated as body: better a visible oddity in
        # the body than silently dropping every field.
        return {}, text

    metadata: dict[str, Any] = {}
    pending_key: str | None = None
    for line in lines[1:end]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") and pending_key:
            metadata.setdefault(pending_key, [])
            if isinstance(metadata[pending_key], list):
                metadata[pending_key].append(_clean_value(stripped[2:]))
            continue
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip().lower()
        if not key:
            continue
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            metadata[key] = [_clean_value(part) for part in inner.split(",") if part.strip()] if inner else []
            pending_key = None
        elif not value:
            # Either an empty scalar or the header of a ``- item`` block; the
            # next lines decide which.
            metadata[key] = []
            pending_key = key
        else:
            metadata[key] = _clean_value(value)
            pending_key = None

    body = "\n".join(lines[end + 1:]).lstrip("\n")
    return metadata, body


def _clean_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value.strip()


def normalise_tags(raw: Any) -> list[str]:
    """Accept a list, a comma-separated string, or nothing at all."""
    if raw is None:
        return []
    if isinstance(raw, list):
        candidates = raw
    else:
        candidates = str(raw).replace("、", ",").split(",")
    tags: list[str] = []
    for item in candidates:
        tag = _clean_value(str(item))
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def build_entry(kind: str, slug: str, text: str, library_repo: str, branch: str) -> dict:
    """Turn one Markdown file into a published entry."""
    metadata, body = parse_frontmatter(text)
    name = _clean_value(str(metadata.get("name") or "")) or slug
    truncated = len(body) > MAX_BODY_CHARS
    relative = f"templates/{KIND_DIRECTORIES[kind]}/{slug}.md"
    return {
        "id": f"{kind}/{slug}",
        "kind": kind,
        "slug": slug,
        "name": name,
        "description": _clean_value(str(metadata.get("description") or "")),
        "category": _clean_value(str(metadata.get("category") or "")),
        "tags": normalise_tags(metadata.get("tags")),
        "version": _clean_value(str(metadata.get("version") or "")),
        "author": _clean_value(str(metadata.get("author") or "")),
        "bytes": len(body.encode("utf-8")),
        "lines": len(body.splitlines()),
        "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "truncated": truncated,
        # The Markdown source is the single source of truth; the site links
        # back to it so a template can be edited where it actually lives.
        "url": f"https://github.com/{library_repo}/blob/{branch}/{relative}",
        "body": body[:MAX_BODY_CHARS],
    }


def load_library(directory: Path, library_repo: str, branch: str) -> list[dict]:
    """Read every template file. Unreadable files are skipped, not fatal."""
    entries: list[dict] = []
    for kind, folder in KIND_DIRECTORIES.items():
        folder_path = directory / folder
        if not folder_path.is_dir():
            continue
        for path in sorted(folder_path.glob("*.md")):
            slug = path.stem.lower()
            if not SLUG_PATTERN.match(slug):
                print(f"skip {path}: 文件名需为小写字母/数字/连字符", file=sys.stderr)
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except OSError as error:
                print(f"skip {path}: {error}", file=sys.stderr)
                continue
            entries.append(build_entry(kind, slug, text, library_repo, branch))
    # Newest metadata first is decided by name; the site re-sorts as needed.
    entries.sort(key=lambda entry: (entry["kind"], entry["slug"]))
    return entries


def summarise(entries: list[dict]) -> dict:
    tags: dict[str, int] = {}
    categories: dict[str, int] = {}
    for entry in entries:
        for tag in entry["tags"]:
            tags[tag] = tags.get(tag, 0) + 1
        if entry["category"]:
            categories[entry["category"]] = categories.get(entry["category"], 0) + 1
    return {
        "total": len(entries),
        "skills": sum(1 for entry in entries if entry["kind"] == "skill"),
        "prompts": sum(1 for entry in entries if entry["kind"] == "prompt"),
        "bytes": sum(entry["bytes"] for entry in entries),
        "tags": [{"tag": tag, "count": count} for tag, count in
                 sorted(tags.items(), key=lambda item: (-item[1], item[0]))],
        "categories": [{"category": name, "count": count} for name, count in
                       sorted(categories.items(), key=lambda item: (-item[1], item[0]))],
    }


def load_previous(path: Path) -> dict:
    """Previous snapshot, so a broken run keeps the library visible."""
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def update_history(history: dict, entries: list[dict], captured_at: dt.datetime,
                   retention_days: int = HISTORY_RETENTION_DAYS) -> dict:
    day = captured_at.date().isoformat()
    snapshots = [snap for snap in (history.get("snapshots") or []) if isinstance(snap, dict) and snap.get("date")]
    snapshots = [snap for snap in snapshots if snap["date"] != day]
    snapshots.append({
        "date": day,
        "total": len(entries),
        "skills": sum(1 for entry in entries if entry["kind"] == "skill"),
        "prompts": sum(1 for entry in entries if entry["kind"] == "prompt"),
        "ids": [entry["id"] for entry in entries],
    })
    snapshots.sort(key=lambda snap: snap["date"])
    if retention_days and len(snapshots) > retention_days:
        snapshots = snapshots[-retention_days:]
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "snapshots": snapshots,
    }


def save(data_dir: Path, entries: list[dict], captured_at: dt.datetime,
         library_repo: str, branch: str, error: str = "") -> None:
    latest = {
        "schema_version": SCHEMA_VERSION,
        "status": "unavailable" if error else "ok",
        "error": error,
        "captured_at": captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "library": {"repo": library_repo, "branch": branch},
        "summary": summarise(entries),
        "templates": entries,
    }
    atomic_json_write(data_dir / "templates.json", latest)

    history_path = data_dir / "templates_history.json"
    atomic_json_write(history_path,
                       update_history(load_previous(history_path), entries, captured_at))


def cleanup_partials(data_dir: Path) -> None:
    """Remove leftover temp files from an interrupted run."""
    for path in data_dir.glob(".partial-*.json"):
        try:
            path.unlink()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Index the local skill and prompt library")
    parser.add_argument("--templates-dir", type=Path, default=ROOT / "templates",
                        help="Library root holding skills/ and prompts/")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--repo", default="isLinXu/model-observatory",
                        help="owner/name used to build the source links")
    parser.add_argument("--branch", default="main")
    args = parser.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)
    cleanup_partials(args.data_dir)
    captured_at = dt.datetime.now(dt.timezone.utc)

    if not args.templates_dir.is_dir():
        # Nothing to index yet. Keep the previous snapshot so the board does not
        # blank out, and say why in the payload.
        previous = load_previous(args.data_dir / "templates.json")
        message = f"模版目录不存在：{args.templates_dir}"
        if previous.get("templates"):
            save(args.data_dir, previous["templates"], captured_at, args.repo, args.branch, error=message[:300])
        else:
            save(args.data_dir, [], captured_at, args.repo, args.branch, error=message[:300])
        print(message, file=sys.stderr)
        return

    entries = load_library(args.templates_dir, args.repo, args.branch)
    save(args.data_dir, entries, captured_at, args.repo, args.branch)
    print(f"indexed {len(entries)} templates from {args.templates_dir}")


if __name__ == "__main__":
    main()