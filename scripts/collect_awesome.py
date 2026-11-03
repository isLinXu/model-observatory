#!/usr/bin/env python3
"""Track what the public awesome lists *contain*, without owning any repository metric.

Six hand- or bot-maintained lists are read every day. They are deliberately not
merged into one parser, because they are not the same object:

* ``markdown-table``  a Markdown table whose header differs per section
  (awesome-agent-world-model, awesome-native-multimodal-models, BradyFU)
* ``machine-json``    the list publishes its own JSON index
  (awesome-visual-reasoning: ``data/papers.json`` + ``data/stats.json``)
* ``topic-archives``  one index page per topic; each month becomes a new file
  and nothing is deleted (paper-list)
* ``report``          a one-off research report, not a living list
  (idea-research-list)

Two rules keep the board honest.

**Measured vs self-reported.**  ``measured`` is what this collector counted in
the bytes it fetched today. ``self_reported`` is what the repository says about
itself - its own ``stats.json``, its own README badges, its own ``Total papers``
line. They are stored side by side and never added together: a number a list
publishes about itself is not our observation, and a badge that contradicts the
table next to it must not be laundered into a statistic.

**One owner per number.**  Stars, forks, ``pushed_at`` and follower counts stay
in ``data/github.json`` and ``data/stars_repos.json``; nothing here copies them.
``cadence`` only answers "when did *this file* last change", which ``pushed_at``
cannot, because a push to any other path moves it. BradyFU is ``upstream``: its
rows are counted, published and excluded from our own totals.

Entry identity is a small stable key (``arxiv:<id>`` when the row carries an arXiv
ID, else ``title:<slug>``) remembered in ``data/awesome_ledger.json``, which is
what turns "added / removed" into a fact rather than a guess. Two sources skip the
row-level ledger on purpose: paper-list (52k rows would be re-downloaded daily)
diffs the *newest archive month per topic* instead, and idea-research-list is a
baseline with no update stream. A rolling window (agent-world-model) drops old rows
by design, so removals there are labelled ``rolling_window`` and not treated as loss.

What a row must look like to become an entry differs by kind, and the difference is
published rather than implied. A table list carries a link column, so a row with no
link is a leaderboard or a nav table and is counted in ``skipped_no_link``. A
one-off report has no link column at all, so there a venue or a date is the paper
signal: those rows are entries (``unlinked_rows`` says how many had no link) and
only a row with neither signal is ``skipped_no_signal``. Every skipped row is
attributed to one of the three reasons, so ``skipped`` is always explainable.

Reads are bounded, and a bounded read says so. A file over ``MAX_BYTES`` is cut and
its row gains ``byte_capped``: the count below it is a floor, not a total. When the
run runs out of fetches mid-way, the lists it never reached are marked
``not_attempted`` (``budget_hit`` plus per-topic ``no_budget``) rather than
``unreadable``, because "we did not ask" and "the server said no" are different
facts the board must not merge.

``recent`` buckets the entries we already counted by how young they are (90 days /
a year / older / undated), read off arXiv ids and dates - no extra fetches. A bare
year is treated as its first January, which can only make an entry look older, so
"added recently" is never inflated.

Only structure is published: counts, coverage, and a capped list of recent
entries with titles and links. Raw Markdown bodies never enter the payload, every
link is re-checked against an ``http(s)`` allowlist, and a repository that cannot
be read today keeps its last good row marked ``stale`` instead of vanishing.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

try:  # executed as a script (python scripts/collect_awesome.py)
    from collect import atomic_json_write
    from collect_github import auth_headers, http_get_json
except ImportError:  # imported as a module (from scripts.collect_awesome import ...)
    from scripts.collect import atomic_json_write
    from scripts.collect_github import auth_headers, http_get_json

SCHEMA_VERSION = 1
SOURCE_ID = "awesome"
USER_AGENT = "Model-Observatory/1.0 (+https://islinxu.github.io/model-observatory/)"
ROOT = Path(__file__).resolve().parent.parent
HISTORY_RETENTION_DAYS = 1100
# The trend chart reads this file, so it is a browser download: daily points for
# four months, then one point per month for two more years.
DAILY_HISTORY_DAYS = 120
MONTHLY_HISTORY_LIMIT = 24

# Each budget exists so that growth in somebody else's repository cannot turn
# into an unbounded download or an unbounded payload in ours.
TITLE_LIMIT = 200
SECTION_LIMIT = 60
SAMPLE_LIMIT = 40          # entries published per repository
LEDGER_ID_LIMIT = 4000     # ids remembered per repository
TOPIC_LIMIT = 40           # paper-list topic index pages
MONTH_SAMPLE_LIMIT = 6     # month files whose rows are actually counted
MAX_BYTES = 2_500_000      # one fetched file
MAX_FETCHES = 80           # fetched files per run
WARNING_LIMIT = 100
CHANGE_LIMIT = 120
REQUEST_TIMEOUT = 30
STALL_AFTER_DAYS = 45

# Two more budgets, for the two files this panel owns. The index is what a
# browser downloads, the ledger is what the repository keeps between runs. Both
# are stated in the 1024-byte KB the daily workflow already reports against.
PAYLOAD_BUDGET_BYTES = 122_880   # 120 KB
LEDGER_BUDGET_BYTES = 204_800    # 200 KB
SAMPLE_TRIM_STEP = 5             # entries per list taken off the sample tail per pass

MARKDOWN_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)[^)]*\)")
ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?", re.I)
ARXIV_LABEL_RE = re.compile(r"\barXiv:?\s*([0-9]{4}\.[0-9]{4,5})", re.I)
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
TABLE_ROW_RE = re.compile(r"^\s*\|(.+)\|\s*$")
SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
BULLET_RE = re.compile(r"^\s*[-*+]\s+(.*)$")
MONTH_RE = re.compile(r"\b(\d{4}-\d{2})\b")
TOPIC_LINK_RE = re.compile(r"docs/([A-Za-z0-9_]+)\.md")
TOTAL_PAPERS_RE = re.compile(r"Total papers:\s*\*\*([0-9,]+)\*\*")
LATEST_MONTH_RE = re.compile(r"Latest archive month:\s*\*\*(\d{4}-\d{2})\*\*")
MONTH_ROW_RE = re.compile(r"^- \[(\d{4}-\d{2})\]", re.M)
SELF_MONTH_RE = re.compile(r"\(\s*([0-9,]+)\s*papers\s*\)", re.I)
BADGE_RE = re.compile(r"(?:entries?|papers?|论文|总数)[^0-9]{0,8}([0-9]{3,6})\+?", re.I)

GITHUB_URL_RE = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]{1,39})/([A-Za-z0-9_.-]{1,100})(?:[/?#].*)?$")
SAFE_URL_RE = re.compile(r"^https?://[^\s<>\"'`]+(?:[^\s<>\"'`).,;:!?]|$)")

# Column vocabulary: only title and a link are guaranteed across all six lists,
# so every mapping here is a preference and never a requirement.
COLUMN_ROLES = (
    ("title", ("论文", "标题", "题目", "title", "paper", "name", "模型", "work", "条目")),
    ("venue", ("venue", "会议", "conference", "发表", "出处", "source")),
    ("date", ("年份", "日期", "时间", "date", "time", "published", "季度", "月份")),
    ("authors", ("作者", "author", "机构", "organization", "affiliation", "单位")),
    ("code", ("code", "代码", "github", "repo", "demo", "project", "实现")),
    ("link", ("链接", "link", "pdf", "arxiv", "url")),
)
DATE_PATTERNS = (
    (re.compile(r"\b(\d{4}-\d{2}-\d{2})\b"), "day"),
    (re.compile(r"\b(\d{4})[/-](\d{2})\b"), "month"),
    (re.compile(r"\b(\d{4})\s*Q([1-4])\b"), "quarter"),
    (re.compile(r"\b((?:19|20)\d{2})\b"), "year"),
)
VENUES = ("SIGGRAPH Asia", "TPAMI", "CVPR", "ICCV", "ECCV", "NeurIPS", "ICML", "ICLR", "ACL",
          "EMNLP", "NAACL", "AAAI", "IJCAI", "SIGGRAPH", "COLM", "CoRL", "RSS", "WACV", "BMVC",
          "INTERSPEECH", "OSDI", "SOSP", "MLSys", "JMLR", "TMLR")
VENUE_RE = re.compile(r"\b(" + "|".join(re.escape(v) for v in
                                         sorted(VENUES, key=len, reverse=True)) + r")\b")
EMOJI_PREFIX_RE = re.compile(r"^[^\w一-鿿]+")

ERROR_MESSAGES = {
    "network": "公开清单暂时读不到，保留上一次快照。",
    "format": "清单文件的格式认不出任何条目，保留上一次快照。",
    "schema": "清单跟踪的数据结构不符合预期，保留上一次快照。",
    "budget": "本次运行超出抓取预算，部分清单未读取。",
}

KINDS = ("markdown-table", "machine-json", "topic-archives", "report")
REPO_STATES = ("ok", "stale", "unavailable")
STATUSES = ("ok", "partial", "stale", "unavailable")

# The list of lists.
SOURCES: tuple[dict[str, Any], ...] = (
    {
        "id": "isLinXu/awesome-agent-world-model",
        "kind": "markdown-table",
        "paths": ("docs/papers.md",),
        "cadence_path": "docs/papers.md",
        "rolling_window": True,
        "badge_path": "README.md",
    },
    {
        "id": "isLinXu/awesome-native-multimodal-models",
        "kind": "markdown-table",
        "paths": ("README.md",),
        "cadence_path": "README.md",
        "badge_path": "README.md",
    },
    {
        "id": "isLinXu/awesome-visual-reasoning",
        "kind": "machine-json",
        "paths": ("data/stats.json", "data/papers.json"),
        "cadence_path": "data/papers.json",
    },
    {
        # Somebody else's repository. Our own merges must not read as updates we
        # authored, and its rows never enter our totals.
        "id": "BradyFU/Awesome-Multimodal-Large-Language-Models",
        "kind": "markdown-table",
        "paths": ("README.md",),
        "cadence_path": "README.md",
        "upstream": True,
    },
    {
        "id": "isLinXu/paper-list",
        "kind": "topic-archives",
        "paths": ("README.md",),
        "cadence_path": "README.md",
    },
    {
        # A one-off survey rather than a living list: baseline only, no row diff.
        "id": "isLinXu/idea-research-list",
        "kind": "report",
        "paths": ("docs/04-论文清单与图鉴.md",),
        "cadence_path": "docs/04-论文清单与图鉴.md",
        "baseline_only": True,
    },
)


class AwesomeError(RuntimeError):
    """A repository could not be read at all; its previous row stays on the board."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(ERROR_MESSAGES.get(code, f"清单跟踪失败（{code}）。"))
        self.code = code
        self.detail = detail[:200]


def utc(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise AwesomeError("schema", "采集时间缺少时区")
    return value.astimezone(dt.timezone.utc)


def timestamp(value: dt.datetime) -> str:
    return utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_instant(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except ValueError:
        return None


def safe_error(error: Exception) -> str:
    """Published reasons never carry a path, token or response body."""
    if isinstance(error, AwesomeError):
        return ERROR_MESSAGES.get(error.code, str(error))
    return "公开清单读取失败。"


def add_note(bucket: list[str], message: str, limit: int | None = None) -> None:
    limit = WARNING_LIMIT if limit is None else limit
    if len(bucket) >= limit:
        if bucket and bucket[-1] != "更多告警已省略":
            bucket.append("更多告警已省略")
        return
    if message not in bucket:
        bucket.append(message)


def clean_text(value: Any, limit: int) -> str:
    """Third-party prose, reduced to something safe to publish."""
    text = str(value if value is not None else "")
    text = re.sub(r"<[^>]*>", " ", text)
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def clean_int(value: Any) -> int | None:
    digits = re.sub(r"[^0-9]", "", str(value if value is not None else ""))
    return int(digits) if digits else None


def safe_url(value: Any) -> str | None:
    """Only http(s) without whitespace or quotes survives."""
    text = str(value or "").strip().rstrip(").,;:!?]")
    if not text or len(text) > 2048 or any(char.isspace() for char in text):
        return None
    return text if SAFE_URL_RE.match(text) else None


def github_repo(value: Any) -> str | None:
    match = GITHUB_URL_RE.match(str(value or ""))
    return f"{match.group(1)}/{match.group(2)}" if match else None


PAGES_HOST_RE = re.compile(r"^https?://([a-z0-9-]+)\.github\.io/([^/?#]+)", re.I)


def self_link(href: str, repo: str) -> bool:
    """Does this link point back at the list's own repository or its Pages site?

    A list that links to its own navigation pages is not describing a paper. Without
    this rule the "Interactive Visualizations" table of a README reads as entries and
    inflates the count of a list nobody added anything to.
    """
    owner, _, name = str(repo).partition("/")
    if not owner or not name:
        return False
    text = str(href or "").lower()
    if github_repo(text) == f"{owner}/{name}".lower():
        return True
    match = PAGES_HOST_RE.match(text)
    return bool(match) and match.group(1) == owner.lower() and match.group(2) == name.lower()


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

class Fetcher:
    """Bounded reader for public raw files, with an offline recorded mirror."""

    def __init__(self, offline_dir: Path | None = None, *, opener: Any = None) -> None:
        self.offline = offline_dir
        self.opener = opener
        self.fetches = 0
        self.bytes = 0
        self.budget_hit = False
        self.reasons: dict[str, str] = {}
        self.truncated: set[str] = set()

    def text(self, repo: str, path: str) -> str | None:
        key = f"{repo}|{path}"
        if self.fetches >= MAX_FETCHES:
            # A list this run never got to is not a list that returned a 404, and
            # readers need that difference to keep their warnings honest.
            self.budget_hit = True
            self.reasons[key] = "no_budget"
            return None
        self.fetches += 1
        if self.offline is not None:
            local = self.offline / repo / path
            if not local.is_file():
                self.reasons[key] = "missing"
                return None
            data = local.read_bytes()
        else:
            url = f"https://raw.githubusercontent.com/{repo}/HEAD/" + \
                  urllib.parse.quote(path, safe="/-_.~")
            data = self._get(url)
            if data is None:
                self.reasons[key] = "http"
                return None
        if len(data) > MAX_BYTES:
            self.truncated.add(key)
        data = data[:MAX_BYTES]
        self.bytes += len(data)
        return data.decode("utf-8", errors="replace")

    def reason(self, repo: str, path: str) -> str:
        return self.reasons.get(f"{repo}|{path}", "unreadable")

    def was_truncated(self, repo: str, path: str) -> bool:
        return f"{repo}|{path}" in self.truncated

    def cadence(self, repo: str, path: str) -> list[dict]:
        """The last commits that touched `path`; empty when the API is unavailable."""
        if self.offline is not None:
            local = self.offline / repo / ".github" / "commits.json"
            if not local.is_file():
                return []
            try:
                value = json.loads(local.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return []
        else:
            query = urllib.parse.urlencode({"path": path, "per_page": 3})
            try:
                value = http_get_json(f"https://api.github.com/repos/{repo}/commits?{query}",
                                      headers=auth_headers())
            except Exception:  # noqa: BLE001 - cadence is optional context, never fatal
                return []
        return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []

    def _get(self, url: str) -> bytes | None:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            opener = self.opener or urllib.request.build_opener()
            with opener.open(request, timeout=REQUEST_TIMEOUT) as response:
                return response.read(MAX_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return None


# ---------------------------------------------------------------------------
# Entry extraction
# ---------------------------------------------------------------------------

def strip_aigc(text: str) -> str:
    """Drop the AIGC provenance block some of these files open with.

    It is fenced by ``---`` exactly like our front matter, so a naive parser would
    read a base64 blob as metadata and then find no entries at all.
    """
    if not text.lstrip().startswith("---"):
        return text
    body = text.lstrip()
    end = body.find("\n---", 3)
    if end == -1:
        return text
    block = body[:end]
    if "AIGC" not in block and "ProduceID" not in block:
        return text
    return body[end + len("\n---"):].lstrip("\n")


def split_row(line: str) -> list[str]:
    match = TABLE_ROW_RE.match(line)
    return [cell.strip() for cell in match.group(1).split("|")] if match else []


def column_map(header: list[str]) -> dict[str, int]:
    roles: dict[str, int] = {}
    for index, cell in enumerate(header):
        name = clean_text(cell, 40).lower().strip("* ")
        if not name:
            continue
        for role, needles in COLUMN_ROLES:
            if role in roles:
                continue
            if any(needle in name for needle in needles):
                roles[role] = index
                break
    return roles


def find_date(text: str) -> tuple[str | None, str | None]:
    for pattern, precision in DATE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        value = match.group(1)
        if precision == "month":
            value = f"{match.group(1)}-{match.group(2)}"
        elif precision == "quarter":
            value = f"{match.group(1)}-Q{match.group(2)}"
        return value, precision
    return None, None


def find_venue(text: str) -> str | None:
    match = VENUE_RE.search(text)
    return match.group(1) if match else None


def links_of(text: str) -> list[tuple[str, str]]:
    return [(clean_text(label, 80), safe_url(href) or "")
            for label, href in MARKDOWN_LINK_RE.findall(text)]


def find_arxiv(text: str) -> str | None:
    match = ARXIV_URL_RE.search(text) or ARXIV_LABEL_RE.search(text)
    return match.group(1) if match else None


def plain_title(value: str) -> str:
    text = str(value or "")
    # Tags go first: an entry that opens with ``<img ...>`` would otherwise lose the
    # "<" to the punctuation strip below and leave "img ...>" inside the title.
    text = re.sub(r"<[^>]*>", " ", text)
    text = MARKDOWN_LINK_RE.sub(lambda match: match.group(1) or "", text)
    # The emoji strip runs after the link substitution: a leading "[" is a
    # non-word character too, and eating it first would leave the bare URL behind.
    text = EMOJI_PREFIX_RE.sub("", text)
    text = re.sub(r"[\[\]()*`]", "", text)
    return clean_text(text, TITLE_LIMIT)


def title_of(cells: list[str], roles: dict[str, int], row_text: str) -> str:
    candidates: list[str] = []
    index = roles.get("title")
    cell = cells[index] if index is not None and index < len(cells) else ""
    bold = BOLD_RE.search(row_text)
    if cell and re.search(r"<br\s*/?>|\n", cell, re.I):
        # A composite cell packs title, repo, venue and link together; the bold
        # span inside it is the title, the rest is metadata.
        if bold:
            candidates.append(bold.group(1))
    if cell:
        candidates.append(cell)
    if bold:
        candidates.append(bold.group(1))
    for label, href in links_of(row_text):
        candidates.append(label or href)
    candidates.extend(cells)
    for candidate in candidates:
        text = plain_title(candidate)
        if len(text) >= 3 and not set(text) <= {"-", ":", " "}:
            return text
    return ""


def arxiv_month(arxiv_id: Any) -> dt.date | None:
    """The first day of the month an arXiv id was submitted, or None."""
    match = re.fullmatch(r"(?<!\d)(\d{2})(0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?(?!\d)",
                         str(arxiv_id or "").strip())
    if not match:
        return None
    year = int(match.group(1))
    return dt.date(1900 + year if year >= 91 else 2000 + year, int(match.group(2)), 1)


def add_recency(measured: dict, entries: list[dict], at: dt.datetime) -> None:
    """How young the list is, read off ids and dates we already counted."""
    day = utc(at).date()
    buckets = {"within_90d": 0, "within_365d": 0, "older": 0, "undated": 0}
    for row in entries:
        month = arxiv_month(row.get("arxiv_id"))
        published = row.get("published")
        if month is None and isinstance(published, str):
            if re.fullmatch(r"\d{4}", published):
                # A year alone is read as its first January: that makes the entry
                # look older than it may be, which is the direction that cannot
                # inflate "added in the last 90 days".
                month = dt.date(int(published), 1, 1)
            elif re.fullmatch(r"\d{4}-\d{2}.*", published):
                month = dt.date(int(published[:4]), int(published[5:7]), 1)
        if month is None:
            buckets["undated"] += 1
            continue
        age = (day - month).days
        if age <= 90:
            buckets["within_90d"] += 1
        elif age <= 365:
            buckets["within_365d"] += 1
        else:
            buckets["older"] += 1
    measured["recent"] = buckets
    newest = measured.get("newest_month")
    if isinstance(newest, str) and re.fullmatch(r"\d{4}-\d{2}", newest):
        start = dt.date(int(newest[:4]), int(newest[5:7]), 1)
        measured["newest_month_age_days"] = (day - start).days


def record_skip(skips: dict[str, int] | None, reason: str) -> None:
    if skips is not None:
        skips[reason] = skips.get(reason, 0) + 1


def make_entry(row_text: str, repo: str, section: str | None, cells: list[str] | None = None,
               roles: dict[str, int] | None = None, skips: dict[str, int] | None = None,
               require_link: bool = True) -> dict | None:
    cells = cells or split_row(row_text)
    roles = roles or {}
    arxiv_id = find_arxiv(row_text)
    url = f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else None
    code = None
    external = None
    for _label, href in links_of(row_text):
        if not href or self_link(href, repo):
            continue
        name = github_repo(href)
        if name and code is None:
            code = f"https://github.com/{name}"
        if name is None and external is None:
            external = href
    if url is None:
        # A paper link beats a code link; a code link still counts as an entry,
        # which is all some reports provide.
        url = external or code
    title = title_of(cells, roles, row_text)
    if not title:
        record_skip(skips, "no_title")
        return None
    published, precision = find_date(row_text)
    if precision == "year" and arxiv_id and published == arxiv_id[:4]:
        # "1905.12345" is the arXiv id of a 2019-05 paper, not a year. Reading the
        # identifier as a date would publish a 19th-century publication for it.
        year, month = int(arxiv_id[:2]), int(arxiv_id[2:4])
        if 1 <= month <= 12:
            published, precision = f"{'19' if year >= 91 else '20'}{year}-{month:02d}", "month"
    venue_cell = clean_text(cells[roles["venue"]], 40) if "venue" in (roles or {}) and \
        roles.get("venue", -1) < len(cells) and roles.get("venue", -1) >= 0 else ""
    venue = venue_cell if find_venue(venue_cell) else find_venue(row_text)
    if arxiv_id is None and url is None:
        # A table list carries a link column: a row without one is a leaderboard or
        # a nav table, so requiring the link keeps those out. A report has no link
        # column at all, so there a venue or a date is the paper signal instead.
        if require_link:
            record_skip(skips, "no_link")
            return None
        if venue is None and precision is None:
            record_skip(skips, "no_signal")
            return None
    entry_id = f"arxiv:{arxiv_id}" if arxiv_id else f"title:{slugify(title)}"
    return {"id": entry_id, "title": title, "url": safe_url(url), "arxiv_id": arxiv_id,
            "code_url": code, "published": published, "precision": precision,
            "venue": venue, "section": clean_text(section, SECTION_LIMIT) if section else None}


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(title or "").lower()).strip("-")
    if len(slug) < 4:
        # A Chinese-only title slugs to nothing. Hashing the *slug* would then hand
        # every one of them the same id and quietly merge separate rows, so the
        # fallback hashes the title the reader actually sees.
        return hashlib.sha256(str(title or "").strip().encode("utf-8")).hexdigest()[:16]
    return slug[:60]


def extract_entries(text: str, repo: str, require_link: bool = True) -> dict:
    """Table rows plus bullet rows, each table interpreted with its own header.

    Only table rows are counted as skipped: a table row claims to be an entry, while
    a bullet may be prose, and counting prose would make the number unexplainable.
    """
    entries: list[dict] = []
    seen: set[str] = set()
    sections: list[str] = []
    skips: dict[str, int] = {}
    section: str | None = None
    roles: dict[str, int] = {}
    header: list[str] = []
    in_table = False
    pending: list[str] = []

    def flush() -> None:
        """A bullet and its wrapped continuation lines describe one entry."""
        if not pending:
            return
        entry = make_entry("\n".join(pending), repo, section, require_link=require_link)
        pending.clear()
        if entry is not None and entry["id"] not in seen:
            seen.add(entry["id"])
            entries.append(entry)

    for line in strip_aigc(text).splitlines():
        heading = HEADING_RE.match(line)
        if heading:
            flush()
            section = clean_text(heading.group(2), SECTION_LIMIT)
            if section and section not in sections:
                sections.append(section)
            roles, header, in_table = {}, [], False
            continue
        cells = split_row(line)
        if not cells:
            if not line.strip():
                flush()
                header, in_table = [], False
            elif not in_table:
                bullet = BULLET_RE.match(line)
                if bullet:
                    flush()
                    pending.append(bullet.group(1))
                elif pending:
                    pending.append(line.strip())
            continue
        flush()
        if SEPARATOR_RE.match(line):
            roles = column_map(header)
            header, in_table = [], True
            continue
        if not in_table:
            header = cells
            continue
        if not any(cells):
            continue
        entry = make_entry(line, repo, section, cells, roles, skips, require_link)
        if entry is None:
            continue
        if entry["id"] not in seen:
            seen.add(entry["id"])
            entries.append(entry)
    flush()
    return {"entries": entries, "sections": len(sections),
            "skipped": sum(skips.values()), "skips": dict(skips)}


def cover(entries: list[dict], **extra: Any) -> dict:
    precision: dict[str, int] = {}
    for row in entries:
        key = row.get("precision") or "none"
        precision[key] = precision.get(key, 0) + 1
    out = {
        "entries": len(entries),
        "with_arxiv": sum(1 for row in entries if row.get("arxiv_id")),
        "with_code": sum(1 for row in entries if row.get("code_url")),
        "with_date": sum(1 for row in entries if row.get("published")),
        "with_venue": sum(1 for row in entries if row.get("venue")),
        "unique_ids": len({row["id"] for row in entries}),
        "date_precision": {key: precision[key] for key in sorted(precision)},
    }
    out.update(extra)
    return out


# ---------------------------------------------------------------------------
# Per-kind readers
# ---------------------------------------------------------------------------

def self_reported_badges(fetcher: Fetcher, source: dict, warnings: list[str]) -> dict | None:
    """README badge numbers are claims; publish them as claims."""
    path = source.get("badge_path")
    if not path:
        return None
    text = fetcher.text(source["id"], path)
    if text is None:
        return None
    numbers = sorted({clean_int(match.group(1)) for match in BADGE_RE.finditer(text)
                      if clean_int(match.group(1))})
    if not numbers:
        return None
    if len(numbers) > 1:
        add_note(warnings, f"{source['id']}：README 徽章自报了多个互不相同的条目数"
                           f"（{' / '.join(str(n) for n in numbers)}），本页一律以实测计数为准。")
    return {"file": path, "entries": max(numbers), "values": numbers,
            "note": "仓库自己写在徽章里的数字，与实测分列显示，不参与任何合计。"}


def read_markdown(fetcher: Fetcher, source: dict, warnings: list[str]) -> dict:
    repo = source["id"]
    entries: list[dict] = []
    seen: set[str] = set()
    sections = 0
    skips: dict[str, int] = {}
    files: list[dict] = []
    unread: list[str] = []
    capped: list[str] = []
    # A report has no link column, so its cited rows are recognised by venue or date
    # instead; a table row without a link is a leaderboard row, not an entry.
    require_link = not source.get("baseline_only")
    for path in source["paths"]:
        text = fetcher.text(repo, path)
        if text is None:
            unread.append(path)
            continue
        parsed = extract_entries(text, repo, require_link)
        sections += parsed["sections"]
        for key, value in parsed["skips"].items():
            skips[key] = skips.get(key, 0) + value
        for entry in parsed["entries"]:
            if entry["id"] in seen:
                continue
            seen.add(entry["id"])
            entries.append(entry)
        encoded = text.encode("utf-8")
        files.append({"path": path, "bytes": len(encoded), "lines": len(text.splitlines()),
                      "sha256": hashlib.sha256(encoded).hexdigest()[:16],
                      "rows": len(parsed["entries"]),
                      "truncated": fetcher.was_truncated(repo, path)})
        if fetcher.was_truncated(repo, path):
            capped.append(path)
    if not files:
        raise AwesomeError(unread_code(fetcher, repo, unread), f"{repo}: 清单文件不可读")
    measured = cover(entries, sections=sections, skipped=sum(skips.values()),
                     skipped_no_title=skips.get("no_title", 0),
                     skipped_no_link=skips.get("no_link", 0),
                     skipped_no_signal=skips.get("no_signal", 0), files=files)
    if capped:
        # Reading stops at the byte ceiling, so the rows past it were never counted:
        # publishing the number without saying so would report a shorter list.
        measured["byte_capped"] = True
        add_note(warnings, f"{repo}：{'、'.join(capped)} 超过单文件 {kb(MAX_BYTES)} KB 上限，"
                           "超出部分没有逐行数过，本次实测条目数是下限。")
    if source.get("baseline_only"):
        # A report cites rows by title, venue and authors; a missing link is how
        # that document is written, not a gap in our reading.
        measured["unlinked_rows"] = sum(1 for row in entries if not row.get("url"))
        measured["note"] = ("该文件是一次性报告：无外链的行只在认得出会议或日期时才计入，"
                            "其余行计入 skipped，不当作条目。")
    return {"entries": entries, "measured": measured,
            "self_reported": self_reported_badges(fetcher, source, warnings)}


def read_machine_json(fetcher: Fetcher, source: dict, warnings: list[str]) -> dict:
    """awesome-visual-reasoning publishes its own index; read that, not the README."""
    repo = source["id"]
    stats_text = fetcher.text(repo, "data/stats.json")
    papers_text = fetcher.text(repo, "data/papers.json")
    if papers_text is None:
        raise AwesomeError(unread_code(fetcher, repo, ["data/papers.json"]),
                           f"{repo}: papers.json 不可读")
    stats = json.loads(stats_text) if stats_text else {}
    if not isinstance(stats, dict):
        stats = {}
    papers = json.loads(papers_text)
    index = papers.get("papers") if isinstance(papers.get("papers"), dict) else None
    if index is None:
        raise AwesomeError("network", f"{repo}: papers.json 结构不符合预期")
    entries: list[dict] = []
    for arxiv_id, item in index.items():
        if not isinstance(item, dict):
            continue
        title = clean_text(item.get("title"), TITLE_LIMIT)
        if not title:
            continue
        published = clean_text(item.get("published"), 10) or None
        categories = item.get("categories") if isinstance(item.get("categories"), list) else []
        entries.append({
            "id": f"arxiv:{arxiv_id}",
            "title": title,
            "url": safe_url(item.get("url")) or f"https://arxiv.org/abs/{arxiv_id}",
            "arxiv_id": str(arxiv_id),
            "code_url": None,
            "published": published,
            "precision": "day" if published else None,
            "venue": None,
            "section": clean_text(categories[0] if categories else None, SECTION_LIMIT) or None,
        })
    categories = stats.get("categories") if isinstance(stats.get("categories"), dict) else {}
    measured = cover(entries, sections=len(categories), skipped=0,
                     skipped_no_title=0, skipped_no_link=0, skipped_no_signal=0,
                     files=[{"path": "data/papers.json", "bytes": len(papers_text.encode()),
                             "rows": len(entries),
                             "truncated": fetcher.was_truncated(repo, "data/papers.json")}] +
                           ([{"path": "data/stats.json", "bytes": len(stats_text.encode()),
                              "rows": 0,
                              "truncated": fetcher.was_truncated(repo, "data/stats.json")}]
                             if stats_text else []))
    if fetcher.was_truncated(repo, "data/papers.json"):
        measured["byte_capped"] = True
        add_note(warnings, f"{repo}：data/papers.json 超过单文件 {kb(MAX_BYTES)} KB 上限，"
                           "本次数到的条目只是截断之前的部分。")
    self_reported = {
        "file": "data/stats.json",
        "generated_at": clean_text(stats.get("generated_at"), 24) or None,
        "entries": clean_int(stats.get("papers_total")),
        "in_docs": clean_int(stats.get("papers_in_docs")),
        "new_7d": clean_int(stats.get("papers_new_7d")),
        "last_30d": clean_int(stats.get("papers_last_30d")),
        "repos_total": clean_int(stats.get("repos_total")),
        # Star counts of third-party code repositories, published by the list
        # itself: recorded as its claim, never merged into our own totals.
        "repos_stars_total": clean_int(stats.get("repos_stars_total")),
        "note": "以下数字来自该仓库自己发布的 data/stats.json，与本站实测分列显示。",
    }
    if self_reported["entries"] != measured["entries"]:
        add_note(warnings, f"{repo}：自报 {self_reported['entries']} 条与实测 "
                           f"{measured['entries']} 条不一致，两边都发布，不做取舍。")
    return {"entries": entries, "measured": measured, "self_reported": self_reported,
            "categories": [{"category": clean_text(name, SECTION_LIMIT),
                            "self_reported": clean_int(item.get("papers")),
                            "rows_in_doc": clean_int(item.get("rows_in_doc")),
                            "new_7d": clean_int(item.get("papers_new_7d"))}
                           for name, item in sorted(categories.items()) if isinstance(item, dict)]}


def unread_code(fetcher: Fetcher, repo: str, paths: list[str]) -> str:
    """`budget` when the run ran out of fetches, `network` when the file did."""
    return "budget" if any(fetcher.reason(repo, path) == "no_budget" for path in paths) \
        else "network"


def read_topic_archives(fetcher: Fetcher, source: dict, warnings: list[str]) -> dict:
    """paper-list: one index page per topic; a month becomes a new file, nothing is deleted."""
    repo = source["id"]
    readme = fetcher.text(repo, "README.md")
    if readme is None:
        raise AwesomeError(unread_code(fetcher, repo, ["README.md"]), f"{repo}: README 不可读")
    topics: list[str] = []
    for match in TOPIC_LINK_RE.finditer(readme):
        if match.group(1) not in topics:
            topics.append(match.group(1))
    if len(topics) > TOPIC_LIMIT:
        add_note(warnings, f"{repo}：主题数超过 {TOPIC_LIMIT} 个，其余本次不读取。")
    topics = topics[:TOPIC_LIMIT]

    rows: list[dict] = []
    missing = 0
    budget_out = False
    for name in topics:
        path = f"docs/{name}.md"
        text = fetcher.text(repo, path)
        if text is None:
            missing += 1
            rows.append({"topic": name, "status": "unavailable", "latest_month": None,
                         "self_reported_total": None, "self_reported_month": None,
                         "measured_rows": None,
                         "error": "no_budget" if fetcher.reason(repo, path) == "no_budget"
                                  else "unreadable"})
            if fetcher.reason(repo, path) == "no_budget":
                budget_out = True
                break
            continue
        month = None
        latest = LATEST_MONTH_RE.search(text)
        if latest:
            month = latest.group(1)
        else:
            months = MONTH_RE.findall(text) + MONTH_ROW_RE.findall(text)
            month = max(months) if months else None
        reported_month = None
        for line in text.splitlines():
            if month and line.strip().startswith(f"- [{month}]"):
                inside = SELF_MONTH_RE.search(line)
                reported_month = clean_int(inside.group(1)) if inside else None
                break
        rows.append({"topic": name, "status": "ok", "latest_month": month,
                     "self_reported_total": clean_int((TOTAL_PAPERS_RE.search(text) or
                                                       _NoMatch()).group(1))
                     if TOTAL_PAPERS_RE.search(text) else None,
                     "self_reported_month": reported_month, "measured_rows": None})
    newest = max((row["latest_month"] or "" for row in rows), default="") or None
    active = sum(1 for row in rows if newest and row["latest_month"] == newest)

    # Only the topics that are still archiving are worth counting row by row.
    entries: list[dict] = []
    seen: set[str] = set()
    duplicated = 0
    sampled = 0
    skips: dict[str, int] = {}
    capped: list[str] = []
    for row in rows:
        if sampled >= MONTH_SAMPLE_LIMIT or budget_out:
            break
        if row["status"] != "ok" or not row["latest_month"] or row["latest_month"] != newest:
            continue
        path = f"docs/{row['topic']}/{row['latest_month']}.md"
        text = fetcher.text(repo, path)
        if text is None:
            if fetcher.reason(repo, path) == "no_budget":
                budget_out = True
            continue
        if fetcher.was_truncated(repo, path):
            capped.append(path)
        parsed = extract_entries(text, repo)
        row["measured_rows"] = len(parsed["entries"])
        row["skipped_rows"] = parsed["skipped"]
        for key, value in parsed["skips"].items():
            skips[key] = skips.get(key, 0) + value
        sampled += 1
        for entry in parsed["entries"]:
            entry["section"] = clean_text(f"{row['topic']} · {row['latest_month']}", SECTION_LIMIT)
            # One arXiv paper is often archived under several topics; counting it
            # twice would make our measured row exceed the topic pages themselves.
            if entry["id"] in seen:
                duplicated += 1
                continue
            seen.add(entry["id"])
            entries.append(entry)
    reported_total = sum(row["self_reported_total"] or 0 for row in rows) or None
    measured = cover(entries, sections=len(topics), skipped=sum(skips.values()),
                     skipped_no_title=skips.get("no_title", 0),
                     skipped_no_link=skips.get("no_link", 0),
                     skipped_no_signal=skips.get("no_signal", 0),
                     duplicated_rows=duplicated,
                     files=[{"path": "README.md", "bytes": len(readme.encode()), "rows": 0,
                             "truncated": fetcher.was_truncated(repo, "README.md")}],
                     topics=len(topics), topics_reporting=sum(1 for row in rows
                                                              if row["status"] == "ok"),
                     topics_unreadable=missing,
                     topics_not_attempted=max(0, len(topics) - len(rows)),
                     topics_at_newest_month=active,
                     newest_month=newest, months_sampled=sampled)
    if capped:
        measured["byte_capped"] = True
        add_note(warnings, f"{repo}：{'、'.join(capped)} 超过单文件 {kb(MAX_BYTES)} KB 上限，"
                           "超出部分没有逐行数过，本次实测条目数是下限。")
    if budget_out:
        add_note(warnings, f"{repo}：抓取预算用尽，{max(0, len(topics) - len(rows))} 个主题这次没轮到："
                           "自报合计与逐行数过的主题都只是已读到的部分，不是整份清单。")
    return {"entries": entries, "measured": measured,
            "self_reported": {"file": "docs/<topic>.md",
                              "entries": reported_total,
                              "months_sampled": sampled,
                              "note": "各主题索引页自报的 Total papers 之和；本站只对最新月份的 "
                                      f"{sampled} 个主题逐行数过，因此实测远小于自报，两者不可比。"},
            "topics": rows}


class _NoMatch:
    """Stand-in so a missing ``Total papers`` line reads as absent, not as zero."""

    group = staticmethod(lambda _index: "")


READERS: dict[str, Callable[[Fetcher, dict, list[str]], dict]] = {
    "markdown-table": read_markdown,
    "machine-json": read_machine_json,
    "topic-archives": read_topic_archives,
    "report": read_markdown,
}


# ---------------------------------------------------------------------------
# Cadence and ledger
# ---------------------------------------------------------------------------

def read_cadence(fetcher: Fetcher, source: dict, at: dt.datetime) -> dict:
    commits = fetcher.cadence(source["id"], source["cadence_path"])
    newest: dict | None = None
    for item in commits:
        meta = item.get("commit") if isinstance(item.get("commit"), dict) else {}
        author = meta.get("author") if isinstance(meta.get("author"), dict) else {}
        instant = parse_instant(author.get("date"))
        if instant is None:
            continue
        if newest is not None and instant <= newest["when"]:
            continue
        owner = item.get("author") if isinstance(item.get("author"), dict) else {}
        name = clean_text(author.get("name"), 40)
        newest = {"when": instant,
                  "author": clean_text(owner.get("login"), 40) or name or None,
                  "is_bot": str(owner.get("type") or "").lower() == "bot" or name.endswith("[bot]"),
                  "message": clean_text((str(meta.get("message") or "").splitlines() or [""])[0], 80),
                  "sha": clean_text(item.get("sha"), 40)[:12] or None}
    if newest is None:
        return {"status": "unknown", "last_file_commit_at": None, "author": None,
                "is_bot": None, "message": None, "cadence": None, "stale_days": None,
                "stalled": None, "commits_seen": len(commits)}
    days = (utc(at) - newest["when"]).days
    label = ("daily" if days <= 2 else "weekly" if days <= 9 else
             "monthly" if days <= 40 else "manual")
    return {"status": "ok", "last_file_commit_at": timestamp(newest["when"]),
            "author": newest["author"], "is_bot": newest["is_bot"], "message": newest["message"],
            "cadence": label, "stale_days": days, "stalled": days > STALL_AFTER_DAYS,
            "commits_seen": len(commits)}


def ledger_ids(entry: Any) -> Any:
    """Yesterday's row in the ledger is ``{captured_at, ids}``; accept either shape.

    Reading the envelope itself as the id list would make every run look like a first
    run, so "added / removed" would never appear at all.
    """
    if isinstance(entry, dict):
        return entry.get("ids")
    return entry


def ledger_capped(entry: Any) -> bool:
    """Whether the remembered id list for a repo was cut by LEDGER_ID_LIMIT."""
    return bool(entry.get("capped")) if isinstance(entry, dict) else False


def diff_ids(previous: Any, current: list[str], capped: bool = False) -> dict:
    """Added / removed against the last run; the first run is a baseline, not a spike."""
    ids = sorted(set(current))
    if not isinstance(previous, list):
        return {"baseline": True, "added": 0, "removed": 0, "held": len(ids),
                "truncated": False, "added_ids": [], "removed_ids": []}
    before, now = set(previous), set(ids)
    if capped:
        # Yesterday's ledger is a prefix of the ids, so every id past the cap reads as
        # new arrivals, forever. A comparison that cannot be made is published as
        # None, not as the number that would flatter the board.
        return {"baseline": False, "added": None, "removed": None,
                "held": len(now & before), "truncated": True,
                "added_ids": [], "removed_ids": [],
                "note": "上次台账被 id 上限截断，新增与移出无法比较：本次只报保留数。"}
    return {"baseline": False, "added": len(now - before), "removed": len(before - now),
            "held": len(now & before), "truncated": False,
            "added_ids": sorted(now - before), "removed_ids": sorted(before - now)}


def topic_ids(rows: list[dict]) -> list[str]:
    """For paper-list the honest diff is "a topic archived a newer month"."""
    return sorted({f"month:{row['topic']}:{row['latest_month']}" for row in rows
                   if row.get("status") == "ok" and row.get("latest_month")})


def pick_sample(entries: list[dict], added_ids: set[str], limit: int | None = None) -> list[dict]:
    limit = SAMPLE_LIMIT if limit is None else limit

    def key(row: dict) -> tuple[int, str]:
        return (0 if row["id"] in added_ids else 1, str(row.get("published") or ""))

    fresh = sorted((row for row in entries if row["id"] in added_ids),
                   key=lambda row: str(row.get("published") or ""), reverse=True)
    rest = sorted((row for row in entries if row["id"] not in added_ids), key=key, reverse=False)
    chosen = fresh[:limit] + rest[:max(0, limit - len(fresh))]
    return [{"id": row["id"], "title": row["title"], "url": row["url"],
             "arxiv_id": row["arxiv_id"], "published": row["published"],
             "venue": row["venue"], "section": row["section"],
             "is_new": row["id"] in added_ids} for row in chosen]


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------

def json_bytes(value: Any) -> int:
    """Size on disk: atomic_json_write uses the same compact form plus one newline."""
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")) + 1


def kb(value: Any) -> int:
    """The KB a reader of these warnings means: 1024 bytes, same as the workflow."""
    return round((value or 0) / 1024)


def published_bytes(payload: dict) -> int:
    """The size of the file including the size field the file itself reports."""
    size = json_bytes(payload)
    for _ in range(4):
        probe = {**payload, "sizes": {**payload["sizes"], "payload_bytes": size}}
        measured = json_bytes(probe)
        if measured == size:
            return size
        size = measured
    return size


def fit_size_budget(payload: dict, ledger_bytes: int, warnings: list[str]) -> None:
    """Keep the browser file inside its budget by shortening samples, never totals.

    A sample is a capped view of a list, and pick_sample puts the fresh entries at
    the head, so cutting the tail loses the least informative rows. The counts and
    the ledger stay whole: a number trimmed for size would be a lie, and a ledger
    with ids missing would report those ids as new arrivals tomorrow.
    """
    payload["sizes"] = {"payload_bytes": json_bytes(payload),
                        "payload_budget_bytes": PAYLOAD_BUDGET_BYTES,
                        "ledger_bytes": ledger_bytes,
                        "ledger_budget_bytes": LEDGER_BUDGET_BYTES}
    rows = [row for row in payload.get("repos") or [] if isinstance(row.get("sample"), list)]
    limit = SAMPLE_LIMIT
    while published_bytes(payload) > PAYLOAD_BUDGET_BYTES and limit > 0:
        limit = max(0, limit - SAMPLE_TRIM_STEP)
        for row in rows:
            del row["sample"][limit:]
    size = published_bytes(payload)
    if limit < SAMPLE_LIMIT:
        add_note(warnings, f"快照超过 {kb(PAYLOAD_BUDGET_BYTES)} KB 预算，本次把每清单样本压到 "
                           f"{limit} 条（从最新往后留）；条目计数、自报数与台账都不受影响。")
        size = published_bytes(payload)
    if size > PAYLOAD_BUDGET_BYTES:
        add_note(warnings, f"样本全部去掉后快照仍有 {kb(size)} KB，超过 {kb(PAYLOAD_BUDGET_BYTES)} KB "
                           "预算：要么少跟一个清单，要么把预算抬上去，否则读者下载的是越来越大的文件。")
    if ledger_bytes > LEDGER_BUDGET_BYTES:
        add_note(warnings, f"id 台账 {kb(ledger_bytes)} KB 超过 {kb(LEDGER_BUDGET_BYTES)} KB 预算。"
                           "台账只报不砍：砍掉的 id 明天会被重新算成新增，所以该调的是每清单的 id 上限。")
    # `budget.sample_limit` is the ceiling the collector runs under; this is what the
    # file actually shipped, so a trimmed snapshot never contradicts its own envelope.
    payload["sizes"]["sample_limit_applied"] = limit
    # Measure last, with every note already inside the file: the byte count the index
    # publishes has to be the byte count the reader downloads.
    payload["sizes"]["payload_bytes"] = published_bytes(payload)


def build_repo_row(source: dict, fetcher: Fetcher, previous: dict, ledger: dict,
                   at: dt.datetime, warnings: list[str]) -> tuple[dict, list[str]]:
    repo = source["id"]
    attempt = timestamp(at)
    old = previous.get(repo) if isinstance(previous.get(repo), dict) else {}

    def degraded(reason: AwesomeError, note: str) -> tuple[dict, list[str]]:
        if old.get("measured"):
            add_note(warnings, f"{repo}：{note}，沿用上次结果并标记过期")
            return {**old, "status": "stale", "error": safe_error(reason),
                    "last_attempt_at": attempt, "not_attempted": False,
                    "previous_captured_at": old.get("captured_at")}, []
        add_note(warnings, f"{repo}：{note}，且没有可沿用的历史")
        return {"id": repo, "kind": source["kind"], "upstream": bool(source.get("upstream")),
                "status": "unavailable", "error": safe_error(reason), "captured_at": None,
                "last_attempt_at": attempt, "measured": None, "self_reported": None,
                "cadence": None, "diff": None, "sample": [], "files": []}, []

    try:
        data = READERS[source["kind"]](fetcher, source, warnings)
    except (AwesomeError, urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        reason = error if isinstance(error, AwesomeError) else AwesomeError("network")
        return degraded(reason, "本次没读到")

    if not data["entries"]:
        # A file we could read but could not parse a single row out of is a format
        # change, not an emptied list. Publishing 0 here would turn tomorrow's diff
        # into "the whole list disappeared", so the last good row is kept instead and
        # the ledger is left untouched.
        return degraded(AwesomeError("format"),
                        "文件读到了但一行条目都没认出，按清单格式变化处理")

    entries = data["entries"]
    add_recency(data["measured"], entries, at)
    try:
        cadence = read_cadence(fetcher, source, at)
    except Exception:  # noqa: BLE001 - cadence never decides whether the row publishes
        cadence = {"status": "unknown", "last_file_commit_at": None, "author": None,
                   "is_bot": None, "message": None, "cadence": None, "stale_days": None,
                   "stalled": None, "commits_seen": 0}
    ids = topic_ids(data.get("topics") or []) if source["kind"] == "topic-archives" \
        else sorted({str(row["id"]) for row in entries})
    outcome = diff_ids(ledger_ids(ledger.get(repo)), ids, ledger_capped(ledger.get(repo)))
    capped = ids[:LEDGER_ID_LIMIT]
    if len(ids) > LEDGER_ID_LIMIT:
        outcome["truncated"] = True
        add_note(warnings, f"{repo}：条目 id 超过 {LEDGER_ID_LIMIT} 个，台账只记前 {LEDGER_ID_LIMIT} 个，"
                           "新增与移出因此是下限而非全量；下一次运行在抬高上限之前不再报增删。")
    if source.get("baseline_only"):
        outcome = {"baseline": True, "added": None, "removed": None, "held": len(ids),
                   "truncated": outcome.get("truncated", False),
                   "note": "一次性调研报告，没有更新流：只登记基线，不声称新增或移出。"}
    elif outcome["baseline"]:
        outcome["note"] = "首次读到这份清单：本次只建立基线，明日起的新增与移出才是可信的变化量。"
        add_note(warnings, f"{repo}：首次建立条目基线，本次不报新增。")
    if source.get("rolling_window") and outcome.get("removed"):
        outcome["rolling_window"] = True
        add_note(warnings, f"{repo}：清单是滚动窗口，移出 {outcome['removed']} 条属于正常收缩，"
                           "不是数据丢失。")
    row = {
        "id": repo,
        "kind": source["kind"],
        "upstream": bool(source.get("upstream")),
        "status": "ok",
        "error": None,
        "captured_at": attempt,
        "last_attempt_at": attempt,
        "measured": data["measured"],
        "self_reported": data.get("self_reported"),
        "cadence": cadence,
        "diff": {key: value for key, value in outcome.items() if not key.endswith("_ids")},
        "sample": pick_sample(entries, set(outcome.get("added_ids") or [])),
        "files": data["measured"].get("files") or [{"path": path} for path in source["paths"]],
    }
    for extra in ("categories", "topics"):
        if data.get(extra) is not None:
            row[extra] = data[extra]
    if cadence.get("stalled"):
        add_note(warnings, f"{repo}：清单文件已 {cadence.get('stale_days')} 天没动过，"
                           "按基线看待，不当作日更来源。")
    return row, capped


def carried_row(source: dict, previous: dict) -> dict:
    """A list this run never fetched still needs a whole row on the board.

    Dropping the row reads as "we stopped tracking it" and takes its ledger with
    it, so tomorrow's run calls a remembered list a first read. Publishing it as
    ``ok`` would claim bytes we never fetched. Neither: keep the last good numbers,
    say plainly that this run did not read it, and leave `last_attempt_at` alone
    because no attempt was made.
    """
    repo = source["id"]
    reason = safe_error(AwesomeError("budget"))
    old = previous.get(repo) if isinstance(previous.get(repo), dict) else {}
    if old.get("measured"):
        return {**old, "status": "stale", "error": reason, "not_attempted": True,
                "previous_captured_at": old.get("captured_at")}
    return {"id": repo, "kind": source["kind"], "upstream": bool(source.get("upstream")),
            "status": "unavailable", "error": reason, "captured_at": None,
            "last_attempt_at": None, "measured": None, "self_reported": None,
            "cadence": None, "diff": None, "sample": [], "files": [],
            "not_attempted": True}


def collect(at: dt.datetime, *, sources: tuple[dict, ...] = SOURCES,
            offline_dir: Path | None = None,
            previous: dict | None = None, ledger: dict | None = None,
            opener: Any = None) -> dict:
    """Read every list and return the payload plus the ledger to persist. No writes."""
    at = utc(at)
    previous = previous if isinstance(previous, dict) else {}
    ledger = ledger if isinstance(ledger, dict) else {}
    old_repos = {row.get("id"): row for row in previous_rows(previous)}
    old_ledger = ledger.get("repos") if isinstance(ledger.get("repos"), dict) else {}
    fetcher = Fetcher(offline_dir, opener=opener)
    warnings: list[str] = []
    fetched: dict[str, dict] = {}
    new_ledger: dict[str, Any] = {}
    read: set[str] = set()
    for index, source in enumerate(sources):
        if fetcher.fetches >= MAX_FETCHES:
            # The published flag means "this run did not reach every tracked list",
            # whether the ceiling stopped a file inside a list or the whole loop.
            fetcher.budget_hit = True
            add_note(warnings, f"抓取达到 {MAX_FETCHES} 次上限，剩余 "
                               f"{len(sources) - index} 个清单留到下一次。")
            break
        row, ids = build_repo_row(source, fetcher, old_repos, old_ledger, at, warnings)
        read.add(row["id"])
        if row["status"] == "ok":
            # `capped` travels with the ids: a remembered prefix that the next run
            # cannot tell apart from a whole list would read as fake new arrivals.
            new_ledger[row["id"]] = {"captured_at": row["captured_at"], "ids": ids,
                                     "capped": bool((row.get("diff") or {}).get("truncated"))}
        elif old_ledger.get(row["id"]) is not None:
            new_ledger[row["id"]] = old_ledger[row["id"]]
        fetched[row["id"]] = row
    # A list the table still tracks but this run never reached — out of fetches, or
    # left out by --only — keeps its last row and its ledger ids. Dropping it would
    # read as "untracked" today and as a brand new first read tomorrow. Only an edit
    # to SOURCES means untracked, and that still reports the list as gone.
    rows: list[dict] = []
    seen: set[str] = set()
    for source in sources:
        rows.append(fetched.get(source["id"]) or carried_row(source, old_repos))
        seen.add(source["id"])
    for source in SOURCES:
        if source["id"] in seen or source["id"] not in old_repos:
            continue
        rows.append(carried_row(source, old_repos))
        seen.add(source["id"])
    for repo, entry in old_ledger.items():
        if repo not in read and entry is not None:
            new_ledger.setdefault(repo, entry)
    summary = summarise(rows)
    ready = summary["repos_ok"]
    if ready and ready == len(rows):
        # A row carried over unread is not "ready", so the run can only ever be
        # partial while a tracked list is left on the board unread.
        status = "ok"
    elif ready:
        status = "partial"
    else:
        status = "stale" if previous_rows(previous) else "unavailable"
    envelope = _envelope(at)
    # The index describes the rows it ships, not the scope the caller asked for: a
    # narrowed run still publishes every tracked list it remembered.
    envelope["source"]["repos"] = [row["id"] for row in rows]
    payload = {**envelope, "status": status,
               "error": None if status in ("ok", "partial")
                        else (warnings[0] if warnings else safe_error(AwesomeError("network"))),
               "captured_at": timestamp(at) if status in ("ok", "partial")
                              else (previous.get("captured_at") if rows else None),
               "last_attempt_at": timestamp(at),
               "summary": summary,
               "fetches": {"files": fetcher.fetches, "bytes": fetcher.bytes,
                           "max_files": MAX_FETCHES, "budget_hit": fetcher.budget_hit},
               "changes": compare_rows(previous_rows(previous), rows),
               "warnings": warnings,
               "repos": rows}
    if status not in ("ok", "partial") and previous_rows(previous):
        # Nothing could be read today: keep the last good snapshot visible.
        payload = {**previous, **payload, "captured_at": previous.get("captured_at"),
                   "summary": summarise(previous_rows(previous)),
                   "changes": previous.get("changes") if isinstance(
                       previous.get("changes"), dict) else payload["changes"],
                   "fetches": payload["fetches"], "warnings": warnings,
                   "repos": previous_rows(previous)}
    ledger_out = {"schema_version": SCHEMA_VERSION, "updated_at": timestamp(at),
                  "repos": new_ledger}
    fit_size_budget(payload, json_bytes(ledger_out), warnings)
    return {"payload": payload, "ledger": ledger_out, "status": status}


def summarise(rows: list[dict]) -> dict:
    own = [row for row in rows if row.get("status") == "ok" and not row.get("upstream")]
    upstream = [row for row in rows if row.get("status") == "ok" and row.get("upstream")]
    by_kind: dict[str, int] = {}
    for row in own:
        key = str(row.get("kind") or "unknown")
        by_kind[key] = by_kind.get(key, 0) + _num(row, "entries")
    return {
        "repos": len(rows),
        "repos_ok": sum(1 for row in rows if row.get("status") == "ok"),
        "repos_stale": sum(1 for row in rows if row.get("status") == "stale"),
        "repos_unavailable": sum(1 for row in rows if row.get("status") == "unavailable"),
        "entries_measured": sum(_num(row, "entries") for row in own),
        "entries_upstream": sum(_num(row, "entries") for row in upstream),
        # Some lists are counted row by row, some only in sampled months, one only
        # where a link exists: the total is "rows we read today", and this says so.
        "entries_by_kind": {key: by_kind[key] for key in sorted(by_kind)},
        "with_arxiv": sum(_num(row, "with_arxiv") for row in own),
        "with_code": sum(_num(row, "with_code") for row in own),
        "added": sum(_num(row, "added") for row in own),
        "removed": sum(_num(row, "removed") for row in own),
        "stalled": sum(1 for row in rows if (row.get("cadence") or {}).get("stalled")),
        "upstream_repos": len(upstream),
        "self_reported_repos": sum(1 for row in rows if row.get("self_reported")),
    }


def _num(row: dict, field: str) -> int:
    source = row.get("measured") if field in ("entries", "with_arxiv", "with_code") \
        else row.get("diff")
    value = (source or {}).get(field)
    return value if isinstance(value, int) and value > 0 else 0


def compare_rows(previous: list[dict], rows: list[dict]) -> dict:
    before = {row.get("id"): row for row in previous if isinstance(row, dict)}
    changes = {"added": [], "removed": [], "grown": [], "shrunk": [], "status": []}
    for row in rows:
        old = before.pop(row["id"], None)
        if old is None:
            changes["added"].append(row["id"])
            continue
        delta = _num(row, "entries") - _num(old, "entries")
        if delta > 0:
            changes["grown"].append({"id": row["id"], "delta": delta})
        elif delta < 0:
            changes["shrunk"].append({"id": row["id"], "delta": delta})
        if row.get("status") != old.get("status"):
            changes["status"].append({"id": row["id"], "from": old.get("status"),
                                      "to": row.get("status")})
    changes["removed"] = sorted(str(key) for key in before)
    for key in ("added", "removed"):
        changes[key] = changes[key][:CHANGE_LIMIT]
    return changes


def previous_rows(payload: Any) -> list[dict]:
    repos = payload.get("repos") if isinstance(payload, dict) else None
    return [row for row in (repos or []) if isinstance(row, dict)]


def history_snapshot(history: dict, summary: dict, at: dt.datetime) -> dict:
    snapshots = [row for row in (history.get("snapshots") or []) if isinstance(row, dict)]
    day = utc(at).date().isoformat()
    snapshots = [row for row in snapshots if row.get("date") != day]
    snapshots.append({"date": day, "captured_at": timestamp(at),
                      "repos": summary["repos_ok"],
                      "entries_measured": summary["entries_measured"],
                      "entries_upstream": summary["entries_upstream"],
                      "added": summary["added"], "removed": summary["removed"],
                      "stalled": summary["stalled"],
                      # A day where fewer lists were read than are tracked is a day of
                      # carried numbers, not a flat list: the trend has to say so.
                      "tracked": summary["repos"]})
    snapshots.sort(key=lambda row: str(row.get("date") or ""))
    cutoff = (utc(at).date() - dt.timedelta(days=HISTORY_RETENTION_DAYS)).isoformat()
    return {"schema_version": SCHEMA_VERSION, "source": {"id": SOURCE_ID},
            "updated_at": timestamp(at),
            "retention": {"daily_days": DAILY_HISTORY_DAYS, "monthly_points": MONTHLY_HISTORY_LIMIT},
            "snapshots": thin_snapshots(snapshots, utc(at).date(), cutoff=cutoff)}


def thin_snapshots(snapshots: list[dict], today: dt.date, *, cutoff: str) -> list[dict]:
    """Daily for the last four months, one point per month before that.

    The page draws a trend from this file, so it has to stay a download a reader
    will actually get: 1,100 daily rows are ~150 KB of numbers the eye cannot use.
    A thinned month keeps that month's last read, which is a real snapshot rather
    than an invented average, and the gap is published in `retention`.
    """
    daily_from = (today - dt.timedelta(days=DAILY_HISTORY_DAYS - 1)).isoformat()
    kept = [row for row in snapshots if cutoff <= str(row.get("date") or "")]
    older = [row for row in kept if str(row.get("date") or "") < daily_from]
    recent = [row for row in kept if str(row.get("date") or "") >= daily_from]
    by_month: dict[str, dict] = {}
    for row in older:
        by_month[str(row.get("date"))[:7]] = row  # dates are sorted: the last wins
    monthly = [by_month[month] for month in sorted(by_month)][-MONTHLY_HISTORY_LIMIT:]
    return monthly + recent


def _envelope(at: dt.datetime) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {"id": SOURCE_ID, "kinds": list(KINDS), "states": list(REPO_STATES),
                   "statuses": list(STATUSES), "cadence": ("daily", "weekly", "monthly", "manual"),
                   "budget": {"sample_limit": SAMPLE_LIMIT, "ledger_id_limit": LEDGER_ID_LIMIT,
                              "topic_limit": TOPIC_LIMIT, "month_sample_limit": MONTH_SAMPLE_LIMIT,
                              "max_fetches": MAX_FETCHES, "title_limit": TITLE_LIMIT,
                              "stall_after_days": STALL_AFTER_DAYS,
                              "payload_budget_bytes": PAYLOAD_BUDGET_BYTES,
                              "ledger_budget_bytes": LEDGER_BUDGET_BYTES},
                   "url": "https://github.com/isLinXu/model-observatory"},
        "captured_at": None, "last_attempt_at": timestamp(at),
    }


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def publish(data_dir: Path, at: dt.datetime, *, sources: tuple[dict, ...] = SOURCES,
            offline_dir: Path | None = None, opener: Any = None) -> str:
    at = utc(at)
    path = data_dir / "awesome.json"
    ledger_path = data_dir / "awesome_ledger.json"
    previous = load(path)
    saved = parse_instant(previous.get("captured_at")) if isinstance(previous, dict) else None
    if saved is not None and saved > at:
        return "rejected"
    outcome = collect(at, sources=sources, offline_dir=offline_dir, previous=previous,
                      ledger=load(ledger_path), opener=opener)
    payload, status = outcome["payload"], outcome["status"]
    atomic_json_write(path, payload)
    if status in ("ok", "partial"):
        atomic_json_write(ledger_path, outcome["ledger"])
        atomic_json_write(data_dir / "awesome_history.json",
                          history_snapshot(load(data_dir / "awesome_history.json"),
                                           payload["summary"], at))
    return status if status != "stale" else "stale"


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------

def report(payload: dict) -> str:
    lines = []
    for row in payload.get("repos") or []:
        measured = row.get("measured") or {}
        diff = row.get("diff") or {}
        cadence = row.get("cadence") or {}
        self_reported = row.get("self_reported") or {}
        lines.append(
            f"  {row['id']} [{row.get('kind')}] {row.get('status')} · "
            f"{'上游' if row.get('upstream') else '自有'} · "
            f"实测 {measured.get('entries')}（arXiv {measured.get('with_arxiv')} / "
            f"代码 {measured.get('with_code')}）· 自报 {self_reported.get('entries')} · "
            f"新增 {diff.get('added')} / 移出 {diff.get('removed')}"
            f"{'（基线）' if diff.get('baseline') else ''} · "
            f"节奏 {cadence.get('cadence') or '?'}"
            f"{'（停更 ' + str(cadence.get('stale_days')) + ' 天）' if cadence.get('stalled') else ''}")
    summary = payload.get("summary") or {}
    sizes = payload.get("sizes") or {}
    unread = [row["id"] for row in payload.get("repos") or [] if row.get("not_attempted")]
    fetches = payload.get("fetches") or {}
    carried = ""
    if unread or fetches.get("budget_hit"):
        # A day that read fewer lists than are tracked still publishes numbers, so the
        # reader has to be told which rows are yesterday's before any exit code is weighed.
        carried = ("\n" + f"  本轮没读到（数字是沿用的）：{'、'.join(unread)}" if unread else "")
        if fetches.get("budget_hit"):
            carried += f"\n  抓取预算 {fetches.get('files')}/{fetches.get('max_files')} 已用尽"
    return (f"{summary.get('repos_ok')}/{summary.get('repos')} 个清单可读 · "
            f"实测 {summary.get('entries_measured')} 条（自有）+ "
            f"{summary.get('entries_upstream')} 条（上游）· 新增 {summary.get('added')} / "
            f"移出 {summary.get('removed')} · 停更 {summary.get('stalled')} 个 · "
            f"快照 {kb(sizes.get('payload_bytes'))}/{kb(sizes.get('payload_budget_bytes'))} KB · "
            f"台账 {kb(sizes.get('ledger_bytes'))}/{kb(sizes.get('ledger_budget_bytes'))} KB\n"
            + "\n".join(lines) + carried)


def main(argv: list[str] | None = None, *, at: dt.datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description="Track the public awesome lists as content")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--offline", type=Path, default=None,
                        help="read recorded files from DIR/<owner>/<name>/<path> instead of the network")
    parser.add_argument("--check", action="store_true",
                        help="read and summarise without writing any file; a partial run "
                             "still exits 0 because an unread third-party list is an "
                             "observation, not a broken collector - the printed status says "
                             "which rows are carried over")
    parser.add_argument("--only", action="append", default=[],
                        help="restrict to these owner/name repositories (repeatable)")
    args = parser.parse_args(argv)

    sources = tuple(row for row in SOURCES if not args.only or row["id"] in args.only)
    if not sources:
        print("没有匹配的清单：--only 需要写 owner/name", file=sys.stderr)
        return 2
    at = utc(at if at is not None else dt.datetime.now(dt.timezone.utc))
    try:
        if args.check:
            payload = collect(at, sources=sources, offline_dir=args.offline,
                              previous=load(args.data_dir / "awesome.json"),
                              ledger=load(args.data_dir / "awesome_ledger.json"))["payload"]
            print(f"check {payload.get('status')}: {report(payload)}")
            for note in (payload.get("warnings") or [])[:10]:
                print(f"  ! {note}")
            return 0 if payload.get("status") in ("ok", "partial") else 1
        status = publish(args.data_dir, at, sources=sources, offline_dir=args.offline)
    except (AwesomeError, OSError, ValueError) as error:
        print(safe_error(error), file=sys.stderr)
        return 1
    payload = load(args.data_dir / "awesome.json")
    print(f"{status}: {report(payload)}")
    for note in (payload.get("warnings") or [])[:10]:
        print(f"  ! {note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
