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


if __name__ == "__main__":
    unittest.main()
