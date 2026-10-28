#!/usr/bin/env python3
"""Collect anonymous ModelScope OpenAPI counters without assuming a download time window."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    from collect import atomic_json_write
except ImportError:
    from scripts.collect import atomic_json_write

SCHEMA_VERSION = 1
METRIC_SOURCE = "modelscope-openapi-v1"
DEFAULT_AUTHOR = "isLinXu"
ROOT = Path(__file__).resolve().parent.parent
MODELS_API = "https://www.modelscope.cn/openapi/v1/models"
PROFILE_API = "https://www.modelscope.cn/api/v1/profile/"
MODEL_URL = "https://www.modelscope.cn/models/"
PAGE_SIZE = 50
MAX_PAGES = 3000 // PAGE_SIZE
REQUEST_TIMEOUT = 20
FETCH_TIMEOUT = 120
RESPONSE_LIMIT = 8 * 1024 * 1024
HISTORY_RETENTION_DAYS = 400

# Persist only local messages, never response bodies or transport credentials.
ERROR_MESSAGES = {
    "author": "Invalid ModelScope author.",
    "identity": "ModelScope returned an invalid model identity or owner.",
    "privacy": "ModelScope did not explicitly identify every model as public.",
    "gated": "ModelScope did not explicitly identify model access restrictions.",
    "payload": "ModelScope returned an invalid response structure.",
    "page": "ModelScope returned an unexpected page number or page size.",
    "total": "ModelScope pagination totals changed.",
    "incomplete": "ModelScope returned an incomplete or oversized page.",
    "count": "ModelScope unique model count does not match the reported total.",
    "progress": "ModelScope pagination made no progress.",
    "cap": "ModelScope pagination cannot complete within the page limit.",
    "redirect": "ModelScope redirects are not allowed.",
    "timeout": "ModelScope request exceeded its time budget.",
    "size": "ModelScope response exceeded the size limit.",
    "json": "ModelScope returned invalid JSON.",
    "status": "ModelScope returned an unexpected HTTP status.",
    "profile": "ModelScope returned an invalid public profile.",
}


class ModelScopeError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(ERROR_MESSAGES.get(code, "ModelScope collection failed."))


def safe_error(error: Exception) -> str:
    if isinstance(error, ModelScopeError):
        return ERROR_MESSAGES.get(error.code, "ModelScope collection failed.")
    if isinstance(error, urllib.error.HTTPError) and type(error.code) is int:
        if 100 <= error.code <= 599:
            return f"ModelScope HTTP {error.code}."
    if isinstance(error, TimeoutError):
        return ERROR_MESSAGES["timeout"]
    return "ModelScope collection failed."


def number_or_none(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value <= 2**53 - 1 else None


def validate_author(author: str) -> None:
    if not isinstance(author, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", author):
        raise ModelScopeError("author")


def model_id(value: Any, author: str) -> str:
    if (not isinstance(value, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9._-]*", value)
            or ".." in value or value.split("/", 1)[0] != author):
        raise ModelScopeError("identity")
    return value


def api_to_model(item: Any, author: str) -> dict:
    if not isinstance(item, dict):
        raise ModelScopeError("payload")
    identity = model_id(item.get("id"), author)
    if item.get("private") is not False:
        raise ModelScopeError("privacy")
    if not isinstance(item.get("gated"), bool):
        raise ModelScopeError("gated")
    name = item.get("display_name")
    tasks = item.get("tasks")
    return {
        "id": identity,
        "name": name if isinstance(name, str) and name.strip() else identity.split("/", 1)[1],
        "url": MODEL_URL + identity,
        "downloads": number_or_none(item.get("downloads")),
        "likes": number_or_none(item.get("likes")),
        "tasks": [task for task in tasks if isinstance(task, str)] if isinstance(tasks, list) else [],
        "license": item.get("license") if isinstance(item.get("license"), str) else "",
        "created_at": item.get("created_at") if isinstance(item.get("created_at"), str) else None,
        "updated_at": item.get("last_modified") if isinstance(item.get("last_modified"), str) else None,
        "gated": item["gated"],
    }


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if fp is not None:
            fp.close()
        raise ModelScopeError("redirect")


def anonymous_opener():
    # Ignore ambient proxies and authentication without changing the global opener.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects())


def http_get_json(opener: Any, url: str, deadline: float) -> Any:
    request_deadline = min(deadline, time.monotonic() + REQUEST_TIMEOUT)

    def remaining() -> float:
        seconds = request_deadline - time.monotonic()
        if seconds <= 0:
            raise ModelScopeError("timeout")
        return seconds

    request = urllib.request.Request(url, headers={
        "Accept": "application/json", "User-Agent": "Model-Observatory/1.0",
    })
    try:
        response = opener.open(request, timeout=remaining())
    except urllib.error.HTTPError as error:
        error.close()  # Do not read or retain an error response body.
        raise
    with response:
        if response.status != 200:
            raise ModelScopeError("status")
        body = bytearray()
        while True:
            budget = remaining()
            # Tighten urllib's inactivity timeout to bound trickle-fed responses.
            raw = getattr(getattr(response, "fp", None), "raw", None)
            sock = getattr(raw, "_sock", None)
            if sock is not None:
                sock.settimeout(budget)
            chunk = response.read1(min(65536, RESPONSE_LIMIT + 1 - len(body)))
            remaining()
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > RESPONSE_LIMIT:
                raise ModelScopeError("size")
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError):
            raise ModelScopeError("json") from None
        remaining()
        return payload


def fetch_models(author: str, *, opener=None, deadline: float | None = None,
                 max_pages: int = MAX_PAGES) -> list[dict]:
    """Return the complete, deduplicated listing, or fail without partial data."""
    validate_author(author)
    if type(max_pages) is not int or not 1 <= max_pages <= MAX_PAGES:
        raise ModelScopeError("cap")
    opener = opener if opener is not None else anonymous_opener()
    deadline = deadline if deadline is not None else time.monotonic() + FETCH_TIMEOUT
    models: dict[str, dict] = {}
    total = None
    for page in range(1, max_pages + 1):
        query = urllib.parse.urlencode({"owner": author, "page_number": page, "page_size": PAGE_SIZE})
        payload = http_get_json(opener, MODELS_API + "?" + query, deadline)
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise ModelScopeError("payload")
        data = payload.get("data")
        if (not isinstance(data, dict) or not isinstance(data.get("models"), list)
                or number_or_none(data.get("total_count")) is None):
            raise ModelScopeError("payload")
        if (type(data.get("page_number")) is not int or data["page_number"] != page
                or type(data.get("page_size")) is not int or data["page_size"] != PAGE_SIZE):
            raise ModelScopeError("page")
        if total is None:
            total = data["total_count"]
        elif data["total_count"] != total:
            raise ModelScopeError("total")
        if total > max_pages * PAGE_SIZE:
            raise ModelScopeError("cap")
        expected = min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE)
        if len(data["models"]) != expected:
            raise ModelScopeError("incomplete")
        before = len(models)
        for item in data["models"]:
            record = api_to_model(item, author)
            models.setdefault(record["id"], record)
        if total and len(models) == before:
            raise ModelScopeError("progress")
        if page * PAGE_SIZE >= total:
            if len(models) != total:
                raise ModelScopeError("count")
            return sorted(models.values(), key=lambda item: item["id"])
    raise ModelScopeError("cap")


def utc(at: dt.datetime) -> dt.datetime:
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("Capture time must be timezone-aware")
    return at.astimezone(dt.timezone.utc)


def timestamp(at: dt.datetime) -> str:
    return utc(at).isoformat(timespec="seconds").replace("+00:00", "Z")


def unavailable_profile(error: str | None = None) -> dict:
    return {"status": "unavailable", "captured_at": None, "followers": None,
            "model_count": None, "downloads": None, "error": error}


def fetch_profile(author: str, at: dt.datetime, *, opener=None,
                  deadline: float | None = None) -> dict:
    """Read homepage follower/profile totals, independently of model metrics."""
    try:
        validate_author(author)
        opener = opener if opener is not None else anonymous_opener()
        deadline = deadline if deadline is not None else time.monotonic() + FETCH_TIMEOUT
        payload = http_get_json(opener, PROFILE_API + author, deadline)
        if (not isinstance(payload, dict) or payload.get("Success") is not True
                or type(payload.get("Code")) is not int or payload["Code"] != 200):
            raise ModelScopeError("profile")
        data = payload.get("Data")
        if (not isinstance(data, dict) or not isinstance(data.get("User"), dict)
                or not isinstance(data.get("Model"), dict)):
            raise ModelScopeError("profile")
        return {
            "status": "ok", "captured_at": timestamp(at),
            # User.Stars is the homepage follower count, not model likes.
            "followers": number_or_none(data["User"].get("Stars")),
            "model_count": number_or_none(data["Model"].get("TotalCount")),
            "downloads": number_or_none(data["User"].get("Downloads")), "error": None,
        }
    except Exception as error:
        return unavailable_profile(safe_error(error))


def _header(author: str) -> dict:
    return {"schema_version": SCHEMA_VERSION, "author": author, "metric_source": METRIC_SOURCE}


def _compatible(obj: Any, author: str) -> bool:
    return (isinstance(obj, dict) and type(obj.get("schema_version")) is int
            and all(obj.get(key) == value for key, value in _header(author).items()))


def _saved_time(value: Any) -> dt.datetime:
    if not isinstance(value, str):
        raise ValueError("Invalid saved UTC timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ValueError("Invalid saved UTC timestamp")
    return parsed


def _saved_capture(obj: dict) -> dt.datetime:
    capture = _saved_time(obj.get("captured_at"))
    if obj.get("date") != capture.date().isoformat():
        raise ValueError("Saved date does not match the UTC capture time")
    return capture


def _counter(value: Any) -> bool:
    return value is None or number_or_none(value) is not None


def validate_history(history: Any, author: str) -> None:
    try:
        if not _compatible(history, author) or not isinstance(history.get("snapshots"), list):
            raise ValueError
        updated = _saved_time(history.get("updated_at"))
        days = set()
        for snapshot in history["snapshots"]:
            if (not isinstance(snapshot, dict) or _saved_capture(snapshot) > updated
                    or snapshot["date"] in days or not isinstance(snapshot.get("models"), dict)
                    or "followers" not in snapshot or not _counter(snapshot["followers"])):
                raise ValueError
            days.add(snapshot["date"])
            for identity, counts in snapshot["models"].items():
                model_id(identity, author)
                if not isinstance(counts, list) or len(counts) != 2 or not all(map(_counter, counts)):
                    raise ValueError
    except (ValueError, TypeError, KeyError, ModelScopeError):
        raise ValueError("Existing ModelScope history has an incompatible schema, author or data; will not overwrite") from None


def empty_history(author: str, at: dt.datetime) -> dict:
    return {**_header(author), "updated_at": timestamp(at), "snapshots": []}


def load_history(path: Path, author: str, at: dt.datetime) -> dict:
    try:
        history = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_history(author, at)
    except (OSError, ValueError):
        raise ValueError("Existing ModelScope history cannot be read; will not overwrite") from None
    validate_history(history, author)
    return history


def load_previous(path: Path, author: str) -> dict | None:
    """Only reuse complete, compatible latest records from this exact author."""
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        if not _compatible(obj, author) or obj.get("status") not in ("ok", "stale"):
            return None
        _saved_capture(obj)
        if not isinstance(obj.get("models"), list):
            return None
        seen = set()
        for record in obj["models"]:
            identity = model_id(record["id"], author)
            if (identity in seen or record.get("url") != MODEL_URL + identity
                    or not all(isinstance(record.get(key), str) for key in ("name", "license"))
                    or not all(key in record and _counter(record[key]) for key in ("downloads", "likes"))
                    or not isinstance(record.get("gated"), bool)
                    or not isinstance(record.get("tasks"), list)
                    or not all(isinstance(task, str) for task in record["tasks"])
                    or not all(key in record and (record[key] is None or isinstance(record[key], str))
                               for key in ("created_at", "updated_at"))):
                return None
            seen.add(identity)
        profile = obj.get("profile")
        if (not isinstance(profile, dict) or profile.get("status") not in ("ok", "unavailable")
                or not all(key in profile and _counter(profile[key])
                           for key in ("followers", "model_count", "downloads"))):
            return None
        if profile["status"] == "ok":
            _saved_time(profile.get("captured_at"))
        elif profile.get("captured_at") is not None:
            return None
        return obj
    except (OSError, ValueError, TypeError, KeyError, ModelScopeError):
        return None


def _not_older(history: dict, previous: dict | None, at: dt.datetime) -> None:
    now = utc(at)
    saved = [_saved_time(history["updated_at"])]
    saved.extend(_saved_capture(snapshot) for snapshot in history["snapshots"])
    if previous is not None:
        saved.append(_saved_capture(previous))
        if previous["profile"].get("captured_at") is not None:
            saved.append(_saved_time(previous["profile"]["captured_at"]))
    if any(capture > now or capture.date() > now.date() for capture in saved):
        raise ValueError("Cannot write ModelScope data older than the saved timestamp or UTC date")


def update_history(history: dict, models: list[dict], followers: int | None, at: dt.datetime) -> dict:
    validate_history(history, history.get("author"))
    _not_older(history, None, at)
    day = utc(at).date()
    snapshot = {"date": day.isoformat(), "captured_at": timestamp(at),
                "models": {model["id"]: [model["downloads"], model["likes"]] for model in models},
                "followers": followers}
    # Keep 400 UTC calendar days including today, without inventing missing points.
    cutoff = (day - dt.timedelta(days=HISTORY_RETENTION_DAYS - 1)).isoformat()
    snapshots = [snap for snap in history["snapshots"] if cutoff <= snap["date"] < snapshot["date"]]
    snapshots.append(snapshot)
    result = {**_header(history["author"]), "updated_at": timestamp(at),
              "snapshots": sorted(snapshots, key=lambda snap: snap["date"])}
    validate_history(result, history["author"])
    return result


def save(data_dir: Path, author: str, models: list[dict] | None, profile: dict | None,
         at: dt.datetime, *, error: str | None = None) -> str:
    """Validate storage before any write. A failed listing never updates history."""
    history_path = data_dir / "modelscope_history.json"
    latest_path = data_dir / "modelscope.json"
    history_exists = history_path.exists()
    history = load_history(history_path, author, at)
    previous = load_previous(latest_path, author)
    _not_older(history, previous, at)
    if error is not None:
        if previous is not None:
            latest = {**previous, "status": "stale", "error": error}
        else:
            latest = {**_header(author), "date": None, "captured_at": None,
                      "status": "unavailable", "error": error, "models": [],
                      "profile": unavailable_profile(error)}
        if not history_exists:
            atomic_json_write(history_path, history)
    else:
        if models is None or profile is None:
            raise ValueError("Successful ModelScope capture needs models and profile status")
        history = update_history(history, models, profile["followers"], at)
        latest = {**_header(author), "date": utc(at).date().isoformat(),
                  "captured_at": timestamp(at), "status": "ok", "error": None,
                  "profile": profile, "models": models}
        # Write authoritative history first, after validating the complete listing.
        atomic_json_write(history_path, history)
    atomic_json_write(latest_path, latest)
    return latest["status"]


def collect(data_dir: Path, author: str = DEFAULT_AUTHOR, at: dt.datetime | None = None) -> str:
    validate_author(author)
    at = utc(at if at is not None else dt.datetime.now(dt.timezone.utc))
    deadline = time.monotonic() + FETCH_TIMEOUT
    try:
        opener = anonymous_opener()
        models = fetch_models(author, opener=opener, deadline=deadline)
    except Exception as error:
        return save(data_dir, author, None, None, at, error=safe_error(error))
    profile = fetch_profile(author, at, opener=opener, deadline=deadline)
    return save(data_dir, author, models, profile, at)


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture anonymous public ModelScope model metrics")
    parser.add_argument("--author", default=DEFAULT_AUTHOR)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    try:
        status = collect(args.data_dir.resolve(), args.author)
    except Exception:
        print("ModelScope capture could not be saved.", file=sys.stderr)
        return 1
    print(f"ModelScope capture: {status}")
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
