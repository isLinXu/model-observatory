#!/usr/bin/env python3
"""Capture public follower metrics from social platforms as daily UTC snapshots.

The set of platforms is declared in config/social_sources.json. Each entry names
a `method`, and that method is dispatched to a fetcher registered in FETCHERS.
Adding a platform therefore means: append one config entry, register one
fetcher. No change is needed in the snapshot writer or in the site.

Every platform is optional. A platform that cannot be read is reported with
status "unavailable" and keeps its last known value, marked stale, so a single
blocked platform never breaks the daily run and never blanks the dashboard.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

try:  # executed as a script (python scripts/collect_social.py)
    from collect import atomic_json_write
except ImportError:  # imported as a module (from scripts.collect_social import ...)
    from scripts.collect import atomic_json_write

SCHEMA_VERSION = 1
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "social_sources.json"

# Bilibili's WBI signature: the mixin order published for the wbi_img keys.
WBI_MIXIN_KEY = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
]


class PlatformError(RuntimeError):
    """A single platform could not be read; the run continues."""


def number_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if value >= 0 else None
    text = str(value).strip().replace(",", "")
    if not re.fullmatch(r"\d+", text):
        return None
    return int(text)


def http_get(url: str, *, headers: dict | None = None, timeout: int = 20,
             retries: int = 3) -> bytes:
    """GET a URL with a browser-like UA and bounded retries."""
    request_headers = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except Exception as error:
            if attempt == retries - 1:
                raise PlatformError(f"请求失败: {error}") from error
            time.sleep(min(2 ** attempt * 3, 12))
    raise AssertionError("unreachable")


def http_get_json(url: str, *, headers: dict | None = None, timeout: int = 20,
                  retries: int = 3) -> Any:
    raw = http_get(url, headers=headers, timeout=timeout, retries=retries)
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as error:
        raise PlatformError(f"返回内容不是合法 JSON: {error}") from error


def cookie_header(name: str) -> dict:
    """Build a Cookie header from an environment variable, if it is set."""
    value = (os.environ.get(name) or "").strip()
    return {"Cookie": value} if value else {}


# --- Fetchers ---------------------------------------------------------------

def fetch_github(source: dict) -> dict:
    """Public GitHub profile: followers, following and public repository count."""
    handle = source["handle"].strip()
    if not handle:
        raise PlatformError("未配置 GitHub 用户名")
    payload = http_get_json(f"https://api.github.com/users/{urllib.parse.quote(handle)}")
    if not isinstance(payload, dict) or "followers" not in payload:
        raise PlatformError("GitHub 返回的响应缺少用户字段")
    return {
        "followers": number_or_none(payload.get("followers")),
        "following": number_or_none(payload.get("following")),
        "posts": number_or_none(payload.get("public_repos")),
        "likes": None,
        "detail": str(payload.get("name") or handle),
        "source": "api.github.com",
    }


def fetch_bilibili(source: dict) -> dict:
    """Public Bilibili space statistics by numeric member id (mid)."""
    mid = source["handle"].strip()
    if not mid.isdigit():
        raise PlatformError("未配置有效的 B 站 mid（数字 ID）")
    payload = http_get_json(
        f"https://api.bilibili.com/x/relation/stat?vmid={mid}",
        headers={"Referer": "https://www.bilibili.com/"},
    )
    if payload.get("code") != 0:
        raise PlatformError(f"B 站接口返回 code={payload.get('code')} {payload.get('message')}")
    data = payload.get("data") or {}
    return {
        "followers": number_or_none(data.get("follower")),
        "following": number_or_none(data.get("following")),
        "posts": None,
        "likes": None,
        "detail": f"mid {mid}",
        "source": "api.bilibili.com",
    }


def _wbi_mixin_key(img_key: str, sub_key: str) -> str:
    raw = img_key + sub_key
    return "".join(raw[index] for index in WBI_MIXIN_KEY)[:32]


def _wbi_sign(params: dict, mixin_key: str) -> dict:
    signed = dict(params)
    signed["wts"] = int(time.time())
    query = urllib.parse.urlencode(
        [(key, str(value).replace("'", "")) for key, value in sorted(signed.items())]
    )
    signed["w_rid"] = _md5_hex(query + mixin_key)
    return signed


def _md5_hex(text: str) -> str:
    import hashlib

    return hashlib.md5(text.encode("utf-8")).hexdigest()


def _bilibili_mixin_key() -> str:
    nav = http_get_json(
        "https://api.bilibili.com/x/web-interface/nav",
        headers={"Referer": "https://www.bilibili.com/"},
    )
    images = (nav.get("data") or {}).get("wbi_img") or {}
    img_key = images.get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
    sub_key = images.get("sub_url", "").rsplit("/", 1)[-1].split(".")[0]
    if not img_key or not sub_key:
        raise PlatformError("无法获取 B 站 WBI 签名密钥")
    return _wbi_mixin_key(img_key, sub_key)


def resolve_bilibili_mid(keyword: str, exact_name: str | None = None) -> tuple[str, str]:
    """Resolve a Bilibili member id from a search keyword using the public API.

    An exact nickname match wins. Otherwise the candidate with the most
    followers is taken, so a keyword like "LIN XU" does not settle for the
    first unrelated account that happens to share the characters.
    """
    mixin_key = _bilibili_mixin_key()
    params = _wbi_sign({"search_type": "bili_user", "keyword": keyword, "page": 1}, mixin_key)
    url = "https://api.bilibili.com/x/web-interface/wbi/search/type?" + urllib.parse.urlencode(params)
    payload = http_get_json(url, headers={"Referer": "https://search.bilibili.com/"})
    if payload.get("code") != 0:
        raise PlatformError(f"B 站搜索接口返回 code={payload.get('code')}")
    results = (payload.get("data") or {}).get("result") or []
    if not results:
        raise PlatformError(f"B 站未搜索到与「{keyword}」匹配的用户")
    if exact_name:
        for item in results:
            if str(item.get("uname", "")).strip().lower() == exact_name.strip().lower():
                return str(item["mid"]), str(item.get("uname"))
    best = max(results, key=lambda item: number_or_none(item.get("fans")) or 0)
    return str(best.get("mid")), str(best.get("uname"))


def fetch_bilibili_search(source: dict) -> dict:
    """Resolve a Bilibili account by nickname, then read its public statistics."""
    keyword = source["handle"].strip()
    if not keyword:
        raise PlatformError("未配置 B 站搜索关键词")
    mid, uname = resolve_bilibili_mid(keyword, source.get("exact_name"))
    stats = fetch_bilibili({"handle": mid})
    stats["detail"] = f"{uname} · mid {mid}"
    return stats


def fetch_zhihu(source: dict) -> dict:
    """Zhihu member statistics. Requires a logged-in cookie for most accounts."""
    token = source["handle"].strip()
    if not token:
        raise PlatformError("未配置知乎 url_token")
    include = "follower_count,following_count,articles_count,answer_count,voteup_count"
    url = (
        f"https://www.zhihu.com/api/v4/members/{urllib.parse.quote(token)}"
        f"?include={urllib.parse.quote(include)}"
    )
    payload = http_get_json(
        url,
        headers={"Referer": f"https://www.zhihu.com/people/{token}", **cookie_header("ZHIHU_COOKIE")},
    )
    if not isinstance(payload, dict):
        raise PlatformError("知乎返回了非预期的响应")
    if payload.get("error"):
        error = payload["error"]
        code = error.get("code")
        if code in (40353, 101):
            raise PlatformError("知乎要求登录，请在环境变量 ZHIHU_COOKIE 中提供有效 Cookie")
        raise PlatformError(f"知乎接口错误 {code}: {error.get('message')}")
    followers = number_or_none(payload.get("follower_count"))
    if followers is None:
        raise PlatformError("知乎响应缺少 follower_count 字段")
    return {
        "followers": followers,
        "following": number_or_none(payload.get("following_count")),
        "posts": number_or_none(payload.get("articles_count")) or number_or_none(payload.get("answer_count")),
        "likes": number_or_none(payload.get("voteup_count")),
        "detail": str(payload.get("name") or token),
        "source": "zhihu.com/api/v4",
    }


def _extract_initial_state(page: str) -> Any:
    """Read the __INITIAL_STATE__ object from a Xiaohongshu page."""
    marker = page.find("__INITIAL_STATE__")
    if marker < 0:
        raise PlatformError("页面中未找到 __INITIAL_STATE__")
    start = page.find("{", marker)
    if start < 0:
        raise PlatformError("__INITIAL_STATE__ 格式异常")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(page)):
        char = page[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                raw = page[start:index + 1]
                # The page embeds JavaScript literals such as `undefined`.
                raw = re.sub(r"\bundefined\b", "null", raw)
                try:
                    return json.loads(raw)
                except json.JSONDecodeError as error:
                    raise PlatformError(f"__INITIAL_STATE__ 解析失败: {error}") from error
    raise PlatformError("__INITIAL_STATE__ 未正常闭合")


def parse_xiaohongshu_state(state: Any) -> dict:
    """Pull follower/following counts out of a decoded Xiaohongshu state."""
    user = ((state or {}).get("user") or {}) if isinstance(state, dict) else {}
    page_data = user.get("userPageData") or {}
    basic = page_data.get("basicInfo") or {}

    def pick(*values: Any) -> int | None:
        for value in values:
            parsed = number_or_none(value)
            if parsed is not None:
                return parsed
        return None

    followers = pick(basic.get("fans"), page_data.get("fans"), page_data.get("fansCount"))
    following = pick(basic.get("follows"), page_data.get("follows"), page_data.get("followsCount"))
    likes = pick(basic.get("liked"), basic.get("interaction"))
    nickname = basic.get("nickname") or page_data.get("nickname") or user.get("nickname")
    red_id = basic.get("redId") or user.get("redId")
    if followers is None:
        raise PlatformError("小红书响应中没有粉丝数（匿名访问会返回空的用户数据）")
    return {
        "followers": followers,
        "following": following,
        "posts": pick(basic.get("noteCount"), page_data.get("noteCount")),
        "likes": likes,
        "detail": " · ".join(part for part in (nickname, red_id) if part) or "小红书",
        "source": "xiaohongshu.com",
    }


def fetch_xiaohongshu(source: dict) -> dict:
    """Xiaohongshu profile statistics. Anonymous requests usually lack user data."""
    user_id = source["handle"].strip()
    if not user_id:
        raise PlatformError("未配置小红书用户 ID")
    page = http_get(
        f"https://www.xiaohongshu.com/user/profile/{urllib.parse.quote(user_id)}",
        headers={
            "Referer": "https://www.xiaohongshu.com/",
            **cookie_header("XIAOHONGSHU_COOKIE"),
        },
    ).decode("utf-8", errors="replace")
    return parse_xiaohongshu_state(_extract_initial_state(page))


def fetch_manual(source: dict) -> dict:
    """Read a hand-maintained value. Used for platforms without a public API."""
    value = number_or_none(source.get("followers"))
    if value is None:
        raise PlatformError("未配置手动粉丝数")
    return {
        "followers": value,
        "following": number_or_none(source.get("following")),
        "posts": number_or_none(source.get("posts")),
        "likes": number_or_none(source.get("likes")),
        "detail": str(source.get("detail") or "手动维护"),
        "source": "manual",
    }


FETCHERS: dict[str, Callable[[dict], dict]] = {
    "github": fetch_github,
    "bilibili": fetch_bilibili,
    "bilibili_search": fetch_bilibili_search,
    "zhihu": fetch_zhihu,
    "xiaohongshu": fetch_xiaohongshu,
    "manual": fetch_manual,
}


# --- Snapshot handling ------------------------------------------------------

def load_config(path: Path) -> list[dict]:
    if not path.is_file():
        raise FileNotFoundError(f"{path} not found")
    payload = json.loads(path.read_text(encoding="utf-8"))
    sources = payload.get("sources")
    if not isinstance(sources, list):
        raise ValueError("social_sources.json must contain a 'sources' list")
    return [source for source in sources if isinstance(source, dict)]


def previous_entries(path: Path) -> dict[str, dict]:
    """Read the last known entry per source, used to keep values when a fetch fails."""
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return {
        entry.get("id"): entry
        for entry in payload.get("sources", [])
        if isinstance(entry, dict) and entry.get("id")
    }


def collect_source(source: dict, captured_at: str | None = None) -> dict:
    """Run one platform and always return a record, including on failure."""
    source_id = str(source.get("id") or source.get("label") or "unknown")
    label = str(source.get("label") or source_id)
    method = str(source.get("method") or "")
    fetcher = FETCHERS.get(method)
    stamp = captured_at or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    record = {
        "id": source_id,
        "label": label,
        "url": str(source.get("url") or ""),
        "color": str(source.get("color") or "#9faeff"),
        "method": method,
        "handle": str(source.get("handle") or ""),
        "status": "unavailable",
        "followers": None,
        "following": None,
        "posts": None,
        "likes": None,
        "detail": "",
        "source": "",
        "updated_at": None,
        "error": None,
    }
    if not source.get("enabled", True):
        record["status"] = "disabled"
        record["error"] = str(source.get("hint") or "该平台未在配置中启用")
        return record
    if fetcher is None:
        record["error"] = f"未知的采集方式: {method}"
        return record
    try:
        metrics = fetcher(source)
    except PlatformError as error:
        record["error"] = str(error)[:300]
        return record
    except Exception as error:  # a broken platform must not break the run
        record["error"] = f"{type(error).__name__}: {error}"[:300]
        return record
    record.update({
        "status": "ok",
        "followers": metrics.get("followers"),
        "following": metrics.get("following"),
        "posts": metrics.get("posts"),
        "likes": metrics.get("likes"),
        "detail": metrics.get("detail", ""),
        "source": metrics.get("source", ""),
        "updated_at": stamp,
    })
    return record


def update_history(history: dict, records: list[dict], at: dt.datetime) -> dict:
    """Append today's follower counts, keeping one snapshot per UTC day."""
    day = at.astimezone(dt.timezone.utc).date().isoformat()
    capture = at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshots = list(history.get("snapshots", []))
    followers = {
        record["id"]: record["followers"]
        for record in records
        if record.get("status") == "ok" and record.get("followers") is not None
    }
    snapshots = [snapshot for snapshot in snapshots if snapshot.get("date") != day]
    snapshots.append({"date": day, "captured_at": capture, "followers": followers})
    snapshots.sort(key=lambda snapshot: snapshot["date"])
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": capture,
        "snapshots": snapshots,
    }


def load_history(path: Path) -> dict:
    if not path.is_file():
        return {"schema_version": SCHEMA_VERSION, "updated_at": None, "snapshots": []}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != SCHEMA_VERSION or not isinstance(payload.get("snapshots"), list):
        raise ValueError("Existing social history has an incompatible schema; will not overwrite")
    return payload


def save(data_dir: Path, records: list[dict], at: dt.datetime) -> None:
    capture = at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    latest = {
        "schema_version": SCHEMA_VERSION,
        "captured_at": capture,
        "sources": records,
    }
    history_path = data_dir / "social_history.json"
    history = update_history(load_history(history_path), records, at)
    atomic_json_write(data_dir / "social.json", latest)
    atomic_json_write(history_path, history)
    ok = sum(1 for record in records if record["status"] == "ok")
    print(f"Saved {ok}/{len(records)} social sources as of {capture}")
    for record in records:
        if record["status"] == "ok":
            print(f"  {record['label']}: {record['followers']} followers")
        else:
            print(f"  {record['label']}: {record['status']} ({record['error']})", file=sys.stderr)


def cleanup_partials(data_dir: Path) -> None:
    """Remove leftover temp files from an interrupted run."""
    for path in data_dir.glob(".partial-*.json"):
        try:
            path.unlink()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture social platform follower counts")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--only", nargs="*", help="Only collect these source ids")
    args = parser.parse_args()

    sources = load_config(args.config)
    if args.only:
        wanted = set(args.only)
        sources = [source for source in sources if source.get("id") in wanted]
    if not sources:
        print("No social sources configured.", file=sys.stderr)
        return

    args.data_dir.mkdir(parents=True, exist_ok=True)
    cleanup_partials(args.data_dir)
    captured_at = dt.datetime.now(dt.timezone.utc)
    capture_stamp = captured_at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    previous = previous_entries(args.data_dir / "social.json")
    records = []
    for source in sources:
        record = collect_source(source, capture_stamp)
        if record["status"] != "ok" and record["followers"] is None:
            # Keep the last known value so the dashboard still shows a trend.
            old = previous.get(record["id"]) or {}
            if old.get("followers") is not None:
                record["followers"] = old["followers"]
                record["following"] = old.get("following")
                record["posts"] = old.get("posts")
                record["likes"] = old.get("likes")
                record["detail"] = old.get("detail", "")
                record["source"] = old.get("source", "")
                record["updated_at"] = old.get("updated_at")
                record["stale"] = True
        records.append(record)
    save(args.data_dir, records, captured_at)


if __name__ == "__main__":
    main()
