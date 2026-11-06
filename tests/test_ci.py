"""Read the daily job as a contract, not as YAML nobody checks.

`.github/workflows/pages.yml` is the only thing that writes to this repository: it
runs on a schedule, holds `contents: write`, pushes snapshots to `main`, and deploys
`_site/`. None of that is testable from the inside, and every one of its properties
is a string someone can edit by accident - a tag moved back to `@vN`, the test step
dragged below a collector, a new permission added. These assertions are read offline,
from the same file Actions reads, so the properties that matter have to be re-decided
out loud before they can change.
"""
from __future__ import annotations

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf8")
DEPENDABOT = ROOT / ".github" / "dependabot.yml"

SHA = re.compile(r"^[0-9a-f]{40}$")


def step_names() -> list[str]:
    return re.findall(r"^\s*- name: (.+)$", WORKFLOW, re.MULTILINE)


def step_block(name: str) -> str:
    """The lines of one step, so a property can be claimed about a step and not
    about anywhere in the file - `continue-on-error` somewhere else means nothing."""
    match = re.search(rf"- name: {re.escape(name)}\n((?:\s{{8}}.+\n)+)", WORKFLOW)
    return match.group(1) if match else ""


def scripts_run() -> set[str]:
    return {line.rsplit("/", 1)[-1] for line in re.findall(r"python (scripts/[\w.]+\.py)", WORKFLOW)}


def staged_payloads() -> set[str]:
    """The `data/<name>.json` files the commit step is told to keep."""
    block = re.search(r"for snapshot in ([^;]+); do", WORKFLOW)
    return set(block.group(1).replace("\\", " ").split()) if block else set()


class ActionPinningTest(unittest.TestCase):
    def test_every_action_is_pinned_to_a_commit_sha(self):
        refs = re.findall(r"^\s*uses: (\S+)", WORKFLOW, re.MULTILINE)
        self.assertEqual(6, len(refs),
                         "the workflow's action count moved - a gate that reads zero lines passes for nothing")
        unpinned = []
        for ref in refs:
            _, _, version = ref.partition("@")
            # A 40-hex sha is the only thing that cannot move under this job later.
            if not SHA.match(version):
                unpinned.append(ref)
        self.assertEqual([], unpinned,
                         "a mutable tag: this job pushes to main with contents:write, so an "
                         "upstream tag move is unreviewed code running here")

    def test_every_pin_says_which_tag_it_came_from(self):
        # Dependabot reads the trailing comment to know what a sha stands for; a
        # bare sha is a pin nobody can bump, and pins nobody can bump rot quietly.
        missing = [line.strip() for line in WORKFLOW.splitlines()
                   if re.match(r"^\s*uses: \S+@[0-9a-f]{40}$", line)]
        self.assertEqual([], missing, "a pinned action without the `# repo@vN` comment beside it")

    def test_the_write_permissions_are_the_documented_ones(self):
        self.assertEqual({"contents: write", "pages: write", "id-token: write"},
                         set(re.findall(r"^\s{2}([a-z-]+: write)$", WORKFLOW, re.MULTILINE)),
                         "the job's grant changed - say what the new permission is for first")


class DependabotTest(unittest.TestCase):
    def test_the_two_things_that_can_move_are_both_tracked(self):
        # Pins make the actions immutable, not current; requirements.txt is a range.
        self.assertTrue(DEPENDABOT.is_file(),
                        "actions are sha-pinned, so without dependabot the pins only go stale")
        text = DEPENDABOT.read_text(encoding="utf8")
        self.assertIn("github-actions", text)
        self.assertIn("pip", text)

class GateOrderTest(unittest.TestCase):
    def test_the_offline_suite_runs_before_anything_captures_or_commits(self):
        names = step_names()
        gate = names.index("Run offline test suite")
        writers = [i for i, name in enumerate(names)
                   if name.startswith("Capture ") or name.startswith("Commit ")]
        self.assertTrue(writers, "the workflow no longer has a capture step to order against")
        self.assertLess(gate, min(writers),
                        "a collector now runs before the regression gate that reviews it")


class CollectorWiringTest(unittest.TestCase):
    def test_every_script_the_workflow_runs_is_in_the_repository(self):
        missing = [item for item in re.findall(r"python (scripts/[\w.]+\.py)", WORKFLOW)
                   if not (ROOT / item).is_file()]
        self.assertEqual([], missing, "the daily job calls a script that is not shipped")

    def test_every_collector_is_run_by_the_daily_job(self):
        idle = sorted(path.name for path in (ROOT / "scripts").glob("collect_*.py")
                      if path.name not in scripts_run())
        self.assertEqual([], idle,
                          "a collector nobody runs leaves its board frozen at the last day it did")

    def test_a_third_party_list_never_blocks_the_boards_that_already_ran(self):
        for name in ("Capture the tracked awesome lists", "Capture the HOMC model list"):
            block = step_block(name)
            self.assertTrue(block, f"{name} is gone from the workflow")
            self.assertIn("continue-on-error: true", block,
                          f"{name}: somebody else's repository may simply be unreadable today")

    def test_the_daily_run_persists_the_ids_the_collectors_read_back(self):
        # The ledgers are committed so tomorrow's diff knows today's ids; keeping
        # them out of the browser payload is a separate claim, and test_wiring owns it.
        for name in ("awesome", "awesome_history", "awesome_ledger",
                     "homc", "homc_history", "homc_ledger", "runs"):
            self.assertIn(name, staged_payloads(), f"{name}.json stopped being committed")

    def test_the_side_channel_says_so_when_a_payload_is_missing_or_unclean(self):
        # A continue-on-error collector that published nothing would otherwise be
        # invisible: these steps re-read the file they just wrote and warn.
        for name in ("Report list tracking sizes", "Report HOMC sizes"):
            block = step_block(name)
            self.assertTrue(block, f"{name} is gone from the workflow")
            self.assertIn("is missing", block, f"{name} stopped warning about an absent payload")
            self.assertIn("::warning::", block, f"{name} no longer has a warning channel")
        homc = step_block("Report HOMC sizes")
        self.assertIn("both stay published", homc,
                      "the measured/self-reported gap is the board's point; the log should say it")


if __name__ == "__main__":
    unittest.main()
