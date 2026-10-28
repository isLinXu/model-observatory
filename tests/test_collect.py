import copy
import datetime as dt
import io
import json
import os
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from scripts import collect
from scripts.collect import (
    HF_DATASET_URL,
    HF_MODEL_URL,
    api_to_datasets,
    api_to_models,
    apply_retention,
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


def collection_detail(name="group", **fields):
    return {"slug": f"gatilin/{name}", "title": "A collection", "description": "Public grouping",
            "owner": {"name": "gatilin"}, "private": False, "lastUpdated": "2026-10-19T12:00:00Z",
            "items": [{"type": "model", "id": "gatilin/A", "private": False}], **fields}


def collection_state(items=None, status="ok", error=None):
    return {"status": status, "captured_at": "2026-10-20T02:23:00Z" if status == "ok" else None,
            "error": error, "items": items if items is not None else []}


class CollectionResponse(io.BytesIO):
    def __init__(self, value, link=""):
        super().__init__(value if isinstance(value, bytes) else json.dumps(value).encode("utf-8"))
        self.status = 200
        self.headers = Message()
        if link:
            self.headers["Link"] = link


class CollectionFetchTests(unittest.TestCase):
    list_url = collect.HF_COLLECTIONS_API + "?limit=100&owner=gatilin"

    def fetch(self, responses, links=None):
        self.requests = []
        links = links or {}

        def open_public(request, *, timeout):
            self.requests.append(request)
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, collect.COLLECTION_REQUEST_TIMEOUT)
            value = responses[request.full_url]
            if isinstance(value, Exception):
                raise value
            return CollectionResponse(value, links.get(request.full_url, ""))

        with mock.patch("scripts.collect.urllib.request.OpenerDirector.open", side_effect=open_public):
            return collect.fetch_collections("gatilin")

    def detail_url(self, name="group"):
        return collect.HF_COLLECTIONS_API + "/gatilin/" + name

    def test_uses_all_full_detail_items_not_truncated_preview(self):
        full = collection_detail(items=[{"type": "model", "id": f"gatilin/M{i}"} for i in range(6)])
        preview = {**full, "title": "Old preview title", "items": full["items"][:4]}
        result = self.fetch({self.list_url: [preview], self.detail_url(): full})
        self.assertEqual(result, [{
            "slug": "gatilin/group", "title": "A collection", "description": "Public grouping",
            "updated_at": "2026-10-19T12:00:00Z",
            "items": [{"type": "model", "id": f"gatilin/M{i}", "note": ""} for i in range(6)],
        }])
        self.assertEqual([r.full_url for r in self.requests], [self.list_url, self.detail_url()])

    def test_pagination_dedupes_slugs_and_fetches_every_detail(self):
        second = collect.HF_COLLECTIONS_API + "?cursor=two&owner=gatilin"
        third = collect.HF_COLLECTIONS_API + "?cursor=three&owner=gatilin"
        a, b, c = [collection_detail(name) for name in ("a", "b", "c")]
        # Previews need not contain items at all; only detail membership counts.
        previews = [{key: value for key, value in item.items() if key != "items"} for item in (a, b, c)]
        result = self.fetch({self.list_url: [previews[0], previews[0]], second: previews[:2],
                             third: previews[1:], self.detail_url("a"): a,
                             self.detail_url("b"): b, self.detail_url("c"): c},
                            {self.list_url: f'<{self.list_url}>; rel="first", '
                                            '<?owner=gatilin&cursor=two>; rel="next"',
                             second: f'<{third}>; rel=next',
                             third: f'<{second}>; rel="prev"'})
        self.assertEqual([item["slug"] for item in result], ["gatilin/a", "gatilin/b", "gatilin/c"])
        self.assertEqual([r.full_url for r in self.requests], [self.list_url, second, third,
                         self.detail_url("a"), self.detail_url("b"), self.detail_url("c")])

    def test_empty_listing_is_a_success(self):
        self.assertEqual(self.fetch({self.list_url: []}), [])
        self.assertEqual(len(self.requests), 1)

    def test_does_not_use_tokens_proxies_or_global_authenticated_opener(self):
        build_opener = collect.urllib.request.build_opener
        global_opener = mock.Mock()
        with mock.patch.dict(os.environ, {"HF_TOKEN": "secret-token", "HF_HUB_TOKEN": "another-token",
                                          "HUGGING_FACE_HUB_TOKEN": "legacy-token",
                                          "HTTPS_PROXY": "http://user:password@proxy.invalid"}), \
                mock.patch("scripts.collect.urllib.request._opener", global_opener), \
                mock.patch("scripts.collect.urllib.request.build_opener", wraps=build_opener) as build:
            full = collection_detail()
            self.fetch({self.list_url: [full], self.detail_url(): full})
        global_opener.open.assert_not_called()
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsInstance(build.call_args.args[1], collect._NoCollectionRedirects)
        for request in self.requests:
            self.assertEqual(request.header_items(), [("Accept", "application/json")])
            self.assertNotIn("token", request.full_url)
            self.assertEqual(request.get_method(), "GET")

    def test_privacy_collection_refs_plain_notes_and_other_item_types(self):
        full = collection_detail(items=[
            {"type": "model", "id": "gatilin/A", "private": False,
             "note": {"text": "Plain text **note**", "html": "<p>DO NOT STORE</p>"}},
            {"type": "model", "id": "gatilin/A", "note": {"text": "Duplicate"}},
            {"type": "model", "id": "other/external"},
            {"type": "dataset", "id": "gatilin/A", "note": {"html": "<b>HTML only</b>"}},
            {"type": "collection", "id": "6addc6d5b04b81f86ac0e942", "slug": "other/child-123",
             "note": {"text": "Nested grouping", "html": "<p>Nested grouping</p>"}},
            {"type": "collection", "id": "different-id", "slug": "other/child-123"},
            {"type": "space", "id": "other/demo", "note": {"text": 42}},
            {"type": "paper", "id": "1234.56789", "note": "Not a note.text object"},
            {"type": "future-type", "id": "future-id", "note": None},
            {"type": "model", "id": "gatilin/private", "private": True},
            {"type": "collection", "private": True},
        ])
        private = collection_detail("private", private=True)
        changed = collection_detail("changed")
        result = self.fetch({self.list_url: [full, private, changed], self.detail_url(): full,
                             self.detail_url("changed"): {**changed, "private": True}})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["items"], [
            {"type": "model", "id": "gatilin/A", "note": "Plain text **note**"},
            {"type": "model", "id": "other/external", "note": ""},
            {"type": "dataset", "id": "gatilin/A", "note": ""},
            {"type": "collection", "id": "other/child-123", "note": "Nested grouping"},
            {"type": "space", "id": "other/demo", "note": ""},
            {"type": "paper", "id": "1234.56789", "note": ""},
            {"type": "future-type", "id": "future-id", "note": ""},
        ])
        self.assertNotIn("html", json.dumps(result))
        self.assertNotIn("DO NOT STORE", json.dumps(result))
        self.assertNotIn(self.detail_url("private"), [r.full_url for r in self.requests])

    def test_empty_detail_and_optional_text_metadata(self):
        full = collection_detail(items=[], description=None, lastUpdated=None)
        result = self.fetch({self.list_url: [full], self.detail_url(): full})
        self.assertEqual(result[0]["items"], [])
        self.assertEqual(result[0]["description"], "")
        self.assertIsNone(result[0]["updated_at"])

    def test_missing_or_malformed_detail_never_returns_partial_results(self):
        a, b = collection_detail("a"), collection_detail("b")
        bad_details = [None, [], {}, b"not JSON", {key: value for key, value in b.items() if key != "items"},
                       urllib.error.HTTPError(self.detail_url("b"), 404, "Not found", {}, None),
                       urllib.error.URLError("Unavailable"), TimeoutError("Timed out")]
        for key, values in {
            "items": [None, {}, [None], [{}], [{"type": "model"}], [{"id": "gatilin/A"}],
                      [{"type": "model", "id": ""}], [{"type": [], "id": "gatilin/A"}],
                      [{"type": "model", "id": "gatilin/A", "private": "false"}],
                      [{"type": "collection", "id": "hex-without-slug"}]],
            "owner": [None, "gatilin", {"name": "other"}],
            "slug": [None, "gatilin/wrong", "other/b"],
            "private": [None, "false", 0],
            "title": [None, {}], "description": [{}], "lastUpdated": [[]],
        }.items():
            bad_details.extend({**b, key: value} for value in values)
        for key in ("slug", "private", "owner", "title"):
            bad_details.append({name: value for name, value in b.items() if name != key})
        for bad in bad_details:
            with self.subTest(detail=bad):
                with self.assertRaises((ValueError, urllib.error.URLError, TimeoutError)):
                    self.fetch({self.list_url: [a, b], self.detail_url("a"): a, self.detail_url("b"): bad})
                self.assertEqual(self.requests[-1].full_url, self.detail_url("b"))

    def test_invalid_listing_fails_instead_of_publishing_empty_data(self):
        for page in (None, {}, {"items": []}, b"invalid JSON", [None], [{}],
                     [collection_detail(owner={"name": "other"})], [collection_detail(private="false")]):
            with self.subTest(page=page), self.assertRaises(ValueError):
                self.fetch({self.list_url: page})

    def test_unsafe_slugs_are_rejected_in_listings_and_nested_refs(self):
        for slug in ("gatilin/../secret", "gatilin/..", "gatilin/%2e%2e", "gatilin/a/b", "gatilin/a?x=1",
                     "gatilin/a#fragment", "gatilin/\\secret", "https://evil.invalid/a", "/gatilin/a", "gatilin/"):
            with self.subTest(slug=slug):
                with self.assertRaises(ValueError):
                    self.fetch({self.list_url: [collection_detail(slug=slug)]})
                full = collection_detail(items=[{"type": "collection", "id": "hex", "slug": slug}])
                with self.assertRaises(ValueError):
                    self.fetch({self.list_url: [full], self.detail_url(): full})

    def test_unsafe_author_is_rejected_before_http(self):
        with mock.patch("scripts.collect.urllib.request.OpenerDirector.open") as request:
            for author in ("../gatilin", "gatilin/other", "gatilin?owner=other", "", "gatilin%2fother"):
                with self.subTest(author=author), self.assertRaises(ValueError):
                    collect.fetch_collections(author)
            request.assert_not_called()

    def test_pagination_rejects_unsafe_endpoints_and_wrong_owners(self):
        for url in ("https://evil.invalid/api/collections?owner=gatilin",
                    "http://huggingface.co/api/collections?owner=gatilin",
                    "https://huggingface.co:443/api/collections?owner=gatilin",
                    "https://user:password@huggingface.co/api/collections?owner=gatilin",
                    "https://huggingface.co/api/models?owner=gatilin", "/login?owner=gatilin",
                    "/api/collections/extra?owner=gatilin", "?owner=other", "?cursor=two",
                    "?owner=gatilin&owner=other", "?owner=gatilin#fragment"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.fetch({self.list_url: []}, {self.list_url: f'<{url}>; rel="next"'})
            self.assertEqual(len(self.requests), 1)

    def test_pagination_rejects_loops_and_malformed_links(self):
        for link in (f'<{self.list_url}>; rel="next"', '<?owner=gatilin&limit=100>; rel="next"',
                     '<?owner=gatilin&cursor=two>; rel="next", <?owner=gatilin&cursor=three>; rel="next"',
                     'not-a-link; rel="next"'):
            with self.subTest(link=link), self.assertRaises(ValueError):
                self.fetch({self.list_url: []}, {self.list_url: link})
            self.assertEqual(len(self.requests), 1)
        second = collect.HF_COLLECTIONS_API + "?cursor=two&owner=gatilin"
        with self.assertRaisesRegex(ValueError, "loop"):
            self.fetch({self.list_url: [], second: []},
                       {self.list_url: f'<{second}>; rel="next"', second: f'<{self.list_url}>; rel="next"'})
        self.assertEqual(len(self.requests), 2)

    def test_http_redirects_are_rejected(self):
        handler = collect._NoCollectionRedirects()
        for url in ("https://evil.invalid/", self.list_url):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "redirect"):
                handler.redirect_request(None, None, 302, "Found", {}, url)

    def test_fetch_budget_and_response_size_are_bounded(self):
        with mock.patch("scripts.collect.time.monotonic", side_effect=[0, 121]):
            with self.assertRaises(TimeoutError):
                self.fetch({self.list_url: []})
            self.assertEqual(self.requests, [])
        with mock.patch("scripts.collect.COLLECTION_RESPONSE_LIMIT", 64):
            with self.assertRaisesRegex(ValueError, "too large"):
                self.fetch({self.list_url: b" " * 65 + b"[]"})
        with mock.patch("scripts.collect.time.monotonic", side_effect=[0, 0, 121]):
            with self.assertRaises(TimeoutError):
                self.fetch({self.list_url: []})
            self.assertEqual(len(self.requests), 1)


class CollectionPersistenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.data_dir = Path(temporary.name)
        self.items = [{"slug": "gatilin/group", "title": "A collection", "description": "",
                       "updated_at": None, "items": [{"type": "model", "id": "gatilin/A", "note": ""}]}]

    def save_collections(self, collections, day="2026-10-20"):
        save(self.data_dir, "gatilin", [example("gatilin/A")], at(day), [dataset("gatilin/D")],
             collections=collections)
        return json.loads((self.data_dir / "latest.json").read_text(encoding="utf-8"))

    def test_success_and_empty_success_replace_previous_membership(self):
        success = collection_state(self.items)
        self.assertEqual(self.save_collections(success)["collections"], success)
        empty = {**collection_state(), "captured_at": "2026-10-21T02:23:00Z"}
        latest = self.save_collections(empty, "2026-10-21")
        self.assertEqual(latest["collections"], empty)
        self.assertEqual(latest["schema_version"], 3)

    def test_failure_preserves_original_capture_across_repeated_failures(self):
        original = collection_state(self.items)
        self.save_collections(original)
        for day, status in (("2026-10-21", "unavailable"), ("2026-10-22", "stale")):
            failure = {"status": status, "captured_at": day + "T00:00:00Z",
                       "error": f"Failed on {day}", "items": [{"slug": "gatilin/partial"}]}
            unchanged = copy.deepcopy(failure)
            latest = self.save_collections(failure, day)
            self.assertEqual(latest["collections"], {**original, "status": "stale", "error": failure["error"]})
            self.assertEqual(latest["captured_at"], day + "T02:23:00Z")
            self.assertEqual(latest["models"], [example("gatilin/A")])
            self.assertEqual(latest["datasets"], [dataset("gatilin/D")])
            self.assertEqual(failure, unchanged)
        self.assertEqual(original["status"], "ok")

    def test_empty_success_can_become_stale(self):
        original = collection_state()
        self.save_collections(original)
        failure = collection_state(status="unavailable", error="Offline")
        latest = self.save_collections(failure, "2026-10-21")
        self.assertEqual(latest["collections"], {**original, "status": "stale", "error": "Offline"})

    def test_failure_without_prior_collections_is_unavailable(self):
        failure = collection_state([{"slug": "gatilin/partial"}], status="unavailable", error="Offline")
        for day in ("2026-10-20", "2026-10-21"):
            latest = self.save_collections(failure, day)
            self.assertEqual(latest["collections"], {"status": "unavailable", "captured_at": None,
                                                    "error": "Offline", "items": []})

    def test_missing_or_unreadable_previous_metadata_is_unavailable(self):
        previous_values = [None, [], {"author": "gatilin"}, {"author": "gatilin", "collections": []},
                           {"author": "gatilin", "collections": {"status": "ok", "items": []}},
                           {"author": "gatilin", "collections": collection_state(status="unavailable")},
                           "invalid JSON"]
        for previous in previous_values:
            with self.subTest(previous=previous):
                (self.data_dir / "latest.json").write_text(
                    previous if isinstance(previous, str) else json.dumps(previous), encoding="utf-8")
                failure = collection_state(status="unavailable", error="Offline")
                self.assertEqual(self.save_collections(failure)["collections"], failure)

    def test_other_authors_collections_are_never_reused(self):
        (self.data_dir / "latest.json").write_text(json.dumps({
            "author": "other", "collections": collection_state(self.items),
        }), encoding="utf-8")
        failure = collection_state(status="unavailable", error="Offline")
        self.assertEqual(self.save_collections(failure)["collections"], failure)

    def test_save_is_offline_and_omitted_collections_remain_optional(self):
        with mock.patch("scripts.collect.fetch_collections") as fetch, \
                mock.patch("scripts.collect.urllib.request.OpenerDirector.open") as request:
            save(self.data_dir, "gatilin", [example("gatilin/A")], at("2026-10-20"))
            latest = json.loads((self.data_dir / "latest.json").read_text(encoding="utf-8"))
            self.assertNotIn("collections", latest)
            self.save_collections(collection_state(self.items))
            fetch.assert_not_called()
            request.assert_not_called()

    def test_collections_do_not_change_compact_history(self):
        save(self.data_dir, "gatilin", [example("gatilin/A")], at("2026-10-20"), [dataset("gatilin/D")])
        path = self.data_dir / "history.json"
        original = path.read_bytes()
        self.save_collections(collection_state(self.items))
        self.assertEqual(path.read_bytes(), original)
        self.save_collections(collection_state(status="unavailable", error="Offline"))
        self.assertEqual(path.read_bytes(), original)
        history = json.loads(original)
        self.assertEqual(set(history), {"schema_version", "author", "updated_at", "snapshots"})
        self.assertEqual(history["snapshots"], [{
            "date": "2026-10-20", "captured_at": "2026-10-20T02:23:00Z",
            "models": {"gatilin/A": [100, 20]}, "datasets": {"gatilin/D": [10, 3]},
        }])

    def test_main_collects_membership_and_survives_collection_failure(self):
        for result in (self.items, [], RuntimeError("Collections offline")):
            with self.subTest(result=result):
                with mock.patch("sys.argv", ["collect.py", "--author", "gatilin", "--data-dir", str(self.data_dir)]), \
                        mock.patch("scripts.collect.fetch_models", return_value=[example("gatilin/A")]) as models, \
                        mock.patch("scripts.collect.fetch_datasets", return_value=[dataset("gatilin/D")]) as datasets, \
                        mock.patch("scripts.collect.fetch_collections") as collections:
                    if isinstance(result, Exception):
                        collections.side_effect = result
                    else:
                        collections.return_value = result
                    collect.main()
                models.assert_called_once_with("gatilin")
                datasets.assert_called_once_with("gatilin")
                collections.assert_called_once_with("gatilin")
                latest = json.loads((self.data_dir / "latest.json").read_text(encoding="utf-8"))
                self.assertEqual(latest["models"], [example("gatilin/A")])
                self.assertEqual(latest["datasets"], [dataset("gatilin/D")])
                state = latest["collections"]
                if isinstance(result, Exception):
                    self.assertEqual(state, {**previous_state, "status": "stale", "error": "Collections offline"})
                else:
                    self.assertEqual(state["status"], "ok")
                    self.assertEqual(state["items"], result)
                    self.assertIsNone(state["error"])
                    self.assertIsInstance(state["captured_at"], str)
                previous_state = state

    def test_main_first_collection_failure_still_saves_statistics(self):
        with mock.patch("sys.argv", ["collect.py", "--author", "gatilin", "--data-dir", str(self.data_dir)]), \
                mock.patch("scripts.collect.fetch_models", return_value=[example("gatilin/A")]), \
                mock.patch("scripts.collect.fetch_datasets", return_value=[dataset("gatilin/D")]), \
                mock.patch("scripts.collect.fetch_collections", side_effect=TimeoutError("Timed out")):
            collect.main()
        latest = json.loads((self.data_dir / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(latest["collections"], collection_state(status="unavailable", error="Timed out"))
        self.assertEqual(latest["models"], [example("gatilin/A")])
        self.assertEqual(latest["datasets"], [dataset("gatilin/D")])


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


class SnapshotRetentionTests(unittest.TestCase):
    """Old snapshots are downsampled so history.json cannot grow forever."""

    def build(self, days, today=dt.date(2026, 10, 21)):
        snapshots = []
        for offset in range(days):
            day = today - dt.timedelta(days=offset)
            snapshots.append({
                "date": day.isoformat(),
                "captured_at": f"{day.isoformat()}T02:23:00Z",
                "models": {"gatilin/A": [offset, offset * 2]},
                "datasets": {},
            })
        return snapshots

    def test_recent_history_is_left_alone(self):
        snapshots = self.build(30)
        kept = apply_retention(snapshots, dt.date(2026, 10, 21))
        self.assertEqual(len(kept), 30)
        self.assertFalse(any(s.get("granularity") for s in kept))

    def test_old_snapshots_collapse_into_weekly_buckets(self):
        snapshots = self.build(800)
        kept = apply_retention(snapshots, dt.date(2026, 10, 21))
        weekly = [s for s in kept if s.get("granularity") == "weekly"]
        daily = [s for s in kept if not s.get("granularity")]
        self.assertLess(len(kept), len(snapshots))
        self.assertTrue(weekly)
        # Daily resolution survives for at least the configured window.
        self.assertGreaterEqual(len(daily), 400)
        for bucket in weekly:
            self.assertEqual(bucket["days"], 7)
            self.assertIn("gatilin/A", bucket["models"])

    def test_series_stays_sorted_and_free_of_overlaps(self):
        kept = apply_retention(self.build(800), dt.date(2026, 10, 21))
        dates = [s["date"] for s in kept]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(len(dates), len(set(dates)))
        weekly = [s for s in kept if s.get("granularity") == "weekly"]
        daily = [s for s in kept if not s.get("granularity")]
        if weekly and daily:
            self.assertLess(weekly[-1]["date"], daily[0]["date"])

    def test_averaging_ignores_missing_values(self):
        """Null metrics must not drag the weekly mean down or fake a value."""
        today = dt.date(2026, 10, 21)
        snapshots = self.build(800)
        # Blank out every all_time reading across the whole oldest week so the
        # bucket has no sample at all for that metric.
        for snapshot in snapshots[-7:]:
            snapshot["models"]["gatilin/A"][0] = None
        weekly = [s for s in apply_retention(snapshots, today) if s.get("granularity") == "weekly"]
        self.assertEqual(weekly[0]["models"]["gatilin/A"][0], None)
        # The rolling-30-day metric still has samples and must be averaged.
        self.assertIsNotNone(weekly[0]["models"]["gatilin/A"][1])

    def test_entities_missing_from_a_bucket_are_still_merged(self):
        today = dt.date(2026, 10, 21)
        snapshots = self.build(800)
        for snapshot in snapshots[:3]:
            snapshot["models"].pop("gatilin/A", None)
        kept = apply_retention(snapshots, today)
        weekly = [s for s in kept if s.get("granularity") == "weekly"]
        self.assertTrue(weekly)
        self.assertIn("gatilin/A", weekly[-1]["models"])


if __name__ == "__main__":
    unittest.main()
