#!/usr/bin/env python3
"""Record that the daily run happened, and what it survived.

Every panel on the site already answers "how fresh is this number".  None of them
answers the question a reader asks first when two of them disagree: **did today's
run actually work, and did a step die on the way?**  A collector with
``continue-on-error: true`` cannot answer that from its own payload - a swallowed
failure looks exactly like a panel that was simply not updated.

So this step runs once, last, and publishes the run's own report card:

* ``status``       ``ok`` / ``partial`` / ``failed`` / ``unknown`` - see below
* ``steps_failed`` / ``steps_missing``  which named steps did not produce
* ``run_url``      the Actions run, when the environment gave us one to link

Two honesty rules shape the derivation.  **Read ``outcome``, not ``conclusion``**:
for a step that failed under ``continue-on-error``, Actions reports
``conclusion: success`` (that is what the job decided) but ``outcome: failure``
(that is what happened).  A health payload built on ``conclusion`` would say
"ok" about the exact failures this file exists to catch.  And **the record stops
where the run's knowledge stops**: it covers the captures and the three indexers,
because the build and the Pages deploy happen after this file is committed - so
``covers`` says that, and nothing here implies the site was updated.

``unknown`` is a real answer, not a placeholder.  With no step map - a manual run
of this script alone, or a JSON blob the parser refused - the file records that
the run happened and that its health was not observed.  It never defaults to
``ok``, and a step that is simply absent from the map is reported as missing
rather than skipped quietly.

Nothing here touches the network, and no number owned by another payload is
copied: this file is about the run, not about the data.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
from pathlib import Path
from typing import Any

try:  # executed as a script (python scripts/record_run.py)
    from collect import atomic_json_write
except ImportError:  # imported as a module (from scripts.record_run import ...)
    from scripts.collect import atomic_json_write

SCHEMA_VERSION = 1
SOURCE_ID = "runs"
ROOT = Path(__file__).resolve().parent.parent
RUN_LIMIT = 60
LABEL_LIMIT = 60

# The steps worth reporting on, in the order they run.  The keys are the `id:`
# strings in .github/workflows/pages.yml - tests/test_runs.py asserts the two
# lists agree, because a step renamed here and not there is a health report that
# quietly stops covering it.  Build and deploy are deliberately absent: they run
# after this record is written and committed, so nothing here can claim to know
# their result.
STEP_LABELS = {
    "setup_python": "装 Python",
    "setup_node": "装 Node.js",
    "install_deps": "装采集器依赖",
    "offline_tests": "离线回归门",
    "capture_hf": "Hugging Face 模型与数据集",
    "capture_scholar": "公开学术档案",
    "capture_social": "各平台粉丝数",
    "capture_github": "GitHub 账号与仓库",
    "capture_modelscope": "ModelScope 公开模型",
    "capture_stars": "star 图谱",
    "capture_conferences": "会议截止目录",
    "capture_awesome": "awesome 清单跟踪",
    "capture_homc": "HOMC 核实总表",
    "index_templates": "模版库索引",
    "index_entities": "实体注册表索引",
    "index_tasks": "任务看板索引",
}

STATUSES = ("ok", "partial", "failed", "unknown")
REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
RUN_ID_RE = re.compile(r"^\d+$")


def clean_label(value: str) -> str:
    return str(value).strip()[:LABEL_LIMIT]


def run_url(server: str, repository: str, run_id: str) -> str | None:
    """Build the link only from an https server, a well-formed owner/repo and digits.

    The environment is not input from a stranger, but a malformed value would
    still reach the page as a link, and this site links out only after a scheme
    check - so the check costs three lines and runs here rather than in the page.
    """
    base = str(server).rstrip("/")
    if not base.startswith("https://") or not REPO_RE.match(repository or ""):
        return None
    if not RUN_ID_RE.match(str(run_id or "")):
        return None
    return f"{base}/{repository}/actions/runs/{run_id}"


def parse_steps(raw: str | None) -> dict[str, dict] | None:
    """`toJSON(steps)` from Actions, or None when there is nothing to read."""
    if not raw or not raw.strip():
        return None
    try:
        loaded = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(loaded, dict) or not loaded:
        return None
    return {key: value for key, value in loaded.items() if isinstance(value, dict)}


def normalise_time(value: str | None) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        stamped = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamped.tzinfo is None:
        stamped = stamped.replace(tzinfo=dt.timezone.utc)
    return stamped.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def derive_status(steps: dict[str, dict] | None, job_status: str | None,
                  failed: list[str], missing: list[str]) -> str:
    if steps is None:
        return "unknown"
    if str(job_status or "").lower() in ("failure", "cancelled"):
        return "failed"
    if failed or missing:
        # The job carried on (continue-on-error), so it is not `failed`; but a
        # step that produced nothing, or one the map never saw, is not `ok` either.
        return "partial"
    return "ok"


def summarise(steps: dict[str, dict] | None) -> dict[str, list[str]]:
    """Which watched steps failed, and which never ran, by label.

    With no step map there is nothing to name: an empty list here means "not
    observed", and only `unknown` says that out loud - a full list of "missing"
    would read as if every collector was skipped, which is a claim about the run
    that the absence of a JSON blob does not license.
    """
    if steps is None:
        return {"failed": [], "missing": []}
    failed: list[str] = []
    missing: list[str] = []
    for ident, label in STEP_LABELS.items():
        step = steps.get(ident)
        if step is None:
            missing.append(label)
            continue
        # `outcome` is the raw result; `conclusion` is what continue-on-error decided.
        if str(step.get("outcome") or "").lower() == "failure":
            failed.append(label)
    return {"failed": failed, "missing": missing}


def record(env: dict[str, str], now: dt.datetime) -> dict[str, Any]:
    job_status = str(env.get("MO_JOB_STATUS") or "").strip().lower() or None
    steps = parse_steps(env.get("MO_STEPS_JSON"))
    summary = summarise(steps)
    return {
        "run_id": str(env.get("GITHUB_RUN_ID") or "").strip() or None,
        "run_number": int(env["GITHUB_RUN_NUMBER"]) if str(env.get("GITHUB_RUN_NUMBER") or "").isdigit() else None,
        "attempt": int(env["GITHUB_RUN_ATTEMPT"]) if str(env.get("GITHUB_RUN_ATTEMPT") or "").isdigit() else 1,
        "date": now.astimezone(dt.timezone.utc).strftime("%Y-%m-%d"),
        "started_at": normalise_time(env.get("GITHUB_RUN_STARTED_AT")),
        "recorded_at": now.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "job_status": job_status,
        "status": derive_status(steps, job_status, summary["failed"], summary["missing"]),
        "steps_watched": len(STEP_LABELS),
        "steps_failed": summary["failed"],
        "steps_missing": summary["missing"],
        "run_url": run_url(str(env.get("GITHUB_SERVER_URL") or "https://github.com"),
                           str(env.get("GITHUB_REPOSITORY") or ""),
                           str(env.get("GITHUB_RUN_ID") or "")),
    }


def merge(previous: dict[str, Any] | None, entry: dict[str, Any]) -> dict[str, Any]:
    """Newest first, one entry per (run_id, attempt), capped at RUN_LIMIT."""
    runs = [row for row in (previous or {}).get("runs", []) if isinstance(row, dict)]
    key = (entry["run_id"], entry["attempt"])
    runs = [row for row in runs if (row.get("run_id"), row.get("attempt")) != key]
    runs.insert(0, entry)
    runs.sort(key=lambda row: str(row.get("recorded_at") or ""), reverse=True)
    return {
        "schema_version": SCHEMA_VERSION,
        "source_id": SOURCE_ID,
        "updated_at": entry["recorded_at"],
        # What this file can speak about, and what it must not be read as.
        "covers": "采集与索引这一段；构建与 Pages 部署排在这份记录提交之后，不在这里",
        "statuses": list(STATUSES),
        "retention": {"runs": RUN_LIMIT, "kept": min(len(runs), RUN_LIMIT)},
        "runs": runs[:RUN_LIMIT],
    }


def load_previous(path: Path) -> dict[str, Any] | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf8"))
    except (OSError, ValueError):
        return None
    return loaded if isinstance(loaded, dict) else None


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None,
         at: dt.datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--now", help="override the clock (UTC ISO); CI passes nothing")
    parser.add_argument("--steps", help="toJSON(steps); defaults to $MO_STEPS_JSON")
    parser.add_argument("--job-status", help="$MO_JOB_STATUS (success/failure/cancelled)")
    parser.add_argument("--check", action="store_true", help="print the record, write nothing")
    args = parser.parse_args(argv)

    context = dict(os.environ if env is None else env)
    if args.steps is not None:
        context["MO_STEPS_JSON"] = args.steps
    if args.job_status is not None:
        context["MO_JOB_STATUS"] = args.job_status
    if at is not None:
        stamp = at
    elif args.now:
        stamp = dt.datetime.fromisoformat(args.now.replace("Z", "+00:00"))
    else:
        stamp = dt.datetime.now(dt.timezone.utc)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=dt.timezone.utc)

    entry = record(context, stamp)
    path = args.data_dir / "runs.json"
    if args.check:
        print(json.dumps(entry, ensure_ascii=False, indent=2))
        return 0
    payload = merge(load_previous(path), entry)
    atomic_json_write(path, payload)
    print(f"Recorded run {entry['run_id']} as {entry['status']} "
          f"({payload['retention']['kept']} kept) -> {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
