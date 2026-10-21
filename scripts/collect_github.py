#!/usr/bin/env python3
"""Capture public GitHub account metrics and repositories as daily UTC snapshots.

Two artefacts are produced:

* ``data/github.json``       - the current account snapshot plus every public
  repository (stars, forks, language, last update) and, when a token with the
  ``read:project`` scope is available, the account's GitHub Projects.
* ``data/github_history.json`` - one snapshot per UTC day holding the follower
  count, so the dashboard can draw a follower trend.

The public REST API works without credentials, which keeps the published site
reproducible. An optional ``GITHUB_TOKEN`` raises the rate limit and unlocks
the GraphQL Projects query; without it the Projects list is simply reported as
unavailable and the repository list still renders.

Every failure is non-fatal: the previous snapshot is preserved and marked
stale, so a rate-limited or offline run never blanks the dashboard.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:  # executed as a script (python scripts/collect_github.py)
    from collect import atomic_json_write
except ImportError:  # imported as a module (from scripts.collect_github import ...)
    from scripts.collect import atomic_json_write

SCHEMA_VERSION = 1
USER_AGENT = "Model-Observatory/1.0 (+https://islinxu.github.io/model-observatory/)"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOGIN = "isLinXu"

# Each follower snapshot is a handful of integers, so the series stays small
# for years. A cap still applies: it bounds the file and the payload the page
# downloads, while comfortably covering the trend range the charts expose.
HISTORY_RETENTION_DAYS = 1100

# Anonymous REST calls are limited to 60 per hour per IP. A token raises this
# to 5000, so authenticated runs can walk many more repositories.
REQUESTS_PER_PAGE = 100
MAX_PAGES = 20


class GitHubError(RuntimeError):
    """GitHub could not be read; the run continues with the previous snapshot."""


def number_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, float):
        # A fractional count is not a valid metric; treat it as missing.
        return int(value) if value >= 0 and value.is_integer() else None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def auth_headers() -> dict:
    """Authorization header when a token is configured, otherwise anonymous."""
    token = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def http_get_json(url: str, *, headers: dict | None = None, timeout: int = 25,
                  retries: int = 3) -> Any:
    """GET a URL and decode JSON, with bounded retries on transient errors."""
    request_headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read().decode("utf-8", errors="replace")[:200]
            except Exception:
                detail = ""
            if error.code in (403, 429):
                # Rate limited: waiting is the only way out.
                wait = 20 if error.code == 429 else 8
                if attempt < retries - 1:
                    print(f"GitHub rate limited ({error.code}); retrying in {wait}s", file=sys.stderr)
                    time.sleep(wait)
                    continue
            raise GitHubError(f"HTTP {error.code} {error.reason} {detail}".strip()) from error
        except Exception as error:
            if attempt < retries - 1:
                time.sleep(min(2 ** attempt * 3, 12))
                continue
            raise GitHubError(f"请求失败: {error}") from error
    raise AssertionError("unreachable")


def fetch_account(login: str) -> dict:
    """Public account profile: followers, following and repository count."""
    payload = http_get_json(
        f"https://api.github.com/users/{urllib.parse.quote(login)}", headers=auth_headers())
    if not isinstance(payload, dict) or "followers" not in payload:
        raise GitHubError("GitHub 返回的响应缺少用户字段")
    return {
        "login": str(payload.get("login") or login),
        "name": str(payload.get("name") or login),
        "followers": number_or_none(payload.get("followers")),
        "following": number_or_none(payload.get("following")),
        "public_repos": number_or_none(payload.get("public_repos")),
        "public_gists": number_or_none(payload.get("public_gists")),
        "created_at": payload.get("created_at"),
        "updated_at": payload.get("updated_at"),
        "blog": str(payload.get("blog") or ""),
        "bio": str(payload.get("bio") or ""),
        "company": str(payload.get("company") or ""),
        "location": str(payload.get("location") or ""),
        "avatar_url": str(payload.get("avatar_url") or ""),
        "url": str(payload.get("html_url") or f"https://github.com/{login}"),
    }


def api_to_repo(item: dict) -> dict:
    """Convert a REST repository payload into a compact record."""
    return {
        "id": str(item.get("full_name") or item.get("name") or ""),
        "name": str(item.get("name") or ""),
        "full_name": str(item.get("full_name") or ""),
        "description": str(item.get("description") or ""),
        "url": str(item.get("html_url") or ""),
        "homepage": str(item.get("homepage") or ""),
        "language": str(item.get("language") or ""),
        "stars": number_or_none(item.get("stargazers_count")) or 0,
        "forks": number_or_none(item.get("forks_count")) or 0,
        "watchers": number_or_none(item.get("watchers_count")) or 0,
        "open_issues": number_or_none(item.get("open_issues_count")) or 0,
        "topics": [topic for topic in (item.get("topics") or []) if isinstance(topic, str)][:8],
        "is_fork": bool(item.get("fork")),
        "archived": bool(item.get("archived")),
        "license": str((item.get("license") or {}).get("spdx_id") or ""),
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "pushed_at": item.get("pushed_at"),
        "default_branch": str(item.get("default_branch") or ""),
    }


def fetch_repositories(login: str, max_pages: int = MAX_PAGES) -> list[dict]:
    """Walk every public repository page owned by the account."""
    repos: list[dict] = []
    seen: set[str] = set()
    for page in range(1, max_pages + 1):
        url = (f"https://api.github.com/users/{urllib.parse.quote(login)}/repos"
               f"?per_page={REQUESTS_PER_PAGE}&page={page}&sort=updated")
        payload = http_get_json(url, headers=auth_headers())
        if not isinstance(payload, list):
            raise GitHubError(f"仓库列表返回了意外结构: {type(payload).__name__}")
        if not payload:
            break
        for item in payload:
            record = api_to_repo(item)
            if not record["full_name"] or record["full_name"] in seen:
                continue
            seen.add(record["full_name"])
            repos.append(record)
        if len(payload) < REQUESTS_PER_PAGE:
            break
    return repos


PROJECTS_QUERY = """
query($login: String!, $after: String) {
  user(login: $login) {
    projectsV2(first: 50, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        title
        number
        url
        shortDescription
        state
        createdAt
        updatedAt
      }
    }
  }
}
"""


def fetch_projects(login: str) -> dict:
    """Read GitHub Projects through GraphQL.

    Projects require a token with the ``read:project`` scope. Without one the
    call is reported as unavailable instead of failing the whole run.
    """
    if not auth_headers():
        return {"status": "unavailable", "reason": "未配置 GITHUB_TOKEN，无法读取 GitHub Projects", "items": []}
    items: list[dict] = []
    cursor: str | None = None
    try:
        for _ in range(10):
            request = urllib.request.Request(
                "https://api.github.com/graphql",
                data=json.dumps({"query": PROJECTS_QUERY,
                                 "variables": {"login": login, "after": cursor}}).encode("utf-8"),
                headers={**auth_headers(), "User-Agent": USER_AGENT,
                         "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=25) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
            if payload.get("errors"):
                message = "; ".join(str(item.get("message")) for item in payload["errors"])
                return {"status": "unavailable", "reason": f"GraphQL 返回错误: {message[:200]}", "items": []}
            block = ((payload.get("data") or {}).get("user") or {}).get("projectsV2") or {}
            for node in block.get("nodes") or []:
                items.append({
                    "id": f"project-{node.get('number')}",
                    "title": str(node.get("title") or ""),
                    "number": number_or_none(node.get("number")),
                    "url": str(node.get("url") or ""),
                    "description": str(node.get("shortDescription") or ""),
                    "state": str(node.get("state") or ""),
                    "created_at": node.get("createdAt"),
                    "updated_at": node.get("updatedAt"),
                })
            page_info = block.get("pageInfo") or {}
            if not page_info.get("hasNextPage"):
                break
            cursor = page_info.get("endCursor")
    except urllib.error.HTTPError as error:
        return {"status": "unavailable", "reason": f"GraphQL HTTP {error.code}", "items": []}
    except Exception as error:
        return {"status": "unavailable", "reason": f"GraphQL 请求失败: {error}"[:200], "items": []}
    return {"status": "ok", "reason": "", "items": items}


def load_previous(path: Path) -> dict:
    """Read the last snapshot so a failed run can keep its values."""
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def update_history(history: dict, account: dict, at: dt.datetime) -> dict:
    """Append today's follower count, keeping one snapshot per UTC day."""
    day = at.astimezone(dt.timezone.utc).date().isoformat()
    capture = at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshots = [s for s in history.get("snapshots", []) if isinstance(s, dict)]
    snapshots = [s for s in snapshots if s.get("date") != day]
    snapshots.append({
        "date": day,
        "captured_at": capture,
        "followers": account.get("followers"),
        "following": account.get("following"),
        "public_repos": account.get("public_repos"),
    })
    snapshots.sort(key=lambda snapshot: snapshot.get("date") or "")
    cutoff = (at.astimezone(dt.timezone.utc).date() - dt.timedelta(days=HISTORY_RETENTION_DAYS)).isoformat()
    snapshots = [s for s in snapshots if (s.get("date") or "") >= cutoff]
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": capture,
        "snapshots": snapshots,
    }


def save(data_dir: Path, account: dict, repos: list[dict], projects: dict,
         at: dt.datetime, error: str | None = None) -> None:
    capture = at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    latest = {
        "schema_version": SCHEMA_VERSION,
        "captured_at": capture,
        "status": "ok" if error is None else "stale",
        "error": error,
        "account": account,
        "repositories": repos,
        "projects": projects,
    }
    history_path = data_dir / "github_history.json"
    history = update_history(load_previous(history_path), account, at)
    atomic_json_write(data_dir / "github.json", latest)
    atomic_json_write(history_path, history)
    print(f"Saved {len(repos)} public repositories, "
          f"{len(projects.get('items') or [])} projects, "
          f"{len(history['snapshots'])} UTC snapshots as of {capture}")
    if error:
        print(f"WARNING: {error}", file=sys.stderr)


def cleanup_partials(data_dir: Path) -> None:
    """Remove leftover temp files from an interrupted run."""
    for path in data_dir.glob(".partial-*.json"):
        try:
            path.unlink()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture public GitHub metrics and repositories")
    parser.add_argument("--login", default=os.environ.get("GITHUB_LOGIN", DEFAULT_LOGIN))
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    parser.add_argument("--skip-projects", action="store_true",
                        help="Skip the GraphQL Projects query entirely")
    args = parser.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)
    cleanup_partials(args.data_dir)
    captured_at = dt.datetime.now(dt.timezone.utc)
    previous = load_previous(args.data_dir / "github.json")

    try:
        account = fetch_account(args.login)
        repos = fetch_repositories(args.login, args.max_pages)
        if not repos:
            raise GitHubError("GitHub 未返回任何公开仓库，拒绝覆盖上一次快照")
    except GitHubError as error:
        # Keep the previous values so the dashboard still shows a trend.
        account = previous.get("account") or {
            "login": args.login, "name": args.login, "followers": None, "following": None,
            "public_repos": None, "public_gists": None, "created_at": None, "updated_at": None,
            "blog": "", "bio": "", "company": "", "location": "", "avatar_url": "",
            "url": f"https://github.com/{args.login}",
        }
        repos = previous.get("repositories") or []
        projects = previous.get("projects") or {"status": "unavailable", "reason": "", "items": []}
        save(args.data_dir, account, repos, projects, captured_at, error=str(error)[:300])
        return

    if args.skip_projects:
        projects = {"status": "skipped", "reason": "本次运行跳过了 Projects 查询", "items": []}
    else:
        projects = fetch_projects(args.login)

    save(args.data_dir, account, repos, projects, captured_at)


if __name__ == "__main__":
    main()
