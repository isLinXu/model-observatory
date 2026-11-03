import datetime as dt
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import collect_tasks as ct


def at(day="2026-11-02", hour=3, minute=18):
    return dt.datetime.fromisoformat(f"{day}T{hour:02}:{minute:02}:00+00:00")


def frontmatter(title="示例任务", status="doing", **fields):
    lines = ["---", f"title: {title}", f"status: {status}"]
    for key, value in fields.items():
        lines.append(f"{key}: {value}")
    lines.extend(["---", "", "正文内容"])
    return "\n".join(lines)


def task_row(slug, **fields):
    """A published row, so the graph and the changelog can be tested alone."""
    value = {"slug": slug, "title": slug, "status": "doing", "parent": None,
             "depends": [], "entity": None, "ddl": None, "tags": [], "updated": None,
             "reason": None, "sha256": "sha-" + slug, "body": "正文"}
    value.update(fields)
    return value


def write_json(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def data_dir(root, **files):
    """A data folder holding only the sibling snapshots a test asks for."""
    directory = Path(root) / "data"
    directory.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        write_json(directory / f"{name}.json", payload)
    return directory


def sources(root, **files):
    warnings = []
    return ct.load_sources(data_dir(root, **(files or SNAPSHOT)), warnings), warnings


# The two boards a task may point at. Both are other collectors' output, so the
# task board reads them exactly as published and never re-derives a number.
SNAPSHOT = {
    "entities": {"status": "ok", "captured_at": "2026-11-01T00:00:00Z",
                 "entries": [{"slug": "youtu-vl"}, {"slug": "mme"},
                             {"slug": "argus-visual-decision"}]},
    "conferences": {"status": "ok", "captured_at": "2026-11-01T00:00:08Z",
                    "conferences": [{"key": "cvpr", "editions": [
                        {"year": 2026, "events": []},
                        {"year": 2027, "events": [{"id": "AI/cvpr:cvpr27:paper:1"},
                                                  {"id": "AI/cvpr:cvpr27:poster:1"}]}]}]},
}

ROW_KEYS = {"slug", "title", "status", "parent", "depends", "entity", "ddl", "tags",
            "updated", "reason", "bytes", "lines", "sha256", "blob_sha", "truncated",
            "url", "body", "entity_state", "ddl_state"}


class BlobShaTest(unittest.TestCase):
    def test_matches_what_git_reports_for_the_same_bytes(self):
        """Vectors taken from `git hash-object --stdin`.

        The browser compares this id against the Contents API before it writes a
        card back, so a number that merely looks self-consistent is a broken
        baseline: every push would either be refused or would overwrite an edit.
        """
        self.assertEqual(ct.blob_sha(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
        self.assertEqual(ct.blob_sha(b"hello world\n"),
                         "3b18e512dba79e4c8300dd08aeb37f8e728b8dad")

    def test_a_shipped_seed_publishes_the_git_blob_id(self):
        path = Path(ct.__file__).resolve().parent.parent / "tasks" / "cvpr27-window-check.md"
        self.assertEqual(ct.blob_sha(path.read_bytes()),
                         "31f2f73e955d440b2a23829f1ef3ffb3a77c9fe5")


class SourceTest(unittest.TestCase):
    def test_reads_the_registry_slugs_and_the_conference_event_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            got, warnings = sources(tmp)
            self.assertEqual(got["entity"]["ids"],
                             {"mme", "youtu-vl", "argus-visual-decision"})
            self.assertIn("AI/cvpr:cvpr27:paper:1", got["ddl"]["ids"])
            self.assertEqual(got["ddl"]["captured_at"], "2026-11-01T00:00:08Z")
            self.assertEqual(warnings, [])

    def test_a_missing_sibling_snapshot_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as tmp:
            got, warnings = sources(tmp, entities=SNAPSHOT["entities"])
            self.assertFalse(got["ddl"]["available"])
            self.assertIsNone(got["ddl"]["captured_at"])
            self.assertIn("缺失", got["ddl"]["reason"])
            self.assertTrue(any("ddl" in note for note in warnings))

    def test_an_unusable_status_is_not_an_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            got, warnings = sources(tmp, entities=dict(SNAPSHOT["entities"], status="unavailable"),
                                    conferences=SNAPSHOT["conferences"])
            self.assertFalse(got["entity"]["available"])
            self.assertEqual(got["entity"]["ids"], set())
            self.assertIn("unavailable", got["entity"]["reason"])
            self.assertTrue(any("entity" in note for note in warnings))

    def test_an_empty_registry_still_counts_as_an_answer(self):
        """A registry that lists nothing must not soften every broken reference."""
        with tempfile.TemporaryDirectory() as tmp:
            got, warnings = sources(
                tmp, entities={"status": "ok", "captured_at": "x", "entries": []},
                conferences=SNAPSHOT["conferences"])
            self.assertTrue(got["entity"]["available"])
            self.assertEqual(got["entity"]["ids"], set())
            self.assertEqual(warnings, [])

    def test_a_malformed_index_shape_is_skipped_row_by_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            got, _ = sources(
                tmp,
                entities={"status": "ok", "captured_at": "x",
                          "entries": [{"slug": "mme"}, "junk", {"slug": 7}]},
                conferences={"status": "ok", "captured_at": "x",
                             "conferences": ["junk", {"editions": [
                                 {"events": [{"id": "e1"}, {"id": None}, "junk"]}]}]})
            self.assertEqual(got["entity"]["ids"], {"mme"})
            self.assertEqual(got["ddl"]["ids"], {"e1"})


class RefStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sources = sources(self.tmp.name)[0]

    def test_a_target_the_registry_names_is_resolved(self):
        self.assertEqual(ct.classify_ref("mme", self.sources["entity"]), ct.RESOLVED)

    def test_a_target_the_registry_answered_about_is_a_broken_reference(self):
        self.assertEqual(ct.classify_ref("gone", self.sources["entity"]), ct.UNRESOLVED)

    def test_a_missing_index_is_never_reported_as_a_broken_reference(self):
        """A failed capture is not the same fact as a target that disappeared."""
        silent = dict(self.sources["ddl"], available=False)
        self.assertEqual(ct.classify_ref("AI/cvpr:cvpr27:paper:1", silent), ct.MISSING_INDEX)

    def test_an_empty_reference_is_not_counted_at_all(self):
        self.assertIsNone(ct.classify_ref(None, self.sources["entity"]))
        self.assertIsNone(ct.classify_ref("", self.sources["entity"]))

    def test_every_card_is_stamped_and_tallied(self):
        rows = [task_row("a", entity="mme"), task_row("b", entity="gone"),
                task_row("c", ddl="AI/cvpr:cvpr27:paper:1"), task_row("d")]
        tallies = ct.attach_refs(rows, self.sources)
        self.assertEqual([row["entity_state"] for row in rows[:2]],
                         [ct.RESOLVED, ct.UNRESOLVED])
        self.assertEqual(rows[2]["ddl_state"], ct.RESOLVED)
        self.assertIsNone(rows[3]["entity_state"], "no reference, no state")
        self.assertEqual(tallies["entity"][ct.UNRESOLVED], 1)
        self.assertEqual(tallies["ddl"][ct.RESOLVED], 1)

    def test_a_failed_capture_moves_the_card_to_unverified(self):
        rows = [task_row("a", entity="mme")]
        silent = dict(self.sources, entity=dict(self.sources["entity"], available=False))
        tallies = ct.attach_refs(rows, silent)
        self.assertEqual(rows[0]["entity_state"], ct.MISSING_INDEX)
        self.assertEqual(tallies["entity"][ct.MISSING_INDEX], 1)
        self.assertEqual(tallies["entity"][ct.UNRESOLVED], 0)


class TaskTest(unittest.TestCase):
    def build(self, name, text, warnings=None, errors=None):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        path = root / name
        path.write_text(text, encoding="utf-8")
        return ct.build_task(path, "o/r", "main",
                             warnings if warnings is not None else [],
                             errors if errors is not None else [])

    def test_frontmatter_becomes_the_published_metadata(self):
        row = self.build("alpha.md", frontmatter("拆画布", status="review", parent="canvas",
                                                 entity="mme", ddl="AI/cvpr:cvpr27:paper:1",
                                                 tags="[看板, 前端]", updated="2026-11-01",
                                                 reason="等 MO.repo"))
        self.assertEqual(row["slug"], "alpha")
        self.assertEqual(row["title"], "拆画布")
        self.assertEqual(row["status"], "review")
        self.assertEqual((row["parent"], row["entity"], row["ddl"]),
                         ("canvas", "mme", "AI/cvpr:cvpr27:paper:1"))
        self.assertEqual(row["tags"], ["看板", "前端"])
        self.assertEqual(row["updated"], "2026-11-01")
        self.assertEqual(row["reason"], "等 MO.repo")
        self.assertEqual(row["body"], "正文内容")
        self.assertEqual(row["url"], "https://github.com/o/r/blob/main/tasks/alpha.md")

    def test_an_unknown_status_is_an_error_and_is_published_as_unlabelled(self):
        errors = []
        row = self.build("alpha.md", frontmatter(status="in-progress", updated="11-01"),
                         errors=errors)
        self.assertEqual((row["status"], row["updated"]), (None, None))
        self.assertEqual(len(errors), 2)
        self.assertIn("status", errors[0])

    def test_a_missing_status_is_treated_like_an_illegal_one(self):
        """Defaulting to 草稿 would invent progress the author never typed."""
        errors = []
        row = self.build("alpha.md", "---\ntitle: 无状态\n---\n\n正文\n", errors=errors)
        self.assertIsNone(row["status"])
        self.assertIn("status", errors[0])

    def test_a_file_without_frontmatter_is_flagged_and_still_published(self):
        errors = []
        row = self.build("alpha.md", "只有正文", errors=errors)
        self.assertEqual(row["title"], "alpha", "the slug stands in for a missing title")
        self.assertEqual(row["body"], "只有正文")
        self.assertTrue(any("front matter" in note for note in errors))

    def test_the_baseline_hashes_the_whole_file_including_the_frontmatter(self):
        text = frontmatter()
        self.assertEqual(self.build("alpha.md", text)["blob_sha"], ct.blob_sha(text.encode()))

    def test_a_long_body_is_cut_but_measured_in_full(self):
        with patch.object(ct, "MAX_BODY_CHARS", 40):
            row = self.build("alpha.md", frontmatter() + "x" * 60)
        self.assertTrue(row["truncated"])
        self.assertEqual(len(row["body"]), 40)
        self.assertGreater(row["bytes"], 40)
        self.assertEqual(row["lines"], 1)

    def test_prose_past_the_published_cut_still_moves_the_baseline(self):
        """A hidden tail must not be invisible to the changelog or to a push."""
        tail = "y" * ct.MAX_BODY_CHARS
        before = self.build("alpha.md", frontmatter() + tail)
        after = self.build("alpha.md", frontmatter() + tail + "z")
        self.assertEqual(before["body"], after["body"])
        self.assertNotEqual(before["blob_sha"], after["blob_sha"])
        self.assertNotEqual(before["sha256"], after["sha256"])

    def test_depends_accepts_a_block_list_and_a_comma_string(self):
        block = self.build("a.md", "---\ntitle: 块\ndepends:\n  - one\n  - two\n---\n\n正文\n")
        scalar = self.build("b.md", "---\ntitle: 逗号\ndepends: one, two\n---\n\n正文\n")
        self.assertEqual(block["depends"], ["one", "two"])
        self.assertEqual(scalar["depends"], ["one", "two"])

    def test_too_many_depends_are_cut_with_a_warning(self):
        warnings = []
        row = self.build("a.md", frontmatter(
            depends=f"[{', '.join(f't{i}' for i in range(ct.DEPENDS_LIMIT + 4))}]"),
            warnings=warnings)
        self.assertEqual(len(row["depends"]), ct.DEPENDS_LIMIT)
        self.assertIn("depends", warnings[0])

    def test_a_self_dependency_stays_visible_on_the_card(self):
        """The author wrote it; the card shows it and build_edges refuses to draw it."""
        self.assertEqual(self.build("a.md", frontmatter(depends="[a]"))["depends"], ["a"])

    def test_a_long_blocking_reason_is_cut(self):
        warnings = []
        row = self.build("alpha.md", frontmatter(reason="挡" * 200), warnings=warnings)
        self.assertEqual(len(row["reason"]), ct.REASON_LIMIT)
        self.assertIn("受阻原因", warnings[0])

    def test_titles_and_tags_are_bounded(self):
        row = self.build("alpha.md", frontmatter(
            "长" * 300, tags=f"[{', '.join(f't{i}' for i in range(ct.TAG_LIMIT + 3))}]"))
        self.assertEqual(len(row["title"]), ct.TITLE_LIMIT)
        self.assertEqual(len(row["tags"]), ct.TAG_LIMIT)


class BoardTest(unittest.TestCase):
    def test_reads_the_folder_in_slug_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "zeta.md").write_text(frontmatter("尾"), encoding="utf-8")
            (root / "alpha.md").write_text(frontmatter("头"), encoding="utf-8")
            rows = ct.load_board(root, "o/r", "main")
            self.assertEqual([row["slug"] for row in rows], ["alpha", "zeta"])

    def test_an_uppercase_file_is_skipped_because_its_source_link_would_not_resolve(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Alpha.md").write_text(frontmatter("大写"), encoding="utf-8")
            (root / "keep.md").write_text(frontmatter("保留"), encoding="utf-8")
            errors = []
            rows = ct.load_board(root, "o/r", "main", errors=errors)
            self.assertEqual([row["slug"] for row in rows], ["keep"])
            self.assertIn("Alpha.md", errors[0])

    def test_an_unreadable_card_is_named_and_the_rest_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "broken.md").mkdir()
            (root / "keep.md").write_text(frontmatter("保留"), encoding="utf-8")
            errors = []
            rows = ct.load_board(root, "o/r", "main", errors=errors)
            self.assertEqual(len(rows), 1)
            self.assertIn("broken.md", errors[0])

    def test_cards_past_the_cap_report_a_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(5):
                (root / f"e{index}.md").write_text(frontmatter(), encoding="utf-8")
            with patch.object(ct, "TASK_LIMIT", 3):
                warnings = []
                rows = ct.load_board(root, "o/r", "main", warnings=warnings)
            self.assertEqual(len(rows), 3)
            self.assertIn("超过 3 条", warnings[0])


class EdgeTest(unittest.TestCase):
    def graph(self, *rows):
        errors = []
        return ct.build_edges(list(rows), errors), errors

    def test_decomposition_and_connection_are_two_independent_graphs(self):
        """A 拆解 edge and a 依赖 edge between the same pair do not make a cycle."""
        built, errors = self.graph(task_row("a", parent="b"), task_row("b", depends=["a"]))
        self.assertEqual(built["edges"], [{"from": "a", "to": "b", "type": "parent"},
                                         {"from": "b", "to": "a", "type": "depends"}])
        self.assertEqual(errors, [])

    def test_a_dependency_cycle_is_dropped_and_named(self):
        built, errors = self.graph(task_row("a", depends=["b"]), task_row("b", depends=["a"]))
        self.assertEqual(len(built["edges"]), 1)
        self.assertEqual(built["dropped"][0]["from"], "b")
        self.assertEqual(built["dropped"][0]["reason"], "cycle")
        self.assertIn("成环", errors[0])

    def test_a_deeper_cycle_is_caught(self):
        built, _ = self.graph(task_row("a", depends=["b"]), task_row("b", depends=["c"]),
                              task_row("c", depends=["a"]))
        self.assertEqual((len(built["edges"]), len(built["dropped"])), (2, 1))

    def test_a_parent_cycle_is_dropped_too(self):
        built, _ = self.graph(task_row("a", parent="b"), task_row("b", parent="a"))
        self.assertEqual([edge["type"] for edge in built["edges"]], ["parent"])
        self.assertEqual(built["dropped"][0]["reason"], "cycle")

    def test_self_edges_are_refused_on_both_kinds(self):
        built, errors = self.graph(task_row("a", parent="a", depends=["a"]))
        self.assertEqual(built["edges"], [])
        self.assertEqual([row["reason"] for row in built["dropped"]], ["self", "self"])
        self.assertEqual(len(errors), 2)

    def test_a_reference_to_a_missing_card_is_counted_per_kind(self):
        built, errors = self.graph(task_row("a", parent="gone", depends=["also-gone"]))
        self.assertEqual((built["missing_parents"], built["missing_depends"]), (1, 1))
        self.assertEqual({row["reason"] for row in built["dropped"]}, {ct.MISSING})
        self.assertIn("不存在", errors[0])

    def test_a_card_without_edges_contributes_nothing(self):
        built, errors = self.graph(task_row("a"))
        self.assertEqual((built["edges"], built["dropped"], errors), ([], [], []))


class SummaryTest(unittest.TestCase):
    def test_counts_roots_edges_and_the_blocked_column(self):
        rows = [task_row("a"), task_row("b", parent="a"), task_row("c", status="blocked"),
                task_row("d", status=None)]
        built = ct.build_edges(rows, [])
        summary = ct.summarise(rows, built["edges"])
        self.assertEqual((summary["total"], summary["roots"], summary["edges"]), (4, 3, 1))
        self.assertEqual(summary["blocked"], 1)
        self.assertEqual(summary["by_status"], {"doing": 2, "blocked": 1, "未标注": 1})

    def test_tags_are_ranked_by_count_then_name(self):
        rows = [task_row("a", tags=["看板", "前端"]), task_row("b", tags=["看板"])]
        self.assertEqual(ct.summarise(rows, [])["by_tag"],
                         [{"tag": "看板", "count": 2}, {"tag": "前端", "count": 1}])

    def test_an_empty_board_summarises_as_zeroes(self):
        self.assertEqual(ct.summarise([], [])["by_status"], {})


class MoveTest(unittest.TestCase):
    def test_entering_review_or_done_is_progress(self):
        for before in ("proposal", "doing", "blocked", None):
            for after in ct.FINISHED:
                self.assertEqual(ct.classify_move(before, after), "advanced",
                                 f"{before} -> {after}")

    def test_leaving_a_finished_state_is_a_regression(self):
        for before in ct.FINISHED:
            for after in ("proposal", "doing", "blocked", None):
                self.assertEqual(ct.classify_move(before, after), "regressed",
                                 f"{before} -> {after}")

    def test_the_column_order_is_not_a_progress_bar(self):
        """blocked -> doing is a move, and review -> done stays inside 已完成."""
        self.assertEqual(ct.classify_move("doing", "blocked"), "moved")
        self.assertEqual(ct.classify_move("proposal", "doing"), "moved")
        self.assertEqual(ct.classify_move("review", "done"), "moved")
        self.assertEqual(ct.classify_move(None, "proposal"), "moved")
        self.assertEqual(ct.classify_move("done", None), "regressed")
        self.assertEqual(ct.classify_move("doing", "doing"), "same")
        self.assertEqual(ct.classify_move(None, None), "same")


class ChangesTest(unittest.TestCase):
    def test_the_first_run_reports_additions(self):
        changes = ct.compare_rows({}, [task_row("b"), task_row("a")])
        self.assertEqual(changes["status"], "initial")
        self.assertEqual(changes["added"], ["a", "b"])
        self.assertEqual(changes["added_count"], 2)
        self.assertFalse(changes["truncated"])

    def test_a_status_move_lands_in_its_own_bucket_and_not_in_revised(self):
        before = {"a": task_row("a", status="doing")}
        changes = ct.compare_rows(before, [task_row("a", status="review")])
        self.assertEqual(changes["advanced"], ["a"])
        self.assertEqual(changes["revised"], [])

    def test_an_author_edit_is_a_revision(self):
        before = {"a": task_row("a")}
        changes = ct.compare_rows(before, [task_row("a", title="改名", depends=["b"])])
        self.assertEqual(changes["revised"], ["a"])

    def test_prose_only_edits_are_visible_because_the_key_carries_the_body_digest(self):
        before = {"a": task_row("a")}
        self.assertEqual(ct.compare_rows(before, [task_row("a", sha256="other")])["revised"],
                         ["a"])

    def test_a_sibling_snapshot_moving_is_not_a_revision(self):
        """Reference states follow the other collectors; only authored work is a revision."""
        before = {"a": task_row("a", entity="mme", entity_state=ct.RESOLVED)}
        after = [task_row("a", entity="mme", entity_state=ct.MISSING_INDEX)]
        changes = ct.compare_rows(before, after)
        self.assertEqual(changes["revised"], [])
        self.assertEqual(changes["status"], "compared")

    def test_the_revision_key_ignores_the_status(self):
        self.assertEqual(ct.revision_key(task_row("a", status="done")),
                         ct.revision_key(task_row("a", status="proposal")))

    def test_lists_are_capped_but_counts_are_not(self):
        rows = [task_row(f"e{index:03d}") for index in range(ct.CHANGE_LIMIT + 10)]
        changes = ct.compare_rows({}, rows)
        self.assertEqual(len(changes["added"]), ct.CHANGE_LIMIT)
        self.assertEqual(changes["added_count"], len(rows))
        self.assertTrue(changes["truncated"])

    def test_a_move_bucket_is_capped_too(self):
        slugs = [f"e{index:03d}" for index in range(ct.CHANGE_LIMIT + 5)]
        before = {slug: task_row(slug, status="done") for slug in slugs}
        changes = ct.compare_rows(before, [task_row(slug, status="doing") for slug in slugs])
        self.assertEqual(len(changes["regressed"]), ct.CHANGE_LIMIT)
        self.assertEqual(changes["regressed_count"], len(slugs))
        self.assertTrue(changes["truncated"])

    def test_removals_are_reported_without_a_body(self):
        before = {slug: task_row(slug) for slug in ("a", "b")}
        changes = ct.compare_rows(before, [task_row("a")])
        self.assertEqual((changes["removed"], changes["removed_count"]), (["b"], 1))


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.board = self.root / "tasks"
        self.board.mkdir()
        self.data = data_dir(self.root, **SNAPSHOT)
        self.write("canvas.md", frontmatter("画布", status="doing", tags="[看板]"))
        self.write("docs.md", frontmatter("文档", status="proposal", parent="canvas",
                                        depends="[canvas]", entity="mme",
                                        ddl="AI/cvpr:cvpr27:paper:1"))

    def write(self, name, text):
        (self.board / name).write_text(text, encoding="utf-8")

    def publish(self, moment=None, **kwargs):
        kwargs.setdefault("directory", self.board)
        kwargs.setdefault("repo", "o/r")
        kwargs.setdefault("branch", "main")
        return ct.publish(self.data, moment or at(), **kwargs)

    def payload(self):
        return json.loads((self.data / "tasks.json").read_text(encoding="utf-8"))

    def row(self, slug):
        return next(row for row in self.payload()["tasks"] if row["slug"] == slug)

    def test_writes_the_index_and_the_first_history_point(self):
        self.assertEqual(self.publish(), "ok")
        latest = self.payload()
        self.assertEqual(latest["status"], "ok")
        self.assertIsNone(latest["error"])
        self.assertEqual(latest["captured_at"], latest["last_attempt_at"])
        self.assertEqual(latest["source"], {"id": "tasks", "directory": "tasks",
                                           "repo": "o/r", "branch": "main",
                                           "url": "https://github.com/o/r/tree/main/tasks"})
        self.assertEqual([row["slug"] for row in latest["tasks"]], ["canvas", "docs"])
        self.assertEqual(latest["summary"],
                         {"total": 2, "edges": 2, "roots": 1, "blocked": 0,
                          "by_status": {"doing": 1, "proposal": 1},
                          "by_tag": [{"tag": "看板", "count": 1}]})
        self.assertEqual(latest["changes"]["status"], "initial")
        self.assertEqual(latest["changes"]["added"], ["canvas", "docs"])
        history = json.loads((self.data / "tasks_history.json").read_text(encoding="utf-8"))
        self.assertEqual(history["snapshots"][0]["ids"], ["canvas", "docs"])
        self.assertEqual(history["snapshots"][0]["edges"], 2)

    def test_both_kinds_of_edge_survive_to_the_canvas_payload(self):
        self.publish()
        graph = self.payload()["graph"]
        self.assertEqual(graph["edges"], [{"from": "docs", "to": "canvas", "type": "parent"},
                                         {"from": "docs", "to": "canvas", "type": "depends"}])
        self.assertEqual(graph["dropped"], [])
        self.assertFalse(graph["truncated"])

    def test_the_reference_tally_is_published_with_its_source(self):
        self.publish()
        latest = self.payload()
        self.assertEqual(latest["validation"]["refs"],
                         {"entity": {ct.RESOLVED: 1, ct.UNRESOLVED: 0, ct.MISSING_INDEX: 0},
                          "ddl": {ct.RESOLVED: 1, ct.UNRESOLVED: 0, ct.MISSING_INDEX: 0}})
        self.assertEqual(latest["sources"]["entity"],
                         {"file": "entities.json", "available": True,
                          "captured_at": "2026-11-01T00:00:00Z", "reason": None})

    def test_a_broken_reference_is_published_as_a_broken_reference(self):
        self.write("docs.md", frontmatter("文档", entity="gone"))
        self.publish()
        self.assertEqual(self.row("docs")["entity_state"], ct.UNRESOLVED)
        self.assertEqual(self.payload()["validation"]["refs"]["entity"][ct.UNRESOLVED], 1)

    def test_a_missing_sibling_snapshot_leaves_the_reference_unverified(self):
        (self.data / "conferences.json").unlink()
        self.publish()
        latest = self.payload()
        self.assertEqual(latest["sources"]["ddl"],
                         {"file": "conferences.json", "available": False, "captured_at": None,
                          "reason": "顶会目录快照不可用（缺失）"})
        self.assertEqual(self.row("docs")["ddl_state"], ct.MISSING_INDEX)
        self.assertTrue(any("ddl" in note for note in latest["warnings"]))

    def test_a_second_run_separates_progress_from_edits(self):
        self.publish()
        self.write("canvas.md", frontmatter("画布", status="review", tags="[看板]"))
        self.write("docs.md", frontmatter("文档改名", status="proposal", parent="canvas",
                                         entity="mme", ddl="AI/cvpr:cvpr27:paper:1"))
        self.assertEqual(self.publish(moment=at(day="2026-11-03")), "ok")
        changes = self.payload()["changes"]
        self.assertEqual((changes["added"], changes["removed"]), ([], []))
        self.assertEqual(changes["advanced"], ["canvas"])
        self.assertEqual(changes["revised"], ["docs"])

    def test_a_deleted_card_is_reported_as_removed(self):
        self.publish()
        (self.board / "docs.md").unlink()
        self.publish(moment=at(day="2026-11-03"))
        latest = self.payload()
        self.assertEqual(latest["changes"]["removed"], ["docs"])
        self.assertEqual(latest["summary"]["roots"], 1)

    def test_edges_past_the_cap_are_flagged_not_dropped_quietly(self):
        for index in range(5):
            self.write(f"c{index}.md", frontmatter(f"子{index}", parent="canvas"))
        with patch.object(ct, "EDGE_LIMIT", 3):
            self.publish()
        graph = self.payload()["graph"]
        self.assertEqual(len(graph["edges"]), 3)
        self.assertTrue(graph["truncated"])

    def test_a_run_from_the_clock_being_wrong_is_refused(self):
        self.publish()
        before = (self.data / "tasks.json").read_text(encoding="utf-8")
        self.assertEqual(self.publish(moment=at(hour=1)), "rejected")
        self.assertEqual((self.data / "tasks.json").read_text(encoding="utf-8"), before)

    def test_a_missing_folder_keeps_the_last_board_and_says_so(self):
        self.publish()
        shutil.rmtree(self.board)
        self.assertEqual(self.publish(moment=at(day="2026-11-03")), "stale")
        latest = self.payload()
        self.assertEqual(latest["status"], "stale")
        self.assertEqual(latest["error"], ct.ERROR_MESSAGES["directory"])
        # The numbers stay, but they keep the time they were taken.
        self.assertEqual(latest["captured_at"], at().isoformat().replace("+00:00", "Z"))
        self.assertEqual(latest["last_attempt_at"],
                         at(day="2026-11-03").isoformat().replace("+00:00", "Z"))
        self.assertEqual(len(latest["tasks"]), 2)
        self.assertEqual(latest["changes"]["status"], "initial", "not recomputed on a failed run")
        history = json.loads((self.data / "tasks_history.json").read_text(encoding="utf-8"))
        self.assertEqual([snap["date"] for snap in history["snapshots"]], ["2026-11-02"],
                         "a failed run does not add a history point")

    def test_a_missing_folder_with_no_history_publishes_nothing(self):
        shutil.rmtree(self.board)
        self.assertEqual(self.publish(), "unavailable")
        latest = self.payload()
        self.assertEqual(latest["status"], "unavailable")
        self.assertIsNone(latest["captured_at"])
        self.assertEqual(latest["tasks"], [])
        self.assertEqual(latest["graph"]["edges"], [])
        self.assertEqual(latest["summary"]["total"], 0)

    def test_structural_errors_reach_the_payload(self):
        self.write("canvas.md", frontmatter("画布", status="wip"))
        self.publish()
        self.assertTrue(any("status" in note for note in self.payload()["structural_errors"]))

    def test_the_published_row_is_a_closed_schema(self):
        """The board stores work: no number from another collector may ride along."""
        self.publish()
        for row in self.payload()["tasks"]:
            self.assertEqual(set(row), ROW_KEYS, row["slug"])
        text = (self.data / "tasks.json").read_text(encoding="utf-8")
        for metric in ('"downloads"', '"stars"', '"followers"', '"citations"', '"views"'):
            self.assertNotIn(metric, text)

    def test_the_published_board_carries_no_secrets_and_no_local_paths(self):
        self.publish()
        for name in ("tasks.json", "tasks_history.json"):
            text = (self.data / name).read_text(encoding="utf-8")
            for marker in ("Bearer", "ghp_", "token=", "Authorization"):
                self.assertNotIn(marker, text, name)
            self.assertNotIn(str(self.root), text, name)

    def test_the_published_reason_never_leaks_a_path(self):
        error = ct.BoardError("schema", f"bad card in {self.root}")
        ct.write_stale(self.data, at(), {}, error, repo="o/r", branch="main")
        text = (self.data / "tasks.json").read_text(encoding="utf-8")
        self.assertIn(ct.ERROR_MESSAGES["schema"], text)
        self.assertNotIn(str(self.root), text)
        self.assertNotIn(str(self.root), ct.safe_error(ValueError(str(self.root))))

    def test_an_unknown_failure_code_still_prints_a_fixed_sentence(self):
        self.assertIn("network", str(ct.BoardError("network", "boom")))
        self.assertEqual(ct.BoardError("directory").code, "directory")

    def test_a_corrupt_previous_file_does_not_stop_a_run(self):
        (self.data / "tasks.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(self.publish(), "ok")
        self.assertEqual(self.payload()["changes"]["status"], "initial")

    def test_an_older_row_shape_survives_a_failed_run(self):
        """A committed snapshot from before this schema must not crash the fallback."""
        self.publish()
        latest = self.payload()
        del latest["tasks"][0]["depends"]
        del latest["tasks"][0]["status"]
        write_json(self.data / "tasks.json", latest)
        shutil.rmtree(self.board)
        self.assertEqual(self.publish(moment=at(day="2026-11-03")), "stale")
        self.assertEqual(len(self.payload()["tasks"]), 2)


class HistoryTest(unittest.TestCase):
    def test_same_day_points_are_replaced_and_order_is_kept(self):
        history = {"snapshots": [{"date": "2026-11-02", "total": 99},
                                 {"date": "2026-10-01", "total": 1}]}
        out = ct.history_snapshot(history, [task_row("a")], ct.summarise([task_row("a")], []), at())
        self.assertEqual([snap["date"] for snap in out["snapshots"]],
                         ["2026-10-01", "2026-11-02"])
        self.assertEqual(out["snapshots"][1]["total"], 1)

    def test_junk_rows_are_dropped(self):
        history = {"snapshots": ["junk", {"date": ""}, {"no_date": 1}]}
        out = ct.history_snapshot(history, [], ct.summarise([], []), at())
        self.assertEqual(len(out["snapshots"]), 1)

    def test_old_days_are_pruned_to_the_retention_window(self):
        history = {"snapshots": [{"date": "2020-01-01", "total": 1}]}
        out = ct.history_snapshot(history, [], ct.summarise([], []), at())
        self.assertEqual([snap["date"] for snap in out["snapshots"]], ["2026-11-02"])
        self.assertEqual(out["retention_days"], ct.HISTORY_RETENTION_DAYS)

    def test_a_point_carries_the_columns_and_the_ids(self):
        rows = [task_row("a"), task_row("b", status="done")]
        out = ct.history_snapshot({}, rows, ct.summarise(rows, []), at())
        snap = out["snapshots"][0]
        self.assertEqual(snap["ids"], ["a", "b"])
        self.assertEqual(snap["by_status"], {"doing": 1, "done": 1})
        self.assertEqual(out["source"], {"id": "tasks"})
        self.assertEqual(out["updated_at"], "2026-11-02T03:18:00Z")


class LimitTest(unittest.TestCase):
    def test_notes_beyond_the_cap_are_marked_as_omitted(self):
        notes = []
        for index in range(ct.WARNING_LIMIT + 5):
            ct.add_note(notes, f"告警 {index}")
            ct.add_note(notes, f"告警 {index}")
        self.assertEqual(notes[ct.WARNING_LIMIT], "更多条目已省略")
        self.assertEqual(len(notes), ct.WARNING_LIMIT + 1)

    def test_a_repeated_note_is_stored_once(self):
        notes = []
        ct.add_note(notes, "同一句")
        ct.add_note(notes, "同一句")
        self.assertEqual(notes, ["同一句"])

    def test_naive_timestamps_are_refused(self):
        with self.assertRaises(ct.BoardError):
            ct.publish(Path(tempfile.mkdtemp()), dt.datetime(2026, 11, 2, 3, 18))


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.board = self.root / "tasks"
        self.board.mkdir()
        self.data = data_dir(self.root, **SNAPSHOT)

    def check(self, *files):
        for name, text in files:
            (self.board / name).write_text(text, encoding="utf-8")
        return ct.inspect(self.board, self.data)

    def test_a_clean_board_passes_and_reports_the_tally(self):
        report = self.check(("canvas.md", frontmatter("画布", entity="mme")))
        text, code = ct.format_check(report)
        self.assertEqual(code, 0)
        self.assertIn("1 个任务", text)
        self.assertIn("entity 引用 1", text)
        self.assertNotIn("未发布", text)

    def test_a_broken_reference_only_fails_under_strict(self):
        report = self.check(("canvas.md", frontmatter("画布", entity="gone")))
        self.assertEqual(ct.format_check(report)[1], 0)
        text, code = ct.format_check(report, strict=True)
        self.assertEqual(code, 1)
        self.assertIn("--strict", text)

    def test_a_dropped_edge_is_named_in_the_check(self):
        report = self.check(("a.md", frontmatter("甲", depends="[gone]")))
        text, _ = ct.format_check(report)
        self.assertIn("未发布：a -depends-> gone（missing）", text)

    def test_a_malformed_card_fails_the_check(self):
        report = self.check(("Alpha.md", frontmatter()))
        text, code = ct.format_check(report)
        self.assertEqual(code, 1)
        self.assertIn("结构错误", text)

    def test_a_missing_folder_fails_the_check(self):
        shutil.rmtree(self.board)
        text, code = ct.format_check(ct.inspect(self.board, self.data))
        self.assertEqual(code, 1)
        self.assertIn("任务目录不存在", text)

    def test_the_check_writes_nothing(self):
        argv = ["collect_tasks.py", "--check", "--tasks-dir", str(self.board),
                "--data-dir", str(self.data)]
        (self.board / "canvas.md").write_text(frontmatter("画布"), encoding="utf-8")
        with patch("sys.argv", argv), patch("builtins.print"):
            self.assertEqual(ct.main(), 0)
        self.assertFalse((self.data / "tasks.json").exists())
        self.assertFalse((self.data / "tasks_history.json").exists())

    def test_the_default_run_prints_the_reference_tally(self):
        argv = ["collect_tasks.py", "--tasks-dir", str(self.board), "--data-dir", str(self.data)]
        (self.board / "canvas.md").write_text(frontmatter("画布", entity="gone"), encoding="utf-8")
        with patch("sys.argv", argv), patch("builtins.print") as output:
            self.assertEqual(ct.main(), 0)
        printed = output.call_args[0][0]
        self.assertIn("indexed 1 tasks", printed)
        self.assertIn("entity 0/1/0", printed)

    def test_a_failed_run_says_so_on_stderr_and_keeps_the_board(self):
        shutil.rmtree(self.board)
        argv = ["collect_tasks.py", "--tasks-dir", str(self.board), "--data-dir", str(self.data)]
        with patch("sys.argv", argv), patch("builtins.print") as output:
            self.assertEqual(ct.main(), 0)
        self.assertIn("unavailable", output.call_args[0][0])


class IdsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.board = self.root / "tasks"
        self.board.mkdir()
        (self.board / "canvas.md").write_text(frontmatter("画布"), encoding="utf-8")
        self.report = ct.inspect(self.board, data_dir(self.root, **SNAPSHOT))

    def test_lists_every_id_a_card_may_point_at(self):
        text = ct.format_ids(self.report)
        self.assertIn("task:canvas", text)
        self.assertIn("entity:mme", text)
        self.assertIn("ddl:AI/cvpr:cvpr27:paper:1", text)

    def test_a_domain_narrows_the_list(self):
        self.assertEqual(ct.format_ids(self.report, domain="entity").splitlines(),
                         ["entity:argus-visual-decision", "entity:mme", "entity:youtu-vl"])

    def test_an_unavailable_source_says_why(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            board = root / "tasks"
            board.mkdir()
            report = ct.inspect(board, data_dir(root, entities=SNAPSHOT["entities"]))
            lines = ct.format_ids(report, domain="ddl").splitlines()
        self.assertEqual(lines, ["# ddl: " + report["sources"]["ddl"]["reason"]])

    def test_grep_filters_without_case(self):
        self.assertEqual(ct.format_ids(self.report, domain="task", grep="CANVAS").splitlines(),
                         ["task:canvas"])


class SeedBoardTest(unittest.TestCase):
    """The shipped board is source, not generated data: it must always parse."""

    ROOT = Path(ct.__file__).resolve().parent.parent / "tasks"

    def report(self):
        return ct.inspect(self.ROOT, self.ROOT.parent / "data-not-used")

    def test_the_seed_cards_parse_cleanly(self):
        report = self.report()
        self.assertEqual(report["errors"], [])
        self.assertGreaterEqual(len(report["tasks"]), 5)

    def test_the_only_notes_are_the_two_missing_sibling_indexes(self):
        """Run against no snapshots at all and the board still explains itself."""
        warnings = self.report()["warnings"]
        self.assertEqual(len(warnings), 2)
        self.assertTrue(all("按未核对处理" in note for note in warnings), warnings)

    def test_every_card_names_itself_and_carries_a_status(self):
        for row in self.report()["tasks"]:
            self.assertTrue(row["title"])
            self.assertIn(row["status"], ct.STATUSES, row["slug"])
            self.assertTrue(row["body"].strip(), row["slug"])
            self.assertRegex(row["updated"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertTrue(row["url"].endswith(f"/tasks/{row['slug']}.md"))

    def test_the_seeds_demonstrate_both_kinds_of_edge(self):
        report = self.report()
        self.assertEqual({edge["type"] for edge in report["graph"]["edges"]},
                         {"parent", "depends"})
        self.assertEqual(report["graph"]["dropped"], [])
        # The board grows as work ships, so the invariant is who must be a root -
        # the umbrella card and the standalone deadline check - not a frozen count.
        roots = {row["slug"] for row in report["tasks"] if not row["parent"]}
        self.assertIn("task-board-canvas", roots)
        self.assertIn("cvpr27-window-check", roots)
        self.assertEqual(report["summary"]["roots"], len(roots))

    def test_the_seeds_publish_a_git_baseline_for_every_card(self):
        for row in self.report()["tasks"]:
            self.assertRegex(row["blob_sha"], r"^[0-9a-f]{40}$")

    def test_the_seeds_reference_their_owners_by_id_only(self):
        """A card points at a slug or an event id - never at a copy of a number."""
        for row in self.report()["tasks"]:
            if row["entity"]:
                self.assertRegex(row["entity"], r"^[a-z0-9]+(?:[-_][a-z0-9]+)*$")
            if row["ddl"]:
                self.assertRegex(row["ddl"], r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+:\S+$")

    def test_the_seeds_carry_no_credentials(self):
        text = "\n".join(path.read_text(encoding="utf-8") for path in sorted(self.ROOT.glob("*.md")))
        for marker in ("Bearer", "ghp_", "token=", "Authorization"):
            self.assertNotIn(marker, text)


class BuildTest(unittest.TestCase):
    NAMES = ("tasks.json", "tasks_history.json")

    def test_the_board_artifacts_are_optional_and_copied_when_present(self):
        from scripts import build

        for present in (False, True):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "site").mkdir()
                (root / "data").mkdir()
                (root / "site" / "index.html").write_text("test")
                for name in ("latest.json", "history.json"):
                    (root / "data" / name).write_text("{}")
                if present:
                    for name in self.NAMES:
                        (root / "data" / name).write_text('{"schema_version":1}')
                with patch.object(build, "ROOT", root), patch.object(build, "SITE", root / "site"), \
                        patch.object(build, "OUTPUT", root / "output"), \
                        patch("sys.stdout", new_callable=io.StringIO):
                    build.build()
                for name in self.NAMES:
                    destination = root / "output" / "data" / name
                    self.assertEqual(destination.exists(), present, name)
                    if present:
                        self.assertEqual(destination.read_bytes(), (root / "data" / name).read_bytes())


if __name__ == "__main__":
    unittest.main()
