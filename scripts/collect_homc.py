"""Read the House of Model Cards list the way every other third-party list is read.

``isLinXu/model-list`` keeps a model catalogue whose unit is not a row but a
*verification claim*: §2.0 of its README splits the round's increment into 🆕 新增
已核实 / 🔄 更新已核实 / ⚠️ 待确认, grades each row's sources A (vendor-first-hand) /
B (independent secondary, ideally two) / C (single rumour), and says out loud that a
row carrying only one B-grade source must be re-checked before its date or spec is
quoted. Its Pages site, ``https://islinxu.github.io/model-list/``, is generated from
that same README, so the README is what gets read here and the site is only ever
linked out to - parsing a rendered page would measure our guess at their markup.

Two disciplines this file keeps, because they are what makes the numbers usable:

* **Their claim and our count are published side by side and never merged.** The
  README's 核心统计 says how many entries the list believes it verified; this
  collector counts the table rows it actually parsed. Neither one adjusts the other,
  and a difference between them is a fact to show, not to smooth away.
* **Verification is theirs.** A row lands with the grade *their* source column
  states. Nothing here re-checks a vendor page, so the board can only ever say
  "this list graded it A", never "this is true".

Reused helpers come from ``collect_awesome`` on purpose: the bounded reader, the
URL allowlist, the prose cleaner and the size accounting are the same code that
guards the other five lists, so "safe to publish" cannot mean two different things
in one repository.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any

try:  # executed as a script (python scripts/collect_homc.py)
    from collect import atomic_json_write
    from collect_awesome import (Fetcher, add_note, clean_int, clean_text, diff_ids, find_date,
                                 json_bytes, kb, links_of, parse_instant, plain_title, published_bytes,
                                 read_cadence, safe_url, slugify, thin_snapshots)
    from collect_awesome import DAILY_HISTORY_DAYS, HISTORY_RETENTION_DAYS, MAX_BYTES, MAX_FETCHES, MONTHLY_HISTORY_LIMIT
except ImportError:  # imported as a module (from scripts.collect_homc import ...)
    from scripts.collect import atomic_json_write
    from scripts.collect_awesome import (Fetcher, add_note, clean_int, clean_text, diff_ids, find_date,
                                         json_bytes, kb, links_of, parse_instant, plain_title,
                                         published_bytes, read_cadence, safe_url, slugify, thin_snapshots)
    from scripts.collect_awesome import (DAILY_HISTORY_DAYS, HISTORY_RETENTION_DAYS, MAX_BYTES,
                                         MAX_FETCHES, MONTHLY_HISTORY_LIMIT)

SCHEMA_VERSION = 1
SOURCE_ID = "homc"
REPO = "isLinXu/model-list"
README_PATH = "README.md"
SITE_URL = "https://islinxu.github.io/model-list/"
ENTRY_FILENAME = "homc.json"
LEDGER_FILENAME = "homc_ledger.json"
HISTORY_FILENAME = "homc_history.json"
ROOT = Path(__file__).resolve().parent.parent

STATUSES = ("ok", "stale", "unavailable")
STATES = ("new", "updated", "unverified")
GRADES = ("A", "B", "C")
SUIT_ORDER = ("♠", "♥", "♦", "♣", "🃏")

# Budgets. The row list is what a browser downloads, so it is the part allowed to
# shrink; the counts and the ledger never do, because a trimmed count is a wrong
# count and a ledger that forgot an id would report it as a new arrival tomorrow.
ROW_LIMIT = 120
LINKS_PER_ROW = 4
NOTE_LIMIT = 160
VENDOR_LIMIT = 60
LEDGER_ID_LIMIT = 4000
PAYLOAD_BUDGET_BYTES = 163_840   # 160 KB
LEDGER_BUDGET_BYTES = 204_800    # 200 KB
ROW_TRIM_STEP = 10
STALL_AFTER_DAYS = 45

STATE_HEADING_RE = re.compile(r"^#{4}\s+2\.0\.([234])\b")
AS_OF_RE = re.compile(r"^#{3}\s+2\.0\b[^\n]*?截至\s*(\d{4}-\d{2}-\d{2})")
SUITE_HEADING_RE = re.compile(r"^#{3,4}\s*(♠|♥|♦|♣|🃏)")
GROUP_LINE_RE = re.compile(r"^\*\*([^*]{1,40})\*\*$")
GRADE_RE = re.compile(r"\[([ABC])\]")
# Two shapes in the catalogue: "**♠K** InternVL2" (rank, then the name outside the
# bold) and "**🃏 DeepSeek-R1**" (Joker rows carry no rank and keep the name inside).
# The asterisks are dropped before matching so both read with one pattern.
SUIT_CELL_RE = re.compile(r"^(♠|♥|♦|♣|🃏)\s*(?:(10|[AKQJ2-9]|Joker)(?=\s|$))?\s*(.*)$")
# The list opens every verification row with the emoji of the table it sits in.
MARKER_RE = re.compile(r"^(🆕|🔄|⚠️|⚠)\s*(.*)$", re.S)
MARKER_STATE = {"🆕": "new", "🔄": "updated", "⚠️": "unverified", "⚠": "unverified"}
SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")
TABLE_ROW_RE = re.compile(r"^\s*\|(.+)\|\s*$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")

# The contract the three state tables share. The eighth column is allowed to grow a
# reason ("标记与更正说明"), so it is matched by prefix; the other seven must appear
# in order, because a reordered column would otherwise silently publish a licence
# count as a date.
EXPECTED_COLUMNS = ("模型名称", "提供方", "发布或更新时间", "模型类别", "核心能力", "可用状态", "信息来源")

# 核心统计 labels, matched by the words that identify the row rather than by the
# emoji, which the list is free to change.
STAT_LABELS = (
    ("model_series", ("模型系列",)),
    ("arxiv_papers", ("arXiv 论文", "arxiv论文")),
    ("github_repos", ("GitHub 仓库", "github仓库")),
    ("hf_links", ("HuggingFace 链接", "Hugging Face 链接", "hf 链接")),
    ("vendors", ("厂商/组织", "厂商 / 组织")),
    ("benchmarks", ("Benchmark", "评测基准")),
    ("increment", ("本轮核实增量", "核实增量")),
)
INCREMENT_SPLIT_RE = re.compile(r"🆕\s*新增\s*([0-9]+)\s*/\s*🔄\s*更新\s*([0-9]+)\s*/\s*⚠️?\s*待确认\s*([0-9]+)")

DATE_STATES = (
    ("unverified", ("待核实", "待确认")),
    ("unpublished", ("未发布",)),
    ("undisclosed", ("未披露", "未公开")),
    ("not_applicable", ("不适用",)),
)

ERROR_MESSAGES = {
    "network": "HOMC 清单暂时读不到，保留上一次快照。",
    "format": "HOMC 的核实总表认不出既定列，保留上一次快照。",
    "empty": "HOMC 总表本轮一行都没解析出来，保留上一次快照。",
}


class HomcError(RuntimeError):
    """The list could not be read as the table it documents itself to be."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(ERROR_MESSAGES.get(code, f"HOMC 清单读取失败（{code}）。"))
        self.code = code
        self.detail = detail[:200]


def utc(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise HomcError("format", "采集时间缺少时区")
    return value.astimezone(dt.timezone.utc)


def timestamp(value: dt.datetime) -> str:
    return utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_error(error: Exception) -> str:
    """Published reasons never carry a path, token or response body."""
    if isinstance(error, HomcError):
        return ERROR_MESSAGES.get(error.code, str(error))
    return "HOMC 清单读取失败。"


def split_row(line: str) -> list[str]:
    match = TABLE_ROW_RE.match(line)
    return [cell.strip() for cell in match.group(1).split("|")] if match else []


def header_matches(cells: list[str]) -> bool:
    """Is this the eight-column verification table, in the order the caliber says?"""
    names = [clean_text(cell, 40).strip("* ") for cell in cells]
    if len(names) < len(EXPECTED_COLUMNS) + 1:
        return False
    if names[:len(EXPECTED_COLUMNS)] != list(EXPECTED_COLUMNS):
        return False
    return names[len(EXPECTED_COLUMNS)].startswith("标记")


def cell_date(cell: str) -> tuple[str | None, str | None, str | None]:
    """A day, a month, or the list's own word for "we did not find one".

    The third slot says which of those it was. A row that reads 待核实 has no date,
    and publishing an empty string next to it would let the board sort it as the
    oldest item in the table.
    """
    for key, needles in DATE_STATES:
        if any(needle in cell for needle in needles):
            return None, None, key
    value, precision = find_date(cell)
    return value, precision, None


def row_grades(cell: str) -> tuple[list[str], int]:
    """The A/B/C grades the source column states, and how many times it states one.

    ``single_b`` is the list's own caveat: a row whose only grade marker is one B
    source is, in their words, a single source, and its dates should be re-checked
    before they are quoted. That is a property of the row, not a judgement added
    here, so it is counted and never used to drop the row.
    """
    grades = GRADE_RE.findall(cell or "")
    counts = {grade: grades.count(grade) for grade in GRADES}
    single_b = counts["B"] == 1 and not counts["A"] and not counts["C"]
    return [grade for grade in GRADES if counts[grade]], counts["B"] if single_b else 0


def row_links(*cells: str) -> tuple[list[str], int, str | None]:
    """Every http(s) target the row carries, allowlisted before it is published."""
    hrefs: list[str] = []
    for cell in cells:
        for _label, href in links_of(cell or ""):
            value = safe_url(href)
            if value and value not in hrefs:
                hrefs.append(value)
    # A Hugging Face weight page is the most useful single target on a model row,
    # so it leads when the row carries one among several sources.
    hf = [item for item in hrefs if "huggingface.co/" in item and "/api/" not in item]
    return hrefs[:LINKS_PER_ROW], len(hrefs), (hf[0] if hf else (hrefs[0] if hrefs else None))


def row_marker(cell: str) -> tuple[str | None, str | None]:
    """The state emoji the row opens with, and whatever prose the list wrote after it.

    ``plain_title`` would eat the emoji as a decoration, and the emoji is the one
    thing on the row that says which table the list filed it under — so it is taken
    from the raw cell, before the note is cleaned.
    """
    match = MARKER_RE.match(str(cell or "").strip())
    if not match:
        return None, clean_text(cell, NOTE_LIMIT) or None
    return match.group(1), plain_title(match.group(2))[:NOTE_LIMIT] or None


def is_section_ref(cell: str) -> bool:
    """Does this row name a section of the list instead of a model?

    The sign is read off the raw cell because the title cleaner drops a leading §,
    and a row that merely mentions "见 §17" further along is not a section pointer.
    """
    return str(cell or "").strip().lstrip("*[ \t").startswith("§")


def make_row(cells: list[str], state: str, group: str | None, warnings: list[str]) -> dict | None:
    name = plain_title(cells[0]) if cells else ""
    if not name:
        # A table row that claims to be an entry and has no name cannot be
        # reconciled with anything, so it is counted elsewhere and not published.
        add_note(warnings, f"{state} 表里有无名行被跳过（{clean_text(cells[0], 40) or '空单元格'}）")
        return None
    vendor = plain_title(cells[1])[:VENDOR_LIMIT]
    date, precision, date_state = cell_date(cells[2])
    marker, note = row_marker(cells[7] if len(cells) > 7 else "")
    links, link_total, url = row_links(cells[0], cells[6])
    grades, single_b = row_grades(cells[6])
    return {
        "id": f"homc:{slugify(name)}|{slugify(vendor)}",
        "name": name[:NOTE_LIMIT],
        "vendor": vendor or None,
        "state": state,
        "group": group,
        "date": date,
        "precision": precision,
        "date_state": date_state,
        "category": plain_title(cells[3])[:NOTE_LIMIT] or None,
        "capability": plain_title(cells[4])[:NOTE_LIMIT] or None,
        "availability": plain_title(cells[5])[:NOTE_LIMIT] or None,
        "grades": grades,
        "single_b_source": bool(single_b),
        "link_count": link_total,
        "links": links,
        "url": url,
        "marker": marker,
        "note": note,
        # The emoji a row carries and the table it sits in should agree; when they
        # do not, the row is published under the heading it was read from and the
        # disagreement is counted, not smoothed over.
        "marker_state": MARKER_STATE.get(marker or "", None),
        # A row that points at a section of the list rather than at a model is
        # still a row the list published; it is marked, never quietly removed.
        "is_section_reference": is_section_ref(cells[0]),
    }


def extract_state_tables(text: str, warnings: list[str]) -> tuple[list[dict], dict[str, int], dict[str, int]]:
    """Rows from §2.0.2 / §2.0.3 / §2.0.4, each interpreted with its own header.

    Anything outside those three headings is left alone: §2.1-2.30 are baseline
    tables with different columns, and §2.0.8 is a machine digest this repository
    already reads from its own payload.
    """
    rows: list[dict] = []
    seen: set[str] = set()
    counts: dict[str, int] = {state: 0 for state in STATES}
    mismatches: dict[str, int] = {}
    state: str | None = None
    group: str | None = None
    header: list[str] = []
    in_table = False

    for line in text.splitlines():
        heading = HEADING_RE.match(line)
        if heading:
            marker = STATE_HEADING_RE.match(line)
            level = len(heading.group(1))
            if marker:
                state = STATES[int(marker.group(1)) - 2]
                group = None
            elif level <= 4:
                state = None
                group = None
            header, in_table = [], False
            continue
        if state is None:
            continue
        cells = split_row(line)
        if not cells:
            group_match = GROUP_LINE_RE.match(line.strip())
            if group_match:
                group = clean_text(group_match.group(1), 40)
            header, in_table = [], False
            continue
        if SEPARATOR_RE.match(line):
            if not in_table:
                if header and not header_matches(header):
                    # A table inside a state section that does not carry the eight
                    # columns the caliber documents is a shape we should name rather
                    # than count: its rows would be read against the wrong columns.
                    label = clean_text(header[0], 40) or " unnamed table"
                    mismatches[label] = mismatches.get(label, 0) + 1
                header = []
            continue
        if not in_table:
            if header_matches(cells):
                in_table = True
            header = cells
            continue
        counts[state] += 1
        row = make_row(cells, state, group, warnings)
        if row is None:
            continue
        if row["id"] in seen:
            # Their own rule says a model appears in exactly one of the three
            # tables; a repeat is a property of the document worth reporting.
            add_note(warnings, f"{row['name']} 在总表里出现多次：同一模型应只落在 🆕/🔄/⚠️ 之一，本站按首次计。")
            continue
        seen.add(row["id"])
        rows.append(row)
    for name, total in mismatches.items():
        add_note(warnings, f"{name}：{total} 张表的列与既定核实表不一致，未计入")
    return rows, counts, mismatches


def extract_suits(text: str) -> tuple[dict[str, str], dict[str, int]]:
    """The playing-card index: which suit and rank the list gave each named model.

    Matching is by name only, exactly as written. A model that the catalogue ranks
    with a suit but that reaches the verification tables under a different string is
    published as unmatched rather than guessed into a suit.
    """
    by_name: dict[str, str] = {}
    by_suit: dict[str, int] = {suit: 0 for suit in SUIT_ORDER}
    section = False
    suit: str | None = None
    header = False
    for line in text.splitlines():
        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            title = heading.group(2)
            if level == 3 and "1.6" in title:
                section = True
                suit, header = None, False
                continue
            if level == 4 and section:
                marker = SUITE_HEADING_RE.match(line)
                suit = marker.group(1) if marker else None
                header = False
                continue
            if level <= 3:
                section = False
            continue
        if not section or suit is None:
            continue
        cells = split_row(line)
        if not cells:
            header = False
            continue
        if SEPARATOR_RE.match(line):
            header = True
            continue
        if not header or len(cells) < 2:
            continue
        marker = SUIT_CELL_RE.match(cells[0].replace("*", "").strip())
        if not marker:
            continue
        label = f"{marker.group(1)}{marker.group(2) or ''}"
        name = plain_title(marker.group(3))
        if not name:
            continue
        by_name.setdefault(name.lower(), label)
        by_suit[suit] = by_suit.get(suit, 0) + 1
    return by_name, by_suit


def extract_self_reported(text: str, warnings: list[str]) -> dict | None:
    """The list's own 核心统计 table, published as what it claims.

    Values keep their shape: "200+" is a range the list chose, and turning it into
    200 would be our number, not theirs.
    """
    section = False
    header = False
    found: dict[str, str] = {}
    note: dict[str, str] = {}
    for line in text.splitlines():
        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            section = level <= 3 and "核心统计" in heading.group(2)
            header = False
            continue
        if not section:
            continue
        cells = split_row(line)
        if not cells:
            continue
        if SEPARATOR_RE.match(line):
            header = True
            continue
        if not header or len(cells) < 2:
            continue
        label = plain_title(cells[0])
        for key, needles in STAT_LABELS:
            if key in found:
                continue
            if any(needle.lower() in label.lower() for needle in needles):
                found[key] = clean_text(cells[1], 40)
                note[key] = clean_text(cells[2] if len(cells) > 2 else "", NOTE_LIMIT)
                break
        if len(found) == len(STAT_LABELS):
            break
    if not found:
        add_note(warnings, "HOMC 的「核心统计」表这次没读到：自报数缺席，本站只报实测。")
        return None
    payload: dict[str, Any] = {}
    for key, value in found.items():
        payload[f"{key}_claimed"] = value
        number = clean_int(value)
        if number is not None and "+" not in value and "约" not in value:
            payload[key] = number
    increment = note.get("increment") or ""
    split = INCREMENT_SPLIT_RE.search(increment)
    if split:
        payload["increment_new"] = int(split.group(1))
        payload["increment_updated"] = int(split.group(2))
        payload["increment_unverified"] = int(split.group(3))
        payload["increment_quote"] = clean_text(increment, NOTE_LIMIT)
    elif payload.get("increment") is not None:
        add_note(warnings, "HOMC 自报了核实增量总数，但 🆕/🔄/⚠️ 的拆分认不出：这里只报总数。")
    return payload or None


def measure(rows: list[dict], suits: dict[str, int], suit_of: dict[str, str],
            counts: dict[str, int], *, bytes_read: int, truncated: bool) -> dict:
    """What this run counted, in shapes the reader can check by hand."""
    grades = {grade: sum(1 for row in rows if grade in row["grades"]) for grade in GRADES}
    precisions: dict[str, int] = {}
    for row in rows:
        key = row["date_state"] or row["precision"] or "none"
        precisions[key] = precisions.get(key, 0) + 1
    matched = [row for row in rows if suit_of.get(row["name"].lower())]
    for row in matched:
        row["suit"] = suit_of[row["name"].lower()]
    for row in rows:
        row.setdefault("suit", None)
    return {
        "rows": {**counts, "total": sum(counts.values())},
        "rows_parsed": len(rows),
        # Rows the list counts but a reader cannot: an empty name cell is a
        # formatting accident, and saying so keeps the total explainable.
        "distinct_vendors": len({row["vendor"] for row in rows if row["vendor"]}),
        "with_link": sum(1 for row in rows if row["url"]),
        "without_link": sum(1 for row in rows if not row["url"]),
        "grades": grades,
        "without_grade": sum(1 for row in rows if not row["grades"]),
        "single_b_source": sum(1 for row in rows if row["single_b_source"]),
        "with_note": sum(1 for row in rows if row["note"]),
        # A row filed under 🆕 whose own marker says ⚠️ is the list disagreeing with
        # itself. We publish the heading we read it from and count the disagreement.
        "marker_mismatch": sum(1 for row in rows
                               if row["marker_state"] not in (None, row["state"])),
        "section_reference_rows": sum(1 for row in rows if row["is_section_reference"]),
        "dates": precisions,
        "suit_index": {suit: suits[suit] for suit in SUIT_ORDER if suits.get(suit)},
        "suit_matched": len(matched),
        "suit_unmatched": len(rows) - len(matched),
        "bytes_read": bytes_read,
        "byte_capped": truncated,
        "files": [{"path": README_PATH, "bytes": bytes_read, "truncated": truncated}],
    }


def balanced_sample(rows: list[dict]) -> list[dict]:
    """Round-robin the three state tables so a trimmed sample still shows all three.

    The row list is the part the budget is allowed to cut, and it cuts the tail.
    Sorted by state, the largest table (usually 🆕) would take every published row
    and the page would have nothing to say about 🔄 and ⚠️ — so the order is taken
    across tables, one row at a time, newest first inside each.
    """
    queues: list[list[dict]] = []
    for state in STATES:
        part = [row for row in rows if row["state"] == state]
        # Stable sorts, least significant first: undated rows fall to the tail,
        # rows the list filed here for the first time rise to the head.
        part.sort(key=lambda row: row["name"])
        part.sort(key=lambda row: str(row.get("date") or ""), reverse=True)
        part.sort(key=lambda row: not row["is_new"])
        if part:
            queues.append(part)
    out: list[dict] = []
    while queues:
        for queue in list(queues):
            out.append(queue.pop(0))
            if not queue:
                queues.remove(queue)
    return out


def fit_size_budget(payload: dict, ledger_bytes: int, warnings: list[str]) -> None:
    """Keep the browser file inside its budget by shortening rows, never counts."""
    payload["sizes"] = {"payload_bytes": json_bytes(payload),
                        "payload_budget_bytes": PAYLOAD_BUDGET_BYTES,
                        "ledger_bytes": ledger_bytes,
                        "ledger_budget_bytes": LEDGER_BUDGET_BYTES}
    limit = ROW_LIMIT
    while published_bytes(payload) > PAYLOAD_BUDGET_BYTES and limit > 0:
        limit = max(0, limit - ROW_TRIM_STEP)
        payload["rows"] = payload["rows"][:limit]
    size = published_bytes(payload)
    if limit < ROW_LIMIT:
        add_note(warnings, f"快照超过 {kb(PAYLOAD_BUDGET_BYTES)} KB 预算，本次只发布前 {limit} 行；"
                           "计数、自报数与台账不受影响。")
    if size > PAYLOAD_BUDGET_BYTES:
        add_note(warnings, f"行全部去掉后快照仍有 {kb(size)} KB，超过 {kb(PAYLOAD_BUDGET_BYTES)} KB "
                           "预算：该砍的是每行留的链接数，不是读者的下载量。")
    if ledger_bytes > LEDGER_BUDGET_BYTES:
        add_note(warnings, f"id 台账 {kb(ledger_bytes)} KB 超过 {kb(LEDGER_BUDGET_BYTES)} KB 预算："
                           "记不全 id 的台账会把漏掉的行报成新增，所以该调的是每行 id 上限。")
    payload["sizes"]["row_limit_applied"] = limit
    payload["sizes"]["payload_bytes"] = published_bytes(payload)


def compare_claim(measured: dict, self_reported: dict | None, warnings: list[str]) -> dict:
    """Measured against claimed, published as a difference rather than resolved."""
    claimed = (self_reported or {}).get("increment")
    total = measured["rows"]["total"]
    out = {"measured_rows": total, "claimed_increment": claimed}
    if claimed is None:
        out["note"] = "清单这次没自报核实增量：只有实测行数。"
        return out
    out["delta"] = total - claimed
    if out["delta"]:
        add_note(warnings, f"本站数到 {total} 行核实条目，清单自报 {claimed} 条：差 "
                           f"{out['delta']:+d}。两个数都保留，谁也不改成对方的数。")
    return out


def carried_payload(previous: dict, at: dt.datetime, reason: str, warnings: list[str]) -> dict:
    """An unread day still shows the last good read, labelled as such."""
    payload = {**previous}
    payload["status"] = "stale"
    payload["error"] = reason
    payload["last_attempt_at"] = timestamp(at)
    add_note(warnings, f"今天没读到 HOMC 总表，页面显示的是 {payload.get('captured_at')} 的快照。")
    payload["warnings"] = warnings
    return payload


def collect(at: dt.datetime, *, offline_dir: Path | None = None, opener: Any = None,
            previous: dict | None = None, ledger: dict | None = None) -> dict:
    """Read the list and return the payload plus the ledger to persist. No writes."""
    at = utc(at)
    previous = previous if isinstance(previous, dict) else {}
    old_ids = (ledger or {}).get("ids") if isinstance((ledger or {}).get("ids"), list) else None
    fetcher = Fetcher(offline_dir, opener=opener)
    warnings: list[str] = []
    text = fetcher.text(REPO, README_PATH)
    if text is None:
        reason = fetcher.reason(REPO, README_PATH)
        if previous.get("measured"):
            return {"payload": carried_payload(previous, at, safe_error(HomcError("network")), warnings),
                    "ledger": ledger or {}, "status": "stale"}
        return {"payload": _empty(at, safe_error(HomcError("network")), reason),
                "ledger": {}, "status": "unavailable"}

    rows, counts, mismatches = extract_state_tables(text, warnings)
    suits_names, suits = extract_suits(text)
    self_reported = extract_self_reported(text, warnings)
    if not rows:
        # A readable README whose tables we cannot parse is a format change, and
        # the last good snapshot is the honest thing to keep showing.
        if previous.get("measured"):
            payload = carried_payload(previous, at, safe_error(HomcError("format")), warnings)
            payload["warnings"] = warnings
            return {"payload": payload, "ledger": ledger or {}, "status": "stale"}
        raise HomcError("empty")

    measured = measure(rows, suits, suits_names, counts, bytes_read=fetcher.bytes,
                       truncated=fetcher.was_truncated(REPO, README_PATH))
    if measured["byte_capped"]:
        add_note(warnings, f"{README_PATH} 在 {MAX_BYTES // 1024} KB 处被截断：总表后面的行没数到，"
                           "实测行数是下限。")
    as_of = None
    for line in text.splitlines():
        marker = AS_OF_RE.match(line)
        if marker:
            as_of = marker.group(1)
            break
    if as_of is None:
        add_note(warnings, "总表标题里的「截至」日期认不出来：页面只报本次采集时间，不代替他们标注口径日期。")
    as_of_age = None
    if as_of is not None:
        claimed_day = dt.date.fromisoformat(as_of)
        as_of_age = max(0, (at.date() - claimed_day).days)

    outcome = diff_ids(old_ids, [row["id"] for row in rows],
                       capped=len(rows) > LEDGER_ID_LIMIT)
    if len(rows) > LEDGER_ID_LIMIT:
        rows_for_ledger = rows[:LEDGER_ID_LIMIT]
        add_note(warnings, f"台账只记前 {LEDGER_ID_LIMIT} 个 id，实测行数是 {len(rows)} 的下限。")
    else:
        rows_for_ledger = rows

    fresh = set(outcome.get("added_ids") or [])
    for row in rows:
        row["is_new"] = row["id"] in fresh
    ordered = balanced_sample(rows)

    envelope = _envelope(at)
    comparison = compare_claim(measured, self_reported, warnings)
    if measured["marker_mismatch"]:
        add_note(warnings, f"{measured['marker_mismatch']} 行的行首标记和它所在的表不一致："
                           "本站按所在的表归类发布，不代替清单改判。")
    payload = {
        **envelope,
        "status": "ok",
        "error": None,
        "as_of": as_of,
        "as_of_age_days": as_of_age,
        "captured_at": timestamp(at),
        "last_attempt_at": timestamp(at),
        "self_reported": self_reported,
        "measured": measured,
        "comparison": comparison,
        "cadence": read_cadence(fetcher, {"id": REPO, "cadence_path": README_PATH}, at),
        "diff": {key: value for key, value in outcome.items() if not key.endswith("_ids")},
        "fetches": {"files": fetcher.fetches, "bytes": fetcher.bytes,
                    "max_files": MAX_FETCHES, "budget_hit": fetcher.budget_hit},
        "warnings": warnings,
        "rows": ordered[:ROW_LIMIT],
    }
    ledger_out = {"schema_version": SCHEMA_VERSION, "updated_at": timestamp(at),
                  "captured_at": timestamp(at),
                  "ids": sorted({row["id"] for row in rows_for_ledger}),
                  "capped": len(rows) > LEDGER_ID_LIMIT}
    fit_size_budget(payload, json_bytes(ledger_out), warnings)
    if payload["cadence"].get("stalled"):
        add_note(warnings, f"HOMC 的 README 已 {payload['cadence'].get('stale_days')} 天没动过："
                           "三态总表按人工核对节奏看待，不当日更来源。")
    return {"payload": payload, "ledger": ledger_out, "status": "ok"}


def _empty(at: dt.datetime, reason: str, detail: str) -> dict:
    payload = _envelope(at)
    payload.update({"status": "unavailable", "error": reason, "as_of": None,
                    "captured_at": None, "last_attempt_at": timestamp(at),
                    "self_reported": None, "measured": None, "comparison": None,
                    "cadence": {"status": "unknown", "last_file_commit_at": None, "author": None,
                                "is_bot": None, "message": None, "cadence": None,
                                "stale_days": None, "stalled": None, "commits_seen": 0},
                    "diff": {"baseline": True, "added": 0, "removed": 0, "held": 0,
                             "truncated": False},
                    "fetches": {"files": 0, "bytes": 0, "max_files": MAX_FETCHES,
                                "budget_hit": False},
                    "unavailable_reason": clean_text(detail, 40) or None,
                    "warnings": [reason], "rows": [], "sizes": {}})
    return payload


def _envelope(at: dt.datetime) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {
            "id": SOURCE_ID, "repo": REPO, "readme_path": README_PATH, "site_url": SITE_URL,
            "states": list(STATES), "grades": list(GRADES), "statuses": list(STATUSES),
            "budget": {"row_limit": ROW_LIMIT, "links_per_row": LINKS_PER_ROW,
                       "ledger_id_limit": LEDGER_ID_LIMIT, "max_bytes": MAX_BYTES,
                       "payload_budget_bytes": PAYLOAD_BUDGET_BYTES,
                       "ledger_budget_bytes": LEDGER_BUDGET_BYTES,
                       "stall_after_days": STALL_AFTER_DAYS},
            "caliber": {
                "graded_by": "他方清单：A 一手来源、B 独立二手、C 单一二手或传闻，均由该清单判定，本站不重复核实。",
                "grades": "measured.grades 是「带该级来源的行数」：一行可以同时列 A 与 B，所以三者之和可以大于行数合计。",
                "single_b": "single_b_source 只由形状判定（这一行的信息来源只标了一个 [B]）；清单自己写的「单一 B 源须复核」"
                            "另存在 note 里，两者互不改写。",
                "cadence": "README 的提交里含他们自己的每日自动日报（§2.0.8），所以 cadence 说的是这个文件多久动一次，"
                           "不代表人工核实表的更新节奏；这一轮核实有多新看 as_of 与 as_of_age_days。",
                "counted_as": "本站按 §2.0.2/2.0.3/2.0.4 三张总表的表格行计数；指向章节的纠偏行照数并单独标注，不替他们决定算不算模型。",
                "sampled": "rows 是样本：三态轮转取前 row_limit 行（每态内部按新到旧），所以砍掉的是样本、不是任何计数。",
                "never_merged": "本站的 Hugging Face 下载观测与该清单的条目数不是同一批对象，永不相加。",
            },
            "url": "https://github.com/isLinXu/model-observatory",
        },
        "captured_at": None, "last_attempt_at": timestamp(at),
    }


def history_snapshot(history: dict, payload: dict, at: dt.datetime) -> dict:
    measured = payload.get("measured") or {}
    rows = measured.get("rows") or {}
    comparison = payload.get("comparison") or {}
    snapshots = [row for row in (history.get("snapshots") or []) if isinstance(row, dict)]
    day = utc(at).date().isoformat()
    snapshots = [row for row in snapshots if row.get("date") != day]
    snapshots.append({"date": day, "captured_at": payload.get("captured_at"),
                      "as_of": payload.get("as_of"),
                      "rows_new": rows.get("new"), "rows_updated": rows.get("updated"),
                      "rows_unverified": rows.get("unverified"), "rows_total": rows.get("total"),
                      "claimed_increment": comparison.get("claimed_increment"),
                      "added": (payload.get("diff") or {}).get("added"),
                      "removed": (payload.get("diff") or {}).get("removed")})
    snapshots.sort(key=lambda row: str(row.get("date") or ""))
    cutoff = (utc(at).date() - dt.timedelta(days=HISTORY_RETENTION_DAYS)).isoformat()
    return {"schema_version": SCHEMA_VERSION, "source": {"id": SOURCE_ID},
            "updated_at": timestamp(at),
            "retention": {"daily_days": DAILY_HISTORY_DAYS, "monthly_points": MONTHLY_HISTORY_LIMIT},
            "snapshots": thin_snapshots(snapshots, utc(at).date(), cutoff=cutoff)}


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def publish(data_dir: Path, at: dt.datetime, *, offline_dir: Path | None = None,
            opener: Any = None) -> str:
    at = utc(at)
    path = data_dir / ENTRY_FILENAME
    ledger_path = data_dir / LEDGER_FILENAME
    previous = load(path)
    saved = parse_instant(previous.get("captured_at"))
    if saved is not None and saved > at:
        return "rejected"
    outcome = collect(at, offline_dir=offline_dir, opener=opener, previous=previous,
                      ledger=load(ledger_path))
    payload, status = outcome["payload"], outcome["status"]
    atomic_json_write(path, payload)
    if status == "ok":
        atomic_json_write(ledger_path, outcome["ledger"])
        atomic_json_write(data_dir / HISTORY_FILENAME,
                          history_snapshot(load(data_dir / HISTORY_FILENAME), payload, at))
    return status


def report(payload: dict) -> str:
    measured = payload.get("measured") or {}
    rows = measured.get("rows") or {}
    comparison = payload.get("comparison") or {}
    grades = measured.get("grades") or {}
    diff = payload.get("diff") or {}
    cadence = payload.get("cadence") or {}
    sizes = payload.get("sizes") or {}
    return (f"{payload.get('status')} · 截至 {payload.get('as_of') or '未标注'}"
            f"{'（距今 ' + str(payload.get('as_of_age_days')) + ' 天）' if payload.get('as_of_age_days') else ''} · "
            f"实测 {rows.get('total')} 行（🆕{rows.get('new')} / 🔄{rows.get('updated')} / "
            f"⚠️{rows.get('unverified')}）· 清单自报 {comparison.get('claimed_increment')} 条"
            f"{'（差 ' + str(comparison.get('delta')) + '）' if comparison.get('delta') else ''} · "
            f"含 A 级来源 {grades.get('A')} 行 / 含 B {grades.get('B')} / 含 C {grades.get('C')} · "
            f"单一 B 源须复核 {measured.get('single_b_source')} · "
            f"带链接 {measured.get('with_link')} · 花色可对上 {measured.get('suit_matched')} · "
            f"发布样本 {len(payload.get('rows') or [])} 行 · "
            f"新增 {diff.get('added')} / 移出 {diff.get('removed')}"
            f"{'（基线）' if diff.get('baseline') else ''} · "
            f"节奏 {cadence.get('cadence') or '?'} · "
            f"快照 {kb(sizes.get('payload_bytes'))}/{kb(sizes.get('payload_budget_bytes'))} KB")


def main(argv: list[str] | None = None, *, at: dt.datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read the HOMC verification tables as content")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--offline", type=Path, default=None,
                        help="read the recorded mirror at DIR/<owner>/<name>/<path> instead of the network")
    parser.add_argument("--check", action="store_true",
                        help="read and summarise without writing any file; an unread third-party "
                             "list is an observation, not a broken collector, so a stale read "
                             "still exits 0 and the printed status says which day is carried")
    args = parser.parse_args(argv)
    at = utc(at if at is not None else dt.datetime.now(dt.timezone.utc))
    try:
        if args.check:
            outcome = collect(at, offline_dir=args.offline,
                              previous=load(args.data_dir / ENTRY_FILENAME),
                              ledger=load(args.data_dir / LEDGER_FILENAME))
            payload = outcome["payload"]
            print(report(payload))
            for note in (payload.get("warnings") or [])[:10]:
                print(f"  ! {note}")
            return 0 if payload.get("status") in ("ok", "stale") else 1
        status = publish(args.data_dir, at, offline_dir=args.offline)
    except (HomcError, OSError, ValueError) as error:
        print(safe_error(error), file=sys.stderr)
        return 1
    print(f"{status}: {report(load(args.data_dir / ENTRY_FILENAME))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
