#!/usr/bin/env python3
"""Index the hand-maintained entity registry and cross-check its links.

One research object is one Markdown file, ``entities/<slug>.md``, with a small
YAML-ish frontmatter block carrying the structured links and a body carrying the
prose a collector cannot know (what was tried, what was concluded, what to do
next).  The format is deliberately the one ``templates/`` already uses.

The registry stores **relationships only**.  No download count, star total or
citation number is ever copied into it, so every metric on this site keeps
exactly one owner and one capture time, and a stale registry can never argue
with a live board.

Each link is checked against the sibling snapshots written earlier in the same
workflow run and lands in one of four states:

* ``resolved``      the target exists in that source's snapshot
* ``unresolved``    the source answered, and the target is gone or misspelt
* ``unchecked``     no usable snapshot for that source, so nothing was claimed
* ``out_of_scope``  a GitHub repository that belongs to somebody else

``unchecked`` matters: a failed Scholar or ModelScope capture must not be
reported as "this link is broken", because that trains the reader to ignore the
board.  ``hf_space`` has no source at all yet, so every Space link stays
honestly ``unchecked`` until a Space collector exists.

Nothing here touches the network.
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

try:  # executed as a script (python scripts/collect_entities.py)
    from collect import atomic_json_write, entity_url
    from collect_templates import (MAX_BODY_CHARS, SLUG_PATTERN, _clean_value,
                                   normalise_tags, parse_frontmatter)
except ImportError:  # imported as a module (from scripts.collect_entities import ...)
    from scripts.collect import atomic_json_write, entity_url
    from scripts.collect_templates import (MAX_BODY_CHARS, SLUG_PATTERN, _clean_value,
                                          normalise_tags, parse_frontmatter)

SCHEMA_VERSION = 1
SOURCE_ID = "registry"
ROOT = Path(__file__).resolve().parent.parent
HISTORY_RETENTION_DAYS = 1100

CHANGE_LIMIT = 200
WARNING_LIMIT = 100
ENTRY_LIMIT = 500
LINK_LIMIT = 40
TITLE_LIMIT = 120
TAG_LIMIT = 12
# The unregistered list is a work queue, not a dataset: the board needs a sample
# to act on plus the honest count, not a few hundred ids on every page load.
UNREGISTERED_LIMIT = 50

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}$")
LINK_RE = re.compile(r"^([a-z_]+):(.+)$")
COLON_RE = re.compile(r"[:：]")

HF_COLLECTION_URL = "https://huggingface.co/collections/{repo_id}"

KINDS = ("project", "model", "dataset", "paper")
STAGES = ("proposal", "training", "evaluating", "submitting", "shipped", "archived")

# domain -> the snapshot that can prove the target exists
DOMAINS = ("hf_model", "hf_dataset", "hf_collection", "hf_space",
           "ms_model", "gh_repo", "scholar", "conf", "template")
# Domains whose snapshot lists *our own* output, so "registered / total" is a
# real coverage figure. A conference key is a directory entry, not our output,
# so it is validated but never counted as a gap.
COVERAGE_DOMAINS = ("hf_model", "hf_dataset", "hf_collection", "ms_model",
                    "gh_repo", "scholar", "template")

ERROR_MESSAGES = {
    "directory": "实体注册表目录不存在，保留上一次快照。",
    "schema": "实体注册表的结构不符合预期，保留上一次快照。",
}

STATES = ("resolved", "unresolved", "unchecked", "out_of_scope")


class RegistryError(RuntimeError):
    """The registry could not be read at all; the previous snapshot stays published."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(ERROR_MESSAGES.get(code, f"注册表采集失败（{code}）。"))
        self.code = code
        self.detail = detail[:200]


def utc(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise RegistryError("schema", "采集时间缺少时区")
    return value.astimezone(dt.timezone.utc)


def timestamp(value: dt.datetime) -> str:
    return utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_error(error: Exception) -> str:
    """Published reasons never carry a path, token or response body."""
    if isinstance(error, RegistryError):
        return ERROR_MESSAGES.get(error.code, str(error))
    return "注册表采集失败。"


def add_note(bucket: list[str], message: str, limit: int = WARNING_LIMIT) -> None:
    if len(bucket) >= limit:
        if bucket and bucket[-1] != "更多条目已省略":
            bucket.append("更多条目已省略")
        return
    if message not in bucket:
        bucket.append(message)


def scholar_alias(title: Any) -> str:
    """Stable alias for a Scholar paper, which has no id of its own.

    The phrase before the first colon is what researchers actually call the work
    (``MME: A Comprehensive ...`` -> ``mme``); a title without a colon falls back
    to its first five words.  Deterministic beats pretty: the board tells the
    reader the link is matched by title alias, so the rule has to be one they can
    reproduce by hand.
    """
    text = str(title or "").strip()
    head = COLON_RE.split(text, maxsplit=1)[0] if COLON_RE.search(text) else ""
    source = head.strip() or " ".join(text.split()[:5])
    return re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-")


# ---------------------------------------------------------------------------
# Sources: what the other collectors published in this run
# ---------------------------------------------------------------------------

def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _pairs(items: Any, id_key: str, template: str | None = None) -> dict[str, str | None]:
    """Collect ``id -> url`` from a snapshot list, keeping None for a real id
    whose source published no link (resolved but unclickable is honest)."""
    out: dict[str, str | None] = {}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        ident = item.get(id_key)
        if not isinstance(ident, str) or not ident:
            continue
        url = item.get("url")
        if not isinstance(url, str) and template:
            url = entity_url(template, ident)
        out[ident] = url if isinstance(url, str) else None
    return out


def _source(name: str, ids: dict[str, str | None], captured_at: Any, reason: str,
            *, available: bool | None = None) -> dict:
    usable = bool(ids) if available is None else available
    return {"available": usable, "ids": ids, "own": set(ids) if usable else set(),
            "captured_at": captured_at if usable else None,
            "file": name, "reason": None if usable else reason}


def _conference_url(item: dict) -> str | None:
    editions = [e for e in (item.get("editions") or []) if isinstance(e, dict) and e.get("url")]
    if not editions:
        return None
    latest = max(editions, key=lambda e: (str(e.get("year") or ""), str(e.get("date") or "")))
    url = latest.get("url")
    return url if isinstance(url, str) and url.startswith(("http://", "https://")) else None


def load_sources(data_dir: Path, warnings: list[str]) -> dict[str, dict]:
    """Build ``domain -> {available, ids, own, captured_at, reason}`` from siblings."""
    latest = read_json(data_dir / "latest.json")
    latest = latest if isinstance(latest, dict) else {}
    collections = latest.get("collections")
    collections = collections if isinstance(collections, dict) else {}
    collections_usable = bool(collections.get("items")) and \
        collections.get("status", "ok") in ("ok", "stale")

    sources = {
        "hf_model": _source("latest.json", _pairs(latest.get("models"), "id"),
                            latest.get("captured_at"), "Hugging Face 模型快照不可用"),
        "hf_dataset": _source("latest.json", _pairs(latest.get("datasets"), "id"),
                              latest.get("captured_at"), "Hugging Face 数据集快照不可用"),
        "hf_collection": _source("latest.json",
                                 _pairs(collections.get("items"), "slug", HF_COLLECTION_URL),
                                 collections.get("captured_at") or latest.get("captured_at"),
                                 f"Hugging Face 集合快照不可用（{collections.get('status') or '缺失'}）",
                                 available=collections_usable),
        # No Space collector exists yet. Declaring the domain with an absent
        # source keeps that gap visible in the payload instead of silently
        # dropping the link or claiming it is broken.
        "hf_space": _source(None, {}, None, "本站还没有 Space 来源，无法核对", available=False),
    }

    modelscope = read_json(data_dir / "modelscope.json")
    modelscope = modelscope if isinstance(modelscope, dict) else {}
    sources["ms_model"] = _source(
        "modelscope.json", _pairs(modelscope.get("models"), "id"), modelscope.get("captured_at"),
        f"ModelScope 快照不可用（{modelscope.get('status') or '缺失'}）",
        available=bool(modelscope.get("models")) and modelscope.get("status", "ok") in ("ok", "stale"))

    github = read_json(data_dir / "github.json")
    github = github if isinstance(github, dict) else {}
    repos = github.get("repositories") if isinstance(github.get("repositories"), list) else []
    account = github.get("account") if isinstance(github.get("account"), dict) else {}
    login = str(account.get("login") or "").lower()
    non_fork = {name for name, repo in ((r.get("full_name"), r) for r in repos if isinstance(r, dict))
                if isinstance(name, str) and not repo.get("is_fork")}
    # The denominator is our own work: a fork is somebody else's repository and a
    # row that is not ours at all must never show up as a gap to fill in.
    own = {name for name in non_fork if not login or _repo_owner(name) == login}
    gh_usable = bool(repos) and github.get("status", "ok") in ("ok", "stale")
    sources["gh_repo"] = {
        "available": gh_usable, "ids": _pairs(repos, "full_name"), "own": own if gh_usable else set(),
        "login": login,
        "captured_at": github.get("captured_at") if gh_usable else None,
        "file": "github.json",
        "reason": None if gh_usable else f"GitHub 仓库快照不可用（{github.get('status') or '缺失'}）",
    }

    scholar = read_json(data_dir / "scholar.json")
    scholar = scholar if isinstance(scholar, dict) else {}
    aliases: dict[str, str | None] = {}
    for paper in scholar.get("papers") if isinstance(scholar.get("papers"), list) else []:
        if not isinstance(paper, dict):
            continue
        alias = scholar_alias(paper.get("title"))
        if not alias:
            continue
        if alias in aliases:
            add_note(warnings, f"两篇论文的标题别名相同（{alias}），只保留第一篇")
            continue
        url = paper.get("url")
        aliases[alias] = url if isinstance(url, str) else None
    sources["scholar"] = _source("scholar.json", aliases, scholar.get("captured_at"),
                                 "学术档案快照不可用")

    conferences = read_json(data_dir / "conferences.json")
    conferences = conferences if isinstance(conferences, dict) else {}
    conf_ids = {item["key"]: _conference_url(item)
                for item in (conferences.get("conferences") or [])
                if isinstance(item, dict) and isinstance(item.get("key"), str)}
    sources["conf"] = _source("conferences.json", conf_ids, conferences.get("captured_at"),
                              "顶会目录快照不可用")

    templates = read_json(data_dir / "templates.json")
    templates = templates if isinstance(templates, dict) else {}
    sources["template"] = _source("templates.json", _pairs(templates.get("templates"), "id"),
                                  templates.get("captured_at"), "模版库快照不可用")
    return sources


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------

def normalise_links(raw: Any, slug: str, warnings: list[str], errors: list[str]) -> list[dict]:
    """Keep well-formed ``domain:id`` links; anything else is a structural error.

    A misspelt prefix can never be validated, so it is reported separately from
    a warning and makes ``--check`` fail: the author learns now, not when a
    link silently stops appearing on the board.
    """
    candidates = raw if isinstance(raw, list) else ([raw] if isinstance(raw, str) and raw.strip() else [])
    links: list[dict] = []
    seen: set[str] = set()
    for item in candidates:
        value = _clean_value(str(item))
        match = LINK_RE.match(value) if value else None
        if not match:
            add_note(errors, f"{slug}：链接「{value[:60]}」不是 domain:id 形态，已忽略")
            continue
        domain, target = match.group(1), match.group(2).strip()
        if domain not in DOMAINS:
            add_note(errors, f"{slug}：未知的链接前缀 {domain}:，已忽略")
            continue
        if not target:
            add_note(errors, f"{slug}：{domain}: 后面是空的，已忽略")
            continue
        if domain == "scholar":
            target = scholar_alias(target) or target
        key = f"{domain}:{target}"
        if key in seen:
            continue
        seen.add(key)
        if len(links) >= LINK_LIMIT:
            add_note(warnings, f"{slug}：链接超过 {LINK_LIMIT} 条，其余未发布")
            break
        links.append({"domain": domain, "id": target, "state": "unchecked", "url": None})
    return links


def build_entry(path: Path, repo: str, branch: str,
                warnings: list[str], errors: list[str]) -> dict:
    text = path.read_text(encoding="utf-8")
    metadata, body = parse_frontmatter(text)
    # The slug is the filename as written, never a folded variant: the source
    # link below has to point at a path that actually exists on GitHub.
    slug = path.stem
    if not metadata:
        add_note(errors, f"{path.name}：没有可解析的 front matter，字段将全部按未标注处理")
    kind = _clean_value(str(metadata.get("kind") or "")).lower()
    stage = _clean_value(str(metadata.get("stage") or "")).lower()
    updated = _clean_value(str(metadata.get("updated") or ""))
    if kind not in KINDS:
        add_note(errors, f"{slug}：kind「{kind[:24] or '空'}」不属于 {'/'.join(KINDS)}，按未标注处理")
        kind = ""
    if stage not in STAGES:
        add_note(errors, f"{slug}：stage「{stage[:24] or '空'}」不属于已知阶段，按未标注处理")
        stage = ""
    if updated and not DATE_RE.match(updated):
        add_note(errors, f"{slug}：updated「{updated[:24]}」不是 YYYY-MM-DD，按未标注处理")
        updated = ""
    # ``body`` below is cut at MAX_BODY_CHARS, but bytes/lines/sha256 describe
    # the whole file, so a truncated entry still shows its true size and still
    # diffs when the only edit lives past the cut.
    truncated = len(body) > MAX_BODY_CHARS
    entry = {
        "slug": slug,
        "title": _clean_value(str(metadata.get("title") or ""))[:TITLE_LIMIT] or slug,
        "kind": kind or None,
        "stage": stage or None,
        "tags": normalise_tags(metadata.get("tags"))[:TAG_LIMIT],
        "updated": updated or None,
        "links": normalise_links(metadata.get("links"), slug, warnings, errors),
        "bytes": len(body.encode("utf-8")),
        "lines": len(body.splitlines()),
        "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "truncated": truncated,
        "url": f"https://github.com/{repo}/blob/{branch}/entities/{slug}.md",
        "body": body[:MAX_BODY_CHARS],
    }
    return entry


def load_registry(directory: Path, repo: str, branch: str, *, warnings: list[str] | None = None,
                  errors: list[str] | None = None) -> list[dict]:
    warnings = warnings if warnings is not None else []
    errors = errors if errors is not None else []
    entries: list[dict] = []
    for path in sorted(directory.glob("*.md")):
        if not SLUG_PATTERN.match(path.stem):
            add_note(errors, f"跳过 {path.name}：文件名需为小写字母/数字/连字符")
            continue
        if len(entries) >= ENTRY_LIMIT:
            add_note(warnings, f"注册表条目超过 {ENTRY_LIMIT} 条，其余未发布")
            break
        try:
            entries.append(build_entry(path, repo, branch, warnings, errors))
        except (OSError, UnicodeDecodeError) as error:
            add_note(errors, f"跳过 {path.name}：无法读取（{type(error).__name__}）")
            continue
    return entries


# ---------------------------------------------------------------------------
# Validation and coverage
# ---------------------------------------------------------------------------

def _repo_owner(full_name: str) -> str:
    return (full_name.split("/", 1)[0] if "/" in full_name else full_name).lower()


def _match(source: dict, domain: str, ident: str) -> tuple[str, str | None]:
    """Find the snapshot's own record for an id, returning ``(id, url)`` or ``("", None)``.

    GitHub routes ``owner/repo`` without regard to case, so a hand-typed lowercase
    id is the same repository; the published id and url then carry the casing the
    snapshot used.  Hugging Face ids are matched exactly, because there the case
    is part of the identifier - ``--ids`` prints it.
    """
    ids = source.get("ids") or {}
    if ident in ids:
        return ident, ids[ident]
    if domain == "gh_repo":
        wanted = ident.lower()
        for name, url in ids.items():
            if name.lower() == wanted:
                return name, url
    return "", None


def classify(entries: list[dict], sources: dict[str, dict]) -> dict[str, int]:
    """Attach a state and a url to every link, in place, and tally the states.

    Only a ``resolved`` link publishes a url: a link on the board is a claim that
    the target was seen in that source's snapshot.
    """
    counts = {state: 0 for state in STATES}
    for entry in entries:
        for link in entry["links"]:
            source = sources.get(link["domain"]) or {}
            login = source.get("login") or ""
            link["url"] = None
            if source.get("available") is not True:
                link["state"] = "unchecked"
            elif link["domain"] == "gh_repo" and login and _repo_owner(link["id"]) != login:
                # Somebody else's repository: not a gap in our registry and not a
                # broken link. Deliberately not looked up in the star list.
                link["state"] = "out_of_scope"
            else:
                canonical, url = _match(source, link["domain"], link["id"])
                link["state"] = "resolved" if canonical else "unresolved"
                if canonical:
                    link["id"] = canonical
                    link["url"] = url if isinstance(url, str) else None
            counts[link["state"]] = counts.get(link["state"], 0) + 1
    return counts


def coverage(entries: list[dict], sources: dict[str, dict]) -> dict[str, dict]:
    """Per source: how much of our own published output the registry mentions."""
    registered: dict[str, set[str]] = {domain: set() for domain in COVERAGE_DOMAINS}
    for entry in entries:
        for link in entry["links"]:
            if link["state"] == "resolved" and link["domain"] in registered:
                registered[link["domain"]].add(link["id"])
    out: dict[str, dict] = {}
    for domain in COVERAGE_DOMAINS:
        source = sources.get(domain) or {}
        universe = set(source.get("own") or set()) if source.get("available") else set()
        missing = sorted(universe - registered[domain])
        out[domain] = {
            "available": source.get("available") is True,
            "total": len(universe),
            "registered": len(registered[domain] & universe),
            "unregistered": missing[:UNREGISTERED_LIMIT],
            "unregistered_count": len(missing),
            "truncated": len(missing) > UNREGISTERED_LIMIT,
        }
    return out


def summarise(entries: list[dict]) -> dict:
    tags: dict[str, int] = {}
    by_kind: dict[str, int] = {}
    by_stage: dict[str, int] = {}
    for entry in entries:
        by_kind[entry["kind"] or "未标注"] = by_kind.get(entry["kind"] or "未标注", 0) + 1
        by_stage[entry["stage"] or "未标注"] = by_stage.get(entry["stage"] or "未标注", 0) + 1
        for tag in entry["tags"]:
            tags[tag] = tags.get(tag, 0) + 1
    return {
        "total": len(entries),
        "links": sum(len(entry["links"]) for entry in entries),
        "by_kind": dict(sorted(by_kind.items())),
        "by_stage": dict(sorted(by_stage.items())),
        "tags": [{"tag": tag, "count": count} for tag, count in
                 sorted(tags.items(), key=lambda item: (-item[1], item[0]))],
    }


def revision_key(entry: dict) -> str:
    """What the author typed, so a sibling snapshot moving is not a revision.

    Link states and urls come and go with the other collectors; the registry only
    changed when one of its own fields did, which is what the board lists as
    「今日更新」.
    """
    return "|".join([
        entry.get("sha256") or "", entry.get("title") or "", entry.get("kind") or "",
        entry.get("stage") or "", entry.get("updated") or "",
        ",".join(entry.get("tags") or []),
        ",".join(f"{item.get('domain')}:{item.get('id')}"
                 for item in (entry.get("links") or []) if isinstance(item, dict)),
    ])


def previous_rows(previous: dict) -> dict[str, dict]:
    """Index the last snapshot by slug, so a run can be diffed against it."""
    rows = previous.get("entries")
    if not isinstance(rows, list):
        return {}
    return {row["slug"]: row for row in rows
            if isinstance(row, dict) and isinstance(row.get("slug"), str)}


def compare_rows(before: dict[str, dict], entries: list[dict]) -> dict:
    current = {entry["slug"]: entry for entry in entries}
    empty: list[str] = []
    if not before:
        return {"status": "initial",
                "added": sorted(current)[:CHANGE_LIMIT], "removed": empty, "revised": empty,
                "added_count": len(current), "removed_count": 0, "revised_count": 0,
                "truncated": len(current) > CHANGE_LIMIT}
    added = sorted(set(current) - set(before))
    removed = sorted(set(before) - set(current))
    revised = sorted(name for name in set(current) & set(before)
                     if revision_key(current[name]) != revision_key(before[name]))
    widths = max(len(added), len(removed), len(revised))
    return {
        "status": "compared",
        "added": added[:CHANGE_LIMIT], "removed": removed[:CHANGE_LIMIT],
        "revised": revised[:CHANGE_LIMIT],
        "added_count": len(added), "removed_count": len(removed), "revised_count": len(revised),
        "truncated": widths > CHANGE_LIMIT,
    }


def history_snapshot(history: dict, entries: list[dict], counts: dict, at: dt.datetime,
                     retention_days: int = HISTORY_RETENTION_DAYS) -> dict:
    moment = utc(at)
    day = moment.date().isoformat()
    snapshots = [s for s in (history.get("snapshots") or []) if isinstance(s, dict) and s.get("date")]
    snapshots = [s for s in snapshots if s["date"] != day]
    summary = summarise(entries)
    snapshots.append({
        "date": day,
        "total": summary["total"],
        "links": summary["links"],
        "by_stage": summary["by_stage"],
        "resolved": counts.get("resolved", 0),
        "unresolved": counts.get("unresolved", 0),
        "ids": [entry["slug"] for entry in entries],
    })
    snapshots.sort(key=lambda snap: str(snap.get("date") or ""))
    cutoff = (moment.date() - dt.timedelta(days=retention_days)).isoformat()
    return {"schema_version": SCHEMA_VERSION, "source": {"id": SOURCE_ID},
            "updated_at": timestamp(at), "retention_days": retention_days,
            "snapshots": [s for s in snapshots if str(s.get("date") or "") >= cutoff]}


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------

def load_previous(path: Path) -> dict:
    value = read_json(path)
    return value if isinstance(value, dict) else {}


def _envelope(at: dt.datetime, repo: str, branch: str) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {"id": SOURCE_ID, "directory": "entities", "repo": repo, "branch": branch,
                   "url": f"https://github.com/{repo}/tree/{branch}/entities"},
        "captured_at": None, "last_attempt_at": timestamp(at),
    }


def publish(data_dir: Path, at: dt.datetime, *, directory: Path | None = None,
            repo: str = "isLinXu/model-observatory", branch: str = "main",
            sources: dict[str, dict] | None = None) -> str:
    """Read, validate and write. A failure keeps every previous file intact."""
    at = utc(at)
    directory = directory if directory is not None else ROOT / "entities"
    path = data_dir / "entities.json"
    previous = load_previous(path)
    if isinstance(previous.get("captured_at"), str):
        try:
            saved = dt.datetime.fromisoformat(previous["captured_at"].replace("Z", "+00:00"))
        except ValueError:
            saved = None
        if saved is not None and saved > at:
            return "rejected"

    if not directory.is_dir():
        return write_stale(data_dir, at, previous, RegistryError("directory"), repo=repo, branch=branch)

    warnings: list[str] = []
    errors: list[str] = []
    entries = load_registry(directory, repo, branch, warnings=warnings, errors=errors)
    if sources is None:
        sources = load_sources(data_dir, warnings)
    counts = classify(entries, sources)
    attempt = timestamp(at)
    payload = _envelope(at, repo, branch)
    payload.update({
        "status": "ok",
        "error": None,
        "captured_at": attempt,
        "summary": summarise(entries),
        "validation": counts,
        "coverage": coverage(entries, sources),
        "sources": {domain: {"file": src.get("file"), "available": src.get("available") is True,
                             "captured_at": src.get("captured_at"), "reason": src.get("reason")}
                    for domain, src in sources.items()},
        "changes": compare_rows(previous_rows(previous), entries),
        "entries": entries,
        "structural_errors": errors,
        "warnings": warnings,
    })
    atomic_json_write(path, payload)
    history_path = data_dir / "entities_history.json"
    atomic_json_write(history_path,
                      history_snapshot(load_previous(history_path), entries, counts, at))
    return "ok"


def write_stale(data_dir: Path, at: dt.datetime, previous: dict, error: Exception, *,
                repo: str, branch: str) -> str:
    """Keep the last good index visible, but say plainly that it was not re-read."""
    entries = previous.get("entries") if isinstance(previous.get("entries"), list) else []
    entries = [row for row in entries if isinstance(row, dict)]
    for row in entries:
        # An index written by an older collector may miss fields; classify needs a
        # list of links to walk, and no link claim survives without a source.
        row["links"] = [dict(link) for link in (row.get("links") or []) if isinstance(link, dict)]
    warnings: list[str] = []
    sources = load_sources(data_dir, warnings)
    counts = classify(entries, sources) if entries else {state: 0 for state in STATES}
    payload = _envelope(at, repo, branch)
    payload.update({
        "status": "stale" if entries else "unavailable",
        "error": safe_error(error),
        "captured_at": previous.get("captured_at") if entries else None,
        "summary": summarise(entries),
        "validation": counts,
        "coverage": coverage(entries, sources),
        "sources": {domain: {"file": src.get("file"), "available": src.get("available") is True,
                             "captured_at": src.get("captured_at"), "reason": src.get("reason")}
                    for domain, src in sources.items()},
        "changes": previous.get("changes") if isinstance(previous.get("changes"), dict) else
                   compare_rows({}, []),
        "entries": entries,
        "structural_errors": previous.get("structural_errors") if entries else [],
        "warnings": warnings,
    })
    atomic_json_write(data_dir / "entities.json", payload)
    return "stale" if entries else "unavailable"


# ---------------------------------------------------------------------------
# Local developer commands (--check and --ids)
# ---------------------------------------------------------------------------

def inspect(directory: Path, data_dir: Path, *, repo: str = "isLinXu/model-observatory",
             branch: str = "main") -> dict:
    """Parse and validate without writing anything."""
    warnings: list[str] = []
    errors: list[str] = []
    entries = load_registry(directory, repo, branch, warnings=warnings, errors=errors) \
        if directory.is_dir() else []
    if not directory.is_dir():
        errors.append(f"注册表目录不存在：{directory.name}")
    sources = load_sources(data_dir, warnings)
    return {"entries": entries, "warnings": warnings, "errors": errors,
             "counts": classify(entries, sources), "coverage": coverage(entries, sources),
             "sources": sources}


def format_check(report: dict, *, strict: bool = False) -> tuple[str, int]:
    counts = report["counts"]
    lines = [f"{len(report['entries'])} 个实体 · 链接 resolved {counts['resolved']} / "
             f"unresolved {counts['unresolved']} / unchecked {counts['unchecked']} / "
             f"out_of_scope {counts['out_of_scope']}"]
    for domain, stats in report["coverage"].items():
        if not stats["available"]:
            lines.append(f"  {domain:13s} 来源不可用，覆盖率未核对")
            continue
        lines.append(f"  {domain:13s} 已登记 {stats['registered']}/{stats['total']}"
                     f" · 未登记 {stats['unregistered_count']}")
    for entry in report["entries"]:
        for link in entry["links"]:
            if link["state"] == "unresolved":
                lines.append(f"  断链：{entry['slug']} → {link['domain']}:{link['id']}")
    for note in report["errors"]:
        lines.append(f"  结构错误：{note}")
    for note in report["warnings"]:
        lines.append(f"  提示：{note}")
    code = 1 if report["errors"] else 0
    if strict and counts["unresolved"]:
        code = 1
        lines.append("  --strict：存在断链，判定失败")
    return "\n".join(lines), code


def format_ids(report: dict, *, domain: str | None = None, grep: str = "") -> str:
    lines: list[str] = []
    for name, source in report["sources"].items():
        if domain and name != domain:
            continue
        if not source.get("available"):
            lines.append(f"# {name}: {(source.get('reason') or '来源不可用')}")
            continue
        for ident in sorted(source.get("own") or source.get("ids") or {}):
            if grep and grep.lower() not in ident.lower():
                continue
            lines.append(f"{name}:{ident}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Index the hand-maintained entity registry")
    parser.add_argument("--entities-dir", type=Path, default=ROOT / "entities")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--repo", default="isLinXu/model-observatory")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--check", action="store_true",
                        help="parse and validate without writing; exit 1 on structural errors")
    parser.add_argument("--strict", action="store_true", help="with --check, fail on broken links too")
    parser.add_argument("--ids", action="store_true", help="list the ids this run can link to")
    parser.add_argument("--domain", help="with --ids, restrict to one link domain")
    parser.add_argument("--grep", default="", help="with --ids, filter by substring")
    args = parser.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    if args.ids:
        print(format_ids(inspect(args.entities_dir, args.data_dir, repo=args.repo, branch=args.branch),
                         domain=args.domain, grep=args.grep))
        return 0
    if args.check:
        text, code = format_check(inspect(args.entities_dir, args.data_dir, repo=args.repo,
                                          branch=args.branch), strict=args.strict)
        print(text)
        return code

    args.data_dir.mkdir(parents=True, exist_ok=True)
    result = publish(args.data_dir, now, directory=args.entities_dir, repo=args.repo,
                     branch=args.branch)
    if result == "ok":
        latest = json.loads((args.data_dir / "entities.json").read_text(encoding="utf-8"))
        counts = latest["validation"]
        print(f"indexed {latest['summary']['total']} entities · "
              f"resolved {counts['resolved']} · unresolved {counts['unresolved']} · "
              f"unchecked {counts['unchecked']} · out_of_scope {counts['out_of_scope']}"
              + (f" · {len(latest['structural_errors'])} 处结构错误" if latest["structural_errors"] else ""))
    else:
        print(f"注册表采集结果为 {result}，保留上一次快照", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
