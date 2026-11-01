import copy
import datetime as dt
import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import collect_conferences as cf

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ccfddl_allconf.json"


def at(day="2026-10-21", hour=2):
    return dt.datetime.fromisoformat(f"{day}T{hour:02}:23:00+00:00")


def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def normalized(payload=None):
    return cf.normalize_payload(fixture() if payload is None else payload)


def conference(key="AI/x", **fields):
    value = {"conference_key": key, "title": "X", "sub": key.split("/", 1)[0],
             "confs": [edition()]}
    value.update(fields)
    return value


def edition(**fields):
    value = {"id": "x26", "year": 2026, "timezone": "UTC",
             "timeline": [{"deadline": "2026-01-01 00:00:00"}]}
    value.update(fields)
    return value


def normalize_one(item):
    conferences, warnings = cf.normalize_payload([item])
    return conferences[0], warnings


def find(conferences, key):
    return next(conference for conference in conferences if conference["key"] == key)


def find_edition(conference, edition_id):
    return next(edition for edition in conference["editions"] if edition["id"] == edition_id)


def find_event(edition, kind, round_no=1):
    return next(event for event in edition["events"]
                if event["kind"] == kind and event["round"] == round_no)


def event(value="2026-01-01 00:00:00", timezone="UTC", **fields):
    fields.setdefault("event_id", "AI/x:x26:paper:1")
    fields.setdefault("kind", "paper")
    fields.setdefault("round_no", 1)
    fields.setdefault("year", 2026)
    fields.setdefault("comment", "")
    return cf.normalize_event(value, timezone, **fields)


class Response(io.BytesIO):
    def __init__(self, payload, status=200, headers=None):
        super().__init__(payload if isinstance(payload, bytes)
                         else json.dumps(payload).encode("utf-8"))
        self.status = status
        self.headers = headers if headers is not None else Message()


def opener_for(*responses):
    return Mock(open=Mock(side_effect=list(responses)))


def headers(**values):
    message = Message()
    for name, value in values.items():
        message[name] = value
    return message


class TimestampTests(unittest.TestCase):
    def test_naive_capture_time_is_rejected(self):
        with self.assertRaises(ValueError):
            cf.utc(dt.datetime(2026, 1, 1))
        with self.assertRaises(ValueError):
            cf.timestamp(dt.datetime(2026, 1, 1))

    def test_timestamp_is_utc_with_z_suffix(self):
        moment = dt.datetime(2026, 1, 1, 2, 3, 4, tzinfo=dt.timezone(dt.timedelta(hours=8)))
        self.assertEqual(cf.timestamp(moment), "2025-12-31T18:03:04Z")
        self.assertEqual(cf.timestamp(dt.datetime(2026, 1, 1, 2, 3, 4, tzinfo=dt.timezone.utc)),
                         "2026-01-01T02:03:04Z")


class TimezoneTests(unittest.TestCase):
    def offset(self, name, when=dt.datetime(2026, 1, 1, 12)):
        zone = cf.parse_timezone(name)
        return zone.utcoffset(when.replace(tzinfo=zone))

    def test_fixed_labels(self):
        cases = {
            "AoE": dt.timedelta(hours=-12),
            "UTC": dt.timedelta(0),
            "UTC+0": dt.timedelta(0),
            "UTC-0": dt.timedelta(0),
            "UTC+8": dt.timedelta(hours=8),
            "UTC-5": dt.timedelta(hours=-5),
            "UTC-12": dt.timedelta(hours=-12),
            "UTC+14": dt.timedelta(hours=14),
            "UTC+14:00": dt.timedelta(hours=14),
            "UTC+05:30": dt.timedelta(hours=5, minutes=30),
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(self.offset(name), expected)

    def test_invalid_labels_stay_unresolved(self):
        for name in ("UTC+15", "UTC+14:01", "UTC+8:60", "UTC8", "Mars/Olympus",
                     "", "   ", None, 8, ["UTC"]):
            with self.subTest(name=name):
                self.assertIsNone(cf.parse_timezone(name))

    def test_pt_observes_daylight_saving(self):
        summer = self.offset("PT", dt.datetime(2026, 7, 1, 12))
        winter = self.offset("PT", dt.datetime(2026, 1, 1, 12))
        self.assertEqual(summer, dt.timedelta(hours=-7))
        self.assertEqual(winter, dt.timedelta(hours=-8))


class EventTests(unittest.TestCase):
    def test_unknown_offsets_are_converted_to_utc(self):
        cases = [
            ("AoE", "2025-11-13 23:59:59", "2025-11-14T11:59:59Z", -720),
            ("PT", "2026-11-13 23:59:59", "2026-11-14T07:59:59Z", -480),
            ("PT", "2026-07-01 12:00:00", "2026-07-01T19:00:00Z", -420),
            ("UTC-12", "2026-08-15 23:59:59", "2026-08-16T11:59:59Z", -720),
            ("UTC+8", "2027-01-15 23:59:59", "2027-01-15T15:59:59Z", 480),
            ("UTC-5", "2026-12-01 23:59:59", "2026-12-02T04:59:59Z", -300),
            ("UTC", "2026-10-15 23:59:59", "2026-10-15T23:59:59Z", 0),
        ]
        for timezone, value, expected, offset in cases:
            with self.subTest(timezone=timezone, value=value):
                result = event(value, timezone)
                self.assertEqual(result["utc"], expected)
                self.assertEqual(result["offset_minutes"], offset)
                self.assertEqual(result["time_status"], "ok")
                self.assertFalse(result["tbd"])
                self.assertEqual(result["source_local"], value)
                self.assertEqual(result["timezone"], timezone)

    def test_iso_separator_is_accepted(self):
        self.assertEqual(event("2026-11-13T23:59:59")["utc"], "2026-11-13T23:59:59Z")

    def test_tbd_is_preserved_without_a_guess(self):
        for value in ("TBD", " tbd "):
            with self.subTest(value=value):
                result = event(value)
                self.assertTrue(result["tbd"])
                self.assertEqual(result["time_status"], "tbd")
                self.assertEqual(result["source_local"], "TBD")
                self.assertIsNone(result["utc"])
                self.assertIsNone(result["offset_minutes"])

    def test_invalid_date_and_unknown_timezone_are_distinct(self):
        invalid = event("not-a-date", "UTC")
        self.assertEqual(invalid["time_status"], "invalid_time")
        self.assertIsNone(invalid["utc"])
        self.assertFalse(invalid["tbd"])

        unknown = event("2027-02-01 23:59:59", "Mars/Olympus")
        self.assertEqual(unknown["time_status"], "unknown_timezone")
        self.assertIsNone(unknown["utc"])

        precedence = event("not-a-date", "Mars/Olympus")
        self.assertEqual(precedence["time_status"], "invalid_time")

    def test_metadata_is_truncated_and_preserved(self):
        result = event("2026-01-01 00:00:00", "UTC", kind="abstract",
                       round_no=3, year=2027, comment="c" * 600,
                       event_id="AI/x:x26:abstract:3")
        self.assertEqual(result["id"], "AI/x:x26:abstract:3")
        self.assertEqual(result["kind"], "abstract")
        self.assertEqual(result["round"], 3)
        self.assertEqual(result["year"], 2027)
        self.assertEqual(len(result["comment"]), 500)

        long_timezone = event("2026-01-01 00:00:00", "z" * 50)
        self.assertEqual(long_timezone["timezone"], "z" * 40)
        self.assertEqual(long_timezone["time_status"], "unknown_timezone")

        long_value = event("x" * 200)
        self.assertEqual(len(long_value["source_local"]), 64)
        self.assertEqual(long_value["time_status"], "invalid_time")


class NormalizeFixtureTests(unittest.TestCase):
    def setUp(self):
        self.conferences, self.warnings = normalized()

    def test_summary_counts(self):
        self.assertEqual(cf.summarize(self.conferences), {
            "conferences": 6, "editions": 7, "events": 17, "paper_events": 10,
            "tbd": 2, "unknown_timezone": 1, "invalid_time": 1,
        })

    def test_conferences_are_sorted_by_key_and_duplicate_titles_are_distinct(self):
        self.assertEqual([conference["key"] for conference in self.conferences],
                         ["AI/aaai", "AI/cvpr", "DB/vldb", "SC/ih&mmsec",
                          "SC/sec", "SE/sec"])
        secs = [conference for conference in self.conferences if conference["title"] == "SEC"]
        self.assertEqual([conference["key"] for conference in secs], ["SC/sec", "SE/sec"])

    def test_ampersand_key_is_accepted(self):
        conference = find(self.conferences, "SC/ih&mmsec")
        self.assertEqual(conference["area"], "SC")
        self.assertEqual(conference["title"], "IH&MMSec")

    def test_editions_are_sorted_and_ignore_derived_fields(self):
        cvpr = find(self.conferences, "AI/cvpr")
        self.assertEqual([edition["id"] for edition in cvpr["editions"]], ["cvpr26", "cvpr27"])
        self.assertNotIn("opening", cvpr["editions"][0])
        self.assertNotIn("opening_is_derived", cvpr["editions"][0])

    def test_aoe_and_pt_conversions(self):
        cvpr = find(self.conferences, "AI/cvpr")
        cvpr26 = find_edition(cvpr, "cvpr26")
        self.assertEqual(find_event(cvpr26, "abstract")["utc"], "2025-11-08T11:59:59Z")
        self.assertEqual(find_event(cvpr26, "paper")["utc"], "2025-11-14T11:59:59Z")
        self.assertEqual(find_event(cvpr26, "paper")["offset_minutes"], -720)

        cvpr27 = find_edition(cvpr, "cvpr27")
        self.assertEqual(find_event(cvpr27, "paper")["utc"], "2026-11-14T07:59:59Z")
        self.assertEqual(find_event(cvpr27, "paper")["offset_minutes"], -480)

    def test_edition_level_timezone_applies_to_every_point(self):
        aaai = find_edition(find(self.conferences, "AI/aaai"), "aaai26")
        self.assertEqual(find_event(aaai, "paper")["utc"], "2026-08-16T11:59:59Z")
        self.assertEqual(find_event(aaai, "paper", round_no=2)["utc"], "2026-09-16T11:59:59Z")
        self.assertEqual(find_event(aaai, "abstract")["utc"], "2026-08-02T11:59:59Z")

        sec = find_edition(find(self.conferences, "SC/sec"), "sec27")
        self.assertEqual(find_event(sec, "paper")["utc"], "2027-01-15T15:59:59Z")
        self.assertEqual(find_event(sec, "paper")["offset_minutes"], 480)

        sec_se = find_edition(find(self.conferences, "SE/sec"), "sec'27")
        self.assertEqual(find_event(sec_se, "paper")["utc"], "2026-12-02T04:59:59Z")

    def test_tbd_unknown_timezone_and_invalid_time_are_preserved(self):
        cvpr26 = find_edition(find(self.conferences, "AI/cvpr"), "cvpr26")
        tbd = find_event(cvpr26, "paper", round_no=2)
        self.assertTrue(tbd["tbd"])
        self.assertEqual(tbd["time_status"], "tbd")
        self.assertEqual(tbd["id"], "AI/cvpr:cvpr26:paper:2")
        self.assertIsNone(tbd["utc"])

        hidden = find_edition(find(self.conferences, "SC/ih&mmsec"), "ihmmsec27")
        unknown = find_event(hidden, "paper")
        self.assertEqual(unknown["time_status"], "unknown_timezone")
        self.assertEqual(unknown["timezone"], "Mars/Olympus")
        self.assertIsNone(unknown["utc"])
        invalid = find_event(hidden, "abstract", round_no=3)
        self.assertEqual(invalid["time_status"], "invalid_time")
        self.assertIsNone(invalid["utc"])

    def test_urls_places_and_ranks_are_handled(self):
        hidden = find_edition(find(self.conferences, "SC/ih&mmsec"), "ihmmsec27")
        self.assertIsNone(hidden["url"])
        self.assertIsNone(hidden["place"])

        sec_se = find_edition(find(self.conferences, "SE/sec"), "sec'27")
        self.assertEqual(sec_se["url"], "http://example.org/sec-se-2027")

        cvpr27 = find_edition(find(self.conferences, "AI/cvpr"), "cvpr27")
        self.assertEqual(cvpr27["place"], "TBD")

        vldb = find(self.conferences, "DB/vldb")
        self.assertEqual(vldb["rank"], {"ccf": "A", "core": "A*", "thcpl": "A"})
        self.assertIsNone(find(self.conferences, "SC/sec")["rank"]["thcpl"])

    def test_warnings_are_specific_and_deduplicated(self):
        self.assertEqual(self.warnings, [
            "SC/ih&mmsec/ihmmsec27: invalid edition URL",
            "SC/ih&mmsec/ihmmsec27: unsupported timezone",
            "SC/ih&mmsec/ihmmsec27: invalid deadline",
        ])

    def test_review_stage_events_keep_their_kind(self):
        vldb = find_edition(find(self.conferences, "DB/vldb"), "vldb26")
        self.assertEqual([event["kind"] for event in vldb["events"]],
                         ["paper", "rebuttal", "decision"])
        self.assertEqual(find_event(vldb, "decision", round_no=2)["utc"],
                         "2027-01-15T23:59:59Z")


class NormalizeValidationTests(unittest.TestCase):
    def test_payload_shape(self):
        for payload in ({}, None, "[]", 1):
            with self.subTest(payload=payload), self.assertRaises(cf.ConferenceError) as raised:
                cf.normalize_payload(payload)
            self.assertEqual(raised.exception.code, "schema")
        with self.assertRaises(cf.ConferenceError) as raised:
            cf.normalize_payload([])
        self.assertEqual(raised.exception.code, "empty")
        with self.assertRaises(cf.ConferenceError) as raised:
            cf.normalize_payload([1])
        self.assertEqual(raised.exception.code, "schema")

    def test_identity_and_display_fields(self):
        cases = [
            conference(key="AI/x", conference_key="ai/x"),
            conference(key="AI/x", title="   "),
            conference(key="AI/x", title=5),
            conference(key="AI/x", sub="SC"),
            conference(key="AI/x", confs=None),
            conference(key="AI/x", confs=()),
        ]
        for item in cases:
            with self.subTest(item=item), self.assertRaises(cf.ConferenceError) as raised:
                cf.normalize_payload([item])
            self.assertEqual(raised.exception.code, "schema")

    def test_conference_key_length_boundary(self):
        for key in ("AI/" + "a" * 64, "AI/" + "a" * 63):
            with self.subTest(length=len(key)):
                conferences, _ = cf.normalize_payload([conference(key=key)])
                self.assertEqual(conferences[0]["key"], key)
        with self.assertRaises(cf.ConferenceError):
            cf.normalize_payload([conference(key="AI/" + "a" * 65)])

    def test_duplicate_keys_fail_but_duplicate_titles_do_not(self):
        with self.assertRaises(cf.ConferenceError) as raised:
            cf.normalize_payload([
                conference(key="AI/a", confs=[edition(id="a26")]),
                conference(key="AI/a", confs=[edition(id="a27")]),
            ])
        self.assertEqual(raised.exception.code, "duplicate")

        conferences, warnings = cf.normalize_payload([
            conference(key="AI/a", title="SEC", confs=[edition(id="a26")]),
            conference(key="AI/b", title="SEC", confs=[edition(id="b26")]),
        ])
        self.assertEqual(len(conferences), 2)
        self.assertEqual(warnings, [])

    def test_edition_identity_and_year(self):
        with self.assertRaises(cf.ConferenceError) as raised:
            cf.normalize_payload([
                conference(key="AI/a", confs=[edition(id="dup")]),
                conference(key="AI/b", confs=[edition(id="dup")]),
            ])
        self.assertEqual(raised.exception.code, "duplicate_edition")

        for edition_id in ("", "bad id", "a" * 65, 5):
            with self.subTest(edition_id=edition_id), self.assertRaises(cf.ConferenceError):
                cf.normalize_payload([conference(confs=[edition(id=edition_id)])])

        for year in (True, False, 2026.0, "2026", None, 1899, 2201):
            with self.subTest(year=year), self.assertRaises(cf.ConferenceError) as raised:
                cf.normalize_payload([conference(confs=[edition(year=year)])])
            self.assertEqual(raised.exception.code, "year")

        for year in (1900, 2200):
            with self.subTest(year=year):
                cf.normalize_payload([conference(confs=[edition(year=year)])])

        value, _ = normalize_one(conference(confs=[edition(id="ifip119'21")]))
        self.assertEqual(value["editions"][0]["id"], "ifip119'21")

    def test_malformed_editions_and_timelines_are_contained(self):
        with self.assertRaises(cf.ConferenceError):
            cf.normalize_payload([conference(confs=["bad"])])

        conference_value, warnings = normalize_one(conference(confs=[]))
        self.assertEqual(conference_value["editions"], [])
        self.assertIn("AI/x: no editions", warnings)

        for timeline, warning in (({}, "malformed timeline"),
                                  ([1], "malformed timeline point")):
            with self.subTest(timeline=timeline):
                value, warnings = normalize_one(conference(confs=[edition(timeline=timeline)]))
                self.assertEqual(value["editions"][0]["events"], [])
                self.assertIn(f"AI/x/x26: {warning}", warnings)

        value, warnings = normalize_one(conference(confs=[edition(timeline=None)]))
        self.assertEqual(value["editions"][0]["events"], [])
        self.assertEqual(warnings, [])

        value, warnings = normalize_one(
            conference(confs=[edition(timeline=[{"deadline": 5, "abstract_deadline": None}])]))
        self.assertEqual(value["editions"][0]["events"], [])
        self.assertIn("AI/x/x26: deadline is not a string", warnings)

    def test_point_timezone_overrides_and_null_falls_back_to_edition(self):
        item = conference(confs=[edition(timezone="UTC", timeline=[
            {"deadline": "2026-01-01 08:00:00", "timezone": "UTC+8"},
            {"deadline": "2026-01-02 08:00:00", "timezone": None},
            {"deadline": "2026-01-03 08:00:00"},
        ])])
        value, warnings = normalize_one(item)
        events = value["editions"][0]["events"]
        self.assertEqual([event["time_status"] for event in events], ["ok", "ok", "ok"])
        self.assertEqual([event["utc"] for event in events], [
            "2026-01-01T00:00:00Z", "2026-01-02T08:00:00Z", "2026-01-03T08:00:00Z",
        ])
        self.assertEqual(warnings, [])

    def test_urls_dates_places_and_ranks_are_normalized(self):
        self.assertEqual(cf._safe_url("https://example.org/x"), "https://example.org/x")
        self.assertEqual(cf._safe_url("http://example.org/x"), "http://example.org/x")
        for value in ("javascript:alert(1)", "ftp://example.org/x", "//example.org/x",
                      "https://", "", "  ", None, 5, "https://example.org/" + "a" * 2050,
                      "https://example.org/\x00"):
            with self.subTest(value=value):
                self.assertIsNone(cf._safe_url(value))

        value, warnings = normalize_one(conference(confs=[
            edition(link="javascript:alert(1)", date="d" * 250, place="  ")]))
        edition_value = value["editions"][0]
        self.assertIsNone(edition_value["url"])
        self.assertEqual(len(edition_value["date"]), 200)
        self.assertIsNone(edition_value["place"])
        self.assertIn("AI/x/x26: invalid edition URL", warnings)

        value, warnings = normalize_one(conference(
            rank={"ccf": "A", "core": None, "thcpl": 5}, description=None, dblp="d" * 100))
        self.assertEqual(value["rank"], {"ccf": "A", "core": None, "thcpl": None})
        self.assertEqual(value["description"], "")
        self.assertEqual(len(value["dblp"]), 80)
        self.assertEqual(warnings, [])

        value, _ = normalize_one(conference(rank="A", dblp=None))
        self.assertEqual(value["rank"], {"ccf": None, "core": None, "thcpl": None})
        self.assertIsNone(value["dblp"])

    def test_warning_count_is_bounded(self):
        warnings = []
        cf._add_warning(warnings, "same")
        cf._add_warning(warnings, "same")
        self.assertEqual(warnings, ["same"])

        warnings = []
        with patch.object(cf, "MAX_WARNINGS", 2):
            for index in range(5):
                cf._add_warning(warnings, f"warning {index}")
        self.assertEqual(warnings, ["warning 0", "warning 1",
                                    "additional warnings suppressed"])


class ChangeTests(unittest.TestCase):
    def setUp(self):
        self.conferences, _ = normalized()

    def previous(self):
        return {"captured_at": "2026-10-20T02:23:00Z",
                "conferences": copy.deepcopy(self.conferences)}

    def test_initial_and_unchanged(self):
        self.assertEqual(cf.compare_changes(None, self.conferences), {
            "status": "initial", "added": 0, "updated": 0, "removed": 0,
            "previous_captured_at": None,
        })
        self.assertEqual(cf.compare_changes(self.previous(), self.conferences), {
            "status": "compared", "added": 0, "updated": 0, "removed": 0,
            "previous_captured_at": "2026-10-20T02:23:00Z",
        })

    def test_added_updated_and_removed(self):
        previous = self.previous()
        current = copy.deepcopy(self.conferences)
        current[0]["editions"][0]["events"][0]["comment"] = "changed"
        del current[-1]["editions"][-1]["events"][-1]
        current[0]["editions"][0]["events"].append(cf.normalize_event(
            "2026-08-20 23:59:59", "UTC", event_id="AI/aaai:aaai26:paper:9",
            kind="paper", round_no=9, year=2026, comment="new"))
        self.assertEqual(cf.compare_changes(previous, current), {
            "status": "compared", "added": 1, "updated": 1, "removed": 1,
            "previous_captured_at": "2026-10-20T02:23:00Z",
        })

    def test_malformed_previous_events_are_ignored(self):
        previous = {"captured_at": 5, "conferences": [
            {"editions": [{"events": [{"kind": "paper"}, 5, {"id": "AI/x:x26:paper:1"}]}]},
            {}, 5,
        ]}
        self.assertEqual(cf.compare_changes(previous, self.conferences), {
            "status": "compared", "added": 17, "updated": 0, "removed": 1,
            "previous_captured_at": None,
        })

    def test_digest_is_stable_and_content_sensitive(self):
        first = cf.digest(self.conferences)
        self.assertTrue(first.startswith("sha256:"))
        self.assertEqual(first, cf.digest(copy.deepcopy(self.conferences)))
        self.assertEqual(cf.digest([{"a": 1, "b": 2}]), cf.digest([{"b": 2, "a": 1}]))
        changed = copy.deepcopy(self.conferences)
        changed[0]["title"] = "Changed"
        self.assertNotEqual(first, cf.digest(changed))


class SaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name)
        self.path = self.data_dir / "conferences.json"
        self.conferences, self.warnings = normalized()

    def seed(self, when=None):
        return cf.save(self.data_dir, when or at(), conferences=self.conferences,
                       warnings=self.warnings,
                       source_updated_at="2026-10-20T07:28:00Z")

    def read(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def write(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def test_successful_snapshot_shape(self):
        self.assertEqual(self.seed(), "ok")
        latest = self.read()
        self.assertEqual(latest["schema_version"], 1)
        self.assertEqual(latest["source"], cf.source_metadata())
        self.assertEqual(latest["status"], "ok")
        self.assertIsNone(latest["error"])
        self.assertEqual(latest["captured_at"], "2026-10-21T02:23:00Z")
        self.assertEqual(latest["last_attempt_at"], "2026-10-21T02:23:00Z")
        self.assertEqual(latest["source_updated_at"], "2026-10-20T07:28:00Z")
        self.assertTrue(latest["source_digest"].startswith("sha256:"))
        self.assertEqual(latest["counts"], cf.summarize(self.conferences))
        self.assertEqual(latest["warnings"], self.warnings)
        self.assertEqual(latest["changes"]["status"], "initial")
        self.assertEqual(latest["conferences"], self.conferences)

    def test_success_requires_conferences(self):
        with self.assertRaises(ValueError):
            cf.save(self.data_dir, at())
        self.assertFalse(self.path.exists())

    def test_older_capture_is_rejected_without_writing(self):
        self.seed(at())
        before = self.path.read_bytes()
        for error in (None, "Conference source network request failed."):
            with self.subTest(error=error), self.assertRaises(ValueError):
                cf.save(self.data_dir, at("2026-10-20"), conferences=self.conferences,
                        error=error)
        self.assertEqual(self.path.read_bytes(), before)

    def test_failure_preserves_the_last_good_payload(self):
        self.seed(at(hour=2))
        before = self.read()
        self.assertEqual(cf.save(self.data_dir, at(hour=3),
                                 error="Conference source network request failed."), "stale")
        latest = self.read()
        self.assertEqual(latest["status"], "stale")
        self.assertEqual(latest["error"], "Conference source network request failed.")
        self.assertEqual(latest["captured_at"], before["captured_at"])
        self.assertEqual(latest["last_attempt_at"], "2026-10-21T03:23:00Z")
        for field in ("source_updated_at", "source_digest", "counts", "warnings",
                      "changes", "conferences", "source"):
            self.assertEqual(latest[field], before[field])

    def test_failure_without_history_is_an_unavailable_shell(self):
        self.assertEqual(cf.save(self.data_dir, at(), error="Conference source returned invalid JSON."),
                         "unavailable")
        latest = self.read()
        self.assertEqual(latest["status"], "unavailable")
        self.assertEqual(latest["source"], cf.source_metadata())
        self.assertEqual(latest["counts"], cf.empty_counts())
        self.assertIsNone(latest["captured_at"])
        self.assertEqual(latest["last_attempt_at"], "2026-10-21T02:23:00Z")
        self.assertIsNone(latest["source_updated_at"])
        self.assertIsNone(latest["source_digest"])
        self.assertEqual(latest["conferences"], [])
        self.assertEqual(latest["warnings"], [])
        self.assertEqual(latest["changes"]["status"], "unavailable")

    def test_recovery_from_stale_is_compared_against_preserved_events(self):
        self.seed(at(hour=2))
        cf.save(self.data_dir, at(hour=3), error="Conference source network request failed.")
        current = copy.deepcopy(self.conferences)
        current[0]["editions"][0]["events"][0]["comment"] = "changed"
        del current[-1]["editions"][-1]["events"][-1]
        current[0]["editions"][0]["events"].append(cf.normalize_event(
            "2026-08-20 23:59:59", "UTC", event_id="AI/aaai:aaai26:paper:9",
            kind="paper", round_no=9, year=2026, comment="new"))
        self.assertEqual(cf.save(self.data_dir, at(hour=4), conferences=current), "ok")
        latest = self.read()
        self.assertEqual(latest["status"], "ok")
        self.assertEqual(latest["changes"], {
            "status": "compared", "added": 1, "updated": 1, "removed": 1,
            "previous_captured_at": "2026-10-21T02:23:00Z",
        })

    def test_load_previous_validation(self):
        self.assertIsNone(cf.load_previous(self.path))
        self.path.write_text("{", encoding="utf-8")
        self.assertIsNone(cf.load_previous(self.path))

        self.path.write_text("")
        self.assertIsNone(cf.load_previous(self.path))

        self.seed()
        valid = self.read()
        self.assertIsNotNone(cf.load_previous(self.path))

        stale = copy.deepcopy(valid)
        stale["status"] = "stale"
        self.write(stale)
        self.assertIsNotNone(cf.load_previous(self.path))

        mutations = [
            ("schema_version", 2),
            ("source", "ccfddl"),
            ("source", {"id": "other"}),
            ("status", "unavailable"),
            ("conferences", {}),
            ("captured_at", None),
            ("captured_at", "2026-10-21T02:23:00"),
            ("captured_at", "not-a-time"),
        ]
        for field, value in mutations:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(valid)
                changed[field] = value
                self.write(changed)
                self.assertIsNone(cf.load_previous(self.path))

    def test_source_metadata_and_empty_counts(self):
        self.assertEqual(cf.source_metadata(), {
            "id": "ccfddl", "name": "CCF-Deadlines", "url": cf.SOURCE_URL,
            "repo": cf.SOURCE_REPO, "license": "MIT",
        })
        self.assertEqual(cf.empty_counts(), {
            "conferences": 0, "editions": 0, "events": 0, "paper_events": 0,
            "tbd": 0, "unknown_timezone": 0, "invalid_time": 0,
        })


class TransportTests(unittest.TestCase):
    def http_error(self, code, message=""):
        error = urllib.error.HTTPError(cf.SOURCE_URL, code, message, {}, None)
        self.addCleanup(error.close)
        return error

    def test_anonymous_opener_ignores_ambient_proxies(self):
        native_builder = urllib.request.build_opener
        ambient = {"HTTP_PROXY": "http://user:secret@proxy.invalid",
                   "HTTPS_PROXY": "http://proxy.invalid"}
        with patch.dict(os.environ, ambient), \
                patch.object(cf.urllib.request, "build_opener", wraps=native_builder) as builder:
            cf.anonymous_opener()
        handlers = builder.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], cf._NoRedirects)

    def test_redirects_are_rejected_and_the_body_is_closed(self):
        handler = cf._NoRedirects()
        body = Mock()
        with self.assertRaises(cf.ConferenceError) as raised:
            handler.redirect_request(Mock(), body, 302, "Found", {},
                                     "https://evil.invalid/x")
        self.assertEqual(raised.exception.code, "redirect")
        body.close.assert_called_once()

    def test_request_headers_and_last_modified(self):
        payload = fixture()
        response = Response(payload, headers=headers(
            **{"Last-Modified": "Tue, 20 Oct 2026 07:28:00 GMT"}))
        opener = opener_for(response)
        with patch.object(cf.time, "monotonic", return_value=0):
            value, modified = cf.fetch_once(opener, cf.SOURCE_URL, 10)
        self.assertEqual(value, payload)
        self.assertEqual(modified, "2026-10-20T07:28:00Z")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, cf.SOURCE_URL)
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertTrue(request.get_header("User-agent").startswith("Model-Observatory/1.0"))
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 10)
        self.assertTrue(response.closed)

    def test_last_modified_variants(self):
        self.assertIsNone(cf._last_modified(None))
        self.assertIsNone(cf._last_modified(headers()))
        self.assertIsNone(cf._last_modified(headers(**{"Last-Modified": "not a date"})))
        self.assertIsNone(cf._last_modified(headers(**{"Last-Modified": "  "})))
        self.assertEqual(cf._last_modified(headers(**{"Last-Modified": "20 Oct 2026 07:28:00"})),
                         "2026-10-20T07:28:00Z")

    def test_status_and_json_fail_closed(self):
        for response in (Response({}, status=204), Response(b"not json"), Response(b"\xff")):
            with self.subTest(response=response), self.assertRaises(cf.ConferenceError):
                cf.fetch_once(opener_for(response), cf.SOURCE_URL, float("inf"))
            self.assertTrue(response.closed)

    def test_response_size_is_bounded(self):
        self.assertEqual(cf.RESPONSE_LIMIT, 8 * 1024 * 1024)
        with patch.object(cf, "RESPONSE_LIMIT", 32):
            self.assertEqual(cf.fetch_once(opener_for(Response(b"{}" + b" " * 30)),
                                           cf.SOURCE_URL, float("inf"))[0], {})
            with self.assertRaises(cf.ConferenceError) as raised:
                cf.fetch_once(opener_for(Response(b"{}" + b" " * 31)),
                              cf.SOURCE_URL, float("inf"))
            self.assertEqual(raised.exception.code, "size")

    def test_http_errors_are_closed_without_exposing_the_body(self):
        body = Mock()
        error = urllib.error.HTTPError(cf.SOURCE_URL, 503, "secret", {}, body)
        with self.assertRaises(urllib.error.HTTPError):
            cf.fetch_once(Mock(open=Mock(side_effect=error)),
                          cf.SOURCE_URL, float("inf"))
        body.close.assert_called_once()
        self.assertNotIn("secret", cf.safe_error(error))

    def test_expired_budget_does_not_open(self):
        opener = Mock()
        with patch.object(cf.time, "monotonic", return_value=100):
            with self.assertRaises(cf.ConferenceError) as raised:
                cf.fetch_once(opener, cf.SOURCE_URL, 100)
        self.assertEqual(raised.exception.code, "timeout")
        opener.open.assert_not_called()

    def test_budget_is_checked_after_each_read(self):
        response = Response(b"{}")
        opener = Mock(open=Mock(return_value=response))
        with patch.object(cf.time, "monotonic", side_effect=[0, 0, 999]):
            with self.assertRaises(cf.ConferenceError) as raised:
                cf.fetch_once(opener, cf.SOURCE_URL, 100)
        self.assertEqual(raised.exception.code, "timeout")
        self.assertTrue(response.closed)

    def test_safe_error_never_echoes_source_details(self):
        cases = {
            cf.ConferenceError("json"): cf.ERROR_MESSAGES["json"],
            TimeoutError("secret"): cf.ERROR_MESSAGES["timeout"],
            urllib.error.URLError("secret"): cf.ERROR_MESSAGES["network"],
            RuntimeError("token=secret"): "Conference collection failed.",
            ValueError("https://user:secret@proxy/"): "Conference collection failed.",
        }
        for error, expected in cases.items():
            with self.subTest(error=type(error)):
                self.assertEqual(cf.safe_error(error), expected)
                self.assertNotIn("secret", cf.safe_error(error))

        error = self.http_error(403, "secret")
        self.assertEqual(cf.safe_error(error), "Conference source HTTP 403.")
        error = self.http_error(599, "secret")
        self.assertEqual(cf.safe_error(error), "Conference source HTTP 599.")

    def test_retryable_classification(self):
        self.assertTrue(cf._retryable(self.http_error(429)))
        self.assertTrue(cf._retryable(self.http_error(500)))
        self.assertTrue(cf._retryable(self.http_error(503)))
        self.assertFalse(cf._retryable(self.http_error(404)))
        self.assertTrue(cf._retryable(urllib.error.URLError("x")))
        self.assertTrue(cf._retryable(TimeoutError()))
        self.assertTrue(cf._retryable(cf.ConferenceError("timeout")))
        for code in ("json", "schema", "size", "redirect"):
            with self.subTest(code=code):
                self.assertFalse(cf._retryable(cf.ConferenceError(code)))
        self.assertFalse(cf._retryable(RuntimeError("x")))

    def test_transient_errors_are_retried(self):
        calls = []

        def fetch(*args):
            calls.append(args)
            if len(calls) == 1:
                raise urllib.error.URLError("secret")
            if len(calls) == 2:
                raise cf.ConferenceError("timeout")
            return {"ok": True}, None

        with patch.object(cf, "fetch_once", side_effect=fetch), \
                patch.object(cf.time, "sleep") as sleep:
            self.assertEqual(cf.fetch_payload(Mock(), source_url="x", deadline=float("inf")),
                             ({"ok": True}, None))
        self.assertEqual(len(calls), 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 4])

    def test_non_retryable_errors_are_not_retried(self):
        cases = [
            self.http_error(404, "secret"),
            cf.ConferenceError("json"),
        ]
        for error in cases:
            with self.subTest(error=type(error)), \
                    patch.object(cf, "fetch_once", side_effect=error), \
                    patch.object(cf.time, "sleep") as sleep:
                with self.assertRaises((urllib.error.HTTPError, cf.ConferenceError)):
                    cf.fetch_payload(Mock(), source_url="x", deadline=100)
                sleep.assert_not_called()

    def test_retry_exhaustion_and_deadline(self):
        with patch.object(cf, "fetch_once", side_effect=urllib.error.URLError("secret")), \
                patch.object(cf.time, "sleep") as sleep:
            with self.assertRaises(urllib.error.URLError):
                cf.fetch_payload(Mock(), source_url="x", deadline=float("inf"))
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 4])

        with patch.object(cf, "fetch_once", side_effect=urllib.error.URLError("secret")), \
                patch.object(cf.time, "sleep") as sleep, \
                patch.object(cf.time, "monotonic", return_value=100):
            with self.assertRaises(urllib.error.URLError):
                cf.fetch_payload(Mock(), source_url="x", deadline=100, retries=1)
        sleep.assert_not_called()

    def test_default_opener_is_created_once(self):
        opener = opener_for(Response({}))
        with patch.object(cf, "anonymous_opener", return_value=opener) as factory:
            self.assertEqual(cf.fetch_payload(deadline=float("inf")), ({}, None))
        factory.assert_called_once_with()


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name)
        self.path = self.data_dir / "conferences.json"

    def read(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def good_opener(self):
        return opener_for(Response(fixture(), headers=headers(
            **{"Last-Modified": "Tue, 20 Oct 2026 07:28:00 GMT"})))

    def test_successful_collection(self):
        self.assertEqual(cf.collect(self.data_dir, at(), opener=self.good_opener()), "ok")
        latest = self.read()
        self.assertEqual(latest["status"], "ok")
        self.assertEqual(latest["captured_at"], "2026-10-21T02:23:00Z")
        self.assertEqual(latest["last_attempt_at"], "2026-10-21T02:23:00Z")
        self.assertEqual(latest["source_updated_at"], "2026-10-20T07:28:00Z")
        self.assertEqual(latest["counts"], {
            "conferences": 6, "editions": 7, "events": 17, "paper_events": 10,
            "tbd": 2, "unknown_timezone": 1, "invalid_time": 1,
        })
        self.assertEqual(latest["warnings"], [
            "SC/ih&mmsec/ihmmsec27: invalid edition URL",
            "SC/ih&mmsec/ihmmsec27: unsupported timezone",
            "SC/ih&mmsec/ihmmsec27: invalid deadline",
        ])
        self.assertEqual(latest["conferences"][0]["key"], "AI/aaai")
        self.assertEqual(list(self.data_dir.glob(".partial-*.json")), [])

    def test_success_without_last_modified(self):
        opener = opener_for(Response(fixture()))
        self.assertEqual(cf.collect(self.data_dir, at(), opener=opener), "ok")
        self.assertIsNone(self.read()["source_updated_at"])

    def test_transport_failure_is_stale_and_sanitized(self):
        self.assertEqual(cf.collect(self.data_dir, at(hour=2), opener=self.good_opener()), "ok")
        before = self.read()
        opener = Mock(open=Mock(side_effect=urllib.error.URLError("token=secret")))
        with patch.object(cf.time, "sleep"):
            self.assertEqual(cf.collect(self.data_dir, at(hour=3), opener=opener), "stale")
        latest = self.read()
        self.assertEqual(latest["status"], "stale")
        self.assertEqual(latest["error"], cf.ERROR_MESSAGES["network"])
        self.assertEqual(latest["captured_at"], before["captured_at"])
        self.assertEqual(latest["last_attempt_at"], "2026-10-21T03:23:00Z")
        self.assertEqual(latest["conferences"], before["conferences"])
        self.assertEqual(latest["counts"], before["counts"])
        self.assertNotIn("secret", self.path.read_text(encoding="utf-8"))

    def test_initial_failure_is_unavailable_then_recovers_as_initial(self):
        opener = Mock(open=Mock(side_effect=urllib.error.URLError("secret")))
        with patch.object(cf.time, "sleep"):
            self.assertEqual(cf.collect(self.data_dir, at(), opener=opener), "unavailable")
        latest = self.read()
        self.assertEqual(latest["status"], "unavailable")
        self.assertEqual(latest["counts"], cf.empty_counts())
        self.assertEqual(latest["conferences"], [])

        self.assertEqual(cf.collect(self.data_dir, at(hour=3), opener=self.good_opener()), "ok")
        self.assertEqual(self.read()["changes"]["status"], "initial")

    def test_http_and_payload_failures_are_mapped(self):
        def server_error(*args, **kwargs):
            raise urllib.error.HTTPError(cf.SOURCE_URL, 500, "secret", {}, None)

        cases = [
            (Mock(open=Mock(side_effect=server_error)), True, "Conference source HTTP 500."),
            (opener_for(Response(b"not json")), False, cf.ERROR_MESSAGES["json"]),
            (opener_for(Response([])), False, cf.ERROR_MESSAGES["empty"]),
            (opener_for(Response([{"unexpected": True}])), False, cf.ERROR_MESSAGES["schema"]),
        ]
        for opener, retries, message in cases:
            with self.subTest(message=message):
                directory = Path(tempfile.mkdtemp(dir=self.data_dir))
                sleep = patch.object(cf.time, "sleep") if retries else patch.object(
                    cf.time, "sleep", side_effect=AssertionError("unexpected retry"))
                with sleep:
                    self.assertEqual(cf.collect(directory, at(), opener=opener), "unavailable")
                latest = json.loads((directory / "conferences.json").read_text(encoding="utf-8"))
                self.assertEqual(latest["error"], message)
                self.assertNotIn("secret", (directory / "conferences.json").read_text())

    def test_unexpected_errors_are_sanitized(self):
        opener = Mock(open=Mock(side_effect=RuntimeError("token=secret")))
        self.assertEqual(cf.collect(self.data_dir, at(), opener=opener), "unavailable")
        self.assertEqual(self.read()["error"], "Conference collection failed.")
        self.assertNotIn("secret", self.path.read_text(encoding="utf-8"))

    def test_provided_opener_avoids_the_anonymous_one(self):
        with patch.object(cf, "anonymous_opener", side_effect=AssertionError("network")):
            self.assertEqual(cf.collect(self.data_dir, at(), opener=self.good_opener()), "ok")

    def test_cli_exit_status_and_safe_storage_error(self):
        with patch.object(cf.sys, "argv", ["collect_conferences.py", "--data-dir", str(self.data_dir)]), \
                patch.object(cf, "collect", return_value="ok") as collect, \
                patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(cf.main(), 0)
            collect.assert_called_once_with(self.data_dir.resolve())
        with patch.object(cf.sys, "argv", ["collect_conferences.py"]), \
                patch.object(cf, "collect", return_value="stale"), \
                patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(cf.main(), 1)
        with patch.object(cf.sys, "argv", ["collect_conferences.py"]), \
                patch.object(cf, "collect", side_effect=ValueError("secret")), \
                patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(cf.main(), 1)
            self.assertNotIn("secret", stderr.getvalue())


class BuildTests(unittest.TestCase):
    def test_conference_snapshot_is_optional_and_copied_when_present(self):
        from scripts import build

        for present in (False, True):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "site").mkdir()
                (root / "data").mkdir()
                (root / "site" / "index.html").write_text("test")
                for name in ("latest.json", "history.json"):
                    (root / "data" / name).write_text("{}")
                snapshot = root / "data" / "conferences.json"
                if present:
                    snapshot.write_text('{"schema_version":1}')
                with patch.object(build, "ROOT", root), patch.object(build, "SITE", root / "site"), \
                        patch.object(build, "OUTPUT", root / "output"), patch("sys.stdout", new_callable=io.StringIO):
                    build.build()
                destination = root / "output" / "data" / "conferences.json"
                self.assertEqual(destination.exists(), present)
                if present:
                    self.assertEqual(destination.read_bytes(), snapshot.read_bytes())


if __name__ == "__main__":
    unittest.main()
