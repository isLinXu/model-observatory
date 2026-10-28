import copy
import datetime as dt
import io
import json
import os
import tempfile
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import collect_modelscope as ms


AUTHOR = "isLinXu"


def at(day="2026-10-21", hour=2):
    return dt.datetime.fromisoformat(f"{day}T{hour:02}:23:00+00:00")


def model(index=0, **overrides):
    # The actual anonymous OpenAPI shape, not the uppercase legacy API.
    value = {"id": f"{AUTHOR}/model-{index}", "display_name": f"Model {index}",
             "description": "A public model", "downloads": 349, "likes": 2,
             "license": "Apache-2.0", "tasks": ["text-generation"],
             "created_at": "2025-01-01T00:00:00Z", "last_modified": "2026-10-20T12:00:00Z",
             "private": False, "gated": False}
    value.update(overrides)
    return value


def page(items=None, total=1, number=1, **overrides):
    data = {"models": [model()] if items is None else items, "total_count": total,
            "page_number": number, "page_size": 50}
    data.update(overrides)
    return {"success": True, "data": data}


def pages(total):
    return [page([model(i) for i in range(start, min(start + 50, total))], total, start // 50 + 1)
            for start in range(0, total, 50)] or [page([], 0)]


def profile_payload():
    return {"Code": 200, "Success": True, "Data": {
        "User": {"NickName": "hertz", "Downloads": 538776, "Stars": 13},
        "Model": {"TotalCount": 310}, "Dataset": {"TotalCount": 113}, "Studio": {"TotalCount": 22}}}


def profile():
    return {"status": "ok", "captured_at": ms.timestamp(at()), "followers": 13,
            "model_count": 310, "downloads": 538776, "error": None}


class Response(io.BytesIO):
    def __init__(self, payload, status=200):
        super().__init__(payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        self.status = status
        self.socket = Mock()
        self.fp = types.SimpleNamespace(raw=types.SimpleNamespace(_sock=self.socket))


def opener_for(*payloads):
    return Mock(open=Mock(side_effect=[Response(payload) for payload in payloads]))


class ModelTests(unittest.TestCase):
    def test_exact_openapi_fields(self):
        result = ms.api_to_model(model(), AUTHOR)
        self.assertEqual(result, {
            "id": "isLinXu/model-0", "name": "Model 0",
            "url": "https://www.modelscope.cn/models/isLinXu/model-0", "downloads": 349,
            "likes": 2, "tasks": ["text-generation"], "license": "Apache-2.0",
            "created_at": "2025-01-01T00:00:00Z", "updated_at": "2026-10-20T12:00:00Z",
            "gated": False,
        })

    def test_counters_preserve_null_and_zero_without_coercion(self):
        for value in (None, True, False, -1, 1.2, 1.0, "3", "0", {}, [], float("inf"), float("nan"), 2**53, 10**30):
            with self.subTest(value=value):
                self.assertIsNone(ms.number_or_none(value))
                result = ms.api_to_model(model(downloads=value, likes=value), AUTHOR)
                self.assertIsNone(result["downloads"])
                self.assertIsNone(result["likes"])
        for value in (0, 1, 349, 2**53 - 1):
            self.assertEqual(ms.number_or_none(value), value)

    def test_optional_metadata_defaults(self):
        result = ms.api_to_model({"id": f"{AUTHOR}/bare", "private": False, "gated": False}, AUTHOR)
        self.assertEqual(result["name"], "bare")
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["license"], "")
        self.assertFalse(result["gated"])
        for key in ("created_at", "updated_at", "downloads", "likes"):
            self.assertIsNone(result[key])
        result = ms.api_to_model(model(display_name=" ", license={}, tasks="invalid",
                                       created_at=5, last_modified=[]), AUTHOR)
        self.assertEqual(result["name"], "model-0")
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["license"], "")
        self.assertIsNone(result["updated_at"])
        self.assertFalse(result["gated"])

    def test_access_restrictions_must_be_explicit(self):
        for value in (None, "false", 0, 1, [], {}):
            with self.subTest(value=value), self.assertRaises(ms.ModelScopeError):
                ms.api_to_model(model(gated=value), AUTHOR)
        item = model()
        del item["gated"]
        with self.assertRaises(ms.ModelScopeError):
            ms.api_to_model(item, AUTHOR)

    def test_task_strings_and_gated_public_models(self):
        result = ms.api_to_model(model(tasks=["a", 1, None, "b"], gated=True), AUTHOR)
        self.assertEqual(result["tasks"], ["a", "b"])
        self.assertTrue(result["gated"])

    def test_reject_invalid_or_wrong_owner_identities(self):
        for identity in (None, 1, "", "other/model", "islinxu/model", "isLinXu/", "isLinXu/a/b",
                         "isLinXu/../x", "isLinXu/a..b", "isLinXu/a?x", "isLinXu/a#b",
                         "isLinXu/%2e", "isLinXu/a\\b", "isLinXu/a\n", "https://evil/model"):
            with self.subTest(identity=identity), self.assertRaises(ms.ModelScopeError):
                ms.api_to_model(model(id=identity), AUTHOR)

    def test_require_explicit_public_false(self):
        for private in (True, None, 0, "false", [], {}):
            with self.subTest(private=private), self.assertRaises(ms.ModelScopeError):
                ms.api_to_model(model(private=private), AUTHOR)
        item = model()
        del item["private"]
        with self.assertRaises(ms.ModelScopeError):
            ms.api_to_model(item, AUTHOR)

    def test_invalid_author_never_sends_request(self):
        opener = Mock()
        for author in ("../x", "a/b", "a?b", "", None, "a\n", "a@b"):
            with self.subTest(author=author), self.assertRaises(ms.ModelScopeError):
                ms.fetch_models(author, opener=opener)
        opener.open.assert_not_called()


class PaginationTests(unittest.TestCase):
    def test_anonymous_verified_url_and_envelope(self):
        opener = opener_for(page())
        self.assertEqual(ms.fetch_models(AUTHOR, opener=opener), [ms.api_to_model(model(), AUTHOR)])
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url,
                         "https://www.modelscope.cn/openapi/v1/models?owner=isLinXu&page_number=1&page_size=50")
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)

    def test_all_pages_including_partial_last_page(self):
        for total in (50, 51, 100, 309, 3000):
            with self.subTest(total=total):
                opener = opener_for(*pages(total))
                result = ms.fetch_models(AUTHOR, opener=opener)
                self.assertEqual(len(result), total)
                self.assertEqual(len({item["id"] for item in result}), total)
                self.assertEqual(opener.open.call_count, (total + 49) // 50)
                for number, call in enumerate(opener.open.call_args_list, 1):
                    query = urllib.parse.parse_qs(urllib.parse.urlsplit(call.args[0].full_url).query)
                    self.assertEqual(query, {"owner": [AUTHOR], "page_number": [str(number)], "page_size": ["50"]})

    def test_empty_total_is_success(self):
        self.assertEqual(ms.fetch_models(AUTHOR, opener=opener_for(page([], 0))), [])

    def test_invalid_payloads_fail(self):
        for payload in (None, [], {}, {"success": 1, "data": page()["data"]},
                        {"success": False, "message": "secret"}, {"success": True, "data": []},
                        {"Success": True, "Data": page()["data"]}, page(models={}),
                        page(total_count=-1), page(total_count=True), page(total_count="1"),
                        page(total_count=1.0), page([None]), page([[]])):
            with self.subTest(payload=payload), self.assertRaises(ms.ModelScopeError):
                ms.fetch_models(AUTHOR, opener=opener_for(payload))

    def test_page_number_and_size_must_match_request(self):
        for field, value in (("page_number", 2), ("page_number", True), ("page_number", "1"),
                             ("page_size", 1), ("page_size", 100), ("page_size", "50"),
                             ("page_size", None)):
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ms.ModelScopeError, "page number"):
                ms.fetch_models(AUTHOR, opener=opener_for(page(**{field: value})))
        first, second = pages(51)
        second["data"]["page_number"] = 1
        with self.assertRaises(ms.ModelScopeError):
            ms.fetch_models(AUTHOR, opener=opener_for(first, second))

    def test_total_must_remain_constant(self):
        first, second = pages(51)
        second["data"]["total_count"] = 50
        with self.assertRaisesRegex(ms.ModelScopeError, "totals changed"):
            ms.fetch_models(AUTHOR, opener=opener_for(first, second))

    def test_short_oversized_and_empty_pages_fail(self):
        for payload in (page([], 1), page([model()], 0), page([model()], 51),
                        page([model(), model(1)], 1)):
            with self.subTest(payload=payload), self.assertRaisesRegex(ms.ModelScopeError, "incomplete"):
                ms.fetch_models(AUTHOR, opener=opener_for(payload))
        with self.assertRaises(ms.ModelScopeError):
            ms.fetch_models(AUTHOR, opener=opener_for(pages(51)[0], page([], 51, 2)))

    def test_duplicates_are_not_counted_twice(self):
        first, second = pages(51)
        first["data"]["models"][-1] = model(0)
        with self.assertRaisesRegex(ms.ModelScopeError, "unique model count"):
            ms.fetch_models(AUTHOR, opener=opener_for(first, second))

    def test_repeated_page_is_nonprogress(self):
        first, second = pages(100)
        second["data"]["models"] = first["data"]["models"]
        with self.assertRaisesRegex(ms.ModelScopeError, "no progress"):
            ms.fetch_models(AUTHOR, opener=opener_for(first, second))

    def test_duplicate_still_validates_privacy(self):
        first, second = pages(51)
        second["data"]["models"] = [model(0, private=True)]
        with self.assertRaisesRegex(ms.ModelScopeError, "public"):
            ms.fetch_models(AUTHOR, opener=opener_for(first, second))

    def test_page_cap_cannot_publish_incomplete_listing(self):
        for total, cap in ((3001, 60), (51, 1)):
            opener = opener_for(page([model(i) for i in range(50)], total))
            with self.subTest(total=total), self.assertRaisesRegex(ms.ModelScopeError, "page limit"):
                ms.fetch_models(AUTHOR, opener=opener, max_pages=cap)
            self.assertEqual(opener.open.call_count, 1)
        for cap in (0, 61, True, 1.5):
            with self.assertRaises(ms.ModelScopeError):
                ms.fetch_models(AUTHOR, opener=Mock(), max_pages=cap)

    def test_later_transport_failure_never_returns_partial_results(self):
        opener = opener_for(pages(51)[0])
        opener.open.side_effect = [Response(pages(51)[0]), OSError("secret response body")]
        with self.assertRaises(OSError):
            ms.fetch_models(AUTHOR, opener=opener)


class TransportTests(unittest.TestCase):
    def test_private_opener_ignores_ambient_credentials_and_proxies(self):
        ambient = {"MODELSCOPE_API_TOKEN": "do-not-use", "MODELSCOPE_TOKEN": "do-not-use",
                   "GITHUB_TOKEN": "do-not-use", "HF_TOKEN": "do-not-use",
                   "HTTP_PROXY": "http://user:secret@proxy.invalid", "HTTPS_PROXY": "http://proxy.invalid"}
        native_builder = urllib.request.build_opener
        with patch.dict(os.environ, ambient), \
                patch.object(ms.urllib.request, "build_opener", wraps=native_builder) as builder, \
                patch.object(ms.urllib.request, "urlopen", side_effect=AssertionError("global opener used")), \
                patch.object(ms.urllib.request, "install_opener", side_effect=AssertionError("global opener changed")), \
                patch.object(ms.urllib.request.OpenerDirector, "open", return_value=Response(page())) as opened:
            ms.fetch_models(AUTHOR)
        handlers = builder.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], ms._NoRedirects)
        request = opened.call_args.args[0]
        self.assertEqual(dict(request.header_items()),
                         {"Accept": "application/json", "User-agent": "Model-Observatory/1.0"})
        self.assertLessEqual(opened.call_args.kwargs["timeout"], 20)
        self.assertGreater(opened.call_args.kwargs["timeout"], 0)

    def test_redirects_rejected_without_followup(self):
        for code in (301, 302, 303, 307, 308):
            handler = ms._NoRedirects()
            handler.parent = Mock()
            response = Response(b"secret")
            with self.subTest(code=code), self.assertRaisesRegex(ms.ModelScopeError, "redirects"):
                handler.http_error_302(urllib.request.Request(ms.MODELS_API), response, code,
                                       "secret", {"location": "https://evil.invalid"})
            handler.parent.open.assert_not_called()
            self.assertTrue(response.closed)

    def test_http_errors_are_closed_without_reading_the_body(self):
        body = Mock()
        error = urllib.error.HTTPError(ms.MODELS_API, 403, "secret", {}, body)
        with self.assertRaises(urllib.error.HTTPError):
            ms.http_get_json(Mock(open=Mock(side_effect=error)), ms.MODELS_API, float("inf"))
        body.read.assert_not_called()
        body.close.assert_called_once()
        self.assertEqual(ms.safe_error(error), "ModelScope HTTP 403.")

    def test_json_and_http_status_fail_closed(self):
        for response in (Response(b"not json secret"), Response(b"\xff"), Response({}, 204)):
            with self.subTest(response=response), self.assertRaises(ms.ModelScopeError):
                ms.http_get_json(Mock(open=Mock(return_value=response)), ms.MODELS_API, float("inf"))
            self.assertTrue(response.closed)

    def test_response_size_bounded_and_exact_limit_allowed(self):
        self.assertEqual(ms.RESPONSE_LIMIT, 8 * 1024 * 1024)
        with patch.object(ms, "RESPONSE_LIMIT", 32):
            self.assertEqual(ms.http_get_json(opener_for(b"{}" + b" " * 30), ms.MODELS_API, float("inf")), {})
            with self.assertRaisesRegex(ms.ModelScopeError, "size limit"):
                ms.http_get_json(opener_for(b"{}" + b" " * 31), ms.MODELS_API, float("inf"))

    def test_expired_overall_budget_does_not_open(self):
        opener = Mock()
        with patch.object(ms.time, "monotonic", return_value=121), self.assertRaisesRegex(ms.ModelScopeError, "time budget"):
            ms.http_get_json(opener, ms.MODELS_API, 120)
        opener.open.assert_not_called()

    def test_remaining_budget_tightens_open_and_socket_timeouts(self):
        response = Response({})
        opener = Mock(open=Mock(return_value=response))
        with patch.object(ms.time, "monotonic", return_value=118):
            ms.http_get_json(opener, ms.MODELS_API, 120)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 2)
        response.socket.settimeout.assert_called_with(2)

    def test_trickle_response_cannot_reset_request_budget(self):
        response = Response({})
        with patch.object(ms.time, "monotonic", side_effect=[0, 0, 1, 21]), \
                self.assertRaisesRegex(ms.ModelScopeError, "time budget"):
            ms.http_get_json(Mock(open=Mock(return_value=response)), ms.MODELS_API, 120)
        response.socket.settimeout.assert_called_once_with(19)
        self.assertTrue(response.closed)

    def test_errors_do_not_expose_bodies_urls_or_credentials(self):
        for error in (RuntimeError("token=secret"), ValueError("https://user:secret@proxy/"),
                      urllib.error.URLError("secret"), ms.ModelScopeError("secret"),
                      urllib.error.HTTPError("https://secret", 403, "secret", {}, io.BytesIO(b"secret"))):
            with self.subTest(error=type(error)):
                self.assertNotIn("secret", ms.safe_error(error))
            if isinstance(error, urllib.error.HTTPError):
                error.close()
        self.assertEqual(ms.safe_error(TimeoutError("secret")), ms.ERROR_MESSAGES["timeout"])


class ProfileTests(unittest.TestCase):
    def test_exact_public_shape_and_followers_not_likes(self):
        opener = opener_for(profile_payload())
        self.assertEqual(ms.fetch_profile(AUTHOR, at(), opener=opener), profile())
        self.assertEqual(opener.open.call_args.args[0].full_url,
                         "https://www.modelscope.cn/api/v1/profile/isLinXu")

    def test_optional_profile_counters_do_not_become_zero(self):
        payload = profile_payload()
        payload["Data"]["User"] = {"Stars": 0, "Downloads": "538776"}
        payload["Data"]["Model"] = {}
        result = ms.fetch_profile(AUTHOR, at(), opener=opener_for(payload))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["followers"], 0)
        self.assertIsNone(result["downloads"])
        self.assertIsNone(result["model_count"])

    def test_profile_failures_are_unavailable_and_sanitized(self):
        invalid = [None, [], {}, {"Code": 200, "Success": 1},
                   {"Code": "200", "Success": True}, {"Code": 500, "Success": True},
                   {"Code": 200, "Success": True, "Data": {"User": [], "Model": {}}}]
        for payload in invalid:
            with self.subTest(payload=payload):
                result = ms.fetch_profile(AUTHOR, at(), opener=opener_for(payload))
                self.assertEqual(result, ms.unavailable_profile(ms.ERROR_MESSAGES["profile"]))
        result = ms.fetch_profile(AUTHOR, at(), opener=Mock(open=Mock(side_effect=OSError("secret"))))
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["captured_at"])
        self.assertNotIn("secret", result["error"])


class HistoryTests(unittest.TestCase):
    def test_compact_counters_null_zero_and_same_day_replace(self):
        models = [ms.api_to_model(model(downloads=0, likes=None), AUTHOR)]
        history = ms.update_history(ms.empty_history(AUTHOR, at()), models, 0, at())
        self.assertEqual(history["snapshots"], [{"date": "2026-10-21", "captured_at": ms.timestamp(at()),
                                               "models": {"isLinXu/model-0": [0, None]}, "followers": 0}])
        later = at(hour=4)
        history = ms.update_history(history, [], None, later)
        self.assertEqual(len(history["snapshots"]), 1)
        self.assertEqual(history["snapshots"][0]["models"], {})
        self.assertIsNone(history["snapshots"][0]["followers"])
        self.assertEqual(history["updated_at"], ms.timestamp(later))

    def test_utc_day_not_local_day(self):
        local = dt.datetime.fromisoformat("2026-10-22T01:00:00+08:00")
        history = ms.update_history(ms.empty_history(AUTHOR, local), [], None, local)
        self.assertEqual(history["snapshots"][0]["date"], "2026-10-21")
        self.assertEqual(history["snapshots"][0]["captured_at"], "2026-10-21T17:00:00Z")
        with self.assertRaises(ValueError):
            ms.timestamp(dt.datetime(2026, 10, 21))

    def test_400_day_retention_including_today(self):
        today = at()
        start = today - dt.timedelta(days=405)
        history = ms.empty_history(AUTHOR, start)
        for offset in range(406):
            history = ms.update_history(history, [], None, start + dt.timedelta(days=offset))
        self.assertEqual(len(history["snapshots"]), 400)
        self.assertEqual(history["snapshots"][0]["date"], (today.date() - dt.timedelta(days=399)).isoformat())
        self.assertEqual(history["snapshots"][-1]["date"], today.date().isoformat())

    def test_history_rejects_older_day_or_same_day_timestamp(self):
        history = ms.update_history(ms.empty_history(AUTHOR, at()), [], None, at())
        for earlier in (at("2026-10-20"), at(hour=1)):
            with self.subTest(earlier=earlier), self.assertRaisesRegex(ValueError, "older"):
                ms.update_history(history, [], None, earlier)

    def test_history_checks_every_snapshot_and_updated_at(self):
        history = ms.update_history(ms.empty_history(AUTHOR, at()), [], None, at())
        history["updated_at"] = ms.timestamp(at(hour=4))
        with self.assertRaisesRegex(ValueError, "older"):
            ms.update_history(history, [], None, at(hour=3))
        history["snapshots"].append({"date": "2026-10-20", "captured_at": ms.timestamp(at("2026-10-20")),
                                     "models": {}, "followers": None})
        result = ms.update_history(history, [], None, at("2026-10-22"))
        self.assertEqual([s["date"] for s in result["snapshots"]], ["2026-10-20", "2026-10-21", "2026-10-22"])


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name)
        self.latest_path = self.data_dir / "modelscope.json"
        self.history_path = self.data_dir / "modelscope_history.json"
        # Every collector test is offline, even if an intended mock is missed.
        self.opener_patch = patch.object(ms, "anonymous_opener", side_effect=AssertionError("Unexpected network request"))
        self.opener_patch.start()
        self.addCleanup(self.opener_patch.stop)

    def seed(self, when=None, models=None):
        when = when or at()
        account = {**profile(), "captured_at": ms.timestamp(when)}
        ms.save(self.data_dir, AUTHOR, [ms.api_to_model(model(), AUTHOR)] if models is None else models, account, when)

    def latest(self):
        return json.loads(self.latest_path.read_text())

    def history(self):
        return json.loads(self.history_path.read_text())

    def test_collect_separates_profile_310_from_openapi_309(self):
        with patch.object(ms, "anonymous_opener", return_value=opener_for(*pages(309), profile_payload())):
            self.assertEqual(ms.collect(self.data_dir, AUTHOR, at()), "ok")
        latest = self.latest()
        self.assertEqual(latest["schema_version"], 1)
        self.assertEqual(latest["author"], AUTHOR)
        self.assertEqual(latest["metric_source"], "modelscope-openapi-v1")
        self.assertIsNone(latest["error"])
        self.assertEqual(len(latest["models"]), 309)
        self.assertEqual(latest["profile"]["model_count"], 310)
        self.assertEqual(latest["profile"]["downloads"], 538776)
        self.assertEqual(sum(m["downloads"] for m in latest["models"]), 309 * 349)
        snapshot = self.history()["snapshots"][0]
        self.assertEqual(len(snapshot["models"]), 309)
        self.assertEqual(snapshot["followers"], 13)

    def test_profile_transport_failure_preserves_good_models(self):
        self.seed(at("2026-10-20"))
        opener = Mock(open=Mock(side_effect=[Response(page()), OSError("private token secret")]))
        with patch.object(ms, "anonymous_opener", return_value=opener):
            self.assertEqual(ms.collect(self.data_dir, AUTHOR, at()), "ok")
        self.assertEqual(self.latest()["models"], [ms.api_to_model(model(), AUTHOR)])
        self.assertEqual(self.latest()["profile"]["status"], "unavailable")
        self.assertIsNone(self.latest()["profile"]["followers"])
        self.assertNotIn("secret", self.latest_path.read_text())
        self.assertEqual(len(self.history()["snapshots"]), 2)
        self.assertIsNone(self.history()["snapshots"][-1]["followers"])

    def test_profile_and_models_share_overall_deadline_and_opener(self):
        opener = Mock()
        with patch.object(ms, "anonymous_opener", return_value=opener), \
                patch.object(ms.time, "monotonic", return_value=10), \
                patch.object(ms, "fetch_models", return_value=[]) as models, \
                patch.object(ms, "fetch_profile", return_value=ms.unavailable_profile()) as account:
            self.assertEqual(ms.collect(self.data_dir, AUTHOR, at()), "ok")
        self.assertEqual(models.call_args.kwargs, {"opener": opener, "deadline": 130})
        self.assertEqual(account.call_args.kwargs, {"opener": opener, "deadline": 130})

    def test_late_page_failure_preserves_capture_and_byte_exact_history(self):
        self.seed(at("2026-10-20"))
        previous = self.latest()
        history_bytes = self.history_path.read_bytes()
        opener = Mock(open=Mock(side_effect=[Response(pages(51)[0]), OSError("secret")]))
        with patch.object(ms, "anonymous_opener", return_value=opener):
            self.assertEqual(ms.collect(self.data_dir, AUTHOR, at()), "stale")
        latest = self.latest()
        self.assertEqual(latest["status"], "stale")
        for key in ("models", "captured_at", "date", "profile"):
            self.assertEqual(latest[key], previous[key])
        self.assertEqual(self.history_path.read_bytes(), history_bytes)
        self.assertNotIn("secret", self.latest_path.read_text())
        self.assertEqual(opener.open.call_count, 2)  # Do not fetch profile after listing failure.
        ms.collect(self.data_dir, AUTHOR, at("2026-10-22"))
        self.assertEqual(self.latest()["captured_at"], previous["captured_at"])
        self.assertEqual(self.history_path.read_bytes(), history_bytes)

    def test_invalid_late_identity_and_privacy_are_atomic(self):
        self.seed(at("2026-10-20"))
        previous = self.latest()["models"]
        history_bytes = self.history_path.read_bytes()
        for item in (model(id="other/model"), model(private=True), model(private=None)):
            with self.subTest(item=item):
                first, second = pages(51)
                second["data"]["models"] = [item]
                with patch.object(ms, "anonymous_opener", return_value=opener_for(first, second)):
                    self.assertEqual(ms.collect(self.data_dir, AUTHOR, at()), "stale")
                self.assertEqual(self.latest()["models"], previous)
                self.assertEqual(self.history_path.read_bytes(), history_bytes)

    def test_first_failure_initializes_loadable_empty_files(self):
        self.assertEqual(ms.collect(self.data_dir, AUTHOR, at()), "unavailable")
        latest = self.latest()
        self.assertEqual(latest["models"], [])
        self.assertIsNone(latest["captured_at"])
        self.assertIsNone(latest["date"])
        self.assertEqual(latest["profile"]["status"], "unavailable")
        self.assertEqual(self.history(), ms.empty_history(AUTHOR, at()))
        before = self.history_path.read_bytes()
        self.assertEqual(ms.collect(self.data_dir, AUTHOR, at("2026-10-22")), "unavailable")
        self.assertEqual(self.history_path.read_bytes(), before)

    def test_empty_success_is_complete_and_can_be_stale(self):
        with patch.object(ms, "anonymous_opener", return_value=opener_for(page([], 0), profile_payload())):
            self.assertEqual(ms.collect(self.data_dir, AUTHOR, at()), "ok")
        self.assertEqual(self.latest()["models"], [])
        self.assertEqual(len(self.history()["snapshots"]), 1)
        self.assertEqual(ms.collect(self.data_dir, AUTHOR, at("2026-10-22")), "stale")
        self.assertEqual(self.latest()["date"], "2026-10-21")

    def test_older_writes_never_modify_either_file(self):
        self.seed()
        original = (self.latest_path.read_bytes(), self.history_path.read_bytes())
        for earlier in (at("2026-10-20"), at(hour=1)):
            for error in (None, "ModelScope collection failed."):
                with self.subTest(earlier=earlier, error=error), self.assertRaisesRegex(ValueError, "older"):
                    ms.save(self.data_dir, AUTHOR, [], profile(), earlier, error=error)
                self.assertEqual((self.latest_path.read_bytes(), self.history_path.read_bytes()), original)

    def test_latest_timestamp_guards_even_when_history_missing(self):
        self.seed()
        self.history_path.unlink()
        original = self.latest_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "older"):
            ms.save(self.data_dir, AUTHOR, [], profile(), at(hour=1))
        self.assertEqual(self.latest_path.read_bytes(), original)
        self.assertFalse(self.history_path.exists())

    def test_history_schema_author_and_source_mismatch_block_all_writes(self):
        self.seed()
        latest_bytes = self.latest_path.read_bytes()
        original = self.history()
        for key, value in (("schema_version", 2), ("schema_version", True), ("author", "other"),
                           ("metric_source", "modelscope-profile")):
            for error in (None, "ModelScope collection failed."):
                with self.subTest(key=key, error=error):
                    self.history_path.write_text(json.dumps({**original, key: value}))
                    before = self.history_path.read_bytes()
                    with self.assertRaisesRegex(ValueError, "incompatible"):
                        ms.save(self.data_dir, AUTHOR, [], profile(), at("2026-10-22"), error=error)
                    self.assertEqual(self.history_path.read_bytes(), before)
                    self.assertEqual(self.latest_path.read_bytes(), latest_bytes)

    def test_corrupt_history_is_not_overwritten(self):
        self.seed()
        latest_bytes = self.latest_path.read_bytes()
        for text in ("{broken secret", "[]", "null"):
            self.history_path.write_text(text)
            with self.assertRaises(ValueError):
                ms.collect(self.data_dir, AUTHOR, at("2026-10-22"))
            self.assertEqual(self.history_path.read_text(), text)
            self.assertEqual(self.latest_path.read_bytes(), latest_bytes)

    def test_invalid_history_snapshots_are_not_silently_dropped(self):
        self.seed()
        original = self.history()
        variants = []
        for key, value in (("models", {"other/model": [1, 2]}), ("models", {"isLinXu/a": [1]}),
                           ("models", {"isLinXu/a": [False, 2]}), ("followers", "13"),
                           ("date", "2026-10-20"), ("captured_at", "invalid")):
            history = copy.deepcopy(original)
            history["snapshots"][0][key] = value
            variants.append(history)
        history = copy.deepcopy(original)
        history["snapshots"].append(history["snapshots"][0])
        variants.append(history)
        for history in variants:
            with self.subTest(history=history):
                self.history_path.write_text(json.dumps(history))
                before = self.history_path.read_bytes()
                with self.assertRaises(ValueError):
                    ms.collect(self.data_dir, AUTHOR, at("2026-10-22"))
                self.assertEqual(self.history_path.read_bytes(), before)

    def test_incompatible_latest_is_never_reused_as_stale(self):
        self.seed()
        original = self.latest()
        history_bytes = self.history_path.read_bytes()
        for key, value in (("author", "other"), ("schema_version", 2),
                           ("metric_source", "different"), ("models", None), ("captured_at", None)):
            with self.subTest(key=key):
                self.latest_path.write_text(json.dumps({**original, key: value}))
                self.assertEqual(ms.collect(self.data_dir, AUTHOR, at("2026-10-22")), "unavailable")
                self.assertEqual(self.latest()["models"], [])
                self.assertIsNone(self.latest()["date"])
                self.assertEqual(self.latest()["author"], AUTHOR)
                self.assertEqual(self.history_path.read_bytes(), history_bytes)

    def test_unrelated_partial_files_are_not_deleted(self):
        partial = self.data_dir / ".partial-unrelated.json"
        partial.write_text("owned by another collector")
        ms.collect(self.data_dir, AUTHOR, at())
        self.assertEqual(partial.read_text(), "owned by another collector")
        self.assertEqual(list(self.data_dir.glob(".partial-*.json")), [partial])

    def test_cli_exit_status_and_safe_storage_error(self):
        with patch.object(ms.sys, "argv", ["collect_modelscope.py", "--data-dir", str(self.data_dir)]), \
                patch.object(ms, "collect", return_value="ok") as collect, patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(ms.main(), 0)
            collect.assert_called_once_with(self.data_dir.resolve(), AUTHOR)
        with patch.object(ms.sys, "argv", ["collect_modelscope.py"]), \
                patch.object(ms, "collect", return_value="stale"), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(ms.main(), 1)
        with patch.object(ms.sys, "argv", ["collect_modelscope.py"]), \
                patch.object(ms, "collect", side_effect=ValueError("secret")), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(ms.main(), 1)
            self.assertNotIn("secret", stderr.getvalue())


class BuildTests(unittest.TestCase):
    def test_modelscope_files_optional_and_copied_when_present(self):
        from scripts import build

        # Redirect every build path into a temporary tree; never touch site/ or _site/.
        for present in (False, True):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "site").mkdir()
                (root / "data").mkdir()
                (root / "site" / "index.html").write_text("test")
                for name in ("latest.json", "history.json"):
                    (root / "data" / name).write_text("{}")
                optional = ("modelscope.json", "modelscope_history.json")
                if present:
                    for name in optional:
                        (root / "data" / name).write_text('{"schema_version":1}')
                with patch.object(build, "ROOT", root), patch.object(build, "SITE", root / "site"), \
                        patch.object(build, "OUTPUT", root / "output"), patch("sys.stdout", new_callable=io.StringIO):
                    build.build()
                for name in optional:
                    destination = root / "output" / "data" / name
                    self.assertEqual(destination.exists(), present)
                    if present:
                        self.assertEqual(destination.read_bytes(), (root / "data" / name).read_bytes())


if __name__ == "__main__":
    unittest.main()
