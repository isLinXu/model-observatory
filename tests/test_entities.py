import datetime as dt
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import collect_entities as ce


def at(day="2026-11-02", hour=2, minute=23):
    return dt.datetime.fromisoformat(f"{day}T{hour:02}:{minute:02}:00+00:00")


def link(domain, ident, state="unchecked", url=None):
    return {"domain": domain, "id": ident, "state": state, "url": url}


def entry(slug, links=(), **fields):
    value = {"slug": slug, "title": slug, "kind": "project", "stage": "training",
             "tags": [], "updated": None, "links": [dict(item) for item in links],
             "bytes": 10, "lines": 1, "sha256": "sha-" + slug, "truncated": False,
             "url": f"https://github.com/o/r/blob/main/entities/{slug}.md", "body": "正文"}
    value.update(fields)
    return value


def frontmatter(title="示例", links=None, kind="project", stage="training", **fields):
    lines = ["---", f"title: {title}", f"kind: {kind}", f"stage: {stage}"]
    for key, value in fields.items():
        lines.append(f"{key}: {value}")
    if links is not None:
        lines.append("links:")
        lines.extend(f"  - {item}" for item in links)
    lines.extend(["---", "", "正文内容"])
    return "\n".join(lines)


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
    return ce.load_sources(data_dir(root, **(files or SNAPSHOT)), warnings), warnings


SNAPSHOT = {
    "latest": {
        "captured_at": "2026-11-01T00:00:00Z",
        "models": [{"id": "gatilin/Alpha", "url": "https://huggingface.co/gatilin/Alpha"},
                   {"id": "gatilin/Beta", "url": None}],
        "datasets": [{"id": "gatilin/Corpus", "url": "https://huggingface.co/datasets/gatilin/Corpus"}],
        "collections": {"status": "ok", "captured_at": "2026-10-31T23:00:00Z",
                        "items": [{"slug": "gatilin/nano-vlm-6add", "name": "nanoVLM factory"}]},
    },
    "modelscope": {"captured_at": "2026-11-01T00:00:05Z",
                   "models": [{"id": "isLinXu/Alpha-ms", "url": "https://modelscope.cn/models/isLinXu/Alpha-ms"}]},
    "github": {"captured_at": "2026-11-01T00:00:06Z", "account": {"login": "IsLinXu"},
               "repositories": [{"full_name": "isLinXu/One", "is_fork": False},
                                {"full_name": "isLinXu/OldFork", "is_fork": True},
                                {"full_name": "huggingface/Other", "is_fork": False}]},
    "scholar": {"captured_at": "2026-11-01T00:00:07Z",
                "papers": [{"title": "MME: A Comprehensive Evaluation of Multimodal LLMs",
                            "url": "https://example.edu/mme"},
                           {"title": "Youtu-LLM", "url": "https://example.edu/youtu"}]},
    "conferences": {"captured_at": "2026-11-01T00:00:08Z",
                    "conferences": [{"key": "cvpr", "editions": [
                        {"year": 2026, "date": "2026-06-06", "url": "https://cvpr2026.thecvf.com"},
                        {"year": 2027, "date": "2027-06-06", "url": "https://cvpr2027.thecvf.com"}]}]},
    "templates": {"captured_at": "2026-11-01T00:00:09Z",
                  "templates": [{"id": "skill/review", "url": "https://github.com/o/r/blob/main/x.md"}]},
}


class ScholarAliasTest(unittest.TestCase):
    def test_uses_the_phrase_before_the_first_colon(self):
        self.assertEqual(ce.scholar_alias("MME: A Comprehensive Evaluation"), "mme")
        self.assertEqual(ce.scholar_alias("MME：多模态评测基准"), "mme")

    def test_falls_back_to_the_first_five_words(self):
        self.assertEqual(ce.scholar_alias("Youtu-LLM"), "youtu-llm")
        self.assertEqual(ce.scholar_alias("one two three four five six"), "one-two-three-four-five")

    def test_folds_punctuation_and_handles_empty_titles(self):
        self.assertEqual(ce.scholar_alias("  Youtu, LLM!!  "), "youtu-llm")
        self.assertEqual(ce.scholar_alias(None), "")
        self.assertEqual(ce.scholar_alias("!!!"), "")


class SourceTest(unittest.TestCase):
    def sources(self, root, **files):
        warnings = []
        payload = files or SNAPSHOT
        return ce.load_sources(data_dir(Path(root), **payload), warnings), warnings

    def test_reads_models_datasets_and_collections(self):
        with tempfile.TemporaryDirectory() as tmp:
            sources, warnings = self.sources(tmp)
            self.assertEqual(sorted(sources["hf_model"]["ids"]), ["gatilin/Alpha", "gatilin/Beta"])
            self.assertEqual(sources["hf_dataset"]["ids"]["gatilin/Corpus"],
                             "https://huggingface.co/datasets/gatilin/Corpus")
            self.assertEqual(sources["hf_collection"]["ids"],
                             {"gatilin/nano-vlm-6add":
                              "https://huggingface.co/collections/gatilin/nano-vlm-6add"})
            self.assertEqual(sources["hf_collection"]["captured_at"], "2026-10-31T23:00:00Z")
            self.assertEqual(warnings, [])

    def test_a_missing_snapshot_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as tmp:
            sources, _ = self.sources(tmp, modelscope=SNAPSHOT["modelscope"])
            for domain in ("hf_model", "hf_dataset", "hf_collection", "template", "conf"):
                self.assertFalse(sources[domain]["available"], domain)
                self.assertIsNone(sources[domain]["captured_at"], domain)
            self.assertIn("不可用", sources["template"]["reason"])
            self.assertIn("缺失", sources["hf_collection"]["reason"])
            self.assertTrue(sources["ms_model"]["available"])

    def test_an_unavailable_collection_block_does_not_look_usable(self):
        with tempfile.TemporaryDirectory() as tmp:
            latest = dict(SNAPSHOT["latest"],
                          collections={"status": "unavailable", "items": []})
            sources, _ = self.sources(tmp, latest=latest)
            self.assertFalse(sources["hf_collection"]["available"])
            self.assertIn("unavailable", sources["hf_collection"]["reason"])

    def test_github_own_repos_drop_forks_and_other_peoples_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            sources, _ = self.sources(tmp)
            github = sources["gh_repo"]
            self.assertEqual(github["own"], {"isLinXu/One"})
            self.assertEqual(github["login"], "islinxu")
            # A fork and a foreign row are still real repositories the snapshot
            # lists, so a link to them may resolve - they are just not our output.
            self.assertIn("isLinXu/OldFork", github["ids"])
            self.assertIn("huggingface/Other", github["ids"])

    def test_an_account_without_a_login_keeps_the_non_fork_universe(self):
        """Losing the login must not quietly zero the coverage denominator."""
        with tempfile.TemporaryDirectory() as tmp:
            github = {"captured_at": "x", "account": {},
                      "repositories": [{"full_name": "someone/Else", "is_fork": False}]}
            sources, _ = self.sources(tmp, github=github)
            self.assertEqual(sources["gh_repo"]["own"], {"someone/Else"})

    def test_two_papers_sharing_an_alias_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            scholar = {"captured_at": "x", "papers": [
                {"title": "Same: first", "url": "https://example.edu/1"},
                {"title": "SAME: second", "url": "https://example.edu/2"}]}
            sources, warnings = self.sources(tmp, scholar=scholar)
            self.assertEqual(sources["scholar"]["ids"], {"same": "https://example.edu/1"})
            self.assertIn("别名相同", warnings[0])

    def test_scholar_without_a_url_still_counts_as_an_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            scholar = {"captured_at": "x", "papers": [{"title": "No Link Paper"}]}
            sources, _ = self.sources(tmp, scholar=scholar)
            self.assertTrue(sources["scholar"]["available"])
            self.assertIsNone(sources["scholar"]["ids"]["no-link-paper"])

    def test_conference_links_point_at_the_latest_edition(self):
        with tempfile.TemporaryDirectory() as tmp:
            sources, _ = self.sources(tmp)
            self.assertEqual(sources["conf"]["ids"]["cvpr"], "https://cvpr2027.thecvf.com")

    def test_spaces_have_no_source_yet(self):
        with tempfile.TemporaryDirectory() as tmp:
            sources, _ = self.sources(tmp)
            self.assertFalse(sources["hf_space"]["available"])
            self.assertIsNone(sources["hf_space"]["file"])
            self.assertIn("无法核对", sources["hf_space"]["reason"])

    def test_a_stale_github_snapshot_is_still_usable(self):
        with tempfile.TemporaryDirectory() as tmp:
            github = dict(SNAPSHOT["github"], status="stale")
            sources, _ = self.sources(tmp, github=github)
            self.assertTrue(sources["gh_repo"]["available"])


class ClassifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sources = sources(self.tmp.name)[0]

    def check(self, entries):
        return ce.classify(entries, self.sources)

    def test_a_target_seen_in_a_snapshot_resolves_with_its_url(self):
        rows = [entry("a", [link("hf_model", "gatilin/Alpha")])]
        self.assertEqual(self.check(rows)["resolved"], 1)
        self.assertEqual(rows[0]["links"][0]["url"], "https://huggingface.co/gatilin/Alpha")

    def test_resolved_also_means_a_target_we_cannot_link_to(self):
        rows = [entry("a", [link("hf_model", "gatilin/Beta")])]
        self.assertEqual(self.check(rows)["resolved"], 1)
        self.assertIsNone(rows[0]["links"][0]["url"])

    def test_a_target_the_source_answered_about_is_a_broken_link(self):
        rows = [entry("a", [link("hf_model", "gatilin/Gone")])]
        self.assertEqual(self.check(rows)["unresolved"], 1)
        self.assertIsNone(rows[0]["links"][0]["url"])

    def test_a_missing_source_never_becomes_a_broken_link(self):
        """Reporting a capture failure as a dead link trains readers to ignore the board."""
        rows = [entry("a", [link("scholar", "mme"), link("hf_space", "gatilin/Demo")])]
        silent = {"scholar": dict(self.sources["scholar"], available=False)}
        with patch.dict(self.sources, silent):
            counts = self.check(rows)
        self.assertEqual((counts["unresolved"], counts["unchecked"]), (0, 2))

    def test_a_foreign_repository_is_out_of_scope(self):
        rows = [entry("a", [link("gh_repo", "huggingface/nanoVLM")])]
        self.assertEqual(self.check(rows)["out_of_scope"], 1)

    def test_without_a_login_nothing_is_called_someone_elses(self):
        """A partial GitHub snapshot may not brand our own repository as foreign."""
        rows = [entry("a", [link("gh_repo", "isLinXu/One")])]
        with patch.dict(self.sources["gh_repo"], {"login": ""}):
            counts = self.check(rows)
        self.assertEqual((counts["resolved"], counts["out_of_scope"]), (1, 0))

    def test_github_ids_do_not_care_about_case(self):
        rows = [entry("a", [link("gh_repo", "islinxu/one"), link("gh_repo", "IsLinXu/ONE")])]
        counts = self.check(rows)
        self.assertEqual((counts["resolved"], counts["out_of_scope"]), (2, 0))
        # The published id keeps the casing the snapshot used, so the board links
        # to the canonical repository and coverage counts it once.
        self.assertEqual([item["id"] for item in rows[0]["links"]], ["isLinXu/One"] * 2)

    def test_a_hugging_face_id_keeps_the_published_casing(self):
        rows = [entry("a", [link("hf_model", "gatilin/alpha")])]
        self.assertEqual(self.check(rows)["unresolved"], 1)

    def test_every_link_lands_in_one_of_four_states(self):
        rows = [entry("a", [link("hf_model", "gatilin/Alpha"), link("hf_model", "gatilin/Gone"),
                            link("gh_repo", "someone/else"), link("hf_space", "gatilin/Demo")])]
        counts = self.check(rows)
        self.assertEqual(sum(counts.values()), 4)
        self.assertEqual(sorted(counts), sorted(ce.STATES))


class CoverageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sources = sources(self.tmp.name)[0]

    def test_counts_only_our_own_published_output(self):
        rows = [entry("a", [link("hf_model", "gatilin/Alpha"), link("gh_repo", "isLinXu/One")])]
        ce.classify(rows, self.sources)
        stats = ce.coverage(rows, self.sources)
        self.assertEqual((stats["hf_model"]["total"], stats["hf_model"]["registered"]), (2, 1))
        # Neither a fork nor another owner's repository inflates the denominator.
        self.assertEqual((stats["gh_repo"]["total"], stats["gh_repo"]["registered"]), (1, 1))
        self.assertEqual(stats["hf_model"]["unregistered"], ["gatilin/Beta"])
        self.assertEqual(stats["gh_repo"]["unregistered"], [])

    def test_a_republished_id_still_counts_as_registered(self):
        rows = [entry("a", [link("gh_repo", "ISLINXU/one")])]
        ce.classify(rows, self.sources)
        self.assertEqual(ce.coverage(rows, self.sources)["gh_repo"]["registered"], 1)

    def test_an_unresolved_link_is_not_registered(self):
        rows = [entry("a", [link("hf_model", "gatilin/Gone")])]
        ce.classify(rows, self.sources)
        self.assertEqual(ce.coverage(rows, self.sources)["hf_model"]["registered"], 0)

    def test_the_work_queue_is_a_sample_plus_the_honest_count(self):
        with patch.object(ce, "UNREGISTERED_LIMIT", 1):
            stats = ce.coverage([], self.sources)
        self.assertEqual(stats["ms_model"]["unregistered"], ["isLinXu/Alpha-ms"])
        self.assertEqual(stats["ms_model"]["unregistered_count"], 1)
        self.assertFalse(stats["ms_model"]["truncated"])
        # hf_model has two own models and the registry mentions neither.
        self.assertEqual(stats["hf_model"]["unregistered_count"], 2)
        self.assertTrue(stats["hf_model"]["truncated"])

    def test_only_domains_of_our_own_output_are_covered(self):
        stats = ce.coverage([], self.sources)
        self.assertEqual(sorted(stats), sorted(ce.COVERAGE_DOMAINS))
        for domain in ("hf_space", "conf"):
            self.assertNotIn(domain, stats)

    def test_an_unavailable_source_reports_no_gap(self):
        rows = [entry("a", [link("template", "skill/review")])]
        ce.classify(rows, self.sources)
        with patch.dict(self.sources, {"template": dict(self.sources["template"], available=False)}):
            stats = ce.coverage(rows, self.sources)
        self.assertEqual(stats["template"], {"available": False, "total": 0, "registered": 0,
                                            "unregistered": [], "unregistered_count": 0,
                                            "truncated": False})


class EntryTest(unittest.TestCase):
    def build(self, name, text, warnings=None, errors=None):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        path = root / name
        path.write_text(text, encoding="utf-8")
        return ce.build_entry(path, "o/r", "main",
                              warnings if warnings is not None else [],
                              errors if errors is not None else [])

    def test_frontmatter_becomes_the_published_metadata(self):
        row = self.build("alpha.md", frontmatter("阿尔法", links=["hf_model:gatilin/Alpha"],
                                                 kind="project", stage="evaluating",
                                                 tags="[llm, 后训练]", updated="2026-11-01"))
        self.assertEqual(row["slug"], "alpha")
        self.assertEqual(row["title"], "阿尔法")
        self.assertEqual(row["kind"], "project")
        self.assertEqual(row["stage"], "evaluating")
        self.assertEqual(row["tags"], ["llm", "后训练"])
        self.assertEqual(row["updated"], "2026-11-01")
        self.assertEqual(row["links"][0]["id"], "gatilin/Alpha")
        self.assertEqual(row["url"], "https://github.com/o/r/blob/main/entities/alpha.md")

    def test_a_bad_enum_is_an_error_not_a_silent_default(self):
        errors = []
        row = self.build("alpha.md", frontmatter(kind="modelx", stage="done", updated="11-01"),
                         errors=errors)
        self.assertEqual((row["kind"], row["stage"], row["updated"]), (None, None, None))
        self.assertEqual(len(errors), 3)
        self.assertIn("kind", errors[0])

    def test_a_file_without_frontmatter_is_flagged_and_still_published(self):
        errors = []
        row = self.build("alpha.md", "只有正文", errors=errors)
        self.assertEqual(row["title"], "alpha")
        self.assertEqual(row["body"], "只有正文")
        self.assertTrue(any("front matter" in note for note in errors))

    def test_links_must_be_domain_colon_id(self):
        errors, warnings = [], []
        row = self.build("alpha.md", frontmatter(links=["no-prefix", "wat:x", "hf_model:",
                                                        "hf_model:a", "hf_model:a"]),
                         warnings=warnings, errors=errors)
        self.assertEqual([item["domain"] for item in row["links"]], ["hf_model"])
        self.assertEqual(len(errors), 3)
        self.assertIn("hf_model", errors[2])
        self.assertEqual(warnings, [])

    def test_a_scalar_link_is_accepted(self):
        """An author writes one link on the ``links:`` line, not as a block."""
        row = self.build("alpha.md", "---\ntitle: 单链接\nlinks: hf_model:gatilin/Alpha\n---\n\n正文\n")
        self.assertEqual([(item["domain"], item["id"]) for item in row["links"]],
                         [("hf_model", "gatilin/Alpha")])

    def test_too_many_links_are_counted_and_truncated(self):
        warnings = []
        row = self.build("alpha.md", frontmatter(
            links=[f"hf_model:gatilin/m{i}" for i in range(ce.LINK_LIMIT + 5)]), warnings=warnings)
        self.assertEqual(len(row["links"]), ce.LINK_LIMIT)
        self.assertIn(f"超过 {ce.LINK_LIMIT} 条", warnings[0])

    def test_scholar_links_are_stored_as_their_alias(self):
        row = self.build("alpha.md", frontmatter(links=["scholar:MME: A Comprehensive Evaluation"]))
        self.assertEqual(row["links"][0]["id"], "mme")

    def test_a_long_body_is_cut_but_still_measured_in_full(self):
        with patch.object(ce, "MAX_BODY_CHARS", 40):
            row = self.build("alpha.md", frontmatter() + "x" * 60)
        self.assertTrue(row["truncated"])
        self.assertEqual(len(row["body"]), 40)
        self.assertGreater(row["bytes"], 40)

    def test_titles_and_tags_are_bounded(self):
        row = self.build("alpha.md", frontmatter("长" * 300, tags=[f"t{i}" for i in
                                                                  range(ce.TAG_LIMIT + 3)]))
        self.assertEqual(len(row["title"]), ce.TITLE_LIMIT)
        self.assertEqual(len(row["tags"]), ce.TAG_LIMIT)


class RegistryTest(unittest.TestCase):
    def write(self, root, name, text):
        (root / name).write_text(text, encoding="utf-8")

    def test_reads_the_folder_in_slug_order_and_keeps_the_source_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "zeta.md", frontmatter("尾"))
            self.write(root, "alpha.md", frontmatter("头"))
            rows = ce.load_registry(root, "o/r", "main")
            self.assertEqual([row["slug"] for row in rows], ["alpha", "zeta"])

    def test_an_uppercase_file_is_skipped_because_its_link_would_not_resolve(self):
        """The published source link has to point at the path that actually exists."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "Alpha.md", frontmatter("大写"))
            self.write(root, "keep.md", frontmatter("保留"))
            errors = []
            rows = ce.load_registry(root, "o/r", "main", errors=errors)
            self.assertEqual([row["slug"] for row in rows], ["keep"])
            self.assertIn("Alpha.md", errors[0])

    def test_an_unreadable_file_is_named_and_the_rest_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "broken.md").mkdir()
            self.write(root, "keep.md", frontmatter("保留"))
            errors = []
            rows = ce.load_registry(root, "o/r", "main", errors=errors)
            self.assertEqual(len(rows), 1)
            self.assertIn("broken.md", errors[0])

    def test_entries_past_the_cap_report_a_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(5):
                self.write(root, f"e{index}.md", frontmatter())
            with patch.object(ce, "ENTRY_LIMIT", 3):
                warnings = []
                rows = ce.load_registry(root, "o/r", "main", warnings=warnings)
            self.assertEqual(len(rows), 3)
            self.assertIn("超过 3 条", warnings[0])


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.entities = self.root / "entities"
        self.entities.mkdir()
        self.data = data_dir(self.root, **SNAPSHOT)
        self.write("alpha.md", frontmatter("阿尔法", links=["hf_model:gatilin/Alpha"],
                                           kind="project", stage="training"))
        self.write("beta.md", frontmatter("贝塔", links=["scholar:MME: A Comprehensive"],
                                          kind="paper", stage="shipped"))

    def write(self, name, text):
        (self.entities / name).write_text(text, encoding="utf-8")

    def publish(self, moment=None, **kwargs):
        kwargs.setdefault("directory", self.entities)
        return ce.publish(self.data, moment or at(), **kwargs)

    def payload(self):
        return json.loads((self.data / "entities.json").read_text(encoding="utf-8"))

    def test_writes_the_index_and_the_first_history_point(self):
        self.assertEqual(self.publish(), "ok")
        latest = self.payload()
        self.assertEqual(latest["status"], "ok")
        self.assertIsNone(latest["error"])
        self.assertEqual(latest["captured_at"], latest["last_attempt_at"])
        self.assertEqual(latest["source"]["directory"], "entities")
        self.assertEqual(latest["summary"]["total"], 2)
        self.assertEqual(latest["summary"]["links"], 2)
        self.assertEqual(latest["validation"], {"resolved": 2, "unresolved": 0,
                                                "unchecked": 0, "out_of_scope": 0})
        self.assertEqual(latest["changes"]["status"], "initial")
        self.assertEqual(latest["changes"]["added"], ["alpha", "beta"])
        self.assertEqual([row["slug"] for row in latest["entries"]], ["alpha", "beta"])
        history = json.loads((self.data / "entities_history.json").read_text(encoding="utf-8"))
        self.assertEqual(history["snapshots"][0]["ids"], ["alpha", "beta"])
        self.assertEqual(history["snapshots"][0]["resolved"], 2)

    def test_a_second_run_reports_revisions_and_removals(self):
        self.publish()
        # Only the title moved; a metadata edit is still an edit the board should show.
        self.write("beta.md", frontmatter("贝塔改名", links=["scholar:mme"], kind="paper",
                                          stage="shipped"))
        (self.entities / "alpha.md").unlink()
        self.assertEqual(self.publish(moment=at(day="2026-11-03")), "ok")
        changes = self.payload()["changes"]
        self.assertEqual(changes["status"], "compared")
        self.assertEqual((changes["added"], changes["removed"], changes["revised"]),
                         ([], ["alpha"], ["beta"]))
        self.assertFalse(changes["truncated"])

    def test_an_edit_past_the_published_cut_still_counts_as_a_revision(self):
        self.write("beta.md", frontmatter("贝塔", links=["scholar:mme"]) + "x" * 30)
        with patch.object(ce, "MAX_BODY_CHARS", 20):
            self.publish()
            published = self.payload()["entries"][1]["body"]
            self.write("beta.md", frontmatter("贝塔", links=["scholar:mme"]) + "x" * 16 + "y" * 20)
            self.publish(moment=at(day="2026-11-03"))
            latest = self.payload()
        self.assertEqual(latest["entries"][1]["body"], published)
        self.assertEqual(latest["changes"]["revised"], ["beta"])

    def test_a_sibling_snapshot_moving_is_not_a_revision(self):
        """Link states follow the other collectors; only authored work is a revision."""
        self.publish()
        (self.data / "latest.json").unlink()
        self.assertEqual(self.publish(moment=at(day="2026-11-03")), "ok")
        latest = self.payload()
        self.assertEqual(latest["validation"], {"resolved": 1, "unresolved": 0,
                                                "unchecked": 1, "out_of_scope": 0})
        self.assertEqual(latest["changes"]["revised"], [])

    def test_a_run_from_the_clock_being_wrong_is_refused(self):
        self.publish()
        before = (self.data / "entities.json").read_text(encoding="utf-8")
        self.assertEqual(self.publish(moment=at(hour=1)), "rejected")
        self.assertEqual((self.data / "entities.json").read_text(encoding="utf-8"), before)

    def test_a_missing_folder_keeps_the_last_index_and_says_so(self):
        self.publish()
        shutil.rmtree(self.entities)
        self.assertEqual(self.publish(moment=at(day="2026-11-03")), "stale")
        latest = self.payload()
        self.assertEqual(latest["status"], "stale")
        self.assertEqual(latest["error"], ce.ERROR_MESSAGES["directory"])
        # The numbers stay, but they are labelled with the time they were taken.
        self.assertEqual(latest["captured_at"], at().isoformat().replace("+00:00", "Z"))
        self.assertEqual(latest["last_attempt_at"], at(day="2026-11-03").isoformat()
                         .replace("+00:00", "Z"))
        self.assertEqual(len(latest["entries"]), 2)

    def test_a_missing_folder_with_no_history_publishes_nothing(self):
        shutil.rmtree(self.entities)
        self.assertEqual(self.publish(), "unavailable")
        latest = self.payload()
        self.assertEqual(latest["status"], "unavailable")
        self.assertIsNone(latest["captured_at"])
        self.assertEqual(latest["entries"], [])
        self.assertEqual(sum(latest["validation"].values()), 0)

    def test_the_published_reason_never_leaks_a_path(self):
        error = ce.RegistryError("schema", f"bad row in {self.root}")
        ce.write_stale(self.data, at(), {"entries": [], }, error, repo="o/r", branch="main")
        text = (self.data / "entities.json").read_text(encoding="utf-8")
        self.assertIn(ce.ERROR_MESSAGES["schema"], text)
        self.assertNotIn(str(self.root), text)
        self.assertNotIn(str(self.root), ce.safe_error(ValueError(str(self.root))))

    def test_the_snapshot_lists_which_sources_answered(self):
        self.publish()
        sources = self.payload()["sources"]
        self.assertEqual(sorted(sources), sorted(ce.DOMAINS))
        self.assertEqual(sources["hf_model"], {"file": "latest.json", "available": True,
                                               "captured_at": "2026-11-01T00:00:00Z",
                                               "reason": None})
        self.assertFalse(sources["hf_space"]["available"])

    def test_the_index_carries_no_secrets(self):
        self.publish()
        for name in ("entities.json", "entities_history.json"):
            self.assertNotIn("Bearer", (self.data / name).read_text(encoding="utf-8"))

    def test_same_day_history_points_are_replaced_and_old_days_pruned(self):
        self.publish()
        self.publish(moment=at(day="2026-11-02", hour=9))
        self.publish(moment=at(day="2026-10-01"))
        history = json.loads((self.data / "entities_history.json").read_text(encoding="utf-8"))
        dates = [snap["date"] for snap in history["snapshots"]]
        self.assertEqual(dates, ["2026-11-02"])
        self.assertEqual(history["snapshots"][0]["total"], 2)

    def test_an_older_index_shape_survives_a_failed_run(self):
        """A committed snapshot from before this schema must not crash the fallback."""
        self.publish()
        latest = self.payload()
        del latest["entries"][0]["links"]
        write_json(self.data / "entities.json", latest)
        shutil.rmtree(self.entities)
        self.assertEqual(self.publish(moment=at(day="2026-11-03")), "stale")
        self.assertEqual(len(self.payload()["entries"]), 2)

    def test_a_corrupt_previous_file_does_not_stop_a_run(self):
        (self.data / "entities.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(self.publish(), "ok")
        self.assertEqual(self.payload()["changes"]["status"], "initial")

    def test_structural_errors_reach_the_payload(self):
        self.write("alpha.md", frontmatter("阿尔法", kind="wrong"))
        self.publish()
        self.assertTrue(any("kind" in note for note in self.payload()["structural_errors"]))


class LimitTest(unittest.TestCase):
    def test_notes_beyond_the_cap_are_marked_as_omitted(self):
        notes = []
        for index in range(ce.WARNING_LIMIT + 5):
            ce.add_note(notes, f"告警 {index}")
            ce.add_note(notes, f"告警 {index}")
        self.assertEqual(notes[ce.WARNING_LIMIT - 1], f"告警 {ce.WARNING_LIMIT - 1}")
        self.assertEqual(notes[ce.WARNING_LIMIT], "更多条目已省略")
        self.assertEqual(len(notes), ce.WARNING_LIMIT + 1)

    def test_changes_lists_are_capped_but_counts_are_not(self):
        rows = [entry(f"e{index:03d}") for index in range(ce.CHANGE_LIMIT + 10)]
        changes = ce.compare_rows({}, rows)
        self.assertEqual(len(changes["added"]), ce.CHANGE_LIMIT)
        self.assertEqual(changes["added_count"], len(rows))
        self.assertTrue(changes["truncated"])


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.entities = self.root / "entities"
        self.entities.mkdir()
        self.data = data_dir(self.root, **SNAPSHOT)

    def check(self, *files):
        for name, text in files:
            (self.entities / name).write_text(text, encoding="utf-8")
        return ce.inspect(self.entities, self.data)

    def test_a_clean_registry_passes_and_reports_coverage(self):
        report = self.check(("alpha.md", frontmatter(links=["hf_model:gatilin/Alpha"])))
        text, code = ce.format_check(report)
        self.assertEqual(code, 0)
        self.assertNotIn("断链", text)
        self.assertIn("已登记 1/2", text)
        self.assertIn("hf_model", text)

    def test_a_broken_link_only_fails_under_strict(self):
        report = self.check(("alpha.md", frontmatter(links=["hf_model:gatilin/Gone"])))
        self.assertEqual(ce.format_check(report)[1], 0)
        text, code = ce.format_check(report, strict=True)
        self.assertEqual(code, 1)
        self.assertIn("断链：alpha → hf_model:gatilin/Gone", text)

    def test_a_malformed_entry_fails_the_check(self):
        report = self.check(("Alpha.md", frontmatter()))
        text, code = ce.format_check(report)
        self.assertEqual(code, 1)
        self.assertIn("结构错误", text)

    def test_a_missing_folder_fails_the_check(self):
        shutil.rmtree(self.entities)
        text, code = ce.format_check(ce.inspect(self.entities, self.data))
        self.assertEqual(code, 1)
        self.assertIn("注册表目录不存在", text)

    def test_the_check_writes_nothing(self):
        argv = ["collect_entities.py", "--check", "--entities-dir", str(self.entities),
                "--data-dir", str(self.data)]
        (self.entities / "alpha.md").write_text(frontmatter(links=["hf_model:gatilin/Alpha"]),
                                                encoding="utf-8")
        with patch("sys.argv", argv), patch("builtins.print"):
            self.assertEqual(ce.main(), 0)
        self.assertFalse((self.data / "entities.json").exists())

    def test_the_default_run_prints_the_link_tally(self):
        argv = ["collect_entities.py", "--entities-dir", str(self.entities),
                "--data-dir", str(self.data)]
        (self.entities / "alpha.md").write_text(frontmatter(links=["hf_model:gatilin/Gone"]),
                                                encoding="utf-8")
        with patch("sys.argv", argv):
            with patch("builtins.print") as output:
                self.assertEqual(ce.main(), 0)
        self.assertIn("unresolved 1", output.call_args[0][0])


class IdsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.entities = self.root / "entities"
        self.entities.mkdir()
        self.report = ce.inspect(self.entities, data_dir(self.root, **SNAPSHOT))

    def test_lists_the_ids_this_run_can_link_to(self):
        text = ce.format_ids(self.report)
        self.assertIn("hf_model:gatilin/Alpha", text)
        self.assertIn("template:skill/review", text)

    def test_github_lists_our_own_repositories_only(self):
        text = ce.format_ids(self.report, domain="gh_repo")
        self.assertEqual(text.splitlines(), ["gh_repo:isLinXu/One"])

    def test_an_unavailable_source_says_why(self):
        lines = ce.format_ids(self.report, domain="hf_space").splitlines()
        self.assertEqual(lines, ["# hf_space: " + self.report["sources"]["hf_space"]["reason"]])

    def test_grep_filters_without_case(self):
        self.assertEqual(ce.format_ids(self.report, domain="hf_model", grep="alpha").splitlines(),
                         ["hf_model:gatilin/Alpha"])


class SeedRegistryTest(unittest.TestCase):
    """The shipped registry is source, not generated data: it must always parse."""

    ROOT = Path(ce.__file__).resolve().parent.parent / "entities"

    def report(self):
        return ce.inspect(self.ROOT, self.ROOT.parent / "data-not-used")

    def test_the_seed_entries_parse_cleanly(self):
        report = self.report()
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["warnings"], [])
        self.assertGreaterEqual(len(report["entries"]), 5)

    def test_every_entry_names_itself_and_points_at_its_own_file(self):
        for row in self.report()["entries"]:
            self.assertTrue(row["title"])
            self.assertIn(row["kind"], ce.KINDS)
            self.assertIn(row["stage"], ce.STAGES)
            self.assertTrue(row["body"].strip(), row["slug"])
            self.assertTrue(row["url"].endswith(f"/entities/{row['slug']}.md"))

    def test_every_link_is_well_formed_and_unique(self):
        for row in self.report()["entries"]:
            seen = set()
            for item in row["links"]:
                self.assertIn(item["domain"], ce.DOMAINS)
                self.assertTrue(item["id"].strip())
                self.assertNotIn(f"{item['domain']}:{item['id']}", seen)
                seen.add(f"{item['domain']}:{item['id']}")

    def test_the_registry_carries_no_credentials(self):
        text = "\n".join(path.read_text(encoding="utf-8") for path in sorted(self.ROOT.glob("*.md")))
        for marker in ("Bearer", "ghp_", "token=", "Authorization"):
            self.assertNotIn(marker, text)


class BuildTest(unittest.TestCase):
    NAMES = ("entities.json", "entities_history.json")

    def test_the_registry_artifacts_are_optional_and_copied_when_present(self):
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
