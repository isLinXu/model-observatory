#!/usr/bin/env python3
"""Record public Hugging Face statistics as append-only daily UTC snapshots.

Covers both model and dataset repositories of one author. The Hub 'downloads'
count is rolling 30-day usage; 'downloadsAllTime' is reported lifetime usage.
Historical changes can be negative when HF revises its counter. Preserve this
signal instead of silently clamping to zero.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 3
LEGACY_SCHEMA_VERSIONS = (1, 2)

# Snapshot retention. The daily series is what the trend charts read, so it is
# kept at full resolution for a year; older snapshots are downsampled to one
# point per ISO week, which keeps multi-year trends meaningful while stopping
# the history file from growing without bound.
DAILY_RETENTION_DAYS = 400
WEEKLY_RETENTION_COUNT = 104  # roughly two years of weekly points

# Canonical landing page for a public model / dataset repository.
HF_MODEL_URL = "https://huggingface.co/{repo_id}"
HF_DATASET_URL = "https://huggingface.co/datasets/{repo_id}"
HF_COLLECTIONS_API = "https://huggingface.co/api/collections"
COLLECTION_REQUEST_TIMEOUT = 15
COLLECTION_FETCH_TIMEOUT = 120
COLLECTION_RESPONSE_LIMIT = 8 * 1024 * 1024


def entity_url(template: str, repo_id: str) -> str:
    """Build the canonical public URL of a repository.

    Every entity carries a `url` field so the dashboard can offer a one-click
    link. The field is optional in the schema: when a source cannot supply a
    link the value is None and the site renders plain text instead of a
    broken anchor.
    """
    if not repo_id:
        return None
    return template.format(repo_id=urllib.parse.quote(repo_id, safe="/"))


def number_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = int(value)
        return number if number >= 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def tag_values(tags: Any, prefix: str, limit: int | None = None) -> list[str]:
    """Collect unique 'prefix:value' tags, optionally capped."""
    values: list[str] = []
    for tag in tags or []:
        if not isinstance(tag, str) or not tag.startswith(prefix):
            continue
        value = tag[len(prefix):].strip()
        if value and value not in values:
            values.append(value)
        if limit and len(values) >= limit:
            break
    return values


def api_to_models(infos: Any, author: str) -> list[dict]:
    """Convert ModelInfo instances into sorted public-model records."""
    items = []
    ids = set()
    for info in infos:
        model_id = getattr(info, "id", None)
        if not isinstance(model_id, str) or not model_id.startswith(f"{author}/"):
            continue
        if getattr(info, "private", False):
            continue
        if model_id in ids:
            continue
        ids.add(model_id)
        created = getattr(info, "created_at", None)
        if isinstance(created, dt.datetime):
            created = created.isoformat()
        elif not isinstance(created, str):
            created = None
        items.append({
            "id": model_id,
            "url": entity_url(HF_MODEL_URL, model_id),
            "all_time": number_or_none(getattr(info, "downloads_all_time", None)),
            "last_30d": number_or_none(getattr(info, "downloads", None)),
            "likes": number_or_none(getattr(info, "likes", None)),
            "pipeline": getattr(info, "pipeline_tag", None) or "other",
            "created_at": created,
        })
    return sorted(items, key=lambda x: x["id"].lower())


def api_to_datasets(infos: Any, author: str) -> list[dict]:
    """Convert DatasetInfo instances into sorted public-dataset records."""
    items = []
    ids = set()
    for info in infos:
        dataset_id = getattr(info, "id", None)
        if not isinstance(dataset_id, str) or not dataset_id.startswith(f"{author}/"):
            continue
        if getattr(info, "private", False):
            continue
        if dataset_id in ids:
            continue
        ids.add(dataset_id)
        created = getattr(info, "created_at", None)
        if isinstance(created, dt.datetime):
            created = created.isoformat()
        elif not isinstance(created, str):
            created = None
        items.append({
            "id": dataset_id,
            "url": entity_url(HF_DATASET_URL, dataset_id),
            "all_time": number_or_none(getattr(info, "downloads_all_time", None)),
            "last_30d": number_or_none(getattr(info, "downloads", None)),
            "likes": number_or_none(getattr(info, "likes", None)),
            "modality": tag_values(getattr(info, "tags", None), "modality:"),
            "languages": tag_values(getattr(info, "tags", None), "language:", limit=6),
            "created_at": created,
        })
    return sorted(items, key=lambda x: x["id"].lower())


def fetch_models(author: str, retries: int = 3) -> list[dict]:
    from huggingface_hub import HfApi

    # Never authenticate: the published GitHub Pages site is public, so only
    # gather models visible without a token, including when HF_TOKEN is set.
    client = HfApi(token=False)
    for attempt in range(retries):
        try:
            infos = client.list_models(
                author=author,
                expand=["downloads", "downloadsAllTime", "likes", "pipeline_tag", "createdAt", "private"],
                token=False,
            )
            models = api_to_models(infos, author)
            if not models:
                raise RuntimeError(f"HF API returned zero public models for {author}; refusing to overwrite snapshots")
            return models
        except Exception as error:
            if attempt == retries - 1:
                raise RuntimeError(f"Unable to collect HF model metadata after {retries} attempts: {error}") from error
            print(f"Hugging Face request failed (attempt {attempt + 1}/{retries}): {error}", file=sys.stderr)
            time.sleep(min(2 ** attempt * 4, 15))
    raise AssertionError("unreachable")


def fetch_datasets(author: str, retries: int = 3) -> list[dict]:
    """Collect public datasets. An account may legitimately own none."""
    from huggingface_hub import HfApi

    client = HfApi(token=False)
    for attempt in range(retries):
        try:
            infos = client.list_datasets(
                author=author,
                expand=["downloads", "downloadsAllTime", "likes", "createdAt", "private", "tags"],
                token=False,
            )
            return api_to_datasets(infos, author)
        except Exception as error:
            if attempt == retries - 1:
                raise RuntimeError(f"Unable to collect HF dataset metadata after {retries} attempts: {error}") from error
            print(f"Hugging Face dataset request failed (attempt {attempt + 1}/{retries}): {error}", file=sys.stderr)
            time.sleep(min(2 ** attempt * 4, 15))
    raise AssertionError("unreachable")


class _NoCollectionRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not let a public API request silently leave its validated endpoint.
        raise ValueError("HF collections API unexpectedly redirected")


def _collection_json(opener: Any, url: str, deadline: float) -> tuple[Any, str]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("HF collections fetch exceeded its time budget")
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with opener.open(request, timeout=min(COLLECTION_REQUEST_TIMEOUT, remaining)) as response:
        if response.status != 200:
            raise ValueError("HF collections API returned an unexpected status")
        # Read in bounded chunks, checking the overall budget even for a server
        # that keeps trickling data without reaching the socket timeout.
        body = bytearray()
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("HF collections fetch exceeded its time budget")
            chunk = response.read1(min(65536, COLLECTION_RESPONSE_LIMIT + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > COLLECTION_RESPONSE_LIMIT:
                raise ValueError("HF collections API response is too large")
        return json.loads(body), ", ".join(response.headers.get_all("Link", []))


def _collection_slug(value: Any) -> str:
    if (not isinstance(value, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9._-]*", value)
            or ".." in value):
        raise ValueError("HF collection has an unsafe or missing slug")
    return value


def _collection_identity(value: Any, author: str, expected_slug: str | None = None) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("private"), bool):
        raise ValueError("HF collection has missing or invalid public/private metadata")
    slug = _collection_slug(value.get("slug"))
    owner = value.get("owner")
    if (not isinstance(owner, dict) or owner.get("name") != author
            or slug.split("/", 1)[0] != author
            or (expected_slug is not None and slug != expected_slug)):
        raise ValueError("HF collection owner or slug does not match the request")
    return slug


def _collection_page_url(url: str, author: str) -> str:
    if any(ord(char) <= 32 or ord(char) == 127 for char in url):
        raise ValueError("Unsafe HF collection pagination URL")
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if (parsed.scheme != "https" or parsed.netloc != "huggingface.co"
            or parsed.path != "/api/collections" or parsed.fragment
            or [value for key, value in query if key == "owner"] != [author]):
        raise ValueError("Unsafe HF collection pagination URL")
    # Canonical query order also detects loops whose URLs only reorder fields.
    return HF_COLLECTIONS_API + "?" + urllib.parse.urlencode(sorted(query))


def _collection_next_page(link: str, current_url: str, author: str) -> str | None:
    next_url = None
    for part in re.split(r",\s*(?=<)", link) if link else []:
        match = re.fullmatch(r"\s*<([^<>\s]+)>(.*)", part)
        if not match:
            raise ValueError("Malformed HF collection pagination Link header")
        relations = re.findall(r'(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))\s*(?=;|$)',
                               match[2], flags=re.IGNORECASE)
        if any("next" in (quoted or unquoted).lower().split() for quoted, unquoted in relations):
            if next_url is not None:
                raise ValueError("Ambiguous HF collection pagination Link header")
            next_url = _collection_page_url(urllib.parse.urljoin(current_url, match[1]), author)
    return next_url


def _normalize_collection(detail: dict, slug: str) -> dict:
    title = detail.get("title")
    description = detail.get("description")
    updated_at = detail.get("lastUpdated")
    if (not isinstance(title, str)
            or (description is not None and not isinstance(description, str))
            or (updated_at is not None and not isinstance(updated_at, str))
            or not isinstance(detail.get("items"), list)):
        raise ValueError("HF collection detail has missing or invalid fields")
    items = []
    seen = set()
    for item in detail["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("private", False), bool):
            raise ValueError("HF collection detail has invalid item metadata")
        if item.get("private", False):
            continue
        kind = item.get("type")
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("HF collection detail has an invalid item type")
        item_id = _collection_slug(item.get("slug")) if kind == "collection" else item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            raise ValueError("HF collection detail has a missing item ID")
        key = (kind, item_id)
        if key in seen:
            continue
        seen.add(key)
        note = item.get("note")
        text = note.get("text") if isinstance(note, dict) else None
        items.append({"id": item_id, "type": kind, "note": text if isinstance(text, str) else ""})
    return {"slug": slug, "title": title, "description": description or "",
            "updated_at": updated_at, "items": items}


def fetch_collections(author: str) -> list[dict]:
    """Fetch complete public collections, or raise without returning partial data.

    Listing items are truncated previews; every public collection needs its own
    detail request. A private opener avoids globally installed authentication,
    cookies, HF tokens, and environment proxy credentials.
    """
    _collection_slug(f"{author}/collection")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoCollectionRedirects())
    deadline = time.monotonic() + COLLECTION_FETCH_TIMEOUT
    url = _collection_page_url(HF_COLLECTIONS_API + "?" + urllib.parse.urlencode(
        {"owner": author, "limit": 100}), author)
    pages = set()
    slugs = {}  # Ordered deduplication, independent of truncated preview items.
    while url is not None:
        if url in pages:
            raise ValueError("HF collection pagination loop detected")
        pages.add(url)
        page, link = _collection_json(opener, url, deadline)
        if not isinstance(page, list):
            raise ValueError("HF collections listing must be an array")
        for preview in page:
            slug = _collection_identity(preview, author)
            if not preview["private"]:
                slugs.setdefault(slug, None)
        url = _collection_next_page(link, url, author)
    collections = []
    for slug in slugs:
        detail, _ = _collection_json(opener, HF_COLLECTIONS_API + "/" + slug, deadline)
        _collection_identity(detail, author, slug)
        if not detail["private"]:
            collections.append(_normalize_collection(detail, slug))
    return collections


def migrate_history(obj: dict, author: str) -> dict:
    """Bring an older history (models only, no urls) forward to the current schema.

    Snapshot payloads keep the compact ``{id: [all_time, rolling_30d]}`` shape
    for backwards compatibility with existing readers, so no url is injected
    into historical snapshots; the url lives on the entity records of
    ``latest.json``.
    """
    snapshots = []
    for snapshot in obj.get("snapshots", []):
        if not isinstance(snapshot, dict):
            continue
        migrated = dict(snapshot)
        migrated.setdefault("datasets", {})
        snapshots.append(migrated)
    return {
        "schema_version": SCHEMA_VERSION,
        "author": author,
        "updated_at": obj.get("updated_at"),
        "snapshots": snapshots,
    }


def _aggregate(snapshots: list[dict]) -> list[dict]:
    """Average the metrics of snapshots that fall in the same week.

    Grouping is by elapsed time rather than ISO week number: a retention
    boundary usually cuts a week in half, and an ISO key would then split the
    remainder into a one-day bucket next to a seven-day one.
    """
    ordered = sorted((snap for snap in snapshots if snap.get("date")),
                     key=lambda snap: snap["date"])
    groups: list[list[dict]] = []
    for snap in ordered:
        # Start a new bucket once the group would span more than a week, so a
        # long run of daily snapshots still produces week-sized buckets.
        if groups and (dt.date.fromisoformat(snap["date"])
                       - dt.date.fromisoformat(groups[-1][0]["date"])).days < 7:
            groups[-1].append(snap)
        else:
            groups.append([snap])
    merged = []
    for group in groups:
        days = [snap["date"] for snap in group]
        merged.append({
            "date": max(days),
            "captured_at": max(snap.get("captured_at") or "" for snap in group),
            "granularity": "weekly",
            "days": len(group),
            # A weekly point is a mean, so the front-end must not read it as a
            # single-day delta; `days` lets it scale the comparison.
            "models": _mean_counts(group, "models"),
            "datasets": _mean_counts(group, "datasets"),
        })
    return merged


def _mean_counts(group: list[dict], key: str) -> dict:
    totals: dict[str, dict[int, list[float]]] = {}
    for snap in group:
        for entity_id, values in (snap.get(key) or {}).items():
            if not isinstance(values, (list, tuple)):
                continue
            for index, value in enumerate(values):
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    continue
                totals.setdefault(entity_id, {}).setdefault(index, []).append(float(value))
    averaged: dict[str, list[float]] = {}
    for entity_id, per_index in totals.items():
        averaged[entity_id] = [None, None]
        for index, samples in per_index.items():
            averaged[entity_id][index] = round(sum(samples) / len(samples))
    return averaged


def apply_retention(snapshots: list[dict], today: dt.date, *,
                   daily_days: int = DAILY_RETENTION_DAYS,
                   weekly_count: int = WEEKLY_RETENTION_COUNT) -> list[dict]:
    """Keep recent snapshots daily and downsample everything older to weekly.

    A weekly bucket is stamped with the *last* day it covers so it always sits
    at or before the first daily snapshot, keeping the series monotonic.
    """
    ordered = sorted((snap for snap in snapshots if isinstance(snap, dict) and snap.get("date")),
                     key=lambda snap: snap["date"])
    cutoff = (today - dt.timedelta(days=daily_days)).isoformat()
    recent = [snap for snap in ordered if snap["date"] >= cutoff]
    older = [snap for snap in ordered if snap["date"] < cutoff]
    weekly = _aggregate(older)[-weekly_count:] if weekly_count else []
    if weekly and recent:
        # A bucket is stamped with the last day it covers, so the bucket that
        # straddles the cutoff can reach into the daily segment. Drop it rather
        # than emit an out-of-order point.
        boundary = recent[0]["date"]
        weekly = [snap for snap in weekly if snap["date"] < boundary]
    return sorted(weekly + recent, key=lambda snap: snap["date"])


def load_history(path: Path, author: str) -> dict:
    if not path.exists():
        return {"schema_version": SCHEMA_VERSION, "author": author, "updated_at": None, "snapshots": []}
    obj = json.loads(path.read_text(encoding="utf-8"))
    version = obj.get("schema_version")
    if version in LEGACY_SCHEMA_VERSIONS:
        obj = migrate_history(obj, author)
    if obj.get("schema_version") != SCHEMA_VERSION or obj.get("author") != author or not isinstance(obj.get("snapshots"), list):
        raise ValueError("Existing history has an incompatible schema or author; will not overwrite")
    return obj


def update_history(history: dict, models: list[dict], at: dt.datetime, datasets: list[dict] | None = None,
                   *, allow_large_drop: bool = False) -> dict:
    if not models:
        raise ValueError("No models returned; preserve previous history")
    datasets = datasets or []
    day = at.astimezone(dt.timezone.utc).date().isoformat()
    capture = at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshots = list(history["snapshots"])
    previous = snapshots[-1] if snapshots else None
    if previous:
        if previous["date"] > day:
            raise ValueError("Cannot write a snapshot older than the latest saved UTC date")
        existing_count = len(previous.get("models") or {})
        if existing_count >= 10 and len(models) < existing_count * 0.5 and not allow_large_drop:
            raise ValueError(f"Number of public models suddenly dropped from {existing_count} to {len(models)}; refusing to overwrite (override with --allow-large-drop)")
        existing_datasets = len(previous.get("datasets") or {})
        if existing_datasets >= 5 and len(datasets) < existing_datasets * 0.5 and not allow_large_drop:
            raise ValueError(f"Number of public datasets suddenly dropped from {existing_datasets} to {len(datasets)}; refusing to overwrite (override with --allow-large-drop)")
    new_snapshot = {
        "date": day,
        "captured_at": capture,
        # [all-time, rolling-30-day], with null if HF API field unavailable.
        "models": {m["id"]: [m["all_time"], m["last_30d"]] for m in models},
        "datasets": {d["id"]: [d["all_time"], d["last_30d"]] for d in datasets},
    }
    snapshots = [snap for snap in snapshots if snap["date"] != day]
    snapshots.append(new_snapshot)
    snapshots.sort(key=lambda snap: snap["date"])
    snapshots = apply_retention(snapshots, at.astimezone(dt.timezone.utc).date())
    dropped = len(snapshots) and sum(1 for snap in snapshots if snap.get("granularity") == "weekly")
    suffix = f" ({dropped} weekly buckets kept for older dates)" if dropped else ""
    print(f"History now holds {len(snapshots)} snapshots{suffix}", file=sys.stderr)
    return {"schema_version": SCHEMA_VERSION, "author": history["author"], "updated_at": capture, "snapshots": snapshots}


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    fd, temp_path = tempfile.mkstemp(prefix=".partial-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp_path, 0o644)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def _collections_for_save(path: Path, author: str, collections: dict) -> dict:
    status = collections.get("status")
    error = collections.get("error")
    if status not in ("ok", "stale", "unavailable") or (error is not None and not isinstance(error, str)):
        raise ValueError("Invalid collections status or error")
    if status == "ok":
        if not isinstance(collections.get("items"), list) or not isinstance(collections.get("captured_at"), str):
            raise ValueError("Successful collections need items and their capture time")
        return {"status": "ok", "captured_at": collections["captured_at"],
                "error": None, "items": collections["items"]}
    # Failure payloads must never replace complete membership with partial data
    # or advance its capture time. Only reuse this author's last successful set.
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = None
    old = previous.get("collections") if isinstance(previous, dict) and previous.get("author") == author else None
    if (isinstance(old, dict) and old.get("status") in ("ok", "stale")
            and isinstance(old.get("captured_at"), str) and isinstance(old.get("items"), list)):
        return {"status": "stale", "captured_at": old["captured_at"],
                "error": error, "items": old["items"]}
    return {"status": "unavailable", "captured_at": None, "error": error, "items": []}


def save(data_dir: Path, author: str, models: list[dict], at: dt.datetime, datasets: list[dict] | None = None,
         allow_large_drop: bool = False, *, collections: dict | None = None) -> None:
    datasets = datasets or []
    history_path = data_dir / "history.json"
    history = update_history(load_history(history_path, author), models, at, datasets, allow_large_drop=allow_large_drop)
    latest = {
        "schema_version": SCHEMA_VERSION,
        "author": author,
        "date": at.astimezone(dt.timezone.utc).date().isoformat(),
        "captured_at": at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "models": models,
        "datasets": datasets,
    }
    if collections is not None:
        latest["collections"] = _collections_for_save(data_dir / "latest.json", author, collections)
    # Latest is a convenience view. History is the authoritative record.
    # Collection membership lives only in latest, not in compact history.
    atomic_json_write(history_path, history)
    atomic_json_write(data_dir / "latest.json", latest)
    print(f"Saved {len(models)} public models, {len(datasets)} public datasets, {len(history['snapshots'])} UTC snapshots as of {latest['captured_at']}")
    missing = sum(model["all_time"] is None for model in models)
    if missing:
        print(f"WARNING: lifetime download count missing for {missing} models; kept as null", file=sys.stderr)
    missing_datasets = sum(dataset["all_time"] is None for dataset in datasets)
    if missing_datasets:
        print(f"WARNING: lifetime download count missing for {missing_datasets} datasets; kept as null", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture model and dataset downloads for a Hugging Face author")
    parser.add_argument("--author", default=os.environ.get("HF_AUTHOR", "gatilin"))
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent.parent / "data")
    parser.add_argument("--allow-large-drop", action="store_true")
    parser.add_argument("--skip-datasets", action="store_true", help="Only refresh model statistics")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    for leftover in args.data_dir.glob(".partial-*.json"):
        # A previous run may have been interrupted mid-write.
        try:
            leftover.unlink()
        except OSError:
            pass
    models = fetch_models(args.author)
    datasets = [] if args.skip_datasets else fetch_datasets(args.author)
    try:
        items = fetch_collections(args.author)
        collections = {
            "status": "ok",
            "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "error": None,
            "items": items,
        }
    except Exception as error:
        print(f"Unable to collect HF collections: {error}", file=sys.stderr)
        collections = {"status": "unavailable", "captured_at": None, "error": str(error), "items": []}
    save(args.data_dir, args.author, models, dt.datetime.now(dt.timezone.utc), datasets,
         allow_large_drop=args.allow_large_drop, collections=collections)


if __name__ == "__main__":
    main()
