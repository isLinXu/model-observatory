import datetime as dt
import io
import json
import os
import re
import tempfile
import unittest
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import collect_starred as cs

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "github_starred_sample.json"

PAGE_RE = re.compile(r"[?&]page=(\d+)")


def at(day="2026-11-01", hour=4, minute=0):
    return dt.datetime.fromisoformat(f"{day}T{hour:02}:{minute:02}:00+00:00")


def item(name="owner/repo", **fields):
    value = {
        "full_name": name,
        "html_url": f"https://github.com/{name}",
        "language": "Python",
        "topics": [],
        "stargazers_count": 10,
        "description": "a description",
        "pushed_at": "2026-10-01T00:00:00Z",
        "fork": False,
        "archived": False,
        "owner": {"login": name.split("/", 1)[0], "type": "User"},
    }
    value.update(fields)
    return value


def fixture_items():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def normalize(item):
    warnings = []
    return cs.normalize_row(item, warnings), warnings


def rows(*specs):
    """Build published rows: each spec is a name, (name, overrides) or a short tuple."""
    result = []
    for spec in specs:
        if isinstance(spec, tuple):
            name = spec[0]
            fields = spec[1] if len(spec) > 1 else {}
        else:
            name, fields = spec, {}
        base = {"n": name, "l": "Python", "t": [], "s": 10, "d": "a description",
                "p": "2026-10-01", "f": 0, "r": 0, "o": 0}
        base.update(fields)
        result.append(base)
    return result


def page_getter(pages):
    """A stand-in for http_get_json that serves a fixed pagination table."""
    calls = []

    def getter(url, *, headers=None):
        page = int(PAGE_RE.search(url).group(1))
        calls.append(url)
        return pages.get(page, [])

    getter.calls = calls
    return getter


def http_response(payload, headers=None):
    message = Message()
    for key, value in (headers or {}).items():
        message[key] = value
    response = Mock()
    response.read = Mock(return_value=json.dumps(payload).encode("utf-8"))
    response.headers = message
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    return response


def opener_for(payload, headers=None):
    return Mock(return_value=http_response(payload, headers))


class ClockTests(unittest.TestCase):
    def test_naive_capture_time_is_rejected(self):
        with self.assertRaises(cs.StarError):
            cs.utc(dt.datetime(2026, 11, 1))

    def test_timestamp_is_utc_with_z_suffix(self):
        self.assertEqual(cs.timestamp(at()), "2026-11-01T04:00:00Z")

    def test_non_utc_zone_is_converted(self):
        value = dt.datetime.fromisoformat("2026-11-01T12:00:00+08:00")
        self.assertEqual(cs.timestamp(value), "2026-11-01T04:00:00Z")


class ErrorSanitizingTests(unittest.TestCase):
    def test_known_codes_have_fixed_messages(self):
        for code in ("count", "empty", "pages", "schema", "token"):
            with self.subTest(code=code):
                self.assertEqual(cs.safe_error(cs.StarError(code)), cs.ERROR_MESSAGES[code])

    def test_http_status_is_kept_but_body_is_dropped(self):
        error = urllib.error.HTTPError("https://api.github.com/x", 403, "Forbidden", Message(), None)
        self.assertEqual(cs.safe_error(error), "GitHub 返回 HTTP 403。")

    def test_network_errors_are_generic(self):
        for error in (urllib.error.URLError("token=secret"), TimeoutError("secret"), OSError("secret")):
            with self.subTest(error=type(error).__name__):
                message = cs.safe_error(error)
                self.assertEqual(message, "无法访问 GitHub API。")
                self.assertNotIn("secret", message)

    def test_unexpected_errors_never_echo_their_message(self):
        self.assertEqual(cs.safe_error(RuntimeError("token=secret")), "star 采集失败。")

    def test_star_error_detail_is_not_part_of_the_message(self):
        error = cs.StarError("count", "expected 5125, got 42 token=secret")
        self.assertEqual(str(error), cs.ERROR_MESSAGES["count"])


class FieldTests(unittest.TestCase):
    def test_whitespace_is_collapsed_and_truncated(self):
        self.assertEqual(cs.clean_text("  a\n b\t c ", 5), "a b c")
        self.assertEqual(cs.clean_text("abcdef", 3), "abc")
        self.assertIsNone(cs.clean_text("   ", 10))
        self.assertIsNone(cs.clean_text(12, 10))

    def test_dates_accept_only_a_valid_iso_day(self):
        self.assertEqual(cs.parse_date("2026-10-05T12:00:00Z"), "2026-10-05")
        self.assertIsNone(cs.parse_date("2026-13-05T12:00:00Z"))
        self.assertIsNone(cs.parse_date("not a date"))
        self.assertIsNone(cs.parse_date(None))

    def test_counts_reject_booleans_and_negatives(self):
        self.assertIsNone(cs.int_or_none(True))
        self.assertIsNone(cs.int_or_none(-1))
        self.assertEqual(cs.int_or_none(0), 0)

    def test_topics_are_lowercased_and_filtered(self):
        self.assertEqual(cs.normalize_topic("  LLM-Tools "), "llm-tools")
        self.assertIsNone(cs.normalize_topic("-bad"))
        self.assertIsNone(cs.normalize_topic("a" * 60))
        self.assertIsNone(cs.normalize_topic(7))


class NormalizeRowTests(unittest.TestCase):
    def test_only_the_whitelisted_fields_survive(self):
        row, warnings = normalize(item(id=999, node_id="N", homepage="https://x", watchers_count=3))
        self.assertEqual(set(row), {"n", "l", "t", "s", "d", "p", "f", "r", "o"})
        self.assertEqual(warnings, [])

    def test_the_url_must_agree_with_the_repository_identity(self):
        for url in (f"https://evil.example/{'owner/repo'}", "https://github.com/other/repo",
                    "http://github.com/owner/repo", "not a url", None):
            with self.subTest(url=url):
                row, warnings = normalize(item(html_url=url))
                self.assertIsNone(row)
                self.assertTrue(warnings)

    def test_repository_names_are_validated(self):
        for name in ("owner", "a/b/c", "", None, "owner/" + "x" * 101, "x" * 40 + "/repo"):
            with self.subTest(name=name):
                self.assertIsNone(normalize(item(name) if isinstance(name, str) else item(full_name=name))[0])

    def test_topics_are_deduplicated_capped_and_ordered(self):
        row, warnings = normalize(item(topics=["LLM", "llm", "a", "b", "c", "d", "e", 5]))
        self.assertEqual(row["t"], ["llm", "a", "b", "c", "d", "e"])
        self.assertEqual(warnings, [])

    def test_a_non_list_topic_field_is_reported_not_fatal(self):
        row, warnings = normalize(item(topics={"a": 1}))
        self.assertEqual(row["t"], [])
        self.assertTrue(any("topics" in warning for warning in warnings))

    def test_owner_type_maps_to_the_org_flag(self):
        self.assertEqual(normalize(item(owner={"login": "openai", "type": "Organization"}))[0]["o"], 1)
        self.assertEqual(normalize(item(owner={"login": "someone", "type": "User"}))[0]["o"], 0)
        self.assertIsNone(normalize(item(owner={"login": "someone"}))[0]["o"])

    def test_a_mismatched_owner_login_is_warned_about(self):
        row, warnings = normalize(item(owner={"login": "someone-else", "type": "User"}))
        self.assertIsNotNone(row)
        self.assertTrue(any("owner.login" in warning for warning in warnings))

    def test_missing_optional_values_become_null(self):
        row, _ = normalize(item(language=None, description=None, pushed_at=None, stargazers_count=None))
        self.assertEqual(row["l"], None)
        self.assertEqual(row["d"], None)
        self.assertEqual(row["p"], None)
        self.assertEqual(row["s"], None)

    def test_fork_and_archived_flags_are_binary(self):
        row, _ = normalize(item(fork=True, archived="yes"))
        self.assertEqual((row["f"], row["r"]), (1, 0))

    def test_long_descriptions_are_cut_to_the_limit(self):
        row, _ = normalize(item(description="x" * 500))
        self.assertEqual(len(row["d"]), cs.DESCRIPTION_LIMIT)

    def test_warnings_are_deduplicated_and_bounded(self):
        warnings: list[str] = []
        for _ in range(5):
            cs.normalize_row({"full_name": "not a valid name"}, warnings)
        self.assertEqual(len(warnings), 1)
        for index in range(cs.WARNING_LIMIT + 60):
            cs.normalize_row({"full_name": f"o/r{index}", "html_url": "https://evil.example/x"},
                             warnings)
        self.assertEqual(len(warnings), cs.WARNING_LIMIT + 1)
        self.assertEqual(warnings[-1], "更多告警已省略")
        self.assertEqual(warnings.count("更多告警已省略"), 1)


class GraphTests(unittest.TestCase):
    def test_fixture_normalizes_without_warnings(self):
        warnings = []
        published = [cs.normalize_row(entry, warnings) for entry in fixture_items()]
        self.assertEqual(warnings, [])
        self.assertTrue(all(entry is not None for entry in published))

    def test_clusters_partition_every_repository(self):
        published = [row for row in (cs.normalize_row(entry, []) for entry in fixture_items()) if row]
        graph = cs.build_graph(published, at())
        self.assertEqual(sum(cluster["repos"] for cluster in graph["clusters"]), len(published))
        self.assertEqual(graph["stats"]["total"], len(published))

    def test_language_wins_over_topics_and_owner(self):
        published = rows(("a/one", {"l": "Rust", "t": ["llm", "agent"], "o": 1}),
                         ("a/two", {"l": "Rust", "t": ["llm"]}))
        graph = cs.build_graph(published, at())
        self.assertEqual([c["id"] for c in graph["clusters"] if c["repos"]], ["lang:Rust"])

    def test_a_row_without_a_language_uses_its_densest_kept_topic(self):
        popular = rows(*[(f"p{i}/r", {"l": None, "t": ["llm"]}) for i in range(10)])
        niche = rows(*[(f"n{i}/r", {"l": None, "t": ["agent"]}) for i in range(cs.TOPIC_MIN_REPOS)])
        probe = rows(("z/probe", {"l": None, "t": ["agent", "llm"]}))
        graph = cs.build_graph(popular + niche + probe, at())
        by_id = {cluster["id"]: cluster for cluster in graph["clusters"]}
        self.assertEqual(by_id["topic:llm"]["repos"], 11)
        self.assertEqual(by_id["topic:agent"]["repos"], cs.TOPIC_MIN_REPOS)
        self.assertEqual(by_id["topic:agent"]["appears"], cs.TOPIC_MIN_REPOS + 1)
        self.assertEqual(by_id[cs.UNKNOWN_CLUSTER]["repos"], 0)
        self.assertEqual(by_id[cs.UNKNOWN_CLUSTER]["appears"], 19)

    def test_a_rare_language_still_outranks_a_dense_topic(self):
        published = rows(*[(f"o{i}/r", {"l": None, "t": ["llm"]}) for i in range(cs.TOPIC_MIN_REPOS)])
        published += rows(("solo/repo", {"l": "Zig", "t": ["llm"]}))
        graph = cs.build_graph(published, at())
        by_id = {cluster["id"]: cluster for cluster in graph["clusters"]}
        self.assertEqual(by_id["lang:Zig"]["repos"], 1)
        self.assertEqual(by_id["topic:llm"]["repos"], cs.TOPIC_MIN_REPOS)
        self.assertEqual(by_id["topic:llm"]["appears"], cs.TOPIC_MIN_REPOS + 1)

    def test_a_row_without_any_cluster_lands_in_the_unknown_bucket(self):
        published = rows(("solo/repo", {"l": None, "t": [], "o": 0}))
        graph = cs.build_graph(published, at())
        by_id = {cluster["id"]: cluster for cluster in graph["clusters"]}
        self.assertEqual(by_id[cs.UNKNOWN_CLUSTER]["repos"], 1)
        self.assertEqual(by_id[cs.UNKNOWN_CLUSTER]["appears"], 1)

    def test_topics_below_the_threshold_are_not_nodes(self):
        published = rows(*[(f"o{i}/r", {"l": None, "t": ["niche"]}) for i in range(cs.TOPIC_MIN_REPOS - 1)])
        graph = cs.build_graph(published, at())
        self.assertNotIn("topic:niche", [cluster["id"] for cluster in graph["clusters"]])

    def test_topic_nodes_are_capped_at_the_node_budget(self):
        published = []
        for index in range(cs.TOPIC_NODES + 5):
            for repeat in range(cs.TOPIC_MIN_REPOS):
                published.append(rows((f"o{index}/r{repeat}", {"l": None, "t": [f"t{index:03d}"]}))[0])
        graph = cs.build_graph(published, at())
        topics = [cluster for cluster in graph["clusters"] if cluster["type"] == "topic"]
        self.assertEqual(len(topics), cs.TOPIC_NODES)

    def test_owners_below_the_threshold_are_not_nodes(self):
        published = rows(*[(f"big0/r{i}", {"l": None, "t": []}) for i in range(cs.OWNER_MIN_REPOS - 1)])
        graph = cs.build_graph(published, at())
        self.assertNotIn("owner:big0", [cluster["id"] for cluster in graph["clusters"]])

    def test_an_owner_node_absorbs_rows_without_language_or_topic(self):
        published = rows(*[(f"big0/r{i}", {"l": None, "t": []}) for i in range(cs.OWNER_MIN_REPOS)])
        graph = cs.build_graph(published, at())
        by_id = {cluster["id"]: cluster for cluster in graph["clusters"]}
        self.assertEqual(by_id["owner:big0"]["repos"], cs.OWNER_MIN_REPOS)
        self.assertEqual(by_id[cs.UNKNOWN_CLUSTER]["repos"], 0)

    def test_owner_nodes_are_capped(self):
        published = []
        for index in range(cs.OWNER_NODES + 5):
            for repeat in range(cs.OWNER_MIN_REPOS):
                published.append(rows((f"o{index:03d}/r{repeat}", {"l": None, "t": []}))[0])
        graph = cs.build_graph(published, at())
        owners = [cluster for cluster in graph["clusters"] if cluster["type"] == "owner"]
        self.assertEqual(len(owners), cs.OWNER_NODES)

    def test_representatives_are_ordered_by_stars_then_name_and_capped(self):
        published = rows(*[(f"o/r{i}", {"s": i}) for i in range(1, cs.CLUSTER_REPS + 4)])
        graph = cs.build_graph(published, at())
        cluster = next(c for c in graph["clusters"] if c["id"] == "lang:Python")
        self.assertEqual(len(cluster["reps"]), cs.CLUSTER_REPS)
        self.assertEqual([rep["n"] for rep in cluster["reps"]],
                         [f"o/r{i}" for i in range(cs.CLUSTER_REPS + 3, 3, -1)])

    def test_clusters_are_sorted_by_size_then_id(self):
        published = rows(("a/one", {"l": "Rust"}), ("a/two", {"l": "Rust"}), ("b/three", {"l": "Zig"}))
        graph = cs.build_graph(published, at())
        self.assertEqual([c["id"] for c in graph["clusters"]], ["lang:Rust", "lang:Zig"])

    def test_edges_are_symmetric_and_thresholded(self):
        count = max(cs.COOCCUR_MIN, cs.TOPIC_MIN_REPOS)
        published = rows(*[(f"o{i}/r", {"l": "Python", "t": ["llm"], "o": 1}) for i in range(count)])
        graph = cs.build_graph(published, at())
        edges = {tuple(sorted((edge["a"], edge["b"]))) for edge in graph["edges"]}
        self.assertIn(tuple(sorted(("lang:Python", "topic:llm"))), edges)
        self.assertTrue(all(edge["a"] < edge["b"] for edge in graph["edges"]))
        self.assertTrue(all(edge["w"] >= cs.COOCCUR_MIN for edge in graph["edges"]))
        self.assertEqual({(edge["a"], edge["b"], edge["w"]) for edge in graph["edges"]},
                         {("lang:Python", "topic:llm", count)})

    def test_an_owner_links_to_the_language_its_repositories_use(self):
        count = max(cs.COOCCUR_MIN, cs.OWNER_MIN_REPOS)
        published = rows(*[(f"big/r{i}", {"l": "Python", "t": []}) for i in range(count)])
        edges = cs.build_graph(published, at())["edges"]
        self.assertEqual([(edge["a"], edge["b"], edge["w"]) for edge in edges],
                         [("lang:Python", "owner:big", count)])

    def test_edges_below_the_threshold_are_dropped(self):
        published = rows(("a/one", {"l": "Rust", "t": ["niche"]}), ("b/two", {"l": "Zig"}))
        self.assertEqual(cs.build_graph(published, at())["edges"], [])

    def test_the_graph_is_deterministic_for_the_same_input(self):
        published = [row for row in (cs.normalize_row(entry, []) for entry in fixture_items()) if row]
        first = json.dumps(cs.build_graph(published, at()), sort_keys=True)
        second = json.dumps(cs.build_graph(list(reversed(published)), at()), sort_keys=True)
        self.assertEqual(first, second)

    def test_unknown_stars_sort_last_in_representatives(self):
        published = rows(("a/none", {"s": None}), ("a/ten", {"s": 10}))
        cluster = next(c for c in cs.build_graph(published, at())["clusters"] if c["id"] == "lang:Python")
        self.assertEqual([rep["n"] for rep in cluster["reps"]], ["a/ten", "a/none"])


class StatsTests(unittest.TestCase):
    def test_counts_cover_languages_topics_owners_and_flags(self):
        published = rows(("a/one", {"l": "Rust", "t": ["llm"], "o": 1, "r": 1, "f": 1}),
                         ("a/two", {"l": "Rust", "t": ["llm", "agent"]}),
                         ("b/three", {"l": None, "d": None}))
        stats = cs.summarize(published, at())
        self.assertEqual(stats["total"], 3)
        self.assertEqual(stats["languages"], 1)
        self.assertEqual(stats["topics"], 2)
        self.assertEqual(stats["owners"], 2)
        self.assertEqual((stats["org_owned"], stats["archived"], stats["forks"]), (1, 1, 1))
        self.assertEqual(stats["undocumented"], 1)

    def test_activity_window_is_exactly_ninety_days(self):
        floor = (at().date() - dt.timedelta(days=90)).isoformat()
        older = (at().date() - dt.timedelta(days=91)).isoformat()
        published = rows(("a/edge", {"p": floor}), ("a/old", {"p": older}), ("a/none", {"p": None}))
        self.assertEqual(cs.summarize(published, at())["active_90d"], 1)

    def test_unknown_push_dates_do_not_count_as_active(self):
        published = rows(("a/one", {"p": None}))
        self.assertEqual(cs.summarize(published, at())["active_90d"], 0)


class ChangeTests(unittest.TestCase):
    def test_the_first_capture_is_marked_initial(self):
        changes = cs.compare_rows(None, rows(("a/one",)))
        self.assertEqual(changes["status"], "initial")
        self.assertEqual((changes["added_count"], changes["removed_count"]), (0, 0))

    def test_added_and_removed_are_computed_by_repository_name(self):
        before = rows(("a/one",), ("a/two",))
        after = rows(("a/two",), ("a/three",))
        changes = cs.compare_rows(before, after)
        self.assertEqual(changes["status"], "compared")
        self.assertEqual(changes["added"], ["a/three"])
        self.assertEqual(changes["removed"], ["a/one"])
        self.assertFalse(changes["truncated"])

    def test_lists_are_capped_but_counts_are_not(self):
        before = rows(*[(f"o/r{i}",) for i in range(cs.CHANGE_LIMIT + 5)])
        changes = cs.compare_rows(before, [])
        self.assertEqual(changes["removed_count"], cs.CHANGE_LIMIT + 5)
        self.assertEqual(len(changes["removed"]), cs.CHANGE_LIMIT)
        self.assertTrue(changes["truncated"])

    def test_a_repeated_run_reports_no_changes(self):
        published = rows(("a/one",), ("a/two",))
        self.assertEqual(cs.compare_rows(published, published)["status"], "compared")
        self.assertEqual(cs.compare_rows(published, published)["added_count"], 0)


class PaginationTests(unittest.TestCase):
    def test_pages_are_joined_until_a_page_runs_short(self):
        full = [item(f"a/r{i}") for i in range(cs.PER_PAGE)]
        getter = page_getter({1: full, 2: [item("b/one"), item("b/two")]})
        published, pages = cs.fetch_rows("isLinXu", {}, getter=getter)
        self.assertEqual(pages, 2)
        self.assertEqual(len(getter.calls), 2)
        self.assertEqual(len(published), cs.PER_PAGE + 2)

    def test_a_list_that_ends_on_a_full_page_asks_once_more(self):
        full = [item(f"a/r{i}") for i in range(cs.PER_PAGE)]
        getter = page_getter({1: full, 2: []})
        published, pages = cs.fetch_rows("isLinXu", {}, getter=getter)
        self.assertEqual(pages, 2)
        self.assertEqual(len(published), cs.PER_PAGE)

    def test_a_short_page_ends_the_walk_without_an_extra_request(self):
        page = [item(f"a/r{i}") for i in range(cs.PER_PAGE)]
        getter = page_getter({1: page, 2: [item("a/tail")]})
        published, pages = cs.fetch_rows("isLinXu", {}, getter=getter)
        self.assertEqual(pages, 2)
        self.assertEqual(len(getter.calls), 2)
        self.assertEqual(len(published), cs.PER_PAGE + 1)

    def test_duplicates_across_pages_are_dropped(self):
        first = [item(f"a/r{i}") for i in range(cs.PER_PAGE)]
        second = [item("a/r0")] + [item(f"b/r{i}") for i in range(cs.PER_PAGE - 1)]
        getter = page_getter({1: first, 2: second, 3: [item("c/tail")]})
        published, pages = cs.fetch_rows("isLinXu", {}, getter=getter)
        self.assertEqual(pages, 3)
        self.assertEqual(len(published), 2 * cs.PER_PAGE)
        self.assertEqual(len({row["n"] for row in published}), len(published))

    def test_rows_are_sorted_by_repository_name(self):
        getter = page_getter({1: [item("zeta/z"), item("alpha/a")], 2: []})
        published, _ = cs.fetch_rows("isLinXu", {}, getter=getter)
        self.assertEqual([row["n"] for row in published], ["alpha/a", "zeta/z"])

    def test_exceeding_the_page_budget_refuses_a_partial_list(self):
        page = [item(f"a/r{i}") for i in range(cs.PER_PAGE)]
        getter = page_getter({index: page for index in range(1, 4)})
        with self.assertRaises(cs.StarError) as caught:
            cs.fetch_rows("isLinXu", {}, max_pages=3, getter=getter)
        self.assertEqual(caught.exception.code, "pages")

    def test_an_unexpected_payload_shape_raises(self):
        with self.assertRaises(cs.StarError) as caught:
            cs.fetch_rows("isLinXu", {}, getter=lambda url, *, headers=None: {"message": "x"})
        self.assertEqual(caught.exception.code, "schema")

    def test_invalid_entries_are_skipped_during_the_walk(self):
        getter = page_getter({1: [item("a/one"), {"full_name": "broken"},
                                  item("a/two", html_url="https://evil.example/a/two"), 7],
                              2: []})
        warnings = []
        published, _ = cs.fetch_rows("isLinXu", {}, getter=getter, warnings=warnings)
        self.assertEqual([row["n"] for row in published], ["a/one"])
        self.assertEqual(len(warnings), 3)


class LinkHeaderTests(unittest.TestCase):
    def test_the_last_link_page_is_the_authoritative_count(self):
        header = ('<https://api.github.com/user/1/starred?per_page=1&page=2>; rel="next", '
                  '<https://api.github.com/user/1/starred?per_page=1&page=5125>; rel="last"')
        self.assertEqual(cs.parse_last_page(header), 5125)

    def test_a_single_page_has_no_last_link(self):
        self.assertIsNone(cs.parse_last_page('<https://api.github.com/x?per_page=1>; rel="self"'))
        self.assertIsNone(cs.parse_last_page(None))

    def test_probe_total_falls_back_to_the_body_when_unpaginated(self):
        total = cs.probe_total("isLinXu", {}, opener=opener_for([item("a/one")]))
        self.assertEqual(total, 1)

    def test_probe_total_reads_the_link_header(self):
        header = '<https://api.github.com/x?per_page=1&page=5125>; rel="last"'
        total = cs.probe_total("isLinXu", {}, opener=opener_for([item("a/one")], {"Link": header}))
        self.assertEqual(total, 5125)

    def test_probe_total_rejects_a_non_list_payload(self):
        with self.assertRaises(cs.StarError):
            cs.probe_total("isLinXu", {}, opener=opener_for({"message": "oops"}))


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.token = {"Authorization": "Bearer secret-token"}

    def published_fixture_rows(self):
        return [row for row in (cs.normalize_row(entry, []) for entry in fixture_items()) if row]

    def successful_publish(self):
        items = fixture_items()
        header = f'<https://api.github.com/x?per_page=1&page={len(items)}>; rel="last"'
        return cs.publish(self.dir, at(), login="isLinXu", headers=self.token,
                          getter=page_getter({1: items}), opener=opener_for([items[0]], {"Link": header}))

    def test_a_successful_run_writes_three_files(self):
        self.assertEqual(self.successful_publish(), "ok")
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        detail = json.loads((self.dir / "stars_repos.json").read_text(encoding="utf-8"))
        history = json.loads((self.dir / "stars_history.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["status"], "ok")
        self.assertEqual(graph["captured_at"], "2026-11-01T04:00:00Z")
        self.assertEqual(graph["counts"]["total"], len(self.published_fixture_rows()))
        self.assertEqual(detail["count"], len(detail["rows"]))
        self.assertEqual(history["snapshots"][0]["date"], "2026-11-01")
        self.assertEqual(graph["changes"]["status"], "initial")

    def test_every_detail_row_carries_a_cluster_from_the_snapshot(self):
        self.successful_publish()
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        detail = json.loads((self.dir / "stars_repos.json").read_text(encoding="utf-8"))
        by_cluster = {}
        for row in detail["rows"]:
            self.assertEqual(set(row), {"n", "l", "t", "s", "d", "p", "f", "r", "o", "c"})
            by_cluster[row["c"]] = by_cluster.get(row["c"], 0) + 1
        # The wall colours cells with these ids, so both views must agree exactly.
        self.assertEqual(by_cluster,
                         {cluster["id"]: cluster["repos"] for cluster in graph["clusters"] if cluster["repos"]})

    def test_the_published_snapshot_never_mentions_the_token(self):
        self.successful_publish()
        for name in ("stars.json", "stars_repos.json", "stars_history.json"):
            with self.subTest(name=name):
                self.assertNotIn("secret-token", (self.dir / name).read_text(encoding="utf-8"))

    def test_without_a_token_the_panel_reports_unavailable(self):
        with patch.dict(os.environ, {}, clear=True):
            status = cs.publish(self.dir, at(), login="isLinXu")
        self.assertEqual(status, "unavailable")
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["error"], cs.ERROR_MESSAGES["token"])
        self.assertEqual(graph["clusters"], [])
        self.assertFalse((self.dir / "stars_repos.json").exists())

    def test_a_failure_keeps_the_last_good_graph_and_detail(self):
        self.successful_publish()
        before = (self.dir / "stars_repos.json").read_bytes()
        history_before = json.loads((self.dir / "stars_history.json").read_text(encoding="utf-8"))
        status = cs.publish(self.dir, at(hour=9), login="isLinXu", headers=self.token,
                            getter=page_getter({}), opener=opener_for([], {}))
        self.assertEqual(status, "stale")
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["status"], "stale")
        self.assertEqual(graph["error"], cs.ERROR_MESSAGES["empty"])
        self.assertTrue(graph["clusters"])
        self.assertEqual(graph["captured_at"], "2026-11-01T04:00:00Z")
        self.assertEqual(graph["last_attempt_at"], "2026-11-01T09:00:00Z")
        self.assertEqual((self.dir / "stars_repos.json").read_bytes(), before)
        self.assertEqual(json.loads((self.dir / "stars_history.json").read_text()), history_before)

    def test_a_count_mismatch_is_refused_instead_of_publishing_half_a_list(self):
        items = fixture_items()
        header = '<https://api.github.com/x?per_page=1&page=900>; rel="last"'
        status = cs.publish(self.dir, at(), login="isLinXu", headers=self.token,
                            getter=page_getter({1: items}), opener=opener_for([items[0]], {"Link": header}))
        self.assertEqual(status, "unavailable")
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["error"], cs.ERROR_MESSAGES["count"])

    def test_a_second_run_same_day_replaces_the_snapshot(self):
        self.successful_publish()
        self.successful_publish()
        history = json.loads((self.dir / "stars_history.json").read_text(encoding="utf-8"))
        self.assertEqual(len(history["snapshots"]), 1)
        self.assertEqual(history["snapshots"][0]["captured_at"], "2026-11-01T04:00:00Z")

    def test_the_next_day_records_added_and_removed_stars(self):
        self.successful_publish()
        items = fixture_items()
        removed = items.pop(0)
        added = item("newest/repo", stargazers_count=1)
        items.append(added)
        header = f'<https://api.github.com/x?per_page=1&page={len(items)}>; rel="last"'
        cs.publish(self.dir, at(day="2026-11-02"), login="isLinXu", headers=self.token,
                   getter=page_getter({1: items}), opener=opener_for([items[0]], {"Link": header}))
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["changes"]["added"], [added["full_name"]])
        self.assertEqual(graph["changes"]["removed"], [removed["full_name"]])
        history = json.loads((self.dir / "stars_history.json").read_text(encoding="utf-8"))
        self.assertEqual([snap["date"] for snap in history["snapshots"]], ["2026-11-01", "2026-11-02"])
        self.assertEqual(history["snapshots"][1]["added"], 1)
        self.assertEqual(history["snapshots"][1]["removed"], 1)

    def test_a_stale_snapshot_is_compared_against_the_preserved_rows(self):
        self.successful_publish()
        cs.publish(self.dir, at(hour=9), login="isLinXu", headers=self.token,
                   getter=page_getter({}), opener=opener_for([], {}))
        items = fixture_items()[1:]
        header = f'<https://api.github.com/x?per_page=1&page={len(items)}>; rel="last"'
        cs.publish(self.dir, at(day="2026-11-02"), login="isLinXu", headers=self.token,
                   getter=page_getter({1: items}), opener=opener_for([items[0]], {"Link": header}))
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["status"], "ok")
        self.assertEqual(graph["changes"]["removed_count"], 1)

    def test_an_older_capture_time_is_rejected_without_writing(self):
        self.successful_publish()
        before = (self.dir / "stars.json").read_bytes()
        status = cs.publish(self.dir, at(day="2026-10-31"), login="isLinXu", headers=self.token,
                            getter=page_getter({1: fixture_items()}),
                            opener=opener_for([item("a/one")], {}))
        self.assertEqual(status, "rejected")
        self.assertEqual((self.dir / "stars.json").read_bytes(), before)

    def test_a_corrupted_previous_file_degrades_instead_of_crashing(self):
        (self.dir / "stars.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(self.successful_publish(), "ok")

    def test_a_mismatched_detail_schema_is_ignored_for_the_diff(self):
        (self.dir / "stars_repos.json").write_text('{"schema_version": 99, "rows": []}', encoding="utf-8")
        self.successful_publish()
        graph = json.loads((self.dir / "stars.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["changes"]["status"], "initial")

    def test_history_is_capped_at_the_retention_window(self):
        oldest = (at().date() - dt.timedelta(days=cs.HISTORY_RETENTION_DAYS + 40)).isoformat()
        kept = (at().date() - dt.timedelta(days=cs.HISTORY_RETENTION_DAYS)).isoformat()
        (self.dir / "stars_history.json").write_text(json.dumps(
            {"schema_version": 1, "snapshots": [{"date": oldest}, {"date": kept}]}), encoding="utf-8")
        history = cs.history_snapshot(json.loads((self.dir / "stars_history.json").read_text()),
                                      cs.summarize(self.published_fixture_rows(), at()),
                                      cs.compare_rows(None, self.published_fixture_rows()), at())
        self.assertEqual([snap["date"] for snap in history["snapshots"]], [kept, "2026-11-01"])

    def test_a_network_failure_writes_the_sanitized_reason(self):
        getter = Mock(side_effect=urllib.error.URLError("token=secret"))
        status = cs.publish(self.dir, at(), login="isLinXu", headers=self.token,
                            getter=getter, opener=opener_for([item("a/one")], {}))
        self.assertEqual(status, "unavailable")
        text = (self.dir / "stars.json").read_text(encoding="utf-8")
        self.assertNotIn("secret", text)
        self.assertEqual(json.loads(text)["error"], "无法访问 GitHub API。")


class BuildTests(unittest.TestCase):
    def test_star_snapshots_are_optional_and_copied_when_present(self):
        from scripts import build

        names = ("stars.json", "stars_repos.json", "stars_history.json")
        for present in (False, True):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "site").mkdir()
                (root / "data").mkdir()
                (root / "site" / "index.html").write_text("test")
                for name in ("latest.json", "history.json"):
                    (root / "data" / name).write_text("{}")
                if present:
                    for name in names:
                        (root / "data" / name).write_text('{"schema_version":1}')
                with patch.object(build, "ROOT", root), patch.object(build, "SITE", root / "site"), \
                        patch.object(build, "OUTPUT", root / "output"), patch("sys.stdout", new_callable=io.StringIO):
                    build.build()
                for name in names:
                    destination = root / "output" / "data" / name
                    with self.subTest(name=name):
                        self.assertEqual(destination.exists(), present)
                        if present:
                            self.assertEqual(destination.read_bytes(), (root / "data" / name).read_bytes())


if __name__ == "__main__":
    unittest.main()
