import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from scripts.collect_social import (
    PlatformError,
    collect_source,
    load_config,
    number_or_none,
    parse_xiaohongshu_state,
    update_history,
)
from scripts.collect_social import save as save_social

CONFIG = Path(__file__).resolve().parent.parent / "config" / "social_sources.json"


def at(day):
    return dt.datetime.fromisoformat(day + "T02:23:00+00:00")


class SocialConfigTests(unittest.TestCase):
    def test_shipped_config_is_valid(self):
        sources = load_config(CONFIG)
        self.assertTrue(sources)
        for source in sources:
            self.assertIn("id", source)
            self.assertIn("method", source)
            self.assertIn("label", source)

    def test_missing_config_raises(self):
        with self.assertRaises(FileNotFoundError):
            load_config(Path("/nonexistent/social_sources.json"))


class SocialNumberTests(unittest.TestCase):
    def test_number_or_none(self):
        self.assertEqual(number_or_none("1,234"), 1234)
        self.assertEqual(number_or_none(42), 42)
        self.assertIsNone(number_or_none(None))
        self.assertIsNone(number_or_none("abc"))
        self.assertIsNone(number_or_none(-5))
        self.assertIsNone(number_or_none(True))


class SocialCollectorTests(unittest.TestCase):
    def test_disabled_source_is_reported(self):
        record = collect_source({"id": "x", "label": "X", "method": "github",
                                 "handle": "a", "enabled": False, "hint": "off"})
        self.assertEqual(record["status"], "disabled")
        self.assertIsNone(record["followers"])

    def test_unknown_method_is_reported(self):
        record = collect_source({"id": "x", "label": "X", "method": "nope", "handle": "a"})
        self.assertEqual(record["status"], "unavailable")
        self.assertIn("nope", record["error"])

    def test_missing_handle_is_reported(self):
        record = collect_source({"id": "x", "label": "X", "method": "bilibili", "handle": ""})
        self.assertEqual(record["status"], "unavailable")
        self.assertIn("mid", record["error"])

    def test_failed_fetch_keeps_record_shape(self):
        record = collect_source({"id": "x", "label": "X", "method": "zhihu", "handle": "tok"})
        self.assertEqual(record["status"], "unavailable")
        self.assertIsNone(record["followers"])
        self.assertIsNotNone(record["error"])
        for key in ("id", "label", "status", "followers", "following", "posts", "updated_at"):
            self.assertIn(key, record)

    def test_manual_fetcher_reads_configured_value(self):
        record = collect_source({"id": "m", "label": "M", "method": "manual",
                                 "followers": 1234, "following": 5, "enabled": True})
        self.assertEqual(record["status"], "ok")
        self.assertEqual(record["followers"], 1234)
        self.assertEqual(record["following"], 5)
        self.assertEqual(record["source"], "manual")
        self.assertIsNotNone(record["updated_at"])

    def test_successful_fetch_sets_timestamp(self):
        record = collect_source({"id": "m", "label": "M", "method": "manual",
                                 "followers": 10, "enabled": True},
                                captured_at="2026-10-21T02:23:00Z")
        self.assertEqual(record["updated_at"], "2026-10-21T02:23:00Z")


class XiaohongshuParsingTests(unittest.TestCase):
    def test_reads_fans_from_basic_info(self):
        state = {"user": {"userPageData": {"basicInfo": {
            "fans": "128400", "follows": 96, "liked": 9000,
            "nickname": "gatilin", "redId": "123", "noteCount": 42}}}}
        result = parse_xiaohongshu_state(state)
        self.assertEqual(result["followers"], 128400)
        self.assertEqual(result["following"], 96)
        self.assertEqual(result["likes"], 9000)
        self.assertEqual(result["posts"], 42)
        self.assertIn("gatilin", result["detail"])

    def test_reads_fans_from_user_page_data(self):
        state = {"user": {"userPageData": {"fans": 500, "follows": 3}}}
        result = parse_xiaohongshu_state(state)
        self.assertEqual(result["followers"], 500)
        self.assertEqual(result["following"], 3)

    def test_empty_state_raises(self):
        with self.assertRaises(PlatformError):
            parse_xiaohongshu_state({"user": {"userPageData": {}}})

    def test_missing_state_raises(self):
        with self.assertRaises(PlatformError):
            parse_xiaohongshu_state(None)


class SocialHistoryTests(unittest.TestCase):
    def test_update_history_appends_one_snapshot_per_day(self):
        records = [{"id": "github", "status": "ok", "followers": 344}]
        history = update_history({"schema_version": 1, "snapshots": []}, records, at("2026-10-21"))
        self.assertEqual(len(history["snapshots"]), 1)
        self.assertEqual(history["snapshots"][0]["followers"], {"github": 344})

        # A second run on the same UTC day replaces the snapshot instead of appending.
        history = update_history(history, records, at("2026-10-21"))
        self.assertEqual(len(history["snapshots"]), 1)

    def test_update_history_ignores_failed_sources(self):
        records = [
            {"id": "github", "status": "ok", "followers": 344},
            {"id": "zhihu", "status": "unavailable", "followers": None},
        ]
        history = update_history({"schema_version": 1, "snapshots": []}, records, at("2026-10-21"))
        self.assertEqual(history["snapshots"][0]["followers"], {"github": 344})

    def test_history_is_sorted_by_date(self):
        records = [{"id": "github", "status": "ok", "followers": 1}]
        history = update_history({"schema_version": 1, "snapshots": []}, records, at("2026-10-23"))
        history = update_history(history, records, at("2026-10-21"))
        dates = [snapshot["date"] for snapshot in history["snapshots"]]
        self.assertEqual(dates, sorted(dates))

    def test_save_writes_latest_and_history(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            records = [{"id": "github", "label": "GitHub", "status": "ok", "followers": 344,
                        "following": 9, "posts": 1, "likes": None, "detail": "",
                        "source": "api", "updated_at": "2026-10-21T02:23:00Z", "error": None}]
            save_social(data_dir, records, at("2026-10-21"))
            latest = json.loads((data_dir / "social.json").read_text(encoding="utf-8"))
            history = json.loads((data_dir / "social_history.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["schema_version"], 1)
            self.assertEqual(latest["sources"][0]["followers"], 344)
            self.assertEqual(len(history["snapshots"]), 1)


if __name__ == "__main__":
    unittest.main()
