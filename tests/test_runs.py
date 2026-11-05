"""Read the run's own report card the way the page will read it.

`data/runs.json` is the only payload that does not describe somebody else's
numbers: it describes the job that wrote the other files. Two things make it
worth its own assertions. It is produced by a step whose inputs come from
Actions (`toJSON(steps)`, `job.status`) and cannot be exercised in a test run
here, so the derivation has to be pinned against fabricated step maps. And its
keys are the `id:` strings of another file - `.github/workflows/pages.yml` -
which no import and no type check can keep in sync: rename a step there and
this report quietly stops covering it.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import pathlib
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from scripts import record_run as rr

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf8")


def at(day="2026-11-03", hour=2, minute=23):
    return dt.datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}:00+00:00")


def steps(**outcomes):
    """A step map shaped like `toJSON(steps)`: id -> {outcome, conclusion, ...}."""
    return json.dumps({
        ident: {"outcome": outcome, "conclusion": "success" if outcome != "failure" else "failure",
                "outputs": {}}
        for ident, outcome in outcomes.items()
    })


def complete(**overrides):
    """Every watched step succeeded, unless a test names one that did not."""
    map_ = {ident: "success" for ident in rr.STEP_LABELS}
    map_.update(overrides)
    return steps(**map_)


class WatchedStepTest(unittest.TestCase):
    def test_the_reported_steps_are_the_ones_the_workflow_declares(self):
        ids = re.findall(r"^\s+id: (\S+)$", WORKFLOW, re.MULTILINE)
        # `deployment` is the Pages deploy; it runs after this record is
        # committed, so nothing here may claim to know how it went.
        self.assertEqual(list(rr.STEP_LABELS), [ident for ident in ids if ident != "deployment"],
                         "a step id and STEP_LABELS disagree: the health report "
                         "silently stops covering whatever moved")

    def test_the_workflow_produces_the_record_before_it_commits_it(self):
        names = re.findall(r"^\s*- name: (.+)$", WORKFLOW, re.MULTILINE)
        self.assertLess(names.index("Record this run"), names.index("Commit historical snapshots"),
                        "the file only reaches the repository in that commit, so a record "
                        "written after it can never describe the run that wrote it")

    def test_the_record_survives_a_cancelled_run(self):
        block = re.search(r"- name: Record this run\n((?:\s{8}.+\n)+)", WORKFLOW)
        self.assertIsNotNone(block, "the Record this run step is gone")
        self.assertIn("if: ${{ !cancelled() }}", block.group(1),
                      "without this the run that died on a hard failure - the one "
                      "worth recording - writes nothing")

    def test_the_commit_stages_the_run_record(self):
        self.assertIn("runs;", WORKFLOW,
                      "the build treats data/runs.json as optional, so an unstaged "
                      "record means every future run starts from an empty history")

    def test_every_step_label_is_something_a_reader_can_name(self):
        blank = [ident for ident, label in rr.STEP_LABELS.items() if not str(label).strip()]
        self.assertEqual([], blank, "a blank label makes an unclean step unpointable on the page")


class StatusDerivationTest(unittest.TestCase):
    def test_all_steps_producing_is_the_only_clean_run(self):
        entry = rr.record({"MO_STEPS_JSON": complete()}, at())
        self.assertEqual("ok", entry["status"])
        self.assertEqual([], entry["steps_failed"])
        self.assertEqual([], entry["steps_missing"])

    def test_a_step_the_map_never_saw_is_reported_as_missing(self):
        map_ = json.dumps({ident: {"outcome": "success"}
                           for ident in list(rr.STEP_LABELS)[:3]})
        entry = rr.record({"MO_STEPS_JSON": map_}, at())
        self.assertEqual("partial", entry["status"])
        self.assertEqual(len(rr.STEP_LABELS) - 3, len(entry["steps_missing"]))

    def test_continue_on_error_failures_are_read_from_outcome_not_conclusion(self):
        # This is the whole reason the file exists: Actions sets `conclusion:
        # success` for a step that failed under continue-on-error.
        entry = rr.record({"MO_STEPS_JSON": complete(capture_conferences="failure")}, at())
        self.assertEqual("partial", entry["status"])
        self.assertEqual([rr.STEP_LABELS["capture_conferences"]], entry["steps_failed"])

    def test_a_failed_job_is_not_softened_into_a_partial(self):
        entry = rr.record({"MO_STEPS_JSON": complete(), "MO_JOB_STATUS": "failure"}, at())
        self.assertEqual("failed", entry["status"])

    def test_no_step_map_is_unknown_rather_than_a_defaulted_ok(self):
        entry = rr.record({}, at())
        self.assertEqual("unknown", entry["status"])
        # Saying "every step was missing" would be a claim about the run that the
        # absence of a JSON blob does not license.
        self.assertEqual([], entry["steps_missing"])

    def test_unreadable_step_json_is_unknown_rather_than_an_error(self):
        for raw in ["", "   ", "{not json", "[]", "{}"]:
            entry = rr.record({"MO_STEPS_JSON": raw}, at())
            self.assertEqual("unknown", entry["status"], raw)

    def test_the_record_never_invents_run_metadata(self):
        entry = rr.record({"MO_STEPS_JSON": complete()}, at())
        self.assertIsNone(entry["run_id"])
        self.assertIsNone(entry["run_number"])
        self.assertIsNone(entry["started_at"])
        self.assertIsNone(entry["run_url"])
        # `recorded_at` is this script's own clock, which it does have.
        self.assertEqual("2026-11-03T02:23:00Z", entry["recorded_at"])

    def test_a_non_numeric_run_number_is_left_absent_instead_of_zero(self):
        entry = rr.record({"MO_STEPS_JSON": complete(), "GITHUB_RUN_NUMBER": "nightly"}, at())
        self.assertIsNone(entry["run_number"])


class RunLinkTest(unittest.TestCase):
    def test_the_link_is_built_from_a_https_server_and_a_wellformed_repo(self):
        self.assertEqual(
            "https://github.com/isLinXu/model-observatory/actions/runs/12345",
            rr.run_url("https://github.com", "isLinXu/model-observatory", "12345"))

    def test_nothing_that_is_not_https_becomes_a_link(self):
        for server in ["http://github.com", "github.com", "//github.com", "javascript:alert(1)"]:
            self.assertIsNone(rr.run_url(server, "isLinXu/model-observatory", "123"), server)

    def test_malformed_repository_or_run_id_is_dropped(self):
        self.assertIsNone(rr.run_url("https://github.com", "isLinXu", "123"))
        self.assertIsNone(rr.run_url("https://github.com", "a/b/c", "123"))
        self.assertIsNone(rr.run_url("https://github.com", "", "123"))
        for run_id in ["", None, "abc", "12;rm", "1.5"]:
            self.assertIsNone(rr.run_url("https://github.com", "isLinXu/model-observatory", run_id), run_id)


class MergeTest(unittest.TestCase):
    def entry(self, run_id, attempt=1, day="2026-11-03", status="ok"):
        record = rr.record({"MO_STEPS_JSON": complete(), "GITHUB_RUN_ID": run_id}, dt.datetime.fromisoformat(
            f"{day}T02:23:00+00:00"))
        record["status"] = status
        record["attempt"] = attempt
        return record

    def test_the_same_run_and_attempt_replaces_rather_than_stacking(self):
        payload = rr.merge(rr.merge(None, self.entry("7", status="partial")), self.entry("7"))
        self.assertEqual(1, len(payload["runs"]), "a re-run of the same attempt is one record, not two")
        self.assertEqual("ok", payload["runs"][0]["status"], "the replacement is what the newest write said")

    def test_newest_first_survives_a_backfilled_older_run(self):
        payload = rr.merge({"runs": [self.entry("9", day="2026-11-04")]}, self.entry("8", day="2026-11-02"))
        self.assertEqual(["9", "8"], [row["run_id"] for row in payload["runs"]])

    def test_retention_caps_the_file_and_says_how_many_it_kept(self):
        payload = {"runs": [self.entry(str(index), day=f"2026-01-{index % 28 + 1:02d}")
                            for index in range(rr.RUN_LIMIT + 25)]}
        merged = rr.merge(payload, self.entry("newest"))
        self.assertEqual(rr.RUN_LIMIT, len(merged["runs"]))
        self.assertEqual({"runs": rr.RUN_LIMIT, "kept": rr.RUN_LIMIT}, merged["retention"])

    def test_a_history_that_cannot_be_read_is_absent_not_empty(self):
        self.assertIsNone(rr.load_previous(pathlib.Path("/no/such/runs.json")))
        # A file that exists but is not this shape must not be trusted either.
        self.assertIsNone(rr.load_previous(pathlib.Path(__file__)))

    def test_merging_onto_an_unreadable_history_still_keeps_this_run(self):
        payload = rr.merge(rr.load_previous(pathlib.Path(__file__)), self.entry("9"))
        self.assertEqual(["9"], [row["run_id"] for row in payload["runs"]])
        self.assertEqual({"runs": rr.RUN_LIMIT, "kept": 1}, payload["retention"])

    def test_the_payload_states_its_own_boundary(self):
        payload = rr.merge(None, self.entry("7"))
        self.assertEqual(1, payload["schema_version"])
        self.assertEqual("runs", payload["source_id"])
        self.assertIn("部署", payload["covers"])
        self.assertEqual(list(rr.STATUSES), payload["statuses"])


class CliTest(unittest.TestCase):
    def test_check_prints_the_record_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = pathlib.Path(tmp)
            stdout = io.StringIO()
            with redirect_stdout(stdout), patch("os.environ", {"MO_STEPS_JSON": complete()}):
                code = rr.main(["--data-dir", str(data_dir), "--check"], at=at())
            self.assertEqual(0, code)
            printed = json.loads(stdout.getvalue())
            self.assertEqual("ok", printed["status"])
            self.assertEqual([], list(data_dir.iterdir()), "--check must not touch the repository")

    def test_the_command_line_writes_the_file_the_build_publishes(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = pathlib.Path(tmp)
            with redirect_stdout(io.StringIO()), patch("os.environ", {
                    "GITHUB_RUN_ID": "42", "GITHUB_REPOSITORY": "isLinXu/model-observatory",
                    "GITHUB_RUN_NUMBER": "301", "MO_STEPS_JSON": complete()}):
                rr.main(["--data-dir", str(data_dir), "--now", "2026-11-03T02:23:00Z"])
            payload = json.loads((data_dir / "runs.json").read_text(encoding="utf8"))
            self.assertEqual(["42"], [row["run_id"] for row in payload["runs"]])
            self.assertEqual(301, payload["runs"][0]["run_number"])
            self.assertEqual("https://github.com/isLinXu/model-observatory/actions/runs/42",
                             payload["runs"][0]["run_url"])

    def test_shipped_data_list_includes_the_record(self):
        from scripts import build as build_module
        self.assertIn("runs.json", build_module.SHIPPED_DATA,
                      "a page that fetches a file the build never copies is a 404, not an error")


if __name__ == "__main__":
    unittest.main()
