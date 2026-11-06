import datetime as dt
import json
import pathlib
import shutil
import tempfile
import unittest
from collections import Counter
from unittest.mock import patch

from scripts import collect_homc as hc

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "homc"


def at(day="2026-11-02", hour=12, minute=0):
    return dt.datetime.fromisoformat(f"{day}T{hour:02}:{minute:02}:00+00:00")


def row(name, vendor="Vertex Labs", date="2026-10-28", category="通用 / 对话",
        capability="对话", availability="闭源 API", source="[A] [官方](https://example.com/a)",
        marker="🆕 第一轮"):
    """One eight-column verification row, written the way the list writes them."""
    return (f"| {name} | {vendor} | {date} | {category} | {capability} | {availability} "
            f"| {source} | {marker} |")


def table(rows):
    return "\n".join(["| 模型名称 | 提供方 | 发布或更新时间 | 模型类别 | 核心能力 | 可用状态 "
                      "| 信息来源 | 标记 |",
                      "|:---|:---|:---|:---|:---|:---|:---|:---|", *rows])


def doc(new=(), updated=(), unverified=(), extra="", stats=None, suits=True):
    """A README shaped like HOMC's, holding exactly the rows a test asks about."""
    total = len(new) + len(updated) + len(unverified)
    split = f"🆕 新增 {len(new)} / 🔄 更新 {len(updated)} / ⚠️ 待确认 {len(unverified)}"
    parts = ["# 🃏 House of Model Cards", "", "## 2. 核实总表", "",
             "### 2.0 本轮核实（截至 2026-11-02）", ""]
    for title, body in (("#### 2.0.2 🆕 新增项", new), ("#### 2.0.3 🔄 有更新项", updated),
                        ("#### 2.0.4 ⚠️ 待确认项", unverified)):
        parts += [title, "", table(body), ""]
    if extra:
        parts += [extra, ""]
    if stats is not False:
        parts += ["## 📊 核心统计", "", "| 指标 | 数量 | 说明 |", "|:---|:---:|:---|",
                  f"| ✅ 本轮核实增量 | {stats or f'{total} 条'} | {split} |", ""]
    if suits:
        parts += ["### 1.6 扑克牌花色索引", "#### ♠ 视觉",
                  "| 花色牌面 | 参数 | 说明 |", "|:---|:---:|:---|",
                  "| **♠A Qwen3-VL** | 30B | 旗舰 |",
                  "#### 🃏 特殊突破", "| 花色牌面 | 创新点 | 说明 |", "|:---|:---|:---|",
                  "| **🃏 DeepSeek-R1** | GRPO | 纯 RL |", ""]
    return "\n".join(parts)


def isolated(text):
    """A recorded mirror holding nothing but this document."""
    root = pathlib.Path(tempfile.mkdtemp())
    target = root / hc.REPO
    target.mkdir(parents=True)
    (target / hc.README_PATH).write_text(text, encoding="utf-8")
    return root


def read(directory=None, at_moment=None, previous=None, ledger=None):
    return hc.collect(at_moment or at(), offline_dir=FIXTURES if directory is None else directory,
                      previous=previous, ledger=ledger)


def rows_of(**kwargs):
    return read(**kwargs)["payload"]["rows"]


def find(rows, name):
    return next(entry for entry in rows if entry["name"] == name)


def hostile(text, **kwargs):
    return read(isolated(text), **kwargs)


def payload(**fields):
    """A published snapshot carrying just what a test needs to carry over."""
    base = {"schema_version": hc.SCHEMA_VERSION, "status": "ok", "as_of": "2026-11-01",
            "captured_at": "2026-11-01T12:00:00Z", "last_attempt_at": "2026-11-01T12:00:00Z",
            "measured": {"rows": {"new": 3, "updated": 1, "unverified": 1, "total": 5}},
            "self_reported": {"increment": 5}, "cadence": None,
            "diff": {"added": 0, "removed": 0}, "warnings": [], "rows": []}
    base.update(fields)
    return base


class _Unread:
    """A fetcher that got nothing back, for the carry-over paths."""

    def __init__(self, *args, **kwargs):
        pass

    def text(self, repo, path):
        return None

    def reason(self, repo, path):
        return "network"


class FixtureBaselineTest(unittest.TestCase):
    def test_the_recorded_list_reads_as_three_state_tables(self):
        result = read()
        measured = result["payload"]["measured"]
        self.assertEqual(result["status"], "ok")
        self.assertEqual(measured["rows"], {"new": 4, "updated": 2, "unverified": 1, "total": 7})
        self.assertEqual(measured["rows_parsed"], 7)
        self.assertEqual(result["payload"]["as_of"], "2026-11-02")
        self.assertEqual(result["payload"]["as_of_age_days"], 0)

    def test_the_group_headings_inside_a_table_become_row_attributes(self):
        rows = rows_of()
        self.assertEqual(find(rows, "Atlas-1")["group"], "海外厂商")
        self.assertEqual(find(rows, "长城 LongWall-3")["group"], "中国厂商与机构")
        self.assertIsNone(find(rows, "Cipher-Z")["group"], "没有分组行的表不编一个分组")

    def test_a_row_is_read_against_the_columns_the_caliber_documents(self):
        entry = find(rows_of(), "Bloom-Reason")
        self.assertEqual(entry["date"], "2026-10")
        self.assertEqual(entry["precision"], "month")
        self.assertEqual(entry["category"], "推理增强")
        self.assertEqual(entry["availability"], "公开仓库")


class MeasuredAgainstSelfReportedTest(unittest.TestCase):
    def test_both_numbers_are_published_and_neither_is_adjusted_to_the_other(self):
        comparison = read()["payload"]["comparison"]
        self.assertEqual(comparison["measured_rows"], 7)
        self.assertEqual(comparison["claimed_increment"], 7)
        self.assertEqual(comparison["delta"], 0)

    def test_a_gap_between_the_two_is_reported_rather_than_reconciled(self):
        result = hostile(doc(new=[row("One")], stats="12 条"))
        comparison = result["payload"]["comparison"]
        self.assertEqual(comparison["measured_rows"], 1)
        self.assertEqual(comparison["claimed_increment"], 12)
        self.assertEqual(comparison["delta"], -11)
        self.assertIn("谁也不改成对方的数", " ".join(result["payload"]["warnings"]))

    def test_a_list_that_says_nothing_about_its_increment_leaves_the_slot_empty(self):
        payload = hostile(doc(new=[row("One")], stats=False))["payload"]
        self.assertIsNone(payload["self_reported"])
        self.assertIsNone(payload["comparison"]["claimed_increment"])
        self.assertIn("没自报", payload["comparison"]["note"])
        self.assertEqual(payload["measured"]["rows"]["total"], 1, "实测数不因自报缺席而变")

    def test_the_self_reported_split_is_kept_as_written(self):
        self_reported = read()["payload"]["self_reported"]
        self.assertEqual(self_reported["model_series_claimed"], "200+", "范围不折成整数")
        self.assertEqual(self_reported["increment_new"], 4)
        self.assertEqual(self_reported["increment_updated"], 2)
        self.assertEqual(self_reported["increment_unverified"], 1)

    def test_the_two_numbers_stay_in_separate_places_of_the_payload(self):
        payload = read()["payload"]
        self.assertNotIn("claimed", json.dumps(payload["measured"]))
        self.assertNotIn("measured", json.dumps(payload["self_reported"]))
        self.assertEqual(payload["measured"]["rows"]["total"], 7)
        self.assertEqual(payload["self_reported"]["increment"], 7)
        self.assertNotIn("total", json.dumps(payload["comparison"]))


class GradeTest(unittest.TestCase):
    def test_a_grade_count_is_rows_carrying_that_grade_not_sources_listed(self):
        measured = read()["payload"]["measured"]
        self.assertEqual(measured["grades"], {"A": 3, "B": 2, "C": 2})
        with_grade = measured["rows"]["total"] - measured["without_grade"]
        self.assertGreater(sum(measured["grades"].values()), with_grade,
                           "一行同时列 A 与 B，所以三档之和可以大于带档的行数")

    def test_the_lists_own_single_b_caveat_is_counted_and_the_row_stays(self):
        entry = find(rows_of(), "Bloom-Reason")
        self.assertTrue(entry["single_b_source"])
        self.assertIn("单一 B 源", entry["note"])
        self.assertEqual(read()["payload"]["measured"]["single_b_source"], 1)

    def test_a_lone_b_source_reads_as_single_source_without_the_caveat_words(self):
        result = hostile(doc(new=[row("Lone", source="[B] [报道](https://example.com/b)")]))
        entry = find(result["payload"]["rows"], "Lone")
        self.assertTrue(entry["single_b_source"], "该行只有一个 [B]，这是可数的形状")
        self.assertNotIn("须复核", entry["note"] or "", "清单没写的提醒不由本站补写")

    def test_a_row_with_no_grade_marker_is_counted_as_ungraded_not_as_a_bad_row(self):
        result = hostile(doc(new=[row("Bare", source="官方页，未标等级")]))
        self.assertEqual(result["payload"]["measured"]["without_grade"], 1)
        self.assertEqual(result["payload"]["measured"]["rows"]["total"], 1)


class MarkerTest(unittest.TestCase):
    def test_the_leading_emoji_survives_a_title_cleaner_that_would_eat_it(self):
        rows = rows_of()
        self.assertEqual({entry["marker"] for entry in rows}, {"🆕", "🔄", "⚠️"})
        self.assertEqual(read()["payload"]["measured"]["marker_mismatch"], 0)
        self.assertEqual(read()["payload"]["measured"]["with_note"], 7)

    def test_the_prose_after_the_emoji_is_published_as_the_lists_own_note(self):
        entry = find(rows_of(), "Atlas-1.5")
        self.assertEqual(entry["marker"], "🔄")
        self.assertEqual(entry["note"], "原记 2026-01 → 更正为 2026-11-01 首发")

    def test_a_marker_that_disagrees_with_its_table_is_counted_not_refiled(self):
        result = hostile(doc(new=[row("One", marker="🆕 ok")],
                             unverified=[row("Two", vendor="Nova AI", marker="🆕 放错表了")]))
        entry = find(result["payload"]["rows"], "Two")
        self.assertEqual(entry["state"], "unverified", "按读到的表归类，不替清单改判")
        self.assertEqual(entry["marker_state"], "new")
        self.assertEqual(result["payload"]["measured"]["marker_mismatch"], 1)
        self.assertIn("不代替清单改判", " ".join(result["payload"]["warnings"]))

    def test_a_row_without_a_known_marker_keeps_the_marker_slot_empty(self):
        entry = find(hostile(doc(new=[row("One", marker="🛈 手滑了")]))["payload"]["rows"], "One")
        self.assertIsNone(entry["marker"])
        self.assertEqual(entry["note"], "🛈 手滑了")
        self.assertEqual(entry["marker_state"], None, "认不出标记时不猜一个状态")


class SectionReferenceTest(unittest.TestCase):
    def test_a_row_that_points_at_a_section_is_kept_and_named_as_one(self):
        self.assertEqual(read()["payload"]["measured"]["section_reference_rows"], 1)
        entry = find(rows_of(), "17 视频生成补白")
        self.assertTrue(entry["is_section_reference"])
        self.assertEqual(entry["state"], "new", "它确实坐在 🆕 表里，照数")

    def test_mentioning_a_section_in_prose_does_not_make_a_row_a_pointer(self):
        self.assertFalse(hc.is_section_ref("[Atlas-1](https://example.com/a)"))
        self.assertTrue(hc.is_section_ref("**§17 视频生成**"))
        self.assertFalse(hc.is_section_ref("见 §17 的说法"))


class TableShapeTest(unittest.TestCase):
    def test_a_table_that_is_not_the_verification_table_is_named_not_counted(self):
        result = read()
        self.assertEqual(result["payload"]["measured"]["rows"]["total"], 7)
        self.assertNotIn("Ghost-0", json.dumps(result["payload"], ensure_ascii=False))
        warning = " ".join(result["payload"]["warnings"])
        self.assertIn("不一致", warning)

    def test_a_reordered_header_is_refused_because_a_column_would_lie(self):
        body = ("| 模型名称 | 提供方 | 模型类别 | 发布或更新时间 | 核心能力 | 可用状态 "
                "| 信息来源 | 标记 |\n|:---|:---|:---|:---|:---|:---|:---|:---|\n" + row("Two"))
        result = hostile(doc(new=[row("One")], extra=body))
        self.assertEqual(result["payload"]["measured"]["rows"]["total"], 1,
                         "换了列序的表一行都不计入，包括它自己的表头行")
        self.assertIn("不一致", " ".join(result["payload"]["warnings"]))

    def test_the_machine_digest_section_is_left_to_its_own_collector(self):
        blob = json.dumps(read()["payload"], ensure_ascii=False)
        self.assertNotIn("digest/Daily-9", blob)
        self.assertNotIn("机器抓取", blob)

    def test_a_baseline_table_with_other_columns_is_not_read_as_entries(self):
        self.assertNotIn("Old-1", json.dumps(read()["payload"], ensure_ascii=False))

    def test_a_nameless_row_is_skipped_said_out_loud_and_not_counted_as_an_entry(self):
        result = hostile(doc(new=[row("One"), row("   ", vendor="Nova AI")]))
        self.assertEqual(result["payload"]["measured"]["rows"]["new"], 2, "表里确实有两行")
        self.assertEqual(result["payload"]["measured"]["rows_parsed"], 1)
        self.assertIn("无名行", " ".join(result["payload"]["warnings"]))

    def test_the_same_model_in_two_state_tables_is_counted_once_as_an_entry(self):
        result = hostile(doc(new=[row("One"), row("Two")],
                             unverified=[row("One", marker="⚠️ 重复")]))
        measured = result["payload"]["measured"]
        self.assertEqual(measured["rows"]["total"], 3, "表格行照数")
        self.assertEqual(measured["rows_parsed"], 2, "条目只按首次计")
        self.assertIn("同一模型应只落在", " ".join(result["payload"]["warnings"]))


class SuitIndexTest(unittest.TestCase):
    def test_both_card_shapes_are_read_including_the_rank_less_joker(self):
        self.assertEqual(read()["payload"]["measured"]["suit_index"],
                         {"♠": 3, "♥": 1, "🃏": 2})

    def test_a_card_label_is_attached_only_when_the_name_matches_exactly(self):
        rows = rows_of()
        measured = read()["payload"]["measured"]
        self.assertEqual(find(rows, "GPT-5")["suit"], "♥A")
        self.assertEqual(measured["suit_matched"], 1)
        self.assertEqual(measured["suit_unmatched"], 6)
        self.assertEqual(sum(1 for entry in rows if entry["suit"] is None), 6,
                         "对不上花色的行照发，只是不编一个花色")

    def test_a_joker_row_without_a_rank_is_still_indexed(self):
        text = (FIXTURES / hc.REPO / hc.README_PATH).read_text(encoding="utf-8")
        by_name, by_suit = hc.extract_suits(text)
        self.assertEqual(by_name["deepseek-r1"], "🃏")
        self.assertEqual(by_suit["🃏"], 2)

    def test_a_card_row_that_carries_no_name_is_not_indexed(self):
        by_name, _suits = hc.extract_suits("### 1.6 索引\n#### ♠ 视觉\n"
                                           "| 牌面 | 说明 |\n|:---|:---|\n| **♠A** | 空 |\n")
        self.assertEqual(by_name, {})


class DatePrecisionTest(unittest.TestCase):
    def test_a_month_is_not_promoted_to_a_day(self):
        entry = find(rows_of(), "Bloom-Reason")
        self.assertEqual(entry["date"], "2026-10")
        self.assertEqual(entry["precision"], "month")

    def test_the_lists_words_for_no_date_are_kept_instead_of_an_empty_string(self):
        rows = rows_of()
        self.assertIsNone(find(rows, "长城 LongWall-3")["date"])
        self.assertEqual(find(rows, "长城 LongWall-3")["date_state"], "undisclosed")
        self.assertIsNone(find(rows, "Cipher-Z")["date"])
        self.assertEqual(find(rows, "Cipher-Z")["date_state"], "unverified")

    def test_the_date_buckets_add_up_to_the_total(self):
        measured = read()["payload"]["measured"]
        self.assertEqual(sum(measured["dates"].values()), measured["rows"]["total"])
        self.assertEqual(measured["dates"], {"day": 2, "month": 2, "undisclosed": 1,
                                             "unverified": 2})

    def test_an_unreadable_as_of_heading_leaves_the_slot_empty_and_says_so(self):
        body = doc(new=[row("One")]).replace("### 2.0 本轮核实（截至 2026-11-02）", "### 2.0 本轮核实")
        result = hostile(body)
        self.assertIsNone(result["payload"]["as_of"])
        self.assertIsNone(result["payload"]["as_of_age_days"])
        self.assertIn("认不出来", " ".join(result["payload"]["warnings"]))


class SampleBudgetTest(unittest.TestCase):
    def many_rows(self):
        """A list shaped like the real one: one table far bigger than the other two."""
        return isolated(doc(new=[row(f"New {index}") for index in range(40)],
                            updated=[row("Up", marker="🔄"),
                                     row("Earlier", vendor="Nova AI", marker="🔄")],
                            unverified=[row("Late", vendor="Nova AI", marker="⚠️")]))

    def test_the_sample_covers_all_three_tables_even_when_one_is_much_larger(self):
        with patch.object(hc, "ROW_LIMIT", 6):
            payload = read(self.many_rows())["payload"]
        self.assertEqual(Counter(entry["state"] for entry in payload["rows"]),
                         {"new": 3, "updated": 2, "unverified": 1},
                         "轮转取样：小的两张表不会被 40 行的 🆕 表挤出样本")
        self.assertEqual(payload["measured"]["rows"]["total"], 43)

    def test_the_newest_dated_rows_lead_and_undated_rows_fall_to_the_tail(self):
        result = hostile(doc(new=[row("No date", date="未披露"), row("Old", date="2026-01-05"),
                                 row("New", date="2026-10-30"),
                                 row("Middle", date="2026-06-15")]))
        self.assertEqual([entry["name"] for entry in result["payload"]["rows"]],
                         ["New", "Middle", "Old", "No date"])

    def test_a_smaller_row_limit_shortens_the_sample_and_no_count(self):
        with patch.object(hc, "ROW_LIMIT", 3):
            result = read()
        payload = result["payload"]
        self.assertEqual([entry["name"] for entry in payload["rows"]],
                         ["Atlas-1", "Atlas-1.5", "Cipher-Z"])
        self.assertEqual(payload["measured"]["rows"]["total"], 7)
        self.assertEqual(payload["sizes"]["row_limit_applied"], 3)
        self.assertEqual(len(result["ledger"]["ids"]), 7, "台账记下全部 id，明天才不谎报新增")

    def test_the_overall_budget_cuts_rows_and_says_which_limit_it_used(self):
        with patch.object(hc, "PAYLOAD_BUDGET_BYTES", 9_000):
            payload = read(self.many_rows())["payload"]
        self.assertLess(len(payload["rows"]), 43)
        self.assertGreater(len(payload["rows"]), 0, "预算内还放得下几行，就不该一行不发")
        self.assertLessEqual(payload["sizes"]["payload_bytes"], 9_000)
        self.assertEqual(payload["measured"]["rows"]["total"], 43)
        self.assertEqual(payload["sizes"]["row_limit_applied"], len(payload["rows"]))
        self.assertIn("只发布前 10 行", " ".join(payload["warnings"]))

    def test_a_budget_smaller_than_the_counts_alone_publishes_no_rows_at_all(self):
        with patch.object(hc, "PAYLOAD_BUDGET_BYTES", 7_000):
            payload = read(self.many_rows())["payload"]
        self.assertEqual(payload["rows"], [])
        self.assertEqual(payload["measured"]["rows"]["total"], 43, "计数不受样本影响")
        self.assertIn("只发布前 0 行", " ".join(payload["warnings"]))

    def test_an_unshrinkable_snapshot_blames_the_links_not_the_reader(self):
        with patch.object(hc, "PAYLOAD_BUDGET_BYTES", 200):
            result = read()
        self.assertIn("该砍的是每行留的链接数", " ".join(result["payload"]["warnings"]))

    def test_a_ledger_over_its_own_budget_is_reported_instead_of_silently_shrunk(self):
        with patch.object(hc, "LEDGER_BUDGET_BYTES", 100):
            result = read()
        self.assertIn("记不全 id 的台账", " ".join(result["payload"]["warnings"]))

    def test_the_published_sample_stays_inside_its_declared_limit(self):
        payload = read()["payload"]
        self.assertLessEqual(len(payload["rows"]), payload["source"]["budget"]["row_limit"])


class LedgerTest(unittest.TestCase):
    def test_the_first_read_is_a_baseline_rather_than_a_spike_of_arrivals(self):
        diff = read()["payload"]["diff"]
        self.assertTrue(diff["baseline"])
        self.assertEqual(diff["added"], 0)
        self.assertEqual(diff["removed"], 0)
        self.assertEqual(diff["held"], 7)

    def test_a_second_read_that_saw_the_same_rows_moves_nothing(self):
        ids = read()["ledger"]["ids"]
        diff = read(ledger={"ids": ids})["payload"]["diff"]
        self.assertEqual(diff, {"baseline": False, "added": 0, "removed": 0, "held": 7,
                               "truncated": False})

    def test_an_arrival_is_flagged_in_the_sample_and_leads_its_table(self):
        directory = isolated(doc(new=[row("Atlas-1"), row("Brand New")]))
        result = read(directory, ledger={"ids": ["homc:atlas-1|vertex-labs"]})
        diff = result["payload"]["diff"]
        self.assertEqual((diff["added"], diff["removed"]), (1, 0))
        self.assertTrue(find(result["payload"]["rows"], "Brand New")["is_new"])
        self.assertFalse(find(result["payload"]["rows"], "Atlas-1")["is_new"])
        self.assertEqual(result["payload"]["rows"][0]["name"], "Brand New",
                         "新到的排在本表最前，样本仍然从每表各取一行开始")

    def test_a_row_the_list_dropped_is_reported_as_removed(self):
        diff = read(ledger={"ids": ["homc:atlas-1|vertex-labs",
                                    "homc:gone|nova-ai"]})["payload"]["diff"]
        self.assertEqual(diff["removed"], 1)
        self.assertEqual(diff["added"], 6)

    def test_a_ledger_that_hit_its_id_ceiling_answers_none_not_a_flattering_count(self):
        with patch.object(hc, "LEDGER_ID_LIMIT", 3):
            result = read(ledger={"ids": [entry["id"] for entry in rows_of()[:3]]})
        diff = result["payload"]["diff"]
        self.assertIsNone(diff["added"])
        self.assertIsNone(diff["removed"])
        self.assertTrue(diff["truncated"])
        self.assertTrue(result["ledger"]["capped"])
        self.assertIn("台账只记前 3 个 id", " ".join(result["payload"]["warnings"]))

    def test_history_points_hold_both_numbers_and_never_a_merged_one(self):
        snapshot = hc.history_snapshot({"snapshots": []}, read()["payload"], at())["snapshots"][0]
        self.assertEqual(snapshot["rows_total"], 7)
        self.assertEqual(snapshot["rows_new"], 4)
        self.assertEqual(snapshot["claimed_increment"], 7)
        self.assertNotIn("entries", snapshot)


class FailureIsolationTest(unittest.TestCase):
    def test_an_unread_list_carries_the_last_good_snapshot_and_labels_it(self):
        result = read(pathlib.Path(tempfile.mkdtemp()), previous=payload())
        published = result["payload"]
        self.assertEqual(result["status"], "stale")
        self.assertEqual(published["status"], "stale")
        self.assertEqual(published["measured"]["rows"]["total"], 5)
        self.assertEqual(published["captured_at"], "2026-11-01T12:00:00Z")
        self.assertEqual(published["last_attempt_at"], "2026-11-02T12:00:00Z")
        self.assertIn("保留上一次快照", published["error"])
        self.assertIn("显示的是", " ".join(published["warnings"]))

    def test_a_read_that_returns_no_rows_is_a_format_change_not_an_empty_list(self):
        result = hostile("# 全部改成图片了\n\n![](cards.png)\n", previous=payload())
        self.assertEqual(result["status"], "stale")
        self.assertIn("认不出既定列", result["payload"]["error"])

    def test_a_first_run_that_reads_nothing_publishes_an_explicit_absence(self):
        published = read(pathlib.Path(tempfile.mkdtemp()))["payload"]
        self.assertEqual(published["status"], "unavailable")
        self.assertIsNone(published["captured_at"])
        self.assertIsNone(published["measured"])
        self.assertEqual(published["rows"], [])
        self.assertEqual(published["cadence"]["status"], "unknown")
        self.assertIsNone(published["self_reported"], "读不到时不编一个自报数")

    def test_a_stale_run_leaves_the_ledger_and_history_untouched(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        data = pathlib.Path(root)
        hc.atomic_json_write(data / hc.ENTRY_FILENAME, payload())
        with patch.object(hc, "Fetcher", _Unread), patch("builtins.print"):
            status = hc.publish(data, at())
        self.assertEqual(status, "stale")
        self.assertEqual(hc.load(data / hc.ENTRY_FILENAME)["status"], "stale")
        self.assertFalse((data / hc.LEDGER_FILENAME).exists())
        self.assertFalse((data / hc.HISTORY_FILENAME).exists(), "沿用上次不是新观测")


class CadenceTest(unittest.TestCase):
    def test_a_commit_day_is_file_movement_not_a_fresh_verification(self):
        published = read()["payload"]
        self.assertEqual(published["cadence"]["cadence"], "daily")
        self.assertEqual(published["cadence"]["last_file_commit_at"], "2026-11-02T09:12:03Z")
        self.assertIn("不代表人工核实表", published["source"]["caliber"]["cadence"])
        self.assertEqual(published["as_of"], "2026-11-02")

    def test_a_stale_file_says_how_stale_it_is_instead_of_going_quiet(self):
        published = read(at_moment=at(day="2027-01-20"))["payload"]
        self.assertTrue(published["cadence"]["stalled"])
        self.assertEqual(published["cadence"]["cadence"], "manual")
        self.assertIn("没动过", " ".join(published["warnings"]))
        self.assertEqual(published["as_of_age_days"], 79)

    def test_no_commits_recorded_is_answered_as_unknown_not_as_ok(self):
        with patch.object(hc, "read_cadence", lambda *args, **kwargs:
                          {"status": "unknown", "cadence": None, "stalled": None,
                           "stale_days": None}):
            published = read()["payload"]
        self.assertEqual(published["cadence"]["status"], "unknown")


class SafetyTest(unittest.TestCase):
    def test_only_http_links_survive_a_row(self):
        result = hostile(doc(new=[row("[x](javascript:alert(1)) Nova",
                                      source="看 [内部页](docs/notes.md)"),
                              row("Clean", source="[A] [官方](https://example.com/ok)")]))
        self.assertEqual(find(result["payload"]["rows"], "Clean")["links"],
                         ["https://example.com/ok"])
        for entry in result["payload"]["rows"]:
            for link in entry["links"]:
                self.assertTrue(link.startswith(("https://", "http://")), link)
                self.assertNotIn(" ", link)

    def test_markup_and_control_characters_never_reach_the_payload(self):
        result = hostile(doc(new=[row("**<script>alert(1)</script>EVIL\x00",
                                      capability="<img src=x>抽取")]))
        blob = json.dumps(result["payload"], ensure_ascii=False)
        entry = result["payload"]["rows"][0]
        self.assertNotIn("<script>", blob)
        self.assertNotIn("<img", blob)
        self.assertNotIn("\x00", blob)
        self.assertEqual(entry["name"], "alert1 EVIL")
        self.assertEqual(entry["capability"], "抽取")

    def test_no_raw_markdown_body_is_published(self):
        blob = json.dumps(read()["payload"], ensure_ascii=False)
        for marker in ("|---", "](", "<p align", "!["):
            self.assertNotIn(marker, blob)

    def test_a_long_cell_is_cut_to_its_field_limit(self):
        entry = find(hostile(doc(new=[row("One", capability="能" * 400)]))["payload"]["rows"], "One")
        self.assertEqual(len(entry["capability"]), hc.NOTE_LIMIT)

    def test_the_committed_fixture_publishes_no_credentials(self):
        blob = json.dumps(read()["payload"], ensure_ascii=False)
        for marker in ("ghp_", "github_pat_", "Bearer", "Authorization", "PRIVATE-TOKEN"):
            self.assertNotIn(marker, blob)

    def test_the_hugging_face_weight_page_leads_a_row_with_several_sources(self):
        entry = find(rows_of(), "Bloom-Reason")
        self.assertEqual(entry["url"], "https://huggingface.co/nova/Bloom-Reason")
        self.assertEqual(entry["link_count"], 2)
        self.assertEqual(len(entry["links"]), 2)

    def test_the_payload_names_the_source_and_keeps_the_honesty_calibers(self):
        source = read()["payload"]["source"]
        self.assertEqual(source["site_url"], "https://islinxu.github.io/model-list/")
        self.assertEqual(source["readme_path"], "README.md")
        self.assertIn("永不相加", source["caliber"]["never_merged"])
        self.assertIn("不重复核实", source["caliber"]["graded_by"])
        self.assertIn("砍掉的是样本", source["caliber"]["sampled"])
        self.assertIn("由该清单判定", source["caliber"]["graded_by"])


class PublishTest(unittest.TestCase):
    def test_a_check_run_writes_no_file(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch("builtins.print"):
            code = hc.main(["--offline", str(FIXTURES), "--data-dir", root, "--check"])
        self.assertEqual(code, 0)
        self.assertEqual(list(pathlib.Path(root).iterdir()), [])

    def test_the_command_line_sums_up_the_same_numbers_the_payload_holds(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch("builtins.print") as spoken:
            code = hc.main(["--offline", str(FIXTURES), "--data-dir", root], at=at())
        printed = hc.report(hc.load(pathlib.Path(root) / hc.ENTRY_FILENAME))
        self.assertEqual(code, 0)
        self.assertIn(f"ok: {printed}", spoken.call_args_list[0][0][0])
        self.assertIn("实测 7 行（🆕4 / 🔄2 / ⚠️1）", printed)
        self.assertIn("清单自报 7 条", printed)

    def test_publishing_writes_the_entry_the_ledger_and_the_history(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch("builtins.print"):
            status = hc.publish(pathlib.Path(root), at(), offline_dir=FIXTURES)
        self.assertEqual(status, "ok")
        self.assertEqual(sorted(path.name for path in pathlib.Path(root).iterdir()),
                         sorted([hc.ENTRY_FILENAME, hc.HISTORY_FILENAME, hc.LEDGER_FILENAME]))

    def test_a_snapshot_from_the_future_is_refused_rather_than_overwritten(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        data = pathlib.Path(root)
        hc.atomic_json_write(data / hc.ENTRY_FILENAME,
                             payload(captured_at="2027-01-01T00:00:00Z",
                                     last_attempt_at="2027-01-01T00:00:00Z"))
        with patch("builtins.print"):
            status = hc.publish(data, at(), offline_dir=FIXTURES)
        self.assertEqual(status, "rejected")
        self.assertEqual(hc.load(data / hc.ENTRY_FILENAME)["as_of"], "2026-11-01")

    def test_a_check_on_a_list_that_was_never_read_exits_nonzero_because_the_board_is_empty(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with patch("builtins.print"):
            code = hc.main(["--offline", str(pathlib.Path(root) / "nothing"),
                            "--data-dir", root, "--check"])
        self.assertEqual(code, 1)

    def test_a_stale_read_still_exits_zero_because_an_unread_list_is_an_observation(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        data = pathlib.Path(root)
        hc.atomic_json_write(data / hc.ENTRY_FILENAME, payload())
        with patch("builtins.print") as spoken:
            code = hc.main(["--offline", str(data / "nothing"), "--data-dir", str(data),
                            "--check"], at=at())
        self.assertEqual(code, 0)
        self.assertIn("stale", spoken.call_args_list[0][0][0])


if __name__ == "__main__":
    unittest.main()
