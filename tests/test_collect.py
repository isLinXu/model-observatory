import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from scripts.collect import (
    HF_DATASET_URL,
    HF_MODEL_URL,
    api_to_datasets,
    api_to_models,
    entity_url,
    load_history,
    migrate_history,
    save,
    update_history,
)
from scripts.collect_scholar import load_history as load_scholar_history
from scripts.collect_scholar import parse_profile, save as save_scholar

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "scholar_profile_mini.html"


def at(day):
    return dt.datetime.fromisoformat(day + "T02:23:00+00:00")


def example(id, all_time=100, last_30d=20):
    return {"id": id, "all_time": all_time, "last_30d": last_30d,
            "likes": 1, "pipeline": "other", "created_at": None}


def dataset(id, all_time=10, last_30d=3):
    return {"id": id, "all_time": all_time, "last_30d": last_30d, "likes": 0,
            "modality": ["text"], "languages": ["en"], "created_at": None}


class DatasetCollectorTests(unittest.TestCase):
    def test_api_to_datasets_filters_and_maps(self):
        infos = [
            SimpleNamespace(id="gatilin/A", downloads_all_time=80, downloads=22, likes=1, private=False,
                            created_at=None, tags=["modality:text", "language:en", "language:zh"]),
            SimpleNamespace(id="other/B", downloads_all_time=10, downloads=5, private=False),
            SimpleNamespace(id="gatilin/private", downloads_all_time=10, downloads=5, private=True),
            SimpleNamespace(id="gatilin/A", downloads_all_time=1, downloads=1, private=False),
        ]
        items = api_to_datasets(infos, "gatilin")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "gatilin/A")
        self.assertEqual(items[0]["all_time"], 80)
        self.assertEqual(items[0]["last_30d"], 22)
        self.assertEqual(items[0]["modality"], ["text"])
        self.assertEqual(items[0]["languages"], ["en", "zh"])

    def test_snapshot_keeps_datasets_next_to_models(self):
        base = {"schema_version": 3, "author": "gatilin", "updated_at": None, "snapshots": []}
        history = update_history(base, [example("gatilin/A")], at("2026-10-20"), [dataset("gatilin/D")])
        snapshot = history["snapshots"][-1]
        self.assertEqual(snapshot["models"]["gatilin/A"], [100, 20])
        self.assertEqual(snapshot["datasets"]["gatilin/D"], [10, 3])

    def test_legacy_history_is_migrated_to_current_schema(self):
        legacy = {
            "schema_version": 1,
            "author": "gatilin",
            "updated_at": "2026-10-20T02:23:00Z",
            "snapshots": [{"date": "2026-10-20", "captured_at": "2026-10-20T02:23:00Z",
                           "models": {"gatilin/A": [100, 20]}}],
        }
        migrated = migrate_history(legacy, "gatilin")
        self.assertEqual(migrated["schema_version"], 3)
        self.assertEqual(migrated["snapshots"][0]["datasets"], {})

    def test_load_history_migrates_legacy_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "history.json"
            path.write_text(json.dumps({
                "schema_version": 1, "author": "gatilin", "updated_at": None,
                "snapshots": [{"date": "2026-10-20", "captured_at": "2026-10-20T02:23:00Z",
                               "models": {"gatilin/A": [100, 20]}}],
            }), encoding="utf-8")
            history = load_history(path, "gatilin")
            self.assertEqual(history["schema_version"], 3)
            self.assertEqual(history["snapshots"][0]["datasets"], {})

    def test_save_writes_datasets_into_latest(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            save(data_dir, "gatilin", [example("gatilin/A")], at("2026-10-20"), [dataset("gatilin/D")])
            latest = json.loads((data_dir / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["schema_version"], 3)
            self.assertEqual(len(latest["datasets"]), 1)
            self.assertEqual(latest["datasets"][0]["id"], "gatilin/D")

    def test_dataset_drop_is_protected(self):
        base = {"schema_version": 3, "author": "gatilin", "updated_at": None, "snapshots": []}
        many = [dataset(f"gatilin/D{i}") for i in range(6)]
        history = update_history(base, [example("gatilin/A")], at("2026-10-20"), many)
        with self.assertRaises(ValueError):
            update_history(history, [example("gatilin/A")], at("2026-10-21"), [])


class ScholarParserTests(unittest.TestCase):
    def setUp(self):
        self.page = FIXTURE.read_text(encoding="utf-8")
        self.profile = parse_profile(self.page, "oTYM_I8AAAAJ")

    def test_identity_fields(self):
        self.assertEqual(self.profile["name"], "Xu Lin")
        self.assertEqual(self.profile["affiliation"], "Tencent Youtu Lab")
        self.assertEqual(self.profile["verified_email"], "tencent.com")
        self.assertEqual(self.profile["interests"], ["Multimodal LLM", "LLM", "CV"])

    def test_metrics(self):
        metrics = self.profile["metrics"]
        self.assertEqual(metrics["citations_all"], 2376)
        self.assertEqual(metrics["citations_recent"], 2376)
        self.assertEqual(metrics["h_index_all"], 4)
        self.assertEqual(metrics["i10_all"], 4)
        self.assertEqual(metrics["publications"], 4)
        self.assertEqual(metrics["publications_listed"], 2)
        self.assertFalse(metrics["truncated"])

    def test_citations_by_year(self):
        years = self.profile["citations_by_year"]
        self.assertEqual([row["year"] for row in years], [2023, 2024, 2025, 2026])
        self.assertEqual([row["citations"] for row in years], [49, 480, 806, 1037])

    def test_papers(self):
        papers = self.profile["papers"]
        self.assertEqual(len(papers), 2)
        first = papers[0]
        self.assertTrue(first["title"].startswith("MME:"))
        self.assertEqual(first["year"], 2024)
        self.assertEqual(first["citations"], 2310)
        self.assertIn("arXiv", first["venue"])
        self.assertTrue(first["url"].startswith("https://scholar.google.com/citations?"))

    def test_unrelated_markup_yields_nothing(self):
        profile = parse_profile("<html><body>nothing here</body></html>", "x")
        self.assertEqual(profile["name"], "")
        self.assertEqual(profile["papers"], [])
        self.assertIsNone(profile["metrics"]["citations_all"])


class ScholarHistoryTests(unittest.TestCase):
    def test_save_and_reload(self):
        page = FIXTURE.read_text(encoding="utf-8")
        profile = parse_profile(page, "oTYM_I8AAAAJ")
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            save_scholar(data_dir, profile, at("2026-10-20"))
            save_scholar(data_dir, profile, at("2026-10-21"))
            latest = json.loads((data_dir / "scholar.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["name"], "Xu Lin")
            history = load_scholar_history(data_dir / "scholar_history.json", "oTYM_I8AAAAJ")
            self.assertEqual(len(history["snapshots"]), 2)
            self.assertEqual(history["snapshots"][-1]["citations_all"], 2376)

    def test_same_day_replaces_previous_snapshot(self):
        page = FIXTURE.read_text(encoding="utf-8")
        profile = parse_profile(page, "oTYM_I8AAAAJ")
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            save_scholar(data_dir, profile, at("2026-10-20"))
            save_scholar(data_dir, profile, at("2026-10-20"))
            history = load_scholar_history(data_dir / "scholar_history.json", "oTYM_I8AAAAJ")
            self.assertEqual(len(history["snapshots"]), 1)

    def test_incompatible_profile_id_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scholar_history.json"
            path.write_text(json.dumps({"schema_version": 1, "profile_id": "other",
                                        "updated_at": None, "snapshots": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_scholar_history(path, "oTYM_I8AAAAJ")


class ModelRegressionTests(unittest.TestCase):
    def test_model_conversion_is_unchanged(self):
        infos = [
            SimpleNamespace(id="gatilin/A", downloads_all_time=80, downloads=22, likes=1,
                            pipeline_tag="text-generation", private=False, created_at=None),
            SimpleNamespace(id="other/B", downloads_all_time=10, downloads=5, private=False),
        ]
        models = api_to_models(infos, "gatilin")
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]["pipeline"], "text-generation")


class EntityUrlTests(unittest.TestCase):
    """Every entity type exposes a `url` so the site can link straight out."""

    def test_model_url_points_at_hugging_face(self):
        infos = [SimpleNamespace(id="gatilin/A", downloads_all_time=1, downloads=1, likes=0,
                                 pipeline_tag="other", private=False, created_at=None)]
        model = api_to_models(infos, "gatilin")[0]
        self.assertEqual(model["url"], "https://huggingface.co/gatilin/A")

    def test_dataset_url_points_at_hugging_face_datasets(self):
        infos = [SimpleNamespace(id="gatilin/D", downloads_all_time=1, downloads=1, likes=0,
                                 private=False, created_at=None, tags=[])]
        item = api_to_datasets(infos, "gatilin")[0]
        self.assertEqual(item["url"], "https://huggingface.co/datasets/gatilin/D")

    def test_url_is_none_for_empty_id(self):
        self.assertIsNone(entity_url(HF_MODEL_URL, ""))

    def test_url_encodes_unsafe_characters(self):
        self.assertEqual(entity_url(HF_MODEL_URL, "gatilin/a b"),
                         "https://huggingface.co/gatilin/a%20b")

    def test_papers_carry_a_url(self):
        page = FIXTURE.read_text(encoding="utf-8")
        profile = parse_profile(page, "oTYM_I8AAAAJ")
        for paper in profile["papers"]:
            self.assertTrue(paper["url"].startswith("https://"))

    def test_history_snapshots_keep_the_compact_shape(self):
        """Historical snapshots stay {id: [all, rolling]} for existing readers."""
        base = {"schema_version": 3, "author": "gatilin", "updated_at": None, "snapshots": []}
        history = update_history(base, [example("gatilin/A")], at("2026-10-20"), [dataset("gatilin/D")])
        snapshot = history["snapshots"][-1]
        self.assertEqual(snapshot["models"]["gatilin/A"], [100, 20])
        self.assertNotIn("url", snapshot)


if __name__ == "__main__":
    unittest.main()
