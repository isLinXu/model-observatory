import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from scripts.collect_github import (
    GitHubError,
    api_to_repo,
    fetch_projects,
    load_previous,
    number_or_none,
    save,
    update_history,
)


def at(day):
    return dt.datetime.fromisoformat(day + "T02:23:00+00:00")


def repo(full_name="isLinXu/demo", **overrides):
    payload = {
        "name": full_name.split("/")[-1],
        "full_name": full_name,
        "description": "a demo repository",
        "html_url": f"https://github.com/{full_name}",
        "homepage": "",
        "language": "Python",
        "stargazers_count": 12,
        "forks_count": 3,
        "watchers_count": 12,
        "open_issues_count": 1,
        "topics": ["demo"],
        "fork": False,
        "archived": False,
        "license": {"spdx_id": "MIT"},
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2026-10-20T00:00:00Z",
        "pushed_at": "2026-10-19T00:00:00Z",
        "default_branch": "main",
    }
    payload.update(overrides)
    return payload


class NumberTests(unittest.TestCase):
    def test_valid_numbers(self):
        self.assertEqual(number_or_none(42), 42)
        self.assertEqual(number_or_none("7"), 7)
        self.assertEqual(number_or_none(0), 0)

    def test_invalid_numbers(self):
        for value in (None, True, "abc", -3, 1.5):
            self.assertIsNone(number_or_none(value))


class RepositoryConversionTests(unittest.TestCase):
    def test_fields_are_mapped(self):
        record = api_to_repo(repo())
        self.assertEqual(record["full_name"], "isLinXu/demo")
        self.assertEqual(record["stars"], 12)
        self.assertEqual(record["forks"], 3)
        self.assertEqual(record["language"], "Python")
        self.assertEqual(record["url"], "https://github.com/isLinXu/demo")
        self.assertEqual(record["updated_at"], "2026-10-20T00:00:00Z")
        self.assertFalse(record["is_fork"])

    def test_missing_optional_fields_become_safe_defaults(self):
        record = api_to_repo({"full_name": "isLinXu/bare", "name": "bare"})
        self.assertEqual(record["stars"], 0)
        self.assertEqual(record["forks"], 0)
        self.assertEqual(record["language"], "")
        self.assertEqual(record["topics"], [])
        self.assertIsNone(record["updated_at"])

    def test_fork_and_archived_flags(self):
        record = api_to_repo(repo(fork=True, archived=True))
        self.assertTrue(record["is_fork"])
        self.assertTrue(record["archived"])


class HistoryTests(unittest.TestCase):
    def test_one_snapshot_per_day(self):
        history = update_history({"snapshots": []}, {"followers": 344}, at("2026-10-20"))
        history = update_history(history, {"followers": 350}, at("2026-10-21"))
        self.assertEqual(len(history["snapshots"]), 2)
        self.assertEqual(history["snapshots"][-1]["followers"], 350)
        self.assertEqual(history["snapshots"][-1]["date"], "2026-10-21")

    def test_same_day_replaces_previous_snapshot(self):
        history = update_history({"snapshots": []}, {"followers": 344}, at("2026-10-21"))
        history = update_history(history, {"followers": 345}, at("2026-10-21"))
        self.assertEqual(len(history["snapshots"]), 1)
        self.assertEqual(history["snapshots"][-1]["followers"], 345)

    def test_snapshots_are_sorted_by_date(self):
        history = update_history({"snapshots": []}, {"followers": 1}, at("2026-10-22"))
        history = update_history(history, {"followers": 2}, at("2026-10-20"))
        dates = [snapshot["date"] for snapshot in history["snapshots"]]
        self.assertEqual(dates, sorted(dates))


class SaveTests(unittest.TestCase):
    def test_save_writes_latest_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            account = {"login": "isLinXu", "followers": 344, "following": 992, "public_repos": 2}
            repos = [api_to_repo(repo())]
            projects = {"status": "unavailable", "reason": "no token", "items": []}
            save(data_dir, account, repos, projects, at("2026-10-21"))
            latest = json.loads((data_dir / "github.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["status"], "ok")
            self.assertEqual(latest["account"]["followers"], 344)
            self.assertEqual(len(latest["repositories"]), 1)
            self.assertEqual(latest["repositories"][0]["url"], "https://github.com/isLinXu/demo")
            history = json.loads((data_dir / "github_history.json").read_text(encoding="utf-8"))
            self.assertEqual(len(history["snapshots"]), 1)
            self.assertEqual(history["snapshots"][0]["followers"], 344)

    def test_failed_run_is_recorded_as_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            account = {"login": "isLinXu", "followers": 344}
            save(data_dir, account, [], {"status": "unavailable", "reason": "", "items": []},
                 at("2026-10-21"), error="HTTP 403 rate limited")
            latest = json.loads((data_dir / "github.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["status"], "stale")
            self.assertIn("403", latest["error"])
            self.assertEqual(latest["account"]["followers"], 344)
            self.assertFalse((data_dir / "github_history.json").exists())

    def test_failed_run_does_not_copy_stale_metrics_into_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            account = {"login": "isLinXu", "followers": 344}
            projects = {"status": "unavailable", "reason": "", "items": []}
            save(data_dir, account, [], projects, at("2026-10-20"))
            save(data_dir, account, [], projects, at("2026-10-21"), error="HTTP 403 rate limited")
            history = json.loads((data_dir / "github_history.json").read_text(encoding="utf-8"))
            self.assertEqual(len(history["snapshots"]), 1)
            self.assertEqual(history["snapshots"][0]["date"], "2026-10-20")
            self.assertEqual(history["updated_at"], "2026-10-20T02:23:00Z")


class DegradationTests(unittest.TestCase):
    def test_previous_snapshot_is_recovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "github.json"
            path.write_text(json.dumps({
                "status": "ok", "account": {"followers": 344},
                "repositories": [api_to_repo(repo())],
            }), encoding="utf-8")
            previous = load_previous(path)
            self.assertEqual(previous["account"]["followers"], 344)
            self.assertEqual(len(previous["repositories"]), 1)

    def test_missing_or_broken_file_yields_empty_dict(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(load_previous(Path(tmp) / "nope.json"), {})
            broken = Path(tmp) / "broken.json"
            broken.write_text("{not json", encoding="utf-8")
            self.assertEqual(load_previous(broken), {})

    def test_projects_without_token_are_unavailable_not_fatal(self):
        result = fetch_projects("isLinXu")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["items"], [])
        self.assertTrue(result["reason"])

    def test_projects_with_broken_token_do_not_raise(self):
        import os
        original = os.environ.get("GITHUB_TOKEN")
        os.environ["GITHUB_TOKEN"] = "ghp_not_a_real_token"
        try:
            result = fetch_projects("isLinXu")
            self.assertIn(result["status"], ("ok", "unavailable"))
            self.assertIsInstance(result["items"], list)
        finally:
            if original is None:
                os.environ.pop("GITHUB_TOKEN", None)
            else:
                os.environ["GITHUB_TOKEN"] = original


class ErrorTests(unittest.TestCase):
    def test_error_carries_the_reason(self):
        error = GitHubError("HTTP 403 rate limited")
        self.assertIn("403", str(error))


if __name__ == "__main__":
    unittest.main()
