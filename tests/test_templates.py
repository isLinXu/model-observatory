import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from scripts.collect_templates import (
    MAX_BODY_CHARS,
    build_entry,
    load_library,
    load_previous,
    normalise_tags,
    parse_frontmatter,
    save,
    summarise,
    update_history,
)


def at(day):
    return dt.datetime.fromisoformat(day + "T02:23:00+00:00")


def frontmatter(name="示例", **fields):
    lines = ["---", f"name: {name}"]
    for key, value in fields.items():
        lines.append(f"{key}: {value}")
    lines.extend(["---", "", "正文内容"])
    return "\n".join(lines)


class FrontmatterTest(unittest.TestCase):
    def test_reads_scalar_fields(self):
        metadata, body = parse_frontmatter(frontmatter("代码审查", description="审查改动", version="2.0.0"))
        self.assertEqual(metadata["name"], "代码审查")
        self.assertEqual(metadata["description"], "审查改动")
        self.assertEqual(metadata["version"], "2.0.0")
        self.assertEqual(body, "正文内容")

    def test_reads_inline_and_block_lists(self):
        metadata, _ = parse_frontmatter("---\ntags: [a, b]\n---\n")
        self.assertEqual(metadata["tags"], ["a", "b"])
        metadata, _ = parse_frontmatter("---\ntags:\n  - x\n  - y\n---\n")
        self.assertEqual(metadata["tags"], ["x", "y"])

    def test_keeps_colons_inside_values(self):
        """A URL contains colons, so only the first separator may split."""
        metadata, _ = parse_frontmatter("---\nurl: https://github.com/a/b\n---\n")
        self.assertEqual(metadata["url"], "https://github.com/a/b")

    def test_text_without_frontmatter_is_all_body(self):
        metadata, body = parse_frontmatter("# 标题\n\n正文")
        self.assertEqual(metadata, {})
        self.assertEqual(body, "# 标题\n\n正文")

    def test_unterminated_block_is_treated_as_body(self):
        """Losing the fields would hide metadata; keeping them visible is safer."""
        metadata, body = parse_frontmatter("---\nname: x\n正文")
        self.assertEqual(metadata, {})
        self.assertIn("name: x", body)

    def test_strips_quotes_and_ignores_comments(self):
        metadata, _ = parse_frontmatter('---\n# 说明\nname: "带引号"\n---\n')
        self.assertEqual(metadata["name"], "带引号")


class TagTest(unittest.TestCase):
    def test_accepts_separators_and_deduplicates(self):
        self.assertEqual(normalise_tags("a, b、a"), ["a", "b"])
        self.assertEqual(normalise_tags(["x", "x", "y"]), ["x", "y"])
        self.assertEqual(normalise_tags(None), [])
        self.assertEqual(normalise_tags(""), [])


class EntryTest(unittest.TestCase):
    def test_falls_back_to_slug_when_name_missing(self):
        entry = build_entry("prompt", "my-slug", "没有 frontmatter", "o/r", "main")
        self.assertEqual(entry["name"], "my-slug")
        self.assertEqual(entry["description"], "")
        self.assertEqual(entry["tags"], [])

    def test_url_points_at_the_markdown_source(self):
        entry = build_entry("skill", "demo", frontmatter(), "isLinXu/model-observatory", "main")
        self.assertEqual(entry["url"],
                         "https://github.com/isLinXu/model-observatory/blob/main/templates/skills/demo.md")
        prompt = build_entry("prompt", "demo", frontmatter(), "isLinXu/model-observatory", "main")
        self.assertIn("/templates/prompts/demo.md", prompt["url"])

    def test_long_body_is_truncated_but_still_counted(self):
        entry = build_entry("prompt", "big", "---\nname: big\n---\n" + "x" * (MAX_BODY_CHARS + 500),
                            "o/r", "main")
        self.assertTrue(entry["truncated"])
        self.assertEqual(len(entry["body"]), MAX_BODY_CHARS)
        self.assertEqual(entry["bytes"], MAX_BODY_CHARS + 500)


class LibraryTest(unittest.TestCase):
    def write(self, root, relative, text):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_reads_both_kinds_and_skips_bad_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "skills/one.md", frontmatter("技能一"))
            self.write(root, "prompts/two.md", frontmatter("模版二"))
            self.write(root, "prompts/Bad Name.md", frontmatter("非法"))
            entries = load_library(root, "o/r", "main")
            # Sorted by (kind, slug), so the order follows KIND_DIRECTORIES.
            self.assertEqual([entry["id"] for entry in entries],
                             ["prompt/two", "skill/one"])

    def test_missing_folder_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "skills/one.md", frontmatter("技能一"))
            entries = load_library(root, "o/r", "main")
            self.assertEqual(len(entries), 1)

    def test_summary_counts_kinds_tags_and_categories(self):
        entries = [
            build_entry("skill", "a", frontmatter("A", tags="[x, y]", category="工程"), "o/r", "main"),
            build_entry("prompt", "b", frontmatter("B", tags="[x]", category="工程"), "o/r", "main"),
        ]
        stats = summarise(entries)
        self.assertEqual((stats["total"], stats["skills"], stats["prompts"]), (2, 1, 1))
        self.assertEqual([item["tag"] for item in stats["tags"]], ["x", "y"])
        self.assertEqual(stats["categories"][0], {"category": "工程", "count": 2})

    def test_empty_library_summarises_to_zero(self):
        self.assertEqual(summarise([])["total"], 0)


class HistoryTest(unittest.TestCase):
    def test_same_day_replaces_the_previous_snapshot(self):
        history = update_history({"snapshots": []}, [], at("2026-10-21"))
        history = update_history(history, [build_entry("prompt", "a", frontmatter(), "o/r", "main")],
                                at("2026-10-21"))
        self.assertEqual(len(history["snapshots"]), 1)
        self.assertEqual(history["snapshots"][0]["total"], 1)

    def test_snapshots_stay_sorted_and_capped(self):
        history = {"snapshots": []}
        for offset in range(12):
            day = dt.date(2026, 10, 1) + dt.timedelta(days=offset)
            history = update_history(history, [], at(day.isoformat()), retention_days=5)
        self.assertEqual(len(history["snapshots"]), 5)
        dates = [snap["date"] for snap in history["snapshots"]]
        self.assertEqual(dates, sorted(dates))


class SaveTest(unittest.TestCase):
    def test_writes_both_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            entries = [build_entry("skill", "demo", frontmatter("演示"), "o/r", "main")]
            save(data_dir, entries, at("2026-10-21"), "o/r", "main")
            latest = json.loads((data_dir / "templates.json").read_text(encoding="utf-8"))
            history = json.loads((data_dir / "templates_history.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["status"], "ok")
            self.assertEqual(latest["summary"]["total"], 1)
            self.assertEqual(latest["library"], {"repo": "o/r", "branch": "main"})
            self.assertEqual(history["snapshots"][0]["ids"], ["skill/demo"])

    def test_failure_marks_the_payload_but_keeps_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            entries = [build_entry("prompt", "keep", frontmatter(), "o/r", "main")]
            save(data_dir, entries, at("2026-10-21"), "o/r", "main", error="模版目录不存在")
            latest = json.loads((data_dir / "templates.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["status"], "unavailable")
            self.assertTrue(latest["error"])
            self.assertEqual(len(latest["templates"]), 1)

    def test_previous_snapshot_survives_a_corrupt_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "templates.json"
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(load_previous(path), {})


if __name__ == "__main__":
    unittest.main()