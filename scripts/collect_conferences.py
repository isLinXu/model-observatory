#!/usr/bin/env python3
"""Capture the CCF-Deadlines catalogue as a normalized UTC snapshot.

The public aggregate at ``ccfddl.com`` is generated from the MIT-licensed
``ccfddl/ccf-deadlines`` repository. Deadlines are published as naive local
times plus a timezone label, so the collector resolves them to UTC while
keeping the original value and the source timezone for display. A TBD or
unsupported timezone is preserved as an unresolved event, never guessed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:  # executed as a script (python scripts/collect_conferences.py)
    from collect import atomic_json_write
except ImportError:  # imported as a module (from scripts.collect_conferences import ...)
    from scripts.collect import atomic_json_write

SCHEMA_VERSION = 1
SOURCE_ID = "ccfddl"
SOURCE_NAME = "CCF-Deadlines"
SOURCE_URL = "https://ccfddl.com/conference/allconf.json"
SOURCE_REPO = "https://github.com/ccfddl/ccf-deadlines"
SOURCE_LICENSE = "MIT"
ROOT = Path(__file__).resolve().parent.parent

REQUEST_TIMEOUT = 30
FETCH_TIMEOUT = 90
RESPONSE_LIMIT = 8 * 1024 * 1024
RETRIES = 2
RETRY_DELAY = 2
MAX_WARNINGS = 100

CONFERENCE_KEY_RE = re.compile(r"[A-Z]{2}/[A-Za-z0-9][A-Za-z0-9._&+-]{0,63}")
EDITION_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._&'+-]{0,63}")
AREA_RE = re.compile(r"[A-Z]{2,8}")
TIMEZONE_RE = re.compile(r"UTC([+-])(\d{1,2})(?::?(\d{2}))?")

# Source timeline field -> normalized event kind.
TIMELINE_FIELDS = (
    ("abstract_deadline", "abstract"),
    ("deadline", "paper"),
    ("rebuttal_deadline", "rebuttal"),
    ("decision_deadline", "decision"),
)
KIND_ORDER = {"abstract": 0, "paper": 1, "rebuttal": 2, "decision": 3}

ERROR_MESSAGES = {
    "redirect": "Conference source redirects are not allowed.",
    "timeout": "Conference source request exceeded its time budget.",
    "size": "Conference source response exceeded the size limit.",
    "json": "Conference source returned invalid JSON.",
    "status": "Conference source returned an unexpected HTTP status.",
    "network": "Conference source network request failed.",
    "schema": "Conference source returned an invalid structure.",
    "empty": "Conference source returned no conferences.",
    "duplicate": "Conference source returned a duplicate conference key.",
    "duplicate_edition": "Conference source returned a duplicate edition id.",
    "year": "Conference source returned an invalid edition year.",
    "write": "Conference capture could not be saved.",
}


class ConferenceError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(ERROR_MESSAGES.get(code, "Conference collection failed."))


def safe_error(error: Exception) -> str:
    """Return a local message only; never echo a response body or URL."""
    if isinstance(error, ConferenceError):
        return ERROR_MESSAGES.get(error.code, "Conference collection failed.")
    if isinstance(error, urllib.error.HTTPError) and type(error.code) is int:
        if 100 <= error.code <= 599:
            return f"Conference source HTTP {error.code}."
    if isinstance(error, TimeoutError):
        return ERROR_MESSAGES["timeout"]
    if isinstance(error, urllib.error.URLError):
        return ERROR_MESSAGES["network"]
    return "Conference collection failed."


def utc(at: dt.datetime) -> dt.datetime:
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("Capture time must be timezone-aware")
    return at.astimezone(dt.timezone.utc)


def timestamp(at: dt.datetime) -> str:
    return utc(at).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_timezone(name: str | None) -> dt.tzinfo | None:
    """Map the source's timezone labels. Unknown labels stay unresolved."""
    if not isinstance(name, str):
        return None
    value = name.strip()
    if not value:
        return None
    if value == "AoE":
        return dt.timezone(dt.timedelta(hours=-12))
    if value in ("UTC", "UTC+0", "UTC-0"):
        return dt.timezone.utc
    if value == "PT":
        try:
            return ZoneInfo("America/Los_Angeles")
        except ZoneInfoNotFoundError:
            return None
    match = TIMEZONE_RE.fullmatch(value)
    if not match:
        return None
    sign, hours_text, minutes_text = match.groups()
    hours = int(hours_text)
    minutes = int(minutes_text or 0)
    if hours > 14 or minutes > 59 or (hours == 14 and minutes):
        return None
    offset = dt.timedelta(hours=hours, minutes=minutes)
    return dt.timezone(-offset if sign == "-" else offset)


def _text(value: Any, limit: int | None = None) -> str:
    if not isinstance(value, str):
        return ""
    result = value.strip()
    return result[:limit] if limit is not None else result


def _safe_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 2048 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return value


def _add_warning(warnings: list[str], message: str) -> None:
    if len(warnings) >= MAX_WARNINGS:
        if warnings[-1] != "additional warnings suppressed":
            warnings.append("additional warnings suppressed")
        return
    if message not in warnings:
        warnings.append(message)


def _normalize_rank(value: Any) -> dict[str, str | None]:
    rank = value if isinstance(value, dict) else {}
    return {key: (_text(rank.get(key), 20) or None) for key in ("ccf", "core", "thcpl")}


def normalize_event(value: Any, timezone: Any, *, event_id: str, kind: str,
                    round_no: int, year: int, comment: str) -> dict:
    """Build one timeline event without inventing a time when parsing fails."""
    raw = value.strip()
    event = {
        "id": event_id,
        "kind": kind,
        "round": round_no,
        "year": year,
        "comment": _text(comment, 500),
        "source_local": raw[:64],
        "timezone": _text(timezone, 40) or None,
        "utc": None,
        "offset_minutes": None,
        "time_status": "ok",
        "tbd": False,
    }
    if raw.upper() == "TBD":
        event.update({"source_local": "TBD", "time_status": "tbd", "tbd": True})
        return event
    local = None
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            local = dt.datetime.strptime(raw, pattern)
            break
        except ValueError:
            continue
    if local is None:
        event["time_status"] = "invalid_time"
        return event
    zone = parse_timezone(timezone)
    if zone is None:
        event["time_status"] = "unknown_timezone"
        return event
    aware = local.replace(tzinfo=zone, fold=0)
    offset = aware.utcoffset()
    event.update({
        "utc": timestamp(aware),
        "offset_minutes": int(offset.total_seconds() // 60) if offset is not None else None,
    })
    return event


def normalize_timeline(timeline: Any, *, key: str, edition_id: str,
                       year: int, timezone: str | None,
                       warnings: list[str]) -> list[dict]:
    if timeline is None:
        return []
    if not isinstance(timeline, list):
        _add_warning(warnings, f"{key}/{edition_id}: malformed timeline")
        return []
    events: list[dict] = []
    for index, point in enumerate(timeline):
        if not isinstance(point, dict):
            _add_warning(warnings, f"{key}/{edition_id}: malformed timeline point")
            continue
        comment = _text(point.get("comment"), 500)
        for field, kind in TIMELINE_FIELDS:
            if field not in point or point[field] is None:
                continue
            value = point[field]
            if not isinstance(value, str):
                _add_warning(warnings, f"{key}/{edition_id}: {field} is not a string")
                continue
            events.append(normalize_event(
                value, point.get("timezone") or timezone,
                event_id=f"{key}:{edition_id}:{kind}:{index + 1}",
                kind=kind, round_no=index + 1, year=year, comment=comment,
            ))
    if any(event["time_status"] == "unknown_timezone" for event in events):
        _add_warning(warnings, f"{key}/{edition_id}: unsupported timezone")
    if any(event["time_status"] == "invalid_time" for event in events):
        _add_warning(warnings, f"{key}/{edition_id}: invalid deadline")
    return sorted(events, key=lambda event: (event["round"], KIND_ORDER[event["kind"]]))


def normalize_conference(item: Any, warnings: list[str],
                         seen_editions: set[str]) -> dict:
    if not isinstance(item, dict):
        raise ConferenceError("schema")
    key = item.get("conference_key")
    if not isinstance(key, str) or not CONFERENCE_KEY_RE.fullmatch(key):
        raise ConferenceError("schema")
    area = item.get("sub")
    if not isinstance(area, str) or not AREA_RE.fullmatch(area) or key.split("/", 1)[0] != area:
        raise ConferenceError("schema")
    title = _text(item.get("title"))
    if not title:
        raise ConferenceError("schema")
    confs = item.get("confs")
    if not isinstance(confs, list):
        raise ConferenceError("schema")
    if not confs:
        _add_warning(warnings, f"{key}: no editions")
    editions: list[dict] = []
    for edition in confs:
        if not isinstance(edition, dict):
            raise ConferenceError("schema")
        edition_id = edition.get("id")
        if not isinstance(edition_id, str) or not EDITION_ID_RE.fullmatch(edition_id):
            raise ConferenceError("schema")
        if edition_id in seen_editions:
            raise ConferenceError("duplicate_edition")
        seen_editions.add(edition_id)
        year = edition.get("year")
        if type(year) is not int or not 1900 <= year <= 2200:
            raise ConferenceError("year")
        raw_link = edition.get("link")
        url = _safe_url(raw_link)
        if raw_link is not None and url is None:
            _add_warning(warnings, f"{key}/{edition_id}: invalid edition URL")
        timezone = _text(edition.get("timezone"), 40) or None
        editions.append({
            "id": edition_id,
            "year": year,
            "url": url,
            "date": _text(edition.get("date"), 200) or None,
            "place": _text(edition.get("place"), 200) or None,
            "timezone": timezone,
            "events": normalize_timeline(
                edition.get("timeline"), key=key, edition_id=edition_id,
                year=year, timezone=timezone, warnings=warnings,
            ),
        })
    editions.sort(key=lambda edition: (edition["year"], edition["id"]))
    return {
        "key": key,
        "title": title,
        "description": _text(item.get("description")),
        "area": area,
        "rank": _normalize_rank(item.get("rank")),
        "dblp": _text(item.get("dblp"), 80) or None,
        "editions": editions,
    }


def normalize_payload(payload: Any) -> tuple[list[dict], list[str]]:
    if not isinstance(payload, list):
        raise ConferenceError("schema")
    if not payload:
        raise ConferenceError("empty")
    conferences: list[dict] = []
    warnings: list[str] = []
    seen_keys: set[str] = set()
    seen_editions: set[str] = set()
    for item in payload:
        conference = normalize_conference(item, warnings, seen_editions)
        if conference["key"] in seen_keys:
            raise ConferenceError("duplicate")
        seen_keys.add(conference["key"])
        conferences.append(conference)
    conferences.sort(key=lambda conference: conference["key"])
    return conferences, warnings


def flatten_events(conferences: list[dict]):
    for conference in conferences:
        if not isinstance(conference, dict):
            continue
        for edition in conference.get("editions") or []:
            if not isinstance(edition, dict):
                continue
            for event in edition.get("events") or []:
                if isinstance(event, dict):
                    yield event


def summarize(conferences: list[dict]) -> dict:
    editions = [edition for conference in conferences for edition in conference.get("editions") or []]
    events = [event for edition in editions for event in edition.get("events") or []]
    return {
        "conferences": len(conferences),
        "editions": len(editions),
        "events": len(events),
        "paper_events": sum(1 for event in events if event.get("kind") == "paper"),
        "tbd": sum(1 for event in events if event.get("tbd")),
        "unknown_timezone": sum(1 for event in events if event.get("time_status") == "unknown_timezone"),
        "invalid_time": sum(1 for event in events if event.get("time_status") == "invalid_time"),
    }


def _event_signature(event: dict) -> tuple:
    return (
        event.get("kind"), event.get("year"), event.get("source_local"),
        event.get("utc"), event.get("time_status"), event.get("tbd"),
        event.get("comment"),
    )


def compare_changes(previous: dict | None, conferences: list[dict]) -> dict:
    if previous is None:
        return {"status": "initial", "added": 0, "updated": 0, "removed": 0,
                "previous_captured_at": None}
    old = {}
    for event in flatten_events(previous.get("conferences") or []):
        if isinstance(event, dict) and isinstance(event.get("id"), str):
            old[event["id"]] = event
    new = {event["id"]: event for event in flatten_events(conferences)}
    added = sum(1 for event_id in new if event_id not in old)
    removed = sum(1 for event_id in old if event_id not in new)
    updated = sum(1 for event_id in new if event_id in old
                  and _event_signature(new[event_id]) != _event_signature(old[event_id]))
    return {
        "status": "compared",
        "added": added,
        "updated": updated,
        "removed": removed,
        "previous_captured_at": previous.get("captured_at")
        if isinstance(previous.get("captured_at"), str) else None,
    }


def source_metadata() -> dict:
    return {"id": SOURCE_ID, "name": SOURCE_NAME, "url": SOURCE_URL,
            "repo": SOURCE_REPO, "license": SOURCE_LICENSE}


def empty_counts() -> dict:
    return {"conferences": 0, "editions": 0, "events": 0, "paper_events": 0,
            "tbd": 0, "unknown_timezone": 0, "invalid_time": 0}


def digest(conferences: list[dict]) -> str:
    payload = json.dumps(conferences, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _saved_time(value: Any) -> dt.datetime:
    if not isinstance(value, str):
        raise ValueError("Invalid saved capture time")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ValueError("Invalid saved capture time")
    return parsed


def load_previous(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    source = value.get("source")
    if (value.get("schema_version") != SCHEMA_VERSION
            or not isinstance(source, dict) or source.get("id") != SOURCE_ID
            or value.get("status") not in ("ok", "stale")
            or not isinstance(value.get("conferences"), list)):
        return None
    try:
        _saved_time(value.get("captured_at"))
    except (ValueError, TypeError):
        return None
    return value


def _not_older(previous: dict | None, at: dt.datetime) -> None:
    if previous is None:
        return
    if utc(at) < _saved_time(previous.get("captured_at")):
        raise ValueError("Cannot write conference data older than the saved capture")


def save(data_dir: Path, at: dt.datetime, *, conferences: list[dict] | None = None,
         warnings: list[str] | None = None, source_updated_at: str | None = None,
         error: str | None = None) -> str:
    """Write only after validation. A failed capture preserves the last payload."""
    at = utc(at)
    path = data_dir / "conferences.json"
    previous = load_previous(path)
    _not_older(previous, at)
    attempt_at = timestamp(at)
    if error is not None:
        if previous is not None:
            latest = {**previous, "status": "stale", "error": error,
                      "last_attempt_at": attempt_at}
        else:
            latest = {
                "schema_version": SCHEMA_VERSION,
                "source": source_metadata(),
                "status": "unavailable",
                "error": error,
                "captured_at": None,
                "last_attempt_at": attempt_at,
                "source_updated_at": None,
                "source_digest": None,
                "counts": empty_counts(),
                "warnings": [],
                "changes": {"status": "unavailable", "added": 0, "updated": 0,
                            "removed": 0, "previous_captured_at": None},
                "conferences": [],
            }
        atomic_json_write(path, latest)
        return latest["status"]
    if conferences is None:
        raise ValueError("Successful conference capture needs conferences")
    latest = {
        "schema_version": SCHEMA_VERSION,
        "source": source_metadata(),
        "status": "ok",
        "error": None,
        "captured_at": attempt_at,
        "last_attempt_at": attempt_at,
        "source_updated_at": source_updated_at,
        "source_digest": digest(conferences),
        "counts": summarize(conferences),
        "warnings": list(warnings or []),
        "changes": compare_changes(previous, conferences),
        "conferences": conferences,
    }
    atomic_json_write(path, latest)
    return latest["status"]


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if fp is not None:
            fp.close()
        raise ConferenceError("redirect")


def anonymous_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects())


def _remaining(deadline: float) -> float:
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise ConferenceError("timeout")
    return seconds


def _last_modified(headers: Any) -> str | None:
    raw = headers.get("Last-Modified") if headers is not None else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return timestamp(parsed)


def fetch_once(opener: Any, source_url: str, deadline: float) -> tuple[Any, str | None]:
    request = urllib.request.Request(source_url, headers={
        "Accept": "application/json",
        "User-Agent": "Model-Observatory/1.0 (+https://github.com/isLinXu/model-observatory)",
    })
    try:
        response = opener.open(request, timeout=min(REQUEST_TIMEOUT, _remaining(deadline)))
    except urllib.error.HTTPError as error:
        try:
            error.close()
        except Exception:
            # An HTTPError with no body attached cannot always be closed (3.9
            # raises out of its own tempfile teardown). Letting that escape here
            # would replace the status code with an unrelated exception, and the
            # reader would be told "collection failed" instead of "HTTP 500".
            pass
        raise
    with response:
        if getattr(response, "status", 200) != 200:
            raise ConferenceError("status")
        body = bytearray()
        while True:
            budget = _remaining(deadline)
            read = getattr(response, "read1", None) or response.read
            chunk = read(min(65536, RESPONSE_LIMIT + 1 - len(body)))
            _remaining(deadline)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > RESPONSE_LIMIT:
                raise ConferenceError("size")
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError):
            raise ConferenceError("json") from None
        _remaining(deadline)
        return payload, _last_modified(response.headers)


def _retryable(error: Exception) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or 500 <= error.code <= 599
    if isinstance(error, urllib.error.URLError):
        return True
    if isinstance(error, TimeoutError):
        return True
    return isinstance(error, ConferenceError) and error.code == "timeout"


def fetch_payload(opener: Any = None, *, source_url: str = SOURCE_URL,
                  deadline: float | None = None,
                  retries: int = RETRIES) -> tuple[Any, str | None]:
    opener = opener if opener is not None else anonymous_opener()
    deadline = deadline if deadline is not None else time.monotonic() + FETCH_TIMEOUT
    for attempt in range(retries + 1):
        try:
            return fetch_once(opener, source_url, deadline)
        except Exception as error:
            if attempt >= retries or not _retryable(error):
                raise
            pause = min(RETRY_DELAY * (attempt + 1), 10)
            if time.monotonic() + pause >= deadline:
                raise
            time.sleep(pause)
    raise AssertionError("unreachable")


def collect(data_dir: Path, at: dt.datetime | None = None, *, opener: Any = None) -> str:
    at = utc(at if at is not None else dt.datetime.now(dt.timezone.utc))
    try:
        payload, source_updated_at = fetch_payload(opener)
        conferences, warnings = normalize_payload(payload)
    except Exception as error:
        return save(data_dir, at, error=safe_error(error))
    return save(data_dir, at, conferences=conferences, warnings=warnings,
                source_updated_at=source_updated_at)


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture CCF conference deadlines")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    try:
        status = collect(args.data_dir.resolve())
    except Exception:
        print("Conference capture could not be saved.", file=sys.stderr)
        return 1
    print(f"Conference capture: {status}")
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
