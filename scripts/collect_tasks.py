#!/usr/bin/env python3
"""Index the hand-maintained task board and cross-check what it points at.

One task is one Markdown file, ``tasks/<slug>.md``: frontmatter carries the
structure (status, the parent it was decomposed from, what it depends on, the
research object or deadline it serves) and the body carries the acceptance note
the collector cannot know.  The format is the one ``entities/`` already uses, so
the same parser, the same slug rule and the same failure behaviour apply.

The board stores **work, not metrics**.  A task never copies a download count,
a star total or a citation number; when it needs one it references the owner -
``entity: <slug>`` for the entity registry, ``ddl: <event id>`` for the
conference board - and that board keeps the number and its ``captured_at``.

References are checked against the sibling snapshots written earlier in the
same workflow run and land in one of three states:

* ``resolved``       the target exists in that source's snapshot
* ``unresolved``     the source answered, and the slug or event id is gone
* ``missing_index``  no usable snapshot, so nothing was claimed

``missing_index`` matters for the same reason ``unchecked`` does: a failed
conference capture must not be reported as "this task points at nothing",
because that trains the reader to ignore the board.

Each file also publishes its git blob SHA-1, which is what the browser uses as
a baseline before it writes a task back - a push that would overwrite an edit
made after the last snapshot is refused instead of silently winning.

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

try:  # executed as a script (python scripts/collect_tasks.py)
    from collect import atomic_json_write, blob_sha
    from collect_templates import (MAX_BODY_CHARS, SLUG_PATTERN, _clean_value,
                                   normalise_tags, parse_frontmatter)
except ImportError:  # imported as a module (from scripts.collect_tasks import ...)
    from scripts.collect import atomic_json_write, blob_sha
    from scripts.collect_templates import (MAX_BODY_CHARS, SLUG_PATTERN, _clean_value,
                                          normalise_tags, parse_frontmatter)

SCHEMA_VERSION = 1
SOURCE_ID = "tasks"
ROOT = Path(__file__).resolve().parent.parent
HISTORY_RETENTION_DAYS = 1100

CHANGE_LIMIT = 200
WARNING_LIMIT = 100
TASK_LIMIT = 400
DEPENDS_LIMIT = 12
EDGE_LIMIT = 600
TITLE_LIMIT = 120
TAG_LIMIT = 8
REASON_LIMIT = 160

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}$")

# Six states that describe *me*, the person doing the work - deliberately not the
# entity registry's stages, which describe a research object.  Reusing those
# words would make both boards say something vaguer than they do today.
STATUSES = ("proposal", "doing", "blocked", "review", "done", "dropped")
# Moving into these is progress; leaving them backwards is a regression; every
# other change (doing -> blocked) is a move, not progress.  Column order is not
# a progress bar, so no bucket is inferred from position in STATUSES.
FINISHED = ("review", "done")

ERROR_MESSAGES = {
    "directory": "任务目录不存在，保留上一次快照。",
    "schema": "任务看板的结构不符合预期，保留上一次快照。",
}

MISSING = "missing"
RESOLVED = "resolved"
UNRESOLVED = "unresolved"
MISSING_INDEX = "missing_index"


class BoardError(RuntimeError):
    """The task directory could not be read at all; the previous snapshot stays."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(ERROR_MESSAGES.get(code, f"任务看板采集失败（{code}）。"))
        self.code = code
        self.detail = detail[:200]


def utc(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise BoardError("schema", "采集时间缺少时区")
    return value.astimezone(dt.timezone.utc)


def timestamp(value: dt.datetime) -> str:
    return utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_error(error: Exception) -> str:
    """Published reasons never carry a path, token or response body."""
    if isinstance(error, BoardError):
        return ERROR_MESSAGES.get(error.code, str(error))
    return "任务看板采集失败。"


def add_note(bucket: list[str], message: str, limit: int = WARNING_LIMIT) -> None:
    if len(bucket) >= limit:
        if bucket and bucket[-1] != "更多条目已省略":
            bucket.append("更多条目已省略")
        return
    if message not in bucket:
        bucket.append(message)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def list_or_text(raw: Any) -> list[str]:
    """Accept a list, a comma-separated string, or nothing at all."""
    if raw is None:
        return []
    candidates = raw if isinstance(raw, list) else [raw]
    out: list[str] = []
    for item in candidates:
        for part in str(item).replace("，", ",").split(","):
            value = _clean_value(part)
            if value and value not in out:
                out.append(value)
    return out


# ---------------------------------------------------------------------------
# Sources: what the other collectors published in this run
# ---------------------------------------------------------------------------

def _ref_source(name: str, ids: set[str], captured_at: Any, reason: str,
                usable: bool) -> dict:
    """``available`` asks one question: did that source answer us today?

    An index that answered and listed nothing is still an answer - a task
    pointing at a research object it does not name is a broken reference, and
    calling that 未核对 would hide the only thing the author can fix.
    """
    return {"available": usable, "ids": ids, "file": name,
            "captured_at": captured_at if usable else None,
            "reason": None if usable else reason}


def entity_slugs(data_dir: Path, warnings: list[str]) -> dict:
    """The registry's own ids, so a task can point at a research object."""
    payload = read_json(data_dir / "entities.json")
    payload = payload if isinstance(payload, dict) else {}
    state = payload.get("status") or ("缺失" if not payload else "未知")
    usable = bool(payload) and payload.get("status", "ok") in ("ok", "stale")
    entries = payload.get("entries") if isinstance(payload.get("entries"), list) else []
    slugs = {row["slug"] for row in entries
             if isinstance(row, dict) and isinstance(row.get("slug"), str)} if usable else set()
    if not usable:
        add_note(warnings, f"实体索引{state}，任务里的 entity 引用按未核对处理")
    return _ref_source("entities.json", slugs, payload.get("captured_at"),
                       f"实体注册表快照不可用（{state}）", usable)


def conference_events(data_dir: Path, warnings: list[str]) -> dict:
    """Event ids only: the deadline itself stays owned by the conference board."""
    payload = read_json(data_dir / "conferences.json")
    payload = payload if isinstance(payload, dict) else {}
    state = payload.get("status") or ("缺失" if not payload else "未知")
    usable = bool(payload) and payload.get("status", "ok") in ("ok", "stale")
    conferences = payload.get("conferences") if isinstance(payload.get("conferences"), list) else []
    ids: set[str] = set()
    if usable:
        for conference in conferences:
            if not isinstance(conference, dict):
                continue
            for edition in conference.get("editions") or []:
                if not isinstance(edition, dict):
                    continue
                for event in edition.get("events") or []:
                    if isinstance(event, dict) and isinstance(event.get("id"), str):
                        ids.add(event["id"])
    else:
        add_note(warnings, f"顶会目录{state}，任务里的 ddl 引用按未核对处理")
    return _ref_source("conferences.json", ids, payload.get("captured_at"),
                       f"顶会目录快照不可用（{state}）", usable)


def load_sources(data_dir: Path, warnings: list[str]) -> dict[str, dict]:
    return {"entity": entity_slugs(data_dir, warnings),
            "ddl": conference_events(data_dir, warnings)}


def classify_ref(value: str | None, source: dict) -> str | None:
    """One reference, three states - and never an invented 断链."""
    if not value:
        return None
    if source.get("available") is not True:
        return MISSING_INDEX
    return RESOLVED if value in source.get("ids", set()) else UNRESOLVED


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

def normalise_depends(raw: Any, slug: str, warnings: list[str]) -> list[str]:
    """Keep the list as authored, only capped.

    A self-dependency or a missing target stays visible here so the card can
    show what was written; ``build_edges`` is the one that refuses to draw it.
    """
    items = list_or_text(raw)
    if len(items) > DEPENDS_LIMIT:
        add_note(warnings, f"{slug}：depends 超过 {DEPENDS_LIMIT} 条，其余未发布")
        items = items[:DEPENDS_LIMIT]
    return items


def build_task(path: Path, repo: str, branch: str,
               warnings: list[str], errors: list[str]) -> dict:
    text = path.read_text(encoding="utf-8")
    metadata, body = parse_frontmatter(text)
    # The slug is the filename as written, so the source link points at a path
    # that actually exists on GitHub.
    slug = path.stem
    if not metadata:
        add_note(errors, f"{path.name}：没有可解析的 front matter，字段将全部按未标注处理")
    status = _clean_value(str(metadata.get("status") or "")).lower()
    updated = _clean_value(str(metadata.get("updated") or ""))
    reason = _clean_value(str(metadata.get("reason") or ""))
    if status not in STATUSES:
        add_note(errors, f"{slug}：status「{status[:24] or '空'}」不属于 {'/'.join(STATUSES)}，按未标注处理")
        status = ""
    if updated and not DATE_RE.match(updated):
        add_note(errors, f"{slug}：updated「{updated[:24]}」不是 YYYY-MM-DD，按未标注处理")
        updated = ""
    if len(reason) > REASON_LIMIT:
        add_note(warnings, f"{slug}：受阻原因超过 {REASON_LIMIT} 字符，已截断")
        reason = reason[:REASON_LIMIT]
    # ``body`` is cut at MAX_BODY_CHARS, but bytes/lines/sha256 measure the whole
    # body and blob_sha hashes the whole file: a truncated note still shows its
    # true size, and an edit past the cut still diffs and still moves the push
    # baseline - which is exactly what a baseline has to be sensitive to.
    encoded = text.encode("utf-8")
    return {
        "slug": slug,
        "title": _clean_value(str(metadata.get("title") or ""))[:TITLE_LIMIT] or slug,
        "status": status or None,
        "parent": _clean_value(str(metadata.get("parent") or "")) or None,
        "depends": normalise_depends(metadata.get("depends"), slug, warnings),
        "entity": _clean_value(str(metadata.get("entity") or "")) or None,
        "ddl": _clean_value(str(metadata.get("ddl") or "")) or None,
        "tags": normalise_tags(metadata.get("tags"))[:TAG_LIMIT],
        "updated": updated or None,
        "reason": reason or None,
        "bytes": len(body.encode("utf-8")),
        "lines": len(body.splitlines()),
        "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "blob_sha": blob_sha(encoded),
        "truncated": len(body) > MAX_BODY_CHARS,
        "url": f"https://github.com/{repo}/blob/{branch}/tasks/{slug}.md",
        "body": body[:MAX_BODY_CHARS],
    }


def load_board(directory: Path, repo: str, branch: str, *, warnings: list[str] | None = None,
               errors: list[str] | None = None) -> list[dict]:
    warnings = warnings if warnings is not None else []
    errors = errors if errors is not None else []
    tasks: list[dict] = []
    for path in sorted(directory.glob("*.md")):
        if not SLUG_PATTERN.match(path.stem):
            add_note(errors, f"跳过 {path.name}：文件名需为小写字母/数字/连字符")
            continue
        if len(tasks) >= TASK_LIMIT:
            add_note(warnings, f"任务超过 {TASK_LIMIT} 条，其余未发布")
            break
        try:
            tasks.append(build_task(path, repo, branch, warnings, errors))
        except (OSError, UnicodeDecodeError) as error:
            add_note(errors, f"跳过 {path.name}：无法读取（{type(error).__name__}）")
            continue
    return tasks


# ---------------------------------------------------------------------------
# Edges: decomposition (parent) and connection (depends)
# ---------------------------------------------------------------------------

def _reaches(adjacency: dict[str, list[str]], start: str, target: str) -> bool:
    """Can ``start`` already get to ``target``? Then target -> start closes a cycle."""
    seen, stack = set(), [start]
    while stack:
        node = stack.pop()
        if node == target:
            return True
        if node in seen:
            continue
        seen.add(node)
        stack.extend(adjacency.get(node) or [])
    return False


def build_edges(tasks: list[dict], errors: list[str]) -> dict:
    """Two independent graphs, because 拆解 and 依赖 are two different questions.

    A cycle in either one is unrecoverable on a canvas - the card can never be
    dragged out of it - so the offending edge is dropped here and named, rather
    than published and left for the reader to discover.
    """
    slugs = {task["slug"] for task in tasks}
    graphs: dict[str, dict[str, list[str]]] = {"parent": {}, "depends": {}}
    edges: list[dict] = []
    dropped: list[dict] = []

    def offer(kind: str, source: str, target: str) -> None:
        adjacency = graphs[kind]
        if target not in slugs:
            add_note(errors, f"{source}：{kind} 指向不存在的 {target}，该边未发布")
            dropped.append({"from": source, "to": target, "type": kind, "reason": MISSING})
            return
        if source == target:
            add_note(errors, f"{source}：{kind} 指向自己，该边未发布")
            dropped.append({"from": source, "to": target, "type": kind, "reason": "self"})
            return
        if _reaches(adjacency, target, source):
            add_note(errors, f"{source}：{kind} 会成环（{target} 已能回到 {source}），该边未发布")
            dropped.append({"from": source, "to": target, "type": kind, "reason": "cycle"})
            return
        adjacency.setdefault(source, []).append(target)
        edges.append({"from": source, "to": target, "type": kind})

    for task in tasks:
        if task.get("parent"):
            offer("parent", task["slug"], task["parent"])
    for task in tasks:
        for target in task.get("depends") or []:
            offer("depends", task["slug"], target)
    missing_parents = sum(1 for task in tasks if task.get("parent") and task["parent"] not in slugs)
    missing_depends = sum(1 for row in dropped
                          if row["type"] == "depends" and row["reason"] == MISSING)
    return {"edges": edges, "dropped": dropped, "missing_parents": missing_parents,
            "missing_depends": missing_depends}


def attach_refs(tasks: list[dict], sources: dict[str, dict]) -> dict:
    """Stamp every reference with its state, and tally what needs a look."""
    out: dict[str, dict[str, int]] = {}
    for field, source in (("entity", sources["entity"]), ("ddl", sources["ddl"])):
        tally = {RESOLVED: 0, UNRESOLVED: 0, MISSING_INDEX: 0}
        for task in tasks:
            state = classify_ref(task.get(field), source)
            task[f"{field}_state"] = state
            if state:
                tally[state] += 1
        out[field] = tally
    return out


# ---------------------------------------------------------------------------
# Summary, changes, history
# ---------------------------------------------------------------------------

def summarise(tasks: list[dict], edges: list[dict]) -> dict:
    by_status: dict[str, int] = {}
    tags: dict[str, int] = {}
    for task in tasks:
        key = task.get("status") or "未标注"
        by_status[key] = by_status.get(key, 0) + 1
        for tag in task.get("tags") or []:
            tags[tag] = tags.get(tag, 0) + 1
    return {
        "total": len(tasks),
        "edges": len(edges),
        "roots": sum(1 for task in tasks if not task.get("parent")),
        "blocked": by_status.get("blocked", 0),
        "by_status": dict(sorted(by_status.items())),
        "by_tag": [{"tag": tag, "count": count} for tag, count in
                   sorted(tags.items(), key=lambda item: (-item[1], item[0]))],
    }


def revision_key(task: dict) -> str:
    """What the author typed, minus the status.

    Status changes are reported as 推进 / 回退 / 移动, so they must not also land
    in 修订 - one edit, one line in the changelog.
    """
    return "|".join([
        task.get("sha256") or "", task.get("title") or "", task.get("parent") or "",
        task.get("entity") or "", task.get("ddl") or "", task.get("reason") or "",
        task.get("updated") or "",
        ",".join(task.get("tags") or []), ",".join(task.get("depends") or []),
    ])


def classify_move(before: str | None, after: str | None) -> str:
    """Progress is a set of destinations, not a column order."""
    if (after or "") == (before or ""):
        return "same"
    if after in FINISHED and before not in FINISHED:
        return "advanced"
    if before in FINISHED and after not in FINISHED:
        return "regressed"
    return "moved"


def previous_rows(previous: dict) -> dict[str, dict]:
    rows = previous.get("tasks")
    if not isinstance(rows, list):
        return {}
    return {row["slug"]: row for row in rows
            if isinstance(row, dict) and isinstance(row.get("slug"), str)}


def compare_rows(before: dict[str, dict], tasks: list[dict]) -> dict:
    current = {task["slug"]: task for task in tasks}
    empty: list[str] = []
    if not before:
        return {"status": "initial",
                "added": sorted(current)[:CHANGE_LIMIT], "removed": empty, "revised": empty,
                "advanced": empty, "regressed": empty, "moved": empty,
                "added_count": len(current), "removed_count": 0, "revised_count": 0,
                "advanced_count": 0, "regressed_count": 0, "moved_count": 0,
                "truncated": len(current) > CHANGE_LIMIT}
    added = sorted(set(current) - set(before))
    removed = sorted(set(before) - set(current))
    advanced: list[str] = []
    regressed: list[str] = []
    moved: list[str] = []
    revised: list[str] = []
    for slug in sorted(set(current) & set(before)):
        now, was = current[slug], before[slug]
        kind = classify_move(was.get("status"), now.get("status"))
        if kind == "same":
            if revision_key(now) != revision_key(was):
                revised.append(slug)
            continue
        {"advanced": advanced, "regressed": regressed, "moved": moved}[kind].append(slug)
    widths = max(len(added), len(removed), len(revised), len(advanced), len(regressed), len(moved))
    return {
        "status": "compared",
        "added": added[:CHANGE_LIMIT], "removed": removed[:CHANGE_LIMIT],
        "revised": revised[:CHANGE_LIMIT], "advanced": advanced[:CHANGE_LIMIT],
        "regressed": regressed[:CHANGE_LIMIT], "moved": moved[:CHANGE_LIMIT],
        "added_count": len(added), "removed_count": len(removed), "revised_count": len(revised),
        "advanced_count": len(advanced), "regressed_count": len(regressed),
        "moved_count": len(moved),
        "truncated": widths > CHANGE_LIMIT,
    }


def history_snapshot(history: dict, tasks: list[dict], summary: dict, at: dt.datetime,
                     retention_days: int = HISTORY_RETENTION_DAYS) -> dict:
    moment = utc(at)
    day = moment.date().isoformat()
    snapshots = [s for s in (history.get("snapshots") or []) if isinstance(s, dict) and s.get("date")]
    snapshots = [s for s in snapshots if s["date"] != day]
    snapshots.append({
        "date": day,
        "total": summary["total"],
        "edges": summary["edges"],
        "roots": summary["roots"],
        "blocked": summary["blocked"],
        "by_status": summary["by_status"],
        "ids": [task["slug"] for task in tasks],
    })
    snapshots.sort(key=lambda snap: str(snap.get("date") or ""))
    cutoff = (moment.date() - dt.timedelta(days=retention_days)).isoformat()
    return {"schema_version": SCHEMA_VERSION, "source": {"id": SOURCE_ID},
            "updated_at": timestamp(at), "retention_days": retention_days,
            "snapshots": [s for s in snapshots if str(s.get("date") or "") >= cutoff]}


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------

def _envelope(at: dt.datetime, repo: str, branch: str) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {"id": SOURCE_ID, "directory": "tasks", "repo": repo, "branch": branch,
                   "url": f"https://github.com/{repo}/tree/{branch}/tasks"},
        "captured_at": None, "last_attempt_at": timestamp(at),
    }


def _index(at: dt.datetime, tasks: list[dict], sources: dict[str, dict],
           repo: str, branch: str, warnings: list[str], errors: list[str]) -> dict:
    """One index, built the same way whether this run succeeded or fell back."""
    graph = build_edges(tasks, errors)
    refs = attach_refs(tasks, sources)
    summary = summarise(tasks, graph["edges"])
    envelope = _envelope(at, repo, branch)
    envelope.update({
        "summary": summary,
        "validation": {
            "parent_missing": graph["missing_parents"],
            "depends_missing": graph["missing_depends"],
            "self_edges": sum(1 for row in graph["dropped"] if row["reason"] == "self"),
            "cycles": sum(1 for row in graph["dropped"] if row["reason"] == "cycle"),
            "refs": refs,
        },
        "sources": {name: {key: src.get(key) for key in ("file", "available", "captured_at", "reason")}
                    for name, src in sources.items()},
        "graph": {"edges": graph["edges"][:EDGE_LIMIT],
                  "dropped": graph["dropped"],
                  "truncated": len(graph["edges"]) > EDGE_LIMIT},
        "tasks": tasks,
        "structural_errors": errors,
        "warnings": warnings,
    })
    return envelope


def publish(data_dir: Path, at: dt.datetime, *, directory: Path | None = None,
             repo: str = "isLinXu/model-observatory", branch: str = "main",
             sources: dict[str, dict] | None = None) -> str:
    """Read, validate and write. A failure keeps every previous file intact."""
    at = utc(at)
    directory = directory if directory is not None else ROOT / "tasks"
    path = data_dir / "tasks.json"
    previous = load_previous(path)
    if isinstance(previous.get("captured_at"), str):
        try:
            saved = dt.datetime.fromisoformat(previous["captured_at"].replace("Z", "+00:00"))
        except ValueError:
            saved = None
        if saved is not None and saved > at:
            return "rejected"

    if not directory.is_dir():
        return write_stale(data_dir, at, previous, BoardError("directory"), repo=repo, branch=branch)

    warnings: list[str] = []
    errors: list[str] = []
    tasks = load_board(directory, repo, branch, warnings=warnings, errors=errors)
    if sources is None:
        sources = load_sources(data_dir, warnings)
    payload = _index(at, tasks, sources, repo, branch, warnings, errors)
    payload["status"] = "ok"
    payload["error"] = None
    payload["captured_at"] = payload["last_attempt_at"]
    payload["changes"] = compare_rows(previous_rows(previous), tasks)
    atomic_json_write(path, payload)
    history_path = data_dir / "tasks_history.json"
    atomic_json_write(history_path,
                      history_snapshot(load_previous(history_path), tasks, payload["summary"], at))
    return "ok"


def load_previous(path: Path) -> dict:
    value = read_json(path)
    return value if isinstance(value, dict) else {}


def write_stale(data_dir: Path, at: dt.datetime, previous: dict, error: Exception, *,
                repo: str, branch: str) -> str:
    """Keep the last good board visible, but say plainly that it was not re-read."""
    rows = previous.get("tasks") if isinstance(previous.get("tasks"), list) else []
    tasks = [dict(row) for row in rows if isinstance(row, dict)]
    warnings: list[str] = []
    sources = load_sources(data_dir, warnings)
    payload = _index(at, tasks, sources, repo, branch, warnings,
                     list(previous.get("structural_errors") or []) if tasks else [])
    payload["status"] = "stale" if tasks else "unavailable"
    payload["error"] = safe_error(error)
    payload["captured_at"] = previous.get("captured_at") if tasks else None
    payload["changes"] = previous.get("changes") if isinstance(previous.get("changes"), dict) \
        else compare_rows({}, [])
    if not tasks:
        payload["structural_errors"] = []
    atomic_json_write(data_dir / "tasks.json", payload)
    return "stale" if tasks else "unavailable"


# ---------------------------------------------------------------------------
# Local developer commands (--check and --ids)
# ---------------------------------------------------------------------------

def inspect(directory: Path, data_dir: Path, *, repo: str = "isLinXu/model-observatory",
            branch: str = "main") -> dict:
    """Parse and validate without writing anything."""
    warnings: list[str] = []
    errors: list[str] = []
    tasks = load_board(directory, repo, branch, warnings=warnings, errors=errors) \
        if directory.is_dir() else []
    if not directory.is_dir():
        errors.append(f"任务目录不存在：{directory.name}")
    sources = load_sources(data_dir, warnings)
    payload = _index(utc(dt.datetime.now(dt.timezone.utc)), tasks, sources, repo, branch,
                     warnings, errors)
    payload["status"] = "ok"
    payload["error"] = None
    payload["changes"] = compare_rows({}, [])
    return {"tasks": tasks, "warnings": warnings, "errors": errors, "sources": sources,
            "summary": payload["summary"], "validation": payload["validation"],
            "graph": payload["graph"]}


def format_check(report: dict, *, strict: bool = False) -> tuple[str, int]:
    summary = report["summary"]
    validation = report["validation"]
    refs = validation["refs"]
    lines = [f"{summary['total']} 个任务 · {summary['roots']} 个根任务 · "
             f"{summary['blocked']} 个受阻 · 边 {summary['edges']} 条"]
    lines.append("  " + " · ".join(f"{name} {count}" for name, count in
                                   summary["by_status"].items()))
    for name, states in (("entity", refs["entity"]), ("ddl", refs["ddl"])):
        lines.append(f"  {name:6s} 引用 {states[RESOLVED]} / 未找到 {states[UNRESOLVED]} / "
                     f"未核对 {states[MISSING_INDEX]}（{report['sources'][name]['file']}）")
    for edge in report["graph"]["dropped"]:
        lines.append(f"  未发布：{edge['from']} -{edge['type']}-> {edge['to']}（{edge['reason']}）")
    for note in report["errors"]:
        lines.append(f"  结构错误：{note}")
    for note in report["warnings"]:
        lines.append(f"  提示：{note}")
    code = 1 if report["errors"] else 0
    if strict and (validation["parent_missing"] or validation["depends_missing"] or
                   refs["entity"][UNRESOLVED] or refs["ddl"][UNRESOLVED]):
        code = 1
        lines.append("  --strict：存在断引用，判定失败")
    return "\n".join(lines), code


def format_ids(report: dict, *, domain: str | None = None, grep: str = "") -> str:
    """What a task may point at, straight from this run's own snapshots."""
    lines: list[str] = []
    if domain in (None, "task"):
        for task in report["tasks"]:
            if grep and grep.lower() not in task["slug"].lower():
                continue
            lines.append(f"task:{task['slug']}")
    for name in ("entity", "ddl"):
        if domain not in (None, name):
            continue
        source = report["sources"][name]
        if not source.get("available"):
            lines.append(f"# {name}: {(source.get('reason') or '来源不可用')}")
            continue
        for ident in sorted(source.get("ids") or set()):
            if grep and grep.lower() not in ident.lower():
                continue
            lines.append(f"{name}:{ident}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Index the hand-maintained task board")
    parser.add_argument("--tasks-dir", type=Path, default=ROOT / "tasks")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--repo", default="isLinXu/model-observatory")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--check", action="store_true",
                        help="parse and validate without writing; exit 1 on structural errors")
    parser.add_argument("--strict", action="store_true", help="with --check, fail on broken refs too")
    parser.add_argument("--ids", action="store_true", help="list the ids a task may point at")
    parser.add_argument("--domain", choices=("task", "entity", "ddl"),
                        help="with --ids, restrict to one reference kind")
    parser.add_argument("--grep", default="", help="with --ids, filter by substring")
    args = parser.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    if args.ids:
        print(format_ids(inspect(args.tasks_dir, args.data_dir, repo=args.repo, branch=args.branch),
                         domain=args.domain, grep=args.grep))
        return 0
    if args.check:
        text, code = format_check(inspect(args.tasks_dir, args.data_dir, repo=args.repo,
                                          branch=args.branch), strict=args.strict)
        print(text)
        return code

    args.data_dir.mkdir(parents=True, exist_ok=True)
    result = publish(args.data_dir, now, directory=args.tasks_dir, repo=args.repo,
                     branch=args.branch)
    if result == "ok":
        latest = json.loads((args.data_dir / "tasks.json").read_text(encoding="utf-8"))
        summary, validation = latest["summary"], latest["validation"]
        tally = " ".join(
            f"{name} {states[RESOLVED]}/{states[UNRESOLVED]}/{states[MISSING_INDEX]}"
            for name, states in validation["refs"].items())
        print(f"indexed {summary['total']} tasks · edges {summary['edges']}"
              f" · blocked {summary['blocked']}"
              f" · 断引用 {validation['parent_missing'] + validation['depends_missing']}"
              f" · 引用 已核对/未找到/未核对 {tally}"
              + (f" · {len(latest['structural_errors'])} 处结构错误"
                 if latest["structural_errors"] else ""))
    else:
        print(f"任务看板采集结果为 {result}，保留上一次快照", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
