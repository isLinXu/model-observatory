import datetime as dt
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

from scripts import collect_awesome as ca

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "awesome"


def at(day="2026-11-02", hour=12, minute=0):
    return dt.datetime.fromisoformat(f"{day}T{hour:02}:{minute:02}:00+00:00")


def read(**fields):
    """One list, pointed at a recorded copy of itself."""
    source = {"id": "isLinXu/recorded-list", "kind": "markdown-table",
              "paths": ("README.md",), "cadence_path": "README.md"}
    source.update(fields)
    return source


def payload(**fields):
    """A published snapshot holding exactly the row a test asks about."""
    row = {"id": "isLinXu/recorded-list", "kind": "markdown-table", "upstream": False,
           "status": "ok", "error": None, "captured_at": "2026-11-01T12:00:00Z",
           "last_attempt_at": "2026-11-01T12:00:00Z", "measured": {"entries": 7},
           "self_reported": None, "cadence": None, "diff": {"added": 0, "removed": 0},
           "sample": [], "files": []}
    row.update(fields)
    return {"schema_version": ca.SCHEMA_VERSION, "status": "ok",
            "captured_at": "2026-11-01T12:00:00Z", "last_attempt_at": "2026-11-01T12:00:00Z",
            "summary": ca.summarise([row]),
            "changes": {"added": [], "removed": [], "grown": [], "shrunk": [], "status": []},
            "repos": [row]}


def run(at_moment=None, directory=None, sources=None, previous=None, ledger=None):
    return ca.collect(at_moment or at(), offline_dir=directory or FIXTURES,
                      sources=tuple(sources) if sources else ca.SOURCES,
                      previous=previous, ledger=ledger)


def row_of(result, repo):
    return next(entry for entry in result["payload"]["repos"] if entry["id"] == repo)


def titles(result, repo):
    return [entry["title"] for entry in row_of(result, repo)["sample"]]


def recorded(root, repo, path, text):
    target = pathlib.Path(root) / repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


class CopyOfFixtures(unittest.TestCase):
    """Shared helper: the recorded lists, with a few files taken away."""

    def mutated(self, *unlinked):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        directory = pathlib.Path(root) / "awesome"
        shutil.copytree(FIXTURES, directory)
        for relative in unlinked:
            target = directory / relative
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        return directory

    def isolated(self, body, path="README.md"):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        directory = pathlib.Path(root)
        recorded(directory, "isLinXu/recorded-list", path, body)
        return directory


class KindTest(CopyOfFixtures):
    def setUp(self):
        self.result = run()
        self.snapshot = self.result["payload"]

    def test_the_six_lists_are_all_read_from_their_recorded_bytes(self):
        self.assertEqual(self.snapshot["status"], "ok")
        self.assertEqual([row["id"] for row in self.snapshot["repos"]],
                         [source["id"] for source in ca.SOURCES])
        self.assertEqual({row["kind"] for row in self.snapshot["repos"]}, set(ca.KINDS))

    def test_a_machine_json_index_is_counted_instead_of_the_readme(self):
        row = row_of(self.result, "isLinXu/awesome-visual-reasoning")
        self.assertEqual(row["measured"]["entries"], 22)
        self.assertEqual(row["measured"]["with_arxiv"], 22)
        self.assertEqual([f["path"] for f in row["files"]],
                         ["data/papers.json", "data/stats.json"])

    def test_a_table_is_read_with_the_header_of_its_own_section(self):
        self.assertIn("world2vec: Mechanistic world models through latent dynamics learning",
                      titles(self.result, "isLinXu/awesome-agent-world-model"))
        sections = {entry["section"] for entry in
                    row_of(self.result, "isLinXu/awesome-agent-world-model")["sample"]}
        self.assertIn("奠基性工作 (2018-2022)", sections)

    def test_a_bullet_and_the_lines_wrapped_under_it_are_one_entry(self):
        entry = next(e for e in row_of(
            self.result, "BradyFU/Awesome-Multimodal-Large-Language-Models")["sample"]
            if e["title"].startswith("MME-Survey"))
        self.assertEqual(entry["arxiv_id"], "2411.15296")
        self.assertEqual(entry["published"], "2025")

    def test_a_link_back_into_the_list_itself_is_not_an_entry(self):
        # The README's own "Interactive Visualizations" table links to that
        # repository's Pages site: navigation, not papers.
        row = row_of(self.result, "isLinXu/awesome-native-multimodal-models")
        self.assertEqual(row["measured"]["entries"], 8)
        self.assertNotIn("taxonomy.html", titles(self.result,
                                                 "isLinXu/awesome-native-multimodal-models"))
        self.assertNotIn("timeline.html", titles(self.result,
                                                 "isLinXu/awesome-native-multimodal-models"))

    def test_a_report_row_without_a_link_is_still_a_paper_when_it_has_a_venue(self):
        row = row_of(self.result, "isLinXu/idea-research-list")
        dab = next(e for e in row["sample"] if e["id"] == "title:dab-detr")
        self.assertEqual(dab["url"], "https://github.com/IDEA-Research/DAB-DETR")
        cited = [entry for entry in row["sample"] if entry["url"] is None]
        self.assertTrue(cited, "报告按会议引用的行应当成为条目，而不是被算成漏读")
        self.assertTrue(all(entry["venue"] for entry in cited))
        self.assertEqual(row["measured"]["unlinked_rows"], len(cited))
        self.assertIn("会议或日期", row["measured"]["note"])
        self.assertNotIn("linked_rows_only", row["measured"])

    def test_markup_inside_a_cell_never_reaches_a_title(self):
        self.assertIn("Accelerate DETR Training by Introducing Query DeNoising",
                      titles(self.result, "isLinXu/idea-research-list"))
        self.assertFalse([title for title in titles(self.result, "isLinXu/idea-research-list")
                          if "<" in title or "](" in title])

    def test_the_aigc_block_that_looks_like_front_matter_is_not_read_as_metadata(self):
        row = row_of(self.result, "isLinXu/idea-research-list")
        self.assertGreater(row["measured"]["entries"], 0)
        self.assertEqual(row["measured"]["files"][0]["lines"], 56)

    def test_an_arxiv_number_is_not_mistaken_for_a_year(self):
        self.assertEqual(ca.find_date("https://arxiv.org/abs/2610.40637"), (None, None))
        self.assertEqual(ca.find_date("| 2026 | https://arxiv.org/abs/2610.40637"),
                         ("2026", "year"))
        self.assertEqual(ca.find_date("| 2025/05 |"), ("2025-05", "month"))

    def test_the_reported_month_of_a_topic_comes_from_the_archive_line(self):
        topic = {row["topic"]: row for row in
                 row_of(self.result, "isLinXu/paper-list")["topics"]}["World_Models"]
        self.assertEqual(topic["self_reported_total"], 28)
        self.assertEqual(topic["self_reported_month"], 28)


class MeasuredAgainstSelfReportedTest(CopyOfFixtures):
    def setUp(self):
        self.result = run()

    def test_a_repository_s_own_claim_is_published_next_to_our_count(self):
        row = row_of(self.result, "isLinXu/awesome-visual-reasoning")
        self.assertEqual(row["measured"]["entries"], 22)
        self.assertEqual(row["self_reported"]["entries"], 796)
        self.assertEqual(row["self_reported"]["repos_stars_total"], 324886)

    def test_the_two_are_never_added_into_one_total(self):
        summary = self.result["payload"]["summary"]
        own = [row for row in self.result["payload"]["repos"]
               if not row["upstream"] and row["status"] == "ok"]
        self.assertEqual(summary["entries_measured"], 100)
        self.assertEqual(summary["entries_measured"],
                         sum(row["measured"]["entries"] for row in own))
        self.assertNotEqual(summary["entries_measured"], 100 + 796)

    def test_a_claim_about_stars_is_not_rolled_into_our_totals(self):
        self.assertNotIn("stars", json.dumps(self.result["payload"]["summary"]))

    def test_contradictory_badges_are_published_as_a_warning_not_resolved(self):
        row = row_of(self.result, "isLinXu/awesome-agent-world-model")
        self.assertEqual(row["self_reported"]["values"], [630, 3970])
        self.assertEqual(row["self_reported"]["entries"], 3970)
        notes = [w for w in self.result["payload"]["warnings"] if "徽章自报了多个" in w]
        self.assertEqual(len(notes), 1)
        self.assertIn("630 / 3970", notes[0])

    def test_a_mismatch_between_claim_and_count_is_said_out_loud(self):
        notes = [w for w in self.result["payload"]["warnings"]
                 if "自报 796 条与实测 22 条" in w]
        self.assertEqual(len(notes), 1)

    def test_a_topic_claim_is_labelled_incomparable(self):
        row = row_of(self.result, "isLinXu/paper-list")
        self.assertEqual(row["self_reported"]["entries"], 3926)
        self.assertEqual(row["measured"]["entries"], 17)
        self.assertIn("不可比", row["self_reported"]["note"])

    def test_a_paper_archived_under_two_topics_is_measured_once(self):
        directory = self.mutated()
        extra = directory / "isLinXu/paper-list/docs/Classification/2026-10.md"
        first = directory / "isLinXu/paper-list/docs/World_Models/2026-10.md"
        borrowed = [line for line in first.read_text(encoding="utf-8").splitlines()
                    if line.startswith("|2026-10-29")][:2]
        extra.write_text(extra.read_text(encoding="utf-8") + "\n".join(borrowed) + "\n",
                         encoding="utf-8")
        row = row_of(run(directory=directory), "isLinXu/paper-list")
        self.assertEqual(row["measured"]["duplicated_rows"], 2)
        self.assertEqual(row["measured"]["entries"], row["measured"]["unique_ids"])


class UpstreamAndStallTest(CopyOfFixtures):
    def setUp(self):
        self.result = run()

    def test_an_upstream_list_is_counted_but_never_becomes_ours(self):
        summary = self.result["payload"]["summary"]
        self.assertEqual(summary["entries_upstream"], 8)
        self.assertEqual(summary["upstream_repos"], 1)
        self.assertEqual(summary["entries_measured"], 100)
        self.assertTrue(row_of(self.result,
                               "BradyFU/Awesome-Multimodal-Large-Language-Models")["upstream"])

    def test_a_list_nobody_touched_for_months_is_marked_stalled(self):
        row = row_of(self.result, "isLinXu/awesome-native-multimodal-models")
        self.assertTrue(row["cadence"]["stalled"])
        self.assertEqual(row["cadence"]["stale_days"], 241)
        self.assertEqual(self.result["payload"]["summary"]["stalled"], 1)
        self.assertIn("241 天没动过", " ".join(self.result["payload"]["warnings"]))

    def test_the_stall_line_is_not_moved_a_day_early(self):
        cadence = row_of(self.result, "isLinXu/idea-research-list")["cadence"]
        self.assertEqual(cadence["stale_days"], ca.STALL_AFTER_DAYS)
        self.assertFalse(cadence["stalled"])

    def test_a_bot_and_a_human_are_told_apart(self):
        self.assertTrue(row_of(self.result, "isLinXu/awesome-agent-world-model")
                        ["cadence"]["is_bot"])
        self.assertFalse(row_of(self.result, "isLinXu/idea-research-list")
                         ["cadence"]["is_bot"])

    def test_the_gap_since_the_last_file_commit_names_the_rhythm(self):
        labels = {row["id"]: row["cadence"]["cadence"] for row in self.result["payload"]["repos"]}
        self.assertEqual(labels["isLinXu/awesome-agent-world-model"], "daily")
        self.assertEqual(labels["BradyFU/Awesome-Multimodal-Large-Language-Models"], "weekly")
        self.assertEqual(labels["isLinXu/idea-research-list"], "manual")

    def test_a_commit_that_moves_the_whole_repository_is_not_a_commit_on_this_file(self):
        blob = json.dumps(self.result["payload"])
        for field in ("pushed_at", "stargazers", "forks_count", "subscribers_count"):
            self.assertNotIn(field, blob)


class LedgerTest(CopyOfFixtures):
    def test_the_first_read_is_a_baseline_and_says_so(self):
        row = row_of(run(), "isLinXu/awesome-agent-world-model")
        self.assertTrue(row["diff"]["baseline"])
        self.assertEqual(row["diff"]["added"], 0)
        self.assertIn("明日起", row["diff"]["note"])

    def test_a_ledger_entry_is_not_re_read_as_a_first_run(self):
        first = run()
        second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                     ledger=first["ledger"])
        row = row_of(second, "isLinXu/awesome-agent-world-model")
        self.assertFalse(row["diff"]["baseline"])
        self.assertEqual(row["diff"]["held"], 38)
        self.assertEqual(row["diff"]["added"], 0)

    def test_a_row_that_leaves_a_rolling_window_is_not_called_a_loss(self):
        first = run()
        second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                     ledger=first["ledger"])
        directory = self.mutated()
        papers = directory / "isLinXu/awesome-agent-world-model/docs/papers.md"
        papers.write_text("\n".join(line for line in
                                    papers.read_text(encoding="utf-8").splitlines()
                                    if "2610.40637" not in line) + "\n", encoding="utf-8")
        third = run(at() + dt.timedelta(days=2), previous=second["payload"],
                    ledger=second["ledger"], directory=directory)
        row = row_of(third, "isLinXu/awesome-agent-world-model")
        self.assertEqual(row["diff"]["removed"], 1)
        self.assertTrue(row["diff"]["rolling_window"])
        self.assertIn("正常收缩", " ".join(third["payload"]["warnings"]))

    def test_a_newspaper_style_list_remembers_months_instead_of_papers(self):
        ids = run()["ledger"]["repos"]["isLinXu/paper-list"]["ids"]
        self.assertTrue(all(entry.startswith("month:") for entry in ids))
        self.assertEqual(len(ids), 4)

    def test_a_one_off_report_never_claims_a_change(self):
        diff = row_of(run(), "isLinXu/idea-research-list")["diff"]
        self.assertIsNone(diff["added"])
        self.assertIsNone(diff["removed"])
        self.assertIn("没有更新流", diff["note"])

    def test_a_row_that_only_moved_between_sections_is_neither_gain_nor_loss(self):
        directory = self.isolated(
            "# 新\n\n| Title | Link |\n|---|---|\n"
            "| [One](https://arxiv.org/abs/2601.00001) | a |\n\n"
            "# 旧\n\n| Title | Link |\n|---|---|\n"
            "| [Two](https://arxiv.org/abs/2601.00002) | b |\n")
        first = ca.collect(at(), sources=(read(),), offline_dir=directory)
        # What a tidy-up PR does: the same papers, one of them moved and repeated.
        (directory / "isLinXu/recorded-list/README.md").write_text(
            "# 新\n\n| Title | Link |\n|---|---|\n"
            "| [One](https://arxiv.org/abs/2601.00001) | a |\n\n"
            "# 旧\n\n| Title | Link |\n|---|---|\n"
            "| [Two](https://arxiv.org/abs/2601.00002) | b |\n"
            "| [One](https://arxiv.org/abs/2601.00001) | a |\n", encoding="utf-8")
        second = ca.collect(at() + dt.timedelta(days=1), sources=(read(),), offline_dir=directory,
                            previous=first["payload"], ledger=first["ledger"])
        row = second["payload"]["repos"][0]
        self.assertEqual((row["diff"]["added"], row["diff"]["removed"]), (0, 0))
        self.assertEqual(row["measured"]["entries"], 2)
        self.assertEqual(row["measured"]["unique_ids"], 2)

    def test_ids_past_the_budget_are_cut_and_announced_as_a_lower_bound(self):
        with patch.object(ca, "LEDGER_ID_LIMIT", 10):
            first = run()
        row = row_of(first, "isLinXu/awesome-visual-reasoning")
        self.assertTrue(row["diff"]["truncated"])
        self.assertEqual(len(first["ledger"]["repos"]
                             ["isLinXu/awesome-visual-reasoning"]["ids"]), 10)
        self.assertIn("下限", " ".join(first["payload"]["warnings"]))


class TopicArchiveTest(CopyOfFixtures):
    def setUp(self):
        self.row = row_of(run(), "isLinXu/paper-list")

    def test_only_topics_still_archiving_are_counted_row_by_row(self):
        months = {topic["topic"]: topic for topic in self.row["topics"]}
        self.assertEqual(self.row["measured"]["newest_month"], "2026-10")
        self.assertEqual(self.row["measured"]["months_sampled"], 3)
        self.assertIsNone(months["Neural_Rendering"]["measured_rows"])
        self.assertEqual(months["World_Models"]["measured_rows"], 7)

    def test_a_topic_page_that_is_not_there_is_reported_not_invented(self):
        months = {topic["topic"]: topic for topic in self.row["topics"]}
        self.assertEqual(months["LLM"]["status"], "unavailable")
        self.assertEqual(self.row["measured"]["topics_unreadable"], 2)
        self.assertEqual(self.row["measured"]["topics_reporting"], 4)

    def test_a_month_page_that_vanishes_leaves_the_rest_of_the_topic_counted(self):
        directory = self.mutated("isLinXu/paper-list/docs/World_Models/2026-10.md")
        row = row_of(run(directory=directory), "isLinXu/paper-list")
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["measured"]["months_sampled"], 2)
        self.assertEqual(row["measured"]["entries"], 10)

    def test_topics_past_the_budget_are_left_for_the_next_run(self):
        with patch.object(ca, "TOPIC_LIMIT", 2):
            result = run()
        row = row_of(result, "isLinXu/paper-list")
        self.assertEqual(row["measured"]["topics"], 2)
        self.assertIn("主题数超过", " ".join(result["payload"]["warnings"]))


class FailureIsolationTest(CopyOfFixtures):
    def test_one_unreadable_list_does_not_take_the_others_down(self):
        directory = self.mutated("isLinXu/awesome-native-multimodal-models/README.md")
        result = run(directory=directory)
        row = row_of(result, "isLinXu/awesome-native-multimodal-models")
        self.assertEqual(row["status"], "unavailable")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["payload"]["summary"]["repos_ok"], 5)
        self.assertEqual(row_of(result, "isLinXu/paper-list")["status"], "ok")

    def test_a_failure_reuses_the_last_good_row_and_marks_it_stale(self):
        first = run()
        directory = self.mutated("isLinXu/paper-list/README.md")
        second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                     ledger=first["ledger"], directory=directory)
        row = row_of(second, "isLinXu/paper-list")
        self.assertEqual(row["status"], "stale")
        self.assertEqual(row["measured"], first["payload"]["repos"][4]["measured"])
        self.assertEqual(row["captured_at"], first["payload"]["captured_at"])
        self.assertEqual(row["last_attempt_at"], "2026-11-03T12:00:00Z")
        self.assertEqual(second["status"], "partial")

    def test_a_stale_row_keeps_its_ledger_so_tomorrow_is_still_comparable(self):
        first = run()
        directory = self.mutated("isLinXu/paper-list/README.md")
        second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                     ledger=first["ledger"], directory=directory)
        self.assertEqual(second["ledger"]["repos"]["isLinXu/paper-list"],
                         first["ledger"]["repos"]["isLinXu/paper-list"])

    def test_nothing_readable_keeps_yesterday_visible(self):
        previous = run()["payload"]
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        result = run(previous=previous, directory=pathlib.Path(root))
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["payload"]["captured_at"], previous["captured_at"])
        self.assertEqual(len(result["payload"]["repos"]), 6)
        self.assertEqual(result["payload"]["last_attempt_at"], "2026-11-02T12:00:00Z")

    def test_a_first_run_with_nothing_to_read_says_unavailable(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        result = run(directory=pathlib.Path(root))
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["payload"]["captured_at"])
        self.assertTrue(all(row["status"] == "unavailable"
                            for row in result["payload"]["repos"]))

    def test_published_reasons_carry_no_path_header_or_token(self):
        directory = self.isolated("{oops github_pat_1J9secret /Users/hertz/private",
                                  path="data/papers.json")
        result = ca.collect(at(), sources=(read(kind="machine-json"),),
                            offline_dir=directory)
        blob = json.dumps(result["payload"], ensure_ascii=False)
        self.assertEqual(result["payload"]["repos"][0]["error"],
                         "公开清单暂时读不到，保留上一次快照。")
        for leak in ("github_pat", "Users", "hertz", "raw.githubusercontent", "paper-"):
            self.assertNotIn(leak, blob)

    def test_a_papers_index_of_the_wrong_shape_fails_only_that_list(self):
        directory = self.mutated("isLinXu/awesome-visual-reasoning/data/papers.json")
        recorded(directory, "isLinXu/awesome-visual-reasoning", "data/papers.json",
                 json.dumps({"papers": []}))
        result = run(directory=directory)
        self.assertEqual(row_of(result, "isLinXu/awesome-visual-reasoning")["status"],
                         "unavailable")
        self.assertEqual(result["payload"]["summary"]["repos_ok"], 5)

    def test_the_cadence_being_unavailable_cannot_lose_a_list(self):
        directory = self.mutated("isLinXu/paper-list/.github/commits.json")
        cadence = row_of(run(directory=directory), "isLinXu/paper-list")["cadence"]
        self.assertEqual(cadence["status"], "unknown")
        self.assertIsNone(cadence["stalled"])

    def test_a_file_that_yields_no_row_is_a_format_change_not_an_emptied_list(self):
        directory = self.isolated(
            "| 论文 | 链接 |\n| --- | --- |\n| SVG | https://arxiv.org/abs/1610.05268 |\n")
        recorded(directory, "isLinXu/second-list", "README.md",
                 "| 论文 | 链接 |\n| --- | --- |\n| VDM | https://arxiv.org/abs/2112.10752 |\n")
        sources = (read(), read(id="isLinXu/second-list"))
        first = run(sources=sources, directory=directory)
        self.assertEqual(first["payload"]["repos"][0]["measured"]["entries"], 1)

        # Next day the same file only carries prose: the rows are still there in the
        # world, the parser just cannot see them, so "removed: 1" would be a lie.
        recorded(directory, "isLinXu/recorded-list", "README.md",
                 "# 清单\n\n条目改成纯文字描述了，没有表格行。\n")
        second = run(at() + dt.timedelta(days=1), sources=sources,
                     previous=first["payload"], ledger=first["ledger"], directory=directory)
        row = row_of(second, "isLinXu/recorded-list")
        self.assertEqual(row["status"], "stale")
        self.assertEqual(row["measured"]["entries"], 1, "昨天数到的行仍然是昨天的数")
        self.assertEqual(row["diff"]["removed"], 0, "认不出行不等于清单清空")
        self.assertEqual(row["error"], "清单文件的格式认不出任何条目，保留上一次快照。")
        self.assertEqual(row_of(second, "isLinXu/second-list")["status"], "ok")
        self.assertEqual(second["status"], "partial")
        self.assertEqual(second["ledger"]["repos"]["isLinXu/recorded-list"],
                         first["ledger"]["repos"]["isLinXu/recorded-list"],
                         "台账记的是上次真实读到的 id，不能被一次解析失败改写")
        self.assertTrue(any("格式变化" in note for note in second["payload"]["warnings"]))

    def test_a_first_read_that_parses_nothing_says_so_without_inventing_a_zero(self):
        result = run(sources=(read(),), directory=self.isolated(
            "# 清单\n\n一段没有表格的自我介绍。\n"))
        row = result["payload"]["repos"][0]
        self.assertEqual(row["status"], "unavailable")
        self.assertIsNone(row["measured"])
        self.assertEqual(row["error"], "清单文件的格式认不出任何条目，保留上一次快照。")
        self.assertEqual(result["status"], "unavailable")


class BudgetTest(CopyOfFixtures):
    def test_the_sample_is_capped_per_list(self):
        with patch.object(ca, "SAMPLE_LIMIT", 3):
            result = run()
        for row in result["payload"]["repos"]:
            self.assertLessEqual(len(row["sample"]), 3)

    def test_a_run_out_of_fetches_stops_short_and_admits_it(self):
        with patch.object(ca, "MAX_FETCHES", 4):
            result = run()
        self.assertEqual(result["status"], "partial")
        self.assertIn("抓取达到", " ".join(result["payload"]["warnings"]))
        # The lists this run never fetched stay on the board: dropping the row would
        # read as "we stopped tracking them", and it would take their ledger with it.
        self.assertEqual(len(result["payload"]["repos"]), len(ca.SOURCES))
        carried = [row for row in result["payload"]["repos"] if row.get("not_attempted")]
        self.assertTrue(carried)
        self.assertTrue(all(row["status"] in ("stale", "unavailable") for row in carried))
        self.assertEqual(result["payload"]["changes"]["removed"], [],
                         "没读到不等于清单消失")

    def test_a_dropped_list_is_not_remembered_as_a_first_read_tomorrow(self):
        first = run()
        with patch.object(ca, "MAX_FETCHES", 4):
            second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                         ledger=first["ledger"])
        skipped = [row["id"] for row in second["payload"]["repos"] if row.get("not_attempted")]
        self.assertTrue(skipped)
        for repo in skipped:
            self.assertEqual(second["ledger"]["repos"][repo], first["ledger"]["repos"][repo],
                             f"{repo} 的 id 台账不能被一次没跑到的运行抹掉")
        third = run(at() + dt.timedelta(days=2), previous=second["payload"],
                    ledger=second["ledger"])
        one_off = {source["id"] for source in ca.SOURCES if source.get("baseline_only")}
        for repo in skipped:
            diff = row_of(third, repo)["diff"]
            self.assertNotIn("首次", str(diff.get("note") or ""),
                             f"{repo} 昨天只是没读到，今天不该重新假装第一次认识它")
            if repo not in one_off:
                # a one-off survey reports baseline by design, so only the live
                # lists can prove that their diff came from a remembered ledger
                self.assertFalse(diff["baseline"], f"{repo} 不是第一次读到")
                self.assertIsNotNone(diff["added"])

    def test_a_narrowed_run_keeps_the_lists_it_skipped_whole(self):
        first = run()
        narrow = run(at() + dt.timedelta(days=1), sources=(ca.SOURCES[0],),
                     previous=first["payload"], ledger=first["ledger"])
        self.assertEqual(narrow["status"], "partial")
        self.assertEqual([row["id"] for row in narrow["payload"]["repos"]],
                         [source["id"] for source in ca.SOURCES])
        self.assertEqual(set(narrow["ledger"]["repos"]), set(first["ledger"]["repos"]))
        for row in narrow["payload"]["repos"][1:]:
            self.assertTrue(row.get("not_attempted"))
            self.assertEqual(row["last_attempt_at"],
                             row_of(first, row["id"])["last_attempt_at"],
                             "没尝试过就不能把今天的时刻写成一次尝试")
            self.assertEqual(row["measured"], row_of(first, row["id"])["measured"])

    def test_a_partial_run_still_publishes_today_s_numbers(self):
        directory = self.mutated("isLinXu/paper-list/README.md")
        result = run(directory=directory)
        self.assertEqual(result["payload"]["status"], "partial")
        self.assertEqual(result["payload"]["captured_at"], "2026-11-02T12:00:00Z")

    def test_warnings_stop_growing_at_their_own_budget(self):
        with patch.object(ca, "WARNING_LIMIT", 2):
            result = run()
        notes = result["payload"]["warnings"]
        self.assertEqual(len(notes), 3)
        self.assertEqual(notes[-1], "更多告警已省略")

    def test_a_title_is_cut_rather_than_dropped(self):
        entry = ca.make_entry("**" + "S" * 400 + "** https://arxiv.org/abs/2601.00001",
                              "isLinXu/recorded-list", None)
        self.assertEqual(len(entry["title"]), ca.TITLE_LIMIT)

    def test_a_snapshot_over_its_byte_budget_loses_samples_not_numbers(self):
        whole = run()["payload"]
        # Above the numbers-only floor (~12.2 KB with six lists), below the full
        # snapshot: the trim has room to work, so nothing may report over budget.
        with patch.object(ca, "PAYLOAD_BUDGET_BYTES", 14_000):
            result = run()["payload"]
        sizes = result["sizes"]
        self.assertLessEqual(sizes["payload_bytes"], sizes["payload_budget_bytes"])
        # the envelope's budget is the ceiling; the file also says what it shipped
        self.assertLess(sizes["sample_limit_applied"],
                        result["source"]["budget"]["sample_limit"])
        self.assertTrue(all(len(row["sample"]) <= sizes["sample_limit_applied"]
                            for row in result["repos"]))
        self.assertEqual(result["summary"], whole["summary"])
        for trimmed, full in zip(result["repos"], whole["repos"]):
            # the tail goes first, so the fresh rows pick_sample put on top survive
            self.assertEqual(trimmed["sample"], full["sample"][:len(trimmed["sample"])])
        self.assertLess(sum(len(row["sample"]) for row in result["repos"]),
                        sum(len(row["sample"]) for row in whole["repos"]))
        self.assertIn("压到", " ".join(result["warnings"]))

    def test_a_budget_the_numbers_alone_exceed_says_so_instead_of_lying(self):
        with patch.object(ca, "PAYLOAD_BUDGET_BYTES", 1_500):
            result = run()["payload"]
        self.assertTrue(all(row["sample"] == [] for row in result["repos"]))
        self.assertGreater(result["sizes"]["payload_bytes"],
                           result["sizes"]["payload_budget_bytes"])
        self.assertIn("样本全部去掉", " ".join(result["warnings"]))

    def test_an_overgrown_ledger_is_announced_but_keeps_every_id(self):
        with patch.object(ca, "LEDGER_BUDGET_BYTES", 1_000):
            result = run()
        self.assertIn("台账", " ".join(result["payload"]["warnings"]))
        # Cutting ids would report them as new arrivals tomorrow, so nothing is cut.
        self.assertEqual(result["ledger"], run()["ledger"])

    def test_the_size_the_index_reports_is_the_size_written_to_disk(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        ca.publish(pathlib.Path(root), at(), offline_dir=FIXTURES)
        raw = (pathlib.Path(root) / "awesome.json").read_bytes()
        index = json.loads(raw)
        self.assertEqual(len(raw), index["sizes"]["payload_bytes"])
        self.assertEqual((pathlib.Path(root) / "awesome_ledger.json").stat().st_size,
                         index["sizes"]["ledger_bytes"])

    def test_a_snapshot_that_grew_notes_still_reports_its_own_size(self):
        # the warnings are written into the same file that counts its bytes, so
        # measuring before they are appended understates what the reader downloads
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch.object(ca, "PAYLOAD_BUDGET_BYTES", 12_000):
            ca.publish(pathlib.Path(root), at(), offline_dir=FIXTURES)
        raw = (pathlib.Path(root) / "awesome.json").read_bytes()
        index = json.loads(raw)
        self.assertGreater(len(index["warnings"]), 0)
        self.assertEqual(len(raw), index["sizes"]["payload_bytes"])


class EntryIdentityTest(CopyOfFixtures):
    def test_two_chinese_titles_without_arxiv_stay_two_entries(self):
        body = ("| 论文 | 链接 |\n| --- | --- |\n"
                "| 多模态大模型综述 | [pdf](https://example.com/a.pdf) |\n"
                "| 视觉推理基准报告 | [pdf](https://example.com/b.pdf) |\n")
        result = ca.collect(at(), sources=(read(),), offline_dir=self.isolated(body))
        row = result["payload"]["repos"][0]
        # a non-Latin title slugs to nothing: hashing the empty slug gave every
        # Chinese-only row the same id, so the list silently counted one
        self.assertEqual(row["measured"]["entries"], 2)
        self.assertEqual(len({entry["id"] for entry in row["sample"]}), 2)

    def test_an_arxiv_id_is_not_read_as_a_year(self):
        entry = ca.make_entry("| [MME](https://arxiv.org/abs/1905.12345) | 评测 |", "x/y", None)
        self.assertEqual(entry["published"], "2019-05")
        self.assertEqual(entry["precision"], "month")

    def test_a_ledger_cut_by_the_cap_stops_claiming_additions(self):
        first = run()
        with patch.object(ca, "LEDGER_ID_LIMIT", 10):
            second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                         ledger=first["ledger"])
            third = run(at() + dt.timedelta(days=2), previous=second["payload"],
                        ledger=second["ledger"])
        big = "isLinXu/awesome-agent-world-model"
        self.assertTrue(second["ledger"]["repos"][big]["capped"])
        # the same bytes are recorded on all three days, so any "added" is the cap
        self.assertEqual(second["payload"]["repos"][0]["diff"]["added"], 0)
        row = row_of(third, big)["diff"]
        self.assertIsNone(row["added"], "台账只记住前 N 个 id 时，新增是不可比的")
        self.assertIsNone(row["removed"])
        self.assertTrue(row["truncated"])
        self.assertEqual(third["payload"]["summary"]["added"], 0)
        self.assertIn("不再报增删", " ".join(third["payload"]["warnings"]))


class EntrySignalTest(CopyOfFixtures):
    """A row left out says why, and the list says how young its entries are."""

    def setUp(self):
        self.result = run()

    def test_the_reasons_account_for_every_row_left_out(self):
        for row in self.result["payload"]["repos"]:
            measured = row["measured"]
            self.assertEqual(
                measured["skipped"],
                measured["skipped_no_title"] + measured["skipped_no_link"]
                + measured["skipped_no_signal"], row["id"])
            unlinked = measured.get("paper_table_rows_without_link")
            if unlinked is None:
                # Only the table reader measures this; a JSON index or a topic archive
                # publishes no number rather than a zero it did not count.
                self.assertEqual(measured["skipped_no_link"], 0, row["id"])
                continue
            # The subset cannot exceed the reason it is drawn from, and being a subset
            # is what keeps it from moving the entry count.
            self.assertLessEqual(unlinked, measured["skipped_no_link"], row["id"])

    def test_a_table_row_without_the_link_column_is_named_as_such(self):
        # The recorded README's nav and leaderboard rows have real titles and years;
        # calling them entries would turn a table of links into a paper count.
        measured = row_of(self.result, "isLinXu/awesome-native-multimodal-models")["measured"]
        self.assertEqual(measured["skipped_no_link"], 10)
        self.assertEqual(measured["skipped_no_signal"], 0)
        self.assertEqual(measured["paper_table_rows_without_link"], 0,
                         'that recording leaves out tables, not papers: nothing to call 下限')

    def test_a_row_in_a_paper_table_that_wrote_no_link_is_counted_apart(self):
        """Two different things fail the link rule, and only one is a missing paper."""
        parsed = ca.extract_entries("\n".join([
            "# Models",
            "",
            "| Name | Title | Venue | Date | Paper | Code |",
            "|---|---|---|---|---|---|",
            "| [Alpha](https://arxiv.org/abs/2501.00001) | Alpha paper | arXiv | 2025/01 |"
            " [PDF](https://arxiv.org/abs/2501.00001) | - |",
            "| **Beta** | Beta paper | arXiv | 2025/02 | - | - |",
            "",
            "# Statistics",
            "",
            "| Metric | Value |",
            "|---|---|",
            "| 📚 Total models | **2** |",
            "",
            "# Pages",
            "",
            "| Page | Link | Description |",
            "|---|---|---|",
            "| Home | [index.html](https://x.github.io/repo/index.html) | landing |",
            ""]), "x/repo")
        self.assertEqual([entry["id"] for entry in parsed["entries"]], ["arxiv:2501.00001"])
        self.assertEqual(parsed["skips"], {"no_link": 3})
        # Beta sits in a table that names a Paper and a Code column and wrote neither;
        # the stats row sits in a table with no such column, and the nav row does
        # carry a link - to its own Pages site - so neither of them is a missing paper.
        self.assertEqual(parsed["blank_link_rows"], 1)
        self.assertLessEqual(parsed["blank_link_rows"], parsed["skips"]["no_link"])

    def test_a_cited_row_needs_no_link_where_the_document_has_no_link_column(self):
        measured = row_of(self.result, "isLinXu/idea-research-list")["measured"]
        self.assertEqual(measured["skipped"], 0)
        self.assertEqual(measured["unlinked_rows"], 10)
        self.assertEqual(measured["with_venue"], 15)

    def test_youth_is_counted_from_the_ids_and_dates_we_already_had(self):
        recent = row_of(self.result, "isLinXu/awesome-agent-world-model")["measured"]["recent"]
        self.assertEqual(sum(recent.values()), 38)
        self.assertEqual(recent["within_90d"], 38)

    def test_a_year_alone_is_counted_as_the_oldest_day_it_could_be(self):
        # Reading 2018 as its first January keeps "added in the last 90 days" from
        # growing out of an ambiguous date.
        recent = row_of(self.result, "isLinXu/idea-research-list")["measured"]["recent"]
        self.assertEqual(recent["undated"], 0)
        self.assertEqual(recent["older"], 15)

    def test_the_newest_archive_month_says_how_long_ago_that_was(self):
        measured = row_of(self.result, "isLinXu/paper-list")["measured"]
        self.assertEqual(measured["newest_month"], "2026-10")
        self.assertEqual(measured["newest_month_age_days"], 32)


class FetcherHonestyTest(CopyOfFixtures):
    def test_running_out_of_fetches_is_not_reported_as_a_missing_file(self):
        with tempfile.TemporaryDirectory() as home:
            root = pathlib.Path(home)
            recorded(root, "owner/repo", "README.md", "| Title |\n|---|\n")
            fetcher = ca.Fetcher(root)
            with patch.object(ca, "MAX_FETCHES", 1):
                self.assertIsNotNone(fetcher.text("owner/repo", "README.md"))
                self.assertIsNone(fetcher.text("owner/repo", "docs/late.md"))
            self.assertEqual(fetcher.reason("owner/repo", "docs/late.md"), "no_budget")
            self.assertEqual(ca.unread_code(fetcher, "owner/repo", ["docs/late.md"]), "budget")

    def test_a_file_that_was_not_recorded_is_not_reported_as_a_used_up_budget(self):
        with tempfile.TemporaryDirectory() as home:
            fetcher = ca.Fetcher(pathlib.Path(home))
            self.assertIsNone(fetcher.text("owner/repo", "README.md"))
        self.assertEqual(fetcher.reason("owner/repo", "README.md"), "missing")
        self.assertEqual(ca.unread_code(fetcher, "owner/repo", ["README.md"]), "network")

    def test_a_file_over_the_byte_ceiling_reports_its_count_as_a_floor(self):
        body = ("| Title | Link |\n|---|---|\n"
                "| [One](https://arxiv.org/abs/2601.00001) | a |\n"
                "| [Two](https://arxiv.org/abs/2601.00002) | b |\n"
                "| [Three](https://arxiv.org/abs/2601.00003) | c |\n")
        with patch.object(ca, "MAX_BYTES", 130):
            result = ca.collect(at(), sources=(read(),), offline_dir=self.isolated(body))
        row = result["payload"]["repos"][0]
        self.assertEqual(row["status"], "ok")
        self.assertTrue(row["measured"]["byte_capped"])
        self.assertTrue(row["files"][0]["truncated"])
        self.assertLess(row["measured"]["entries"], 3, "后面的行确实没数到")
        note = " ".join(result["payload"]["warnings"])
        self.assertIn("超过单文件", note)
        self.assertIn("下限", note)

    def test_the_run_publishes_how_much_of_its_fetch_budget_it_used(self):
        fetches = run()["payload"]["fetches"]
        self.assertLessEqual(fetches["files"], fetches["max_files"])
        self.assertFalse(fetches["budget_hit"])

    def test_a_budget_exhausted_run_says_so_in_the_payload_too(self):
        with patch.object(ca, "MAX_FETCHES", 4):
            result = run()
        self.assertTrue(result["payload"]["fetches"]["budget_hit"])


class SafetyTest(CopyOfFixtures):
    def hostile(self, body):
        directory = self.isolated(body)
        return ca.collect(at(), sources=(read(),), offline_dir=directory)

    def test_only_http_links_survive(self):
        result = self.hostile(
            "| Title | Link |\n|---|---|\n"
            "| [bad scheme](javascript:alert(1)) | x |\n"
            "| [also bad](ftp://host/paper) | y |\n"
            "| [good paper](https://arxiv.org/abs/2601.00001) | z |\n")
        rows = result["payload"]["repos"][0]
        self.assertEqual([entry["url"] for entry in rows["sample"]],
                         ["https://arxiv.org/abs/2601.00001"])
        self.assertEqual(rows["measured"]["entries"], 1)

    def test_markup_and_control_characters_never_enter_the_payload(self):
        result = self.hostile(
            "| Title | Link |\n|---|---|\n"
            "| [**<script>alert(1)</script>EVIL\x00](https://x.test/p) | a |\n")
        blob = json.dumps(result["payload"], ensure_ascii=False)
        entry = result["payload"]["repos"][0]["sample"][0]
        self.assertNotIn("<script>", blob)
        self.assertEqual(entry["title"], "alert1 EVIL")
        self.assertNotIn("\x00", entry["title"])

    def test_every_published_link_is_absolute_http_without_spaces(self):
        for row in run()["payload"]["repos"]:
            for entry in row["sample"]:
                if entry["url"]:
                    self.assertTrue(entry["url"].startswith(("https://", "http://")),
                                    entry["url"])
                    self.assertNotIn(" ", entry["url"])

    def test_no_raw_markdown_body_is_published(self):
        blob = json.dumps(run()["payload"], ensure_ascii=False)
        for marker in ("|---", "![", "](", "<p align", "\\n\\n"):
            self.assertNotIn(marker, blob)

    def test_the_committed_fixtures_publish_no_credentials(self):
        blob = json.dumps(run()["payload"], ensure_ascii=False)
        for marker in ("ghp_", "github_pat_", "Bearer", "Authorization", "PRIVATE-TOKEN"):
            self.assertNotIn(marker, blob)

    def test_a_relative_link_is_never_turned_into_a_guessed_url(self):
        entry = ca.make_entry("| [internal page](docs/papers.md) | note |",
                             "isLinXu/recorded-list", None)
        self.assertIsNone(entry)
        self.assertIsNone(ca.safe_url("docs/papers.md"))
        self.assertIsNone(ca.safe_url("https://x.test/a b"))


class PublishTest(CopyOfFixtures):
    def test_a_check_run_writes_no_file(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch("builtins.print"):
            code = ca.main(["--offline", str(FIXTURES), "--data-dir", root, "--check"])
        self.assertEqual(code, 0)
        self.assertEqual(sorted(pathlib.Path(root).iterdir()), [])

    def test_a_partial_check_reports_the_carried_rows_instead_of_failing(self):
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(root), True)
        ca.publish(root, at(), offline_dir=FIXTURES)
        printed = []
        with patch("builtins.print",
                   lambda *args: printed.append(" ".join(str(arg) for arg in args))):
            code = ca.main(["--offline", str(FIXTURES), "--data-dir", str(root), "--check",
                            "--only", "isLinXu/paper-list"])
        text = "\n".join(printed)
        self.assertEqual(code, 0,
                         "an unread third-party list is an observation, not a broken collector")
        self.assertIn("check partial:", text)
        self.assertIn("本轮没读到（数字是沿用的）", text)

    def test_a_check_with_nothing_read_is_the_one_that_fails(self):
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(root), True)
        empty = root / "empty"
        empty.mkdir()
        with patch("builtins.print"):
            code = ca.main(["--offline", str(empty), "--data-dir", str(root), "--check"])
        self.assertEqual(code, 1)

    def test_publish_lands_the_index_the_ledger_and_the_history(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        directory = pathlib.Path(root)
        status = ca.publish(directory, at(), offline_dir=FIXTURES)
        self.assertEqual(status, "ok")
        self.assertEqual(sorted(path.name for path in directory.iterdir()),
                         ["awesome.json", "awesome_history.json", "awesome_ledger.json"])

    def test_a_day_that_could_not_read_anything_touches_only_the_index(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        directory = pathlib.Path(root)
        (directory / "empty").mkdir()
        first = ca.publish(directory, at(), offline_dir=FIXTURES)
        ledger = (directory / "awesome_ledger.json").read_text(encoding="utf-8")
        second = ca.publish(directory, at(day="2026-11-03"), offline_dir=directory / "empty")
        self.assertEqual(first, "ok")
        self.assertEqual(second, "stale")
        self.assertEqual((directory / "awesome_ledger.json").read_text(encoding="utf-8"),
                         ledger)
        snapshot = json.loads((directory / "awesome.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["status"], "stale")
        self.assertEqual(snapshot["captured_at"], "2026-11-02T12:00:00Z")
        self.assertEqual(snapshot["last_attempt_at"], "2026-11-03T12:00:00Z")

    def test_a_run_older_than_the_snapshot_is_refused(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        directory = pathlib.Path(root)
        ca.publish(directory, at(), offline_dir=FIXTURES)
        before = (directory / "awesome.json").read_text(encoding="utf-8")
        status = ca.publish(directory, at() - dt.timedelta(days=3), offline_dir=FIXTURES)
        self.assertEqual(status, "rejected")
        self.assertEqual((directory / "awesome.json").read_text(encoding="utf-8"), before)

    def test_a_second_run_on_the_same_day_replaces_that_day(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        directory = pathlib.Path(root)
        ca.publish(directory, at(), offline_dir=FIXTURES)
        ca.publish(directory, at(hour=18), offline_dir=FIXTURES)
        same_day = json.loads((directory / "awesome_history.json")
                              .read_text(encoding="utf-8"))["snapshots"]
        ca.publish(directory, at(day="2026-11-03"), offline_dir=FIXTURES)
        two_days = json.loads((directory / "awesome_history.json")
                              .read_text(encoding="utf-8"))["snapshots"]
        self.assertEqual([row["date"] for row in same_day], ["2026-11-02"])
        self.assertEqual([row["date"] for row in two_days], ["2026-11-02", "2026-11-03"])

    def test_snapshots_older_than_the_retention_are_dropped(self):
        history = {"snapshots": [{"date": "2019-01-01", "captured_at": "x"},
                                 {"date": "2026-11-01", "captured_at": "y"}]}
        summary = run()["payload"]["summary"]
        kept = ca.history_snapshot(history, summary, at())["snapshots"]
        self.assertEqual([row["date"] for row in kept], ["2026-11-01", "2026-11-02"])
        self.assertEqual(kept[-1]["entries_measured"], summary["entries_measured"])

    def test_the_trend_file_stays_a_downloadable_size(self):
        # Three years of daily points is ~150 KB of integers the eye cannot use.
        # Recent days stay daily; older months keep that month's last real read.
        today = at().date()
        history = {"snapshots": [{"date": (today - dt.timedelta(days=back)).isoformat(),
                                  "captured_at": "x"} for back in range(700, 0, -1)]}
        result = ca.history_snapshot(history, {"repos": 6, "repos_ok": 6, "repos_stale": 0,
                                               "repos_unavailable": 0, "entries_measured": 1,
                                               "entries_upstream": 1, "added": 0, "removed": 0,
                                               "stalled": 0}, at())
        dates = [row["date"] for row in result["snapshots"]]
        self.assertEqual(dates, sorted(dates))
        daily_start = (today - dt.timedelta(days=ca.DAILY_HISTORY_DAYS - 1)).isoformat()
        daily = [row for row in dates if row >= daily_start]
        self.assertEqual(len(daily), ca.DAILY_HISTORY_DAYS)
        monthly = [row for row in dates if row < daily_start]
        self.assertLessEqual(len(monthly), ca.MONTHLY_HISTORY_LIMIT)
        self.assertEqual(len({row[:7] for row in monthly}), len(monthly), "一个月只留一个点")
        # the kept month point is that month's last read, not an invented average.
        # The month the daily window starts in is deliberately split: its older days
        # are the thinned tail, its newer days are daily points.
        original = sorted(row["date"] for row in history["snapshots"])
        for date in monthly:
            if date[:7] == daily_start[:7]:
                continue
            self.assertEqual(date, [other for other in original if other[:7] == date[:7]][-1])
        self.assertEqual(result["retention"], {"daily_days": ca.DAILY_HISTORY_DAYS,
                                               "monthly_points": ca.MONTHLY_HISTORY_LIMIT})

    def test_a_day_of_carried_numbers_is_telled_apart_from_a_flat_list(self):
        summary = run()["payload"]["summary"]
        row = ca.history_snapshot({"snapshots": []}, summary, at())["snapshots"][0]
        self.assertEqual(row["tracked"], summary["repos"])
        self.assertEqual(row["repos"], summary["repos_ok"])
        self.assertLess(row["repos"], row["tracked"] + 1)

    def test_the_index_says_which_budget_it_ran_under(self):
        snapshot = run()["payload"]
        self.assertEqual(snapshot["schema_version"], ca.SCHEMA_VERSION)
        self.assertEqual(snapshot["source"]["budget"]["sample_limit"], ca.SAMPLE_LIMIT)
        self.assertEqual(sorted(snapshot["source"]["repos"]),
                         sorted(source["id"] for source in ca.SOURCES))
        self.assertEqual(snapshot["fetches"]["files"], 18)

    def test_an_only_filter_narrows_the_index_it_describes(self):
        result = ca.collect(at(), sources=(ca.SOURCES[2],), offline_dir=FIXTURES)
        self.assertEqual(result["payload"]["source"]["repos"],
                         ["isLinXu/awesome-visual-reasoning"])
        self.assertEqual(result["payload"]["summary"]["repos"], 1)

    def test_the_grow_and_shrink_log_is_computed_not_stored(self):
        first = run()
        second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                     ledger=first["ledger"])
        self.assertEqual(second["payload"]["changes"],
                         {"added": [], "removed": [], "grown": [], "shrunk": [],
                          "status": []})

    def test_a_status_flip_is_logged_as_a_change(self):
        first = run()
        directory = self.mutated("isLinXu/paper-list/README.md")
        second = run(at() + dt.timedelta(days=1), previous=first["payload"],
                     ledger=first["ledger"], directory=directory)
        entry = next(item for item in second["payload"]["changes"]["status"]
                     if item["id"] == "isLinXu/paper-list")
        self.assertEqual(entry, {"id": "isLinXu/paper-list", "from": "ok", "to": "stale"})

    def test_a_list_dropped_from_the_source_table_is_reported_gone(self):
        previous = run()["payload"]
        trimmed = tuple(source for source in ca.SOURCES
                        if source["id"] != "isLinXu/paper-list")
        # Leaving the table is the only way to stop tracking: --only just narrows
        # one run, and its skipped lists keep their rows.
        with patch.object(ca, "SOURCES", trimmed):
            result = ca.collect(at(), sources=trimmed, offline_dir=FIXTURES, previous=previous)
        self.assertIn("isLinXu/paper-list", result["payload"]["changes"]["removed"])

    def test_the_daily_log_carries_both_file_sizes(self):
        printed = ca.report(run()["payload"])
        self.assertIn("快照", printed)
        self.assertIn("台账", printed)

    def test_the_command_line_reports_what_the_reader_can_re_open(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch("builtins.print") as spoken:
            code = ca.main(["--offline", str(FIXTURES), "--data-dir", root], at=at())
        printed = ca.report(ca.load(pathlib.Path(root) / "awesome.json"))
        self.assertIn("停更 1 个", spoken.call_args_list[0][0][0])
        self.assertEqual(code, 0)
        self.assertIn("6/6 个清单可读", printed)
        # The daily log repeats the payload's own summary, so the number a reader
        # re-opens from data/awesome.json is the number the log printed.
        summary = ca.load(pathlib.Path(root) / "awesome.json")["summary"]
        self.assertIn(f"实测 {summary['entries_measured']} 条（自有）+ "
                      f"{summary['entries_upstream']} 条（上游）", printed)

    def test_the_command_line_stall_count_follows_the_clock_not_the_calendar(self):
        # `isLinXu/idea-research-list` sits exactly on STALL_AFTER_DAYS at noon on
        # 2026-11-02, so the recorded lists answer a different question one day
        # later. The count is a function of the `at` the caller passes, which is
        # why the command line takes one at all: an assertion that read the wall
        # clock turned this suite red the day the fixtures crossed the line.
        def first_line(at_value):
            root = tempfile.mkdtemp()
            self.addCleanup(shutil.rmtree, root, True)
            with patch("builtins.print") as calls:
                ca.main(["--offline", str(FIXTURES), "--data-dir", root], at=at_value)
            return calls.call_args_list[0][0][0]

        self.assertIn("停更 1 个", first_line(at()))
        self.assertIn("停更 2 个", first_line(at(day="2026-11-03")))

    def test_an_unknown_repository_name_is_refused_before_anything_is_read(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch("builtins.print"):
            code = ca.main(["--only", "nobody/nothing", "--data-dir", root])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
