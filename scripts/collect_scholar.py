#!/usr/bin/env python3
"""Capture a public Google Scholar profile as a daily UTC snapshot.

The published site is static and public, so this script only reads the public
profile page. Google's robots policy allows /citations?user= but disallows the
paginated /citations?cstart= variant, therefore only the first page of the
publication list is collected and the payload flags truncation.

Any failure is non-fatal: the previous snapshot is kept and the workflow keeps
going, because an academic profile is secondary to the download statistics.
"""
from __future__ import annotations

import argparse
import datetime as dt
import html as html_lib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

try:  # executed as a script (python scripts/collect_scholar.py)
    from collect import atomic_json_write
except ImportError:  # imported as a module (from scripts.collect_scholar import ...)
    from scripts.collect import atomic_json_write

SCHEMA_VERSION = 1
SCHOLAR_BASE = "https://scholar.google.com"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
BLOCK_MARKERS = ("unusual traffic", "not a robot", "/sorry/index", "recaptcha")


def strip_tags(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    text = html_lib.unescape(text)
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def number_or_none(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not re.fullmatch(r"-?\d+", text):
        return None
    return int(text)


def fetch_profile_html(user_id: str, retries: int = 3, timeout: int = 25) -> str:
    url = f"{SCHOLAR_BASE}/citations?user={user_id}&hl=en"
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
            lowered = body.lower()
            if any(marker in lowered for marker in BLOCK_MARKERS):
                raise RuntimeError("Google Scholar returned a verification page instead of the profile")
            if "gsc_prf_in" not in body:
                raise RuntimeError("Profile markup not found; the page layout may have changed")
            return body
        except Exception as error:
            if attempt == retries - 1:
                raise RuntimeError(f"Unable to read the Google Scholar profile after {retries} attempts: {error}") from error
            print(f"Google Scholar request failed (attempt {attempt + 1}/{retries}): {error}", file=sys.stderr)
            time.sleep(min(2 ** attempt * 5, 20))
    raise AssertionError("unreachable")


def parse_stats(page: str) -> dict:
    """Read the 'Cited by' table: citations, h-index, i10-index (all / recent)."""
    table = re.search(r'<table id="gsc_rsb_st".*?</table>', page, re.S)
    stats: dict[str, list[int | None]] = {}
    if not table:
        return stats
    for row in re.findall(r"<tr>(.*?)</tr>", table.group(0), re.S):
        label_match = re.search(r'<td class="gsc_rsb_sc1">(.*?)</td>', row, re.S)
        if not label_match:
            continue
        label = strip_tags(label_match.group(1)).lower()
        values = [number_or_none(strip_tags(v)) for v in re.findall(r'<td class="gsc_rsb_std">(.*?)</td>', row, re.S)]
        if not values:
            continue
        if label.startswith("citations"):
            stats["citations"] = values
        elif label.startswith("h-index"):
            stats["h_index"] = values
        elif label.startswith("i10-index"):
            stats["i10_index"] = values
    return stats


def parse_citations_by_year(page: str) -> list[dict]:
    """Read the per-year citations histogram."""
    block = re.search(r'<div class="gsc_md_hist_b">(.*?)</div></div></div>', page, re.S)
    if not block:
        return []
    years = re.findall(r'<span class="gsc_g_t"[^>]*>(\d{4})</span>', block.group(1))
    values = re.findall(r'<span class="gsc_g_al">([\d,\.]+)</span>', block.group(1))
    rows = []
    for year, value in zip(years, values):
        count = number_or_none(value)
        if count is None:
            continue
        rows.append({"year": int(year), "citations": count})
    return rows


def parse_papers(page: str) -> list[dict]:
    """Read the publication table (first page only)."""
    papers = []
    for row in re.findall(r'<tr class="gsc_a_tr">(.*?)</tr>', page, re.S):
        title_match = re.search(r'<a href="([^"]+)" class="gsc_a_at">(.*?)</a>', row, re.S)
        if not title_match:
            continue
        title = strip_tags(title_match.group(2))
        if not title:
            continue
        url = html_lib.unescape(title_match.group(1))
        if url.startswith("/"):
            url = SCHOLAR_BASE + url
        # Some rows have no usable link; the field stays None and the site
        # renders the title as plain text instead of a dead anchor.
        if not url.startswith("http"):
            url = None
        grays = re.findall(r'<div class="gs_gray">(.*?)</div>', row, re.S)
        authors = strip_tags(grays[0]) if grays else ""
        venue = strip_tags(grays[1]) if len(grays) > 1 else ""
        venue = re.sub(r",\s*\d{4}\s*$", "", venue).strip()
        year_match = re.search(r'<td class="gsc_a_y">.*?>([^<]*\d{4}[^<]*)</span>', row, re.S)
        year = number_or_none(strip_tags(year_match.group(1))) if year_match else None
        cite_cell = re.search(r'<td class="gsc_a_c">(.*?)</td>', row, re.S)
        citations = None
        cited_by_url = None
        if cite_cell:
            cited = re.search(r'<a href="([^"]+)"[^>]*class="gsc_a_ac[^"]*"[^>]*>(.*?)</a>', cite_cell.group(1), re.S)
            if cited:
                cited_by_url = html_lib.unescape(cited.group(1))
                citations = number_or_none(strip_tags(cited.group(2)))
        papers.append({
            "title": title,
            "authors": authors,
            "venue": venue,
            "year": year,
            "citations": citations,
            "url": url,
            "cited_by_url": cited_by_url,
        })
    return papers


def parse_publication_range(page: str) -> tuple[int, bool]:
    """Return (listed upper bound, truncated). 'Articles 1-4' -> (4, False)."""
    label = re.search(r'<span id="gsc_a_nn">(.*?)</span>', page, re.S)
    upper = 0
    if label:
        numbers = [int(n) for n in re.findall(r"\d+", strip_tags(label.group(1)))]
        if numbers:
            upper = max(numbers)
    more = re.search(r'<button[^>]*id="gsc_bpf_more"(?![^>]*disabled)', page)
    return upper, bool(more)


def parse_profile(page: str, user_id: str) -> dict:
    name_match = re.search(r'<div id="gsc_prf_in">(.*?)</div>', page, re.S)
    name = strip_tags(name_match.group(1)) if name_match else ""
    affiliation_match = re.search(r'<div class="gsc_prf_il">([^<]+)</div>', page)
    affiliation = strip_tags(affiliation_match.group(1)) if affiliation_match else ""
    email_match = re.search(r'id="gsc_prf_ivh"[^>]*>(.*?)</div>', page, re.S)
    verified_email = ""
    if email_match:
        text = strip_tags(email_match.group(1))
        verified_email = re.sub(r"^.*?email at\s*", "", text, flags=re.I).strip()
    interests = []
    interest_block = re.search(r'id="gsc_prf_int">(.*?)</div>', page, re.S)
    if interest_block:
        for label in re.findall(r"<a[^>]*>(.*?)</a>", interest_block.group(1), re.S):
            value = strip_tags(label)
            if value:
                interests.append(value)
    stats = parse_stats(page)
    citations = stats.get("citations") or []
    h_index = stats.get("h_index") or []
    i10_index = stats.get("i10_index") or []
    papers = parse_papers(page)
    listed, truncated = parse_publication_range(page)
    return {
        "schema_version": SCHEMA_VERSION,
        "source": "google_scholar",
        "profile_id": user_id,
        "profile_url": f"{SCHOLAR_BASE}/citations?user={user_id}",
        "name": name,
        "affiliation": affiliation,
        "verified_email": verified_email,
        "interests": interests,
        "metrics": {
            "citations_all": citations[0] if citations else None,
            "citations_recent": citations[1] if len(citations) > 1 else None,
            "h_index_all": h_index[0] if h_index else None,
            "h_index_recent": h_index[1] if len(h_index) > 1 else None,
            "i10_all": i10_index[0] if i10_index else None,
            "i10_recent": i10_index[1] if len(i10_index) > 1 else None,
            "publications": listed or len(papers),
            "publications_listed": len(papers),
            "truncated": truncated,
        },
        "citations_by_year": parse_citations_by_year(page),
        "papers": papers,
    }


def load_history(path: Path, user_id: str) -> dict:
    if not path.exists():
        return {"schema_version": SCHEMA_VERSION, "profile_id": user_id, "updated_at": None, "snapshots": []}
    obj = json.loads(path.read_text(encoding="utf-8"))
    if obj.get("schema_version") != SCHEMA_VERSION or obj.get("profile_id") != user_id or not isinstance(obj.get("snapshots"), list):
        raise ValueError("Existing scholar history has an incompatible schema or profile id; will not overwrite")
    return obj


def save(data_dir: Path, profile: dict, at: dt.datetime) -> None:
    capture = at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    day = at.astimezone(dt.timezone.utc).date().isoformat()
    user_id = profile["profile_id"]
    profile = dict(profile)
    profile["captured_at"] = capture
    atomic_json_write(data_dir / "scholar.json", profile)

    history = load_history(data_dir / "scholar_history.json", user_id)
    metrics = profile.get("metrics") or {}
    snapshot = {
        "date": day,
        "captured_at": capture,
        "citations_all": metrics.get("citations_all"),
        "h_index_all": metrics.get("h_index_all"),
        "i10_all": metrics.get("i10_all"),
        "publications": metrics.get("publications"),
    }
    snapshots = [s for s in history["snapshots"] if s.get("date") != day]
    snapshots.append(snapshot)
    snapshots.sort(key=lambda s: s["date"])
    history["updated_at"] = capture
    history["snapshots"] = snapshots
    atomic_json_write(data_dir / "scholar_history.json", history)
    print(f"Saved Google Scholar profile '{profile.get('name') or user_id}' with {len(profile.get('papers') or [])} papers as of {capture}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture a public Google Scholar profile")
    parser.add_argument("--user", default=os.environ.get("SCHOLAR_USER_ID", "oTYM_I8AAAAJ"))
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent.parent / "data")
    args = parser.parse_args()
    try:
        page = fetch_profile_html(args.user)
        profile = parse_profile(page, args.user)
        if not profile.get("name") or not profile.get("papers"):
            raise RuntimeError("Profile parsed without a name or publications; keeping the previous snapshot")
        save(args.data_dir, profile, dt.datetime.now(dt.timezone.utc))
    except Exception as error:
        print(f"WARNING: Google Scholar profile unavailable: {error}", file=sys.stderr)
        latest = args.data_dir / "scholar.json"
        if not latest.exists():
            atomic_json_write(latest, {
                "schema_version": SCHEMA_VERSION,
                "source": "google_scholar",
                "profile_id": args.user,
                "profile_url": f"{SCHOLAR_BASE}/citations?user={args.user}",
                "status": "unavailable",
                "error": str(error)[:300],
                "metrics": {},
                "papers": [],
                "citations_by_year": [],
                "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            })
        return


if __name__ == "__main__":
    main()
