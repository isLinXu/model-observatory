"""Check the wires, offline, before the browser has to.

The page has no bundler and no types: `index.html` loads plain scripts, the
boards look elements up by id, and the builder copies a named list of data files
into `_site/`. Each of those is a string, so the ways they can disagree - a
renamed section, a panel that fetches a file nobody ships, a script tag left out
of the page - surface as an empty board or a 404 on the deployed site instead of
a failing build. These tests read the files as they are shipped.
"""
from __future__ import annotations

import pathlib
import re
import unittest

from scripts import build

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
INDEX = (SITE / "index.html").read_text(encoding="utf-8")
SCRIPTS = {path.name: path.read_text(encoding="utf8") for path in sorted(SITE.glob("*.js"))}

# How many ids the shipped markup interpolates today; see the blind-spot test.
KNOWN_INTERPOLATED_IDS = 4


def referenced_ids(text: str) -> set[str]:
    """Ids a file looks up. An element lookup in this codebase is always one of
    three literal shapes; something assembled at runtime (`$(prefix + name)`) is
    outside what a static read can prove and is not pretended to be covered."""
    found = set()
    for pattern in (r"""\$\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)""",
                    r"""getElementById\(\s*['"]([A-Za-z][\w-]*)['"]""",
                    r"""querySelector(?:All)?\(\s*['"]#([A-Za-z][\w-]*)['"]"""):
        found.update(re.findall(pattern, text))
    return found


def declared_ids(text: str) -> tuple[set[str], int]:
    """Literal ids a file writes into the DOM, plus how many ids it interpolates."""
    literals = set(re.findall(r"""\bid=["']([^"'{$]+)["']""", text))
    dynamic = len(re.findall(r"""\bid=["'][^"']*\$\{""", text))
    return literals, dynamic


class PageAssetTest(unittest.TestCase):
    def test_every_asset_the_page_names_exists(self):
        named = [match for tag in re.findall(r"<(?:script|link)\b[^>]*>", INDEX)
                 for match in re.findall(r'''(?:src|href)="(\./[^"]+)"''', tag)]
        # Payload names belong to DataWiringTest: they live outside site/.
        local = [item for item in named if not item.startswith("./data/")]
        self.assertTrue(local, "index.html names no local asset")
        for item in local:
            self.assertTrue((SITE / item[2:]).is_file(), f"{item} is named by the page but not in site/")

    def test_every_script_in_site_is_loaded_by_the_page(self):
        loaded = {item[2:] for item in re.findall(r'<script src="(\./[^"]+)"', INDEX)}
        self.assertEqual(sorted(loaded), sorted(SCRIPTS),
                         "a script in site/ is not in index.html (or the page names one that is gone)")


class ElementIdTest(unittest.TestCase):
    def setUp(self):
        html_ids, html_dynamic = declared_ids(INDEX)
        self.assertTrue(html_ids)
        self.declared = set(html_ids)
        self.dynamic = html_dynamic
        for text in SCRIPTS.values():
            ids, count = declared_ids(text)
            self.declared |= ids
            self.dynamic += count

    def test_every_id_the_scripts_look_up_is_declared_somewhere(self):
        missing = {}
        for name, text in SCRIPTS.items():
            for ident in sorted(referenced_ids(text) - self.declared):
                missing.setdefault(ident, []).append(name)
        self.assertEqual({}, missing,
                         "looked up but never written: these ids resolve to null at runtime")

    def test_the_interpolated_ids_are_the_documented_blind_spot(self):
        # A template that writes `id="task-arrow-${kind}"` cannot be matched
        # against a literal lookup, so the count is pinned instead of quietly
        # dropped: when it moves, someone should decide whether the new id is one
        # the rules above could have checked.
        self.assertEqual(
            KNOWN_INTERPOLATED_IDS, self.dynamic,
            "interpolated ids changed - decide whether each new one is provable, then bump the count")


class DataWiringTest(unittest.TestCase):
    def setUp(self):
        asked = set()
        # The page can name a payload in markup (`<link rel="preload">`) as well
        # as in a fetch, so both halves of the shipped site are read.
        for text in [INDEX, *SCRIPTS.values()]:
            asked.update(re.findall(r'''["'`]\.?/?data/([A-Za-z][\w-]*\.json)''', text))
        self.asked = asked

    def test_the_page_asks_only_for_data_the_builder_ships(self):
        self.assertTrue(self.asked)
        self.assertEqual([], sorted(self.asked - set(build.SHIPPED_DATA)),
                         "a script fetches a payload that scripts/build.py never copies")

    def test_the_core_payloads_are_the_ones_a_missing_build_would_blow_up_on(self):
        self.assertEqual({"latest.json", "history.json"}, set(build.CORE_DATA))
        self.assertTrue(set(build.CORE_DATA) <= self.asked)

    def test_the_id_ledger_is_a_collector_file_and_never_a_page_payload(self):
        # README promises the ledger is not served to readers. It is committed by
        # the daily workflow (the collector must read it back the next morning),
        # so "in the repo but out of _site/" is the claim that needs a test:
        # one half lives in the workflow, the other in the ship list.
        workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("awesome_ledger", workflow, "the daily run stopped persisting the ledger")
        self.assertNotIn("awesome_ledger.json", self.asked)
        self.assertNotIn("awesome_ledger.json", build.SHIPPED_DATA)


if __name__ == "__main__":
    unittest.main()
