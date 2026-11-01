#!/usr/bin/env python3
"""Publish the public starred repository list as a compact graph snapshot.

``GET /users/<login>/starred`` returns about 6 KB per repository — 31 MB for the
5,000+ stars this account has — and it omits ``starred_at`` entirely, because
GitHub only exposes star dates through the authenticated ``/user/starred``
endpoint. Both facts shape this collector: a whitelisted subset of fields is
published instead of the raw list, graph edges stay unmaterialised so the
browser can derive them from the same rows, and the star timeline is rebuilt
from our own daily snapshots rather than from a user-scoped token.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:  # executed as a script (python scripts/collect_starred.py)
    from collect import atomic_json_write
    from collect_github import GitHubError, auth_headers, http_get_json
except ImportError:  # imported as a module (from scripts.collect_starred import ...)
    from scripts.collect import atomic_json_write
    from scripts.collect_github import GitHubError, auth_headers, http_get_json

SCHEMA_VERSION = 1
SOURCE_ID = "github"
USER_AGENT = "Model-Observatory/1.0 (+https://islinxu.github.io/model-observatory/)"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOGIN = "isLinXu"

# Anonymous calls are capped at 60 per hour and one crawl already needs ~52
# pages, so a token is mandatory: the GitHub repository collector consumes part
# of the same hourly budget in the very same workflow run.
PER_PAGE = 100
MAX_PAGES = 80
HISTORY_RETENTION_DAYS = 1100

NAME_RE = re.compile(r"[A-Za-z0-9_.\-]{1,39}/[A-Za-z0-9_.\-]{1,100}$")
TOPIC_RE = re.compile(r"[a-z0-9][a-z0-9._+\-]{0,49}$")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}$")
URL_RE = re.compile(r"https://github\.com/[A-Za-z0-9_.\-]{1,39}/[A-Za-z0-9_.\-]{1,100}$")

TOPIC_KEEP = 6
TOPIC_MIN_REPOS = 8
TOPIC_NODES = 120
OWNER_MIN_REPOS = 3
OWNER_NODES = 60
CLUSTER_REPS = 8
COOCCUR_MIN = 5
COOCCUR_LIMIT = 600
CHANGE_LIMIT = 200
WARNING_LIMIT = 100
LANGUAGE_LIMIT = 40
DESCRIPTION_LIMIT = 120
UNKNOWN_CLUSTER = "lang:未知"

ERROR_MESSAGES = {
    "count": "star 列表与账号公布的数量不一致，保留上一次快照。",
    "empty": "GitHub 未返回任何 star 记录，保留上一次快照。",
    "pages": "star 列表超出页数上限，保留上一次快照。",
    "schema": "GitHub 返回的 star 列表结构不符合预期，保留上一次快照。",
    "token": "未配置 GITHUB_TOKEN，无法分页读取完整 star 列表。",
}


class StarError(RuntimeError):
    """The starred list could not be read; the previous snapshot stays published."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(ERROR_MESSAGES.get(code, f"star 采集失败（{code}）。"))
        self.code = code
        self.detail = detail[:200]


def utc(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise StarError("schema", "采集时间缺少时区")
    return value.astimezone(dt.timezone.utc)


def timestamp(value: dt.datetime) -> str:
    return utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_error(error: Exception) -> str:
    """Never leak a URL, token or response body into the published snapshot."""
    if isinstance(error, StarError):
        return ERROR_MESSAGES.get(error.code, str(error))
    if isinstance(error, urllib.error.HTTPError):
        return f"GitHub 返回 HTTP {error.code}。"
    if isinstance(error, (urllib.error.URLError, TimeoutError, OSError)):
        return "无法访问 GitHub API。"
    return "star 采集失败。"


def add_warning(warnings: list[str], message: str) -> None:
    if len(warnings) >= WARNING_LIMIT:
        if warnings and warnings[-1] != "更多告警已省略":
            warnings.append("更多告警已省略")
        return
    if message not in warnings:
        warnings.append(message)


def int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def clean_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:limit] or None


def parse_date(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    match = DATE_RE.match(value[:10])
    if not match:
        return None
    try:
        dt.date.fromisoformat(value[:10])
    except ValueError:
        return None
    return value[:10]


def normalize_topic(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    topic = value.strip().lower()
    return topic if TOPIC_RE.fullmatch(topic) else None


def normalize_row(item: Any, warnings: list[str]) -> dict | None:
    """Keep only the fields the wall and the graph can actually use."""
    if not isinstance(item, dict):
        add_warning(warnings, "忽略了一条非对象记录")
        return None
    name = item.get("full_name")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        add_warning(warnings, "忽略了一条 full_name 非法的记录")
        return None
    url = item.get("html_url")
    if not isinstance(url, str) or not URL_RE.fullmatch(url) or url != f"https://github.com/{name}":
        add_warning(warnings, f"{name}: html_url 与仓库标识不一致，已忽略")
        return None

    topics: list[str] = []
    raw_topics = item.get("topics")
    if isinstance(raw_topics, list):
        for value in raw_topics:
            topic = normalize_topic(value)
            if topic is None:
                continue
            if topic not in topics:
                topics.append(topic)
            if len(topics) >= TOPIC_KEEP:
                break
    elif raw_topics is not None:
        add_warning(warnings, f"{name}: topics 不是列表")

    owner = item.get("owner") if isinstance(item.get("owner"), dict) else {}
    owner_type = owner.get("type")
    org = 1 if owner_type == "Organization" else 0 if owner_type == "User" else None
    owner_login = owner.get("login") if isinstance(owner.get("login"), str) else ""
    if owner_login and not name.lower().startswith(f"{owner_login.lower()}/"):
        add_warning(warnings, f"{name}: owner.login 与仓库标识不一致")

    return {
        "n": name,
        "l": clean_text(item.get("language"), LANGUAGE_LIMIT),
        "t": topics,
        "s": int_or_none(item.get("stargazers_count")),
        "d": clean_text(item.get("description"), DESCRIPTION_LIMIT),
        "p": parse_date(item.get("pushed_at")),
        "f": 1 if item.get("fork") is True else 0,
        "r": 1 if item.get("archived") is True else 0,
        "o": org,
    }


def owner_login_of(name: str) -> str:
    return name.split("/", 1)[0].lower()


def topic_frequencies(rows: list[dict]) -> dict[str, int]:
    frequencies: dict[str, int] = {}
    for row in rows:
        for topic in row["t"]:
            frequencies[topic] = frequencies.get(topic, 0) + 1
    return frequencies


def select_nodes(rows: list[dict]) -> dict[str, dict]:
    """Build the cluster nodes that are dense enough to draw.

    ``repos`` counts the primary assignment (the clusters partition every row)
    while ``appears`` counts co-occurrence, so a repository that carries three
    topics is visible in three ``appears`` values without inflating ``repos``.
    """
    topic_freq = topic_frequencies(rows)
    owner_freq: dict[str, int] = {}
    for row in rows:
        owner = owner_login_of(row["n"])
        owner_freq[owner] = owner_freq.get(owner, 0) + 1

    nodes: dict[str, dict] = {}
    language_freq: dict[str, int] = {}
    for row in rows:
        if row["l"]:
            language_freq[row["l"]] = language_freq.get(row["l"], 0) + 1
    for language, count in language_freq.items():
        nodes[f"lang:{language}"] = {"id": f"lang:{language}", "type": "language",
                                     "label": language, "appears": count}
    for topic, count in sorted(topic_freq.items(), key=lambda kv: (-kv[1], kv[0]))[:TOPIC_NODES]:
        if count < TOPIC_MIN_REPOS:
            break
        nodes[f"topic:{topic}"] = {"id": f"topic:{topic}", "type": "topic",
                                   "label": topic, "appears": count}
    ranked_owners = sorted(owner_freq.items(), key=lambda kv: (-kv[1], kv[0]))
    kept_owners = {owner for owner, count in ranked_owners[:OWNER_NODES] if count >= OWNER_MIN_REPOS}
    for owner, count in ranked_owners:
        if owner not in kept_owners:
            continue
        nodes[f"owner:{owner}"] = {"id": f"owner:{owner}", "type": "owner",
                                   "label": owner, "appears": count}
    for node in nodes.values():
        node["repos"] = 0
        node["reps"] = []
    nodes[UNKNOWN_CLUSTER] = {"id": UNKNOWN_CLUSTER, "type": "language", "label": "未知",
                              "repos": 0, "reps": [],
                              "appears": sum(1 for row in rows if not row["l"])}
    return {"nodes": nodes, "kept_owners": kept_owners, "topic_freq": topic_freq}


def primary_node(row: dict, index: dict) -> str:
    """One deterministic cluster per repository: language, then a dense topic, then owner."""
    if row["l"] and f"lang:{row['l']}" in index["nodes"]:
        return f"lang:{row['l']}"
    candidates = [topic for topic in row["t"] if f"topic:{topic}" in index["nodes"]]
    if candidates:
        return f"topic:{sorted(candidates, key=lambda t: (-index['topic_freq'][t], t))[0]}"
    owner = owner_login_of(row["n"])
    if owner in index["kept_owners"]:
        return f"owner:{owner}"
    return UNKNOWN_CLUSTER


def cooccurrence(pairs: list[tuple[dict, str]], nodes: dict[str, dict]) -> list[dict]:
    """Cluster-to-cluster weights observed through shared repositories."""
    weights: dict[tuple[str, str], int] = {}
    for row, left in pairs:
        others = [f"topic:{topic}" for topic in row["t"] if f"topic:{topic}" in nodes][:3]
        owner_node = f"owner:{owner_login_of(row['n'])}"
        if owner_node in nodes:
            others.append(owner_node)
        for other in others:
            if other == left:
                continue
            pair = (left, other) if left < other else (other, left)
            weights[pair] = weights.get(pair, 0) + 1
    ranked = sorted(((pair, count) for pair, count in weights.items() if count >= COOCCUR_MIN),
                    key=lambda item: (-item[1], item[0]))
    return [{"a": pair[0], "b": pair[1], "w": count} for pair, count in ranked[:COOCCUR_LIMIT]]


def summarize(rows: list[dict], at: dt.datetime) -> dict:
    day = utc(at).date()
    active_floor = (day - dt.timedelta(days=90)).isoformat()
    owners = {owner_login_of(row["n"]) for row in rows}
    languages = {row["l"] for row in rows if row["l"]}
    topics = {topic for row in rows for topic in row["t"]}
    return {
        "total": len(rows),
        "languages": len(languages),
        "topics": len(topics),
        "owners": len(owners),
        "org_owned": sum(1 for row in rows if row["o"] == 1),
        "archived": sum(1 for row in rows if row["r"]),
        "forks": sum(1 for row in rows if row["f"]),
        "undocumented": sum(1 for row in rows if not row["d"]),
        "active_90d": sum(1 for row in rows if (row["p"] or "") >= active_floor),
    }


def compare_rows(previous: list[dict] | None, rows: list[dict]) -> dict:
    if not isinstance(previous, list):
        return {"status": "initial", "added": [], "removed": [],
                "added_count": 0, "removed_count": 0, "truncated": False}
    before = {row["n"] for row in previous if isinstance(row, dict) and isinstance(row.get("n"), str)}
    now = {row["n"] for row in rows}
    added = sorted(now - before, key=str.lower)
    removed = sorted(before - now, key=str.lower)
    return {
        "status": "compared",
        "added": added[:CHANGE_LIMIT],
        "removed": removed[:CHANGE_LIMIT],
        "added_count": len(added),
        "removed_count": len(removed),
        "truncated": len(added) > CHANGE_LIMIT or len(removed) > CHANGE_LIMIT,
    }


def build_graph(rows: list[dict], at: dt.datetime) -> dict:
    """Cluster the rows and report the graph plus each row's primary cluster.

    ``assignment`` is published with the detail rows so the wall can colour and
    group cells with the same rule the snapshot uses, instead of re-deriving the
    node thresholds in the browser.
    """
    index = select_nodes(rows)
    nodes = index["nodes"]
    pairs = [(row, primary_node(row, index)) for row in rows]
    grouped: dict[str, list[dict]] = {}
    for row, cluster in pairs:
        nodes[cluster]["repos"] += 1
        grouped.setdefault(cluster, []).append(row)
    for cluster, members in grouped.items():
        nodes[cluster]["reps"] = [{"n": row["n"], "s": row["s"]} for row in sorted(
            members, key=lambda row: (-(row["s"] or 0), row["n"].lower()))[:CLUSTER_REPS]]
    # A node nobody lands in and nobody shares carries no information; publishing it
    # would only widen the graph without drawing anything.
    clusters = sorted((node for node in nodes.values() if node["repos"] or node["appears"]),
                      key=lambda node: (-node["repos"], node["id"]))
    return {"clusters": clusters, "edges": cooccurrence(pairs, nodes),
            "stats": summarize(rows, at),
            "assignment": {row["n"]: cluster for row, cluster in pairs}}


def parse_last_page(link_header: str | None) -> int | None:
    for part in (link_header or "").split(","):
        match = re.search(r'[?&]page=(\d+)[^>]*>;\s*rel="last"', part.strip())
        if match:
            return int(match.group(1))
    return None


def get_with_headers(url: str, headers: dict, *, opener: Any = None) -> tuple[Any, dict]:
    """One request that also returns response headers, for the authoritative count."""
    request = urllib.request.Request(url, headers={**headers, "User-Agent": USER_AGENT,
                                                  "Accept": "application/vnd.github+json"})
    with (opener or urllib.request.urlopen)(request, timeout=25) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
        return payload, {key.lower(): value for key, value in response.headers.items()}


def probe_total(login: str, headers: dict, *, opener: Any = None) -> int | None:
    """The count GitHub publishes for this list, read from the Link header."""
    url = (f"https://api.github.com/users/{urllib.parse.quote(login)}/starred"
           f"?per_page=1&page=1")
    payload, response_headers = get_with_headers(url, headers, opener=opener)
    if not isinstance(payload, list):
        raise StarError("schema")
    pages = parse_last_page(response_headers.get("link"))
    if pages is None:
        return len(payload)
    return pages


def fetch_rows(login: str, headers: dict, *, max_pages: int = MAX_PAGES,
               getter: Any = http_get_json, warnings: list[str] | None = None) -> tuple[list[dict], int]:
    rows: list[dict] = []
    seen: set[str] = set()
    pages = 0
    collected = warnings if warnings is not None else []
    for page in range(1, max_pages + 1):
        url = (f"https://api.github.com/users/{urllib.parse.quote(login)}/starred"
               f"?per_page={PER_PAGE}&page={page}")
        payload = getter(url, headers=headers)
        pages = page
        if not isinstance(payload, list):
            raise StarError("schema")
        if not payload:
            break
        for item in payload:
            row = normalize_row(item, collected)
            if row is None or row["n"] in seen:
                continue
            seen.add(row["n"])
            rows.append(row)
        if len(payload) < PER_PAGE:
            break
    else:
        raise StarError("pages")
    rows.sort(key=lambda row: row["n"].lower())
    return rows, pages


def load_previous(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def previous_rows(data_dir: Path) -> list[dict] | None:
    payload = load_previous(data_dir / "stars_repos.json")
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        return None
    rows = payload.get("rows")
    return rows if isinstance(rows, list) else None


def source_meta(login: str) -> dict:
    return {"id": SOURCE_ID, "login": login, "api": f"users/{login}/starred",
            "per_page": PER_PAGE, "url": f"https://github.com/stars/{login}"}


def empty_stats() -> dict:
    return {"total": 0, "languages": 0, "topics": 0, "owners": 0, "org_owned": 0,
            "archived": 0, "forks": 0, "undocumented": 0, "active_90d": 0}


def history_snapshot(history: dict, stats: dict, changes: dict, at: dt.datetime) -> dict:
    day = utc(at).date()
    snapshots = [snap for snap in (history.get("snapshots") or []) if isinstance(snap, dict)]
    snapshots = [snap for snap in snapshots if snap.get("date") != day.isoformat()]
    snapshots.append({
        "date": day.isoformat(),
        "captured_at": timestamp(at),
        "total": stats["total"],
        "added": changes["added_count"],
        "removed": changes["removed_count"],
        "active_90d": stats["active_90d"],
        "languages": stats["languages"],
    })
    snapshots.sort(key=lambda snap: str(snap.get("date") or ""))
    cutoff = (day - dt.timedelta(days=HISTORY_RETENTION_DAYS)).isoformat()
    return {"schema_version": SCHEMA_VERSION, "updated_at": timestamp(at),
            "retention_days": HISTORY_RETENTION_DAYS,
            "snapshots": [snap for snap in snapshots if str(snap.get("date") or "") >= cutoff]}


def publish(data_dir: Path, at: dt.datetime, *, login: str = DEFAULT_LOGIN,
            headers: dict | None = None, getter: Any = http_get_json,
            opener: Any = None, max_pages: int = MAX_PAGES) -> str:
    """Fetch, aggregate and write. A failure keeps every previous file intact."""
    at = utc(at)
    path = data_dir / "stars.json"
    previous = load_previous(path)
    if isinstance(previous, dict) and isinstance(previous.get("captured_at"), str):
        try:
            saved = dt.datetime.fromisoformat(previous["captured_at"].replace("Z", "+00:00"))
        except ValueError:
            saved = None
        if saved is not None and saved > at:
            return "rejected"
    headers = auth_headers() if headers is None else headers
    if not headers:
        return write_unavailable(data_dir, at, login, StarError("token"))
    warnings: list[str] = []
    try:
        expected = probe_total(login, headers, opener=opener)
        rows, pages = fetch_rows(login, headers, max_pages=max_pages, getter=getter,
                                 warnings=warnings)
        if not rows:
            raise StarError("empty")
        if expected is not None and abs(expected - len(rows)) > max(10, expected // 100):
            raise StarError("count", f"expected {expected}, got {len(rows)}")
    except (StarError, GitHubError, urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        return write_stale(data_dir, at, login, previous, safe_error(error))

    graph = build_graph(rows, at)
    changes = compare_rows(previous_rows(data_dir), rows)
    attempt = timestamp(at)
    atomic_json_write(path, {
        "schema_version": SCHEMA_VERSION,
        "source": source_meta(login),
        "status": "ok",
        "error": None,
        "captured_at": attempt,
        "last_attempt_at": attempt,
        "pages": pages,
        "expected_total": expected,
        "counts": graph["stats"],
        "changes": changes,
        "clusters": graph["clusters"],
        "edges": graph["edges"],
        "warnings": warnings,
    })
    atomic_json_write(data_dir / "stars_repos.json", {
        "schema_version": SCHEMA_VERSION,
        "source": source_meta(login),
        "captured_at": attempt,
        "count": len(rows),
        "rows": [{**row, "c": graph["assignment"].get(row["n"], UNKNOWN_CLUSTER)} for row in rows],
    })
    history_path = data_dir / "stars_history.json"
    history = load_previous(history_path)
    history = history if isinstance(history, dict) else {}
    atomic_json_write(history_path, history_snapshot(history, graph["stats"], changes, at))
    return "ok"


def write_stale(data_dir: Path, at: dt.datetime, login: str, previous: Any,
                error: str) -> str:
    """Keep the last good graph and mark it as older than the latest attempt."""
    attempt = timestamp(at)
    if isinstance(previous, dict) and isinstance(previous.get("clusters"), list):
        atomic_json_write(data_dir / "stars.json", {**previous, "status": "stale",
                                                   "error": error, "last_attempt_at": attempt})
        return "stale"
    return write_unavailable(data_dir, at, login, error)


def write_unavailable(data_dir: Path, at: dt.datetime, login: str, error: Any) -> str:
    attempt = timestamp(at)
    message = error if isinstance(error, str) else safe_error(error)
    atomic_json_write(data_dir / "stars.json", {
        "schema_version": SCHEMA_VERSION,
        "source": source_meta(login),
        "status": "unavailable",
        "error": message,
        "captured_at": None,
        "last_attempt_at": attempt,
        "pages": 0,
        "expected_total": None,
        "counts": empty_stats(),
        "changes": {"status": "unavailable", "added": [], "removed": [],
                    "added_count": 0, "removed_count": 0, "truncated": False},
        "clusters": [],
        "edges": [],
        "warnings": [],
    })
    return "unavailable"


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture the public starred repository list")
    parser.add_argument("--login", default=os.environ.get("GITHUB_LOGIN", DEFAULT_LOGIN))
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    args = parser.parse_args()
    try:
        status = publish(args.data_dir.resolve(), dt.datetime.now(dt.timezone.utc),
                         login=args.login, max_pages=args.max_pages)
    except Exception as error:
        print(f"Star capture could not be saved: {safe_error(error)}", file=sys.stderr)
        return 1
    print(f"Star capture: {status}")
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
