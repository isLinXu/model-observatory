"""Parse every file this site actually runs, before a browser or a cron has to.

There is no build step, so nothing ever asks whether a shipped file parses:
`index.html` loads plain scripts one by one, and a syntax error costs that whole
board - the page still loads, the section is simply empty, and the first reader to
notice is a human. On the Python side the same failure hides one step earlier: a
collector that cannot compile never gets to say what is wrong.

This is the zero-install half of a lint, and it is deliberately not a style linter.
The class of mistake here is "no runtime has ever parsed this file", which no
ruleset catches on a repository that has no linter configured - and adding ESLint
or Ruff would put a dependency and a config file in front of a repo whose tests
already are its style guide. `node --check` uses the same parser the page uses and
installs nothing; Python's builtin `compile()` uses the interpreter that runs it.
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


def javascript_files() -> list[pathlib.Path]:
    """Every script the page or the suite loads, in the order they ship."""
    return sorted(SITE.glob("*.js")) + sorted((ROOT / "tests").glob("*.js"))


def python_files() -> list[pathlib.Path]:
    """Every Python file the repo runs: collectors, builder, server, tests."""
    return sorted(p for directory in ("scripts", "tests")
                  for p in (ROOT / directory).glob("*.py"))


class JSParseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")

    def test_every_shipped_script_parses(self):
        files = javascript_files()
        self.assertTrue(files, "no scripts found in site/ - the gate silently checks nothing")
        if self.node is None:
            # Saying "skipped" beats saying "passed": the page's parser was not run.
            self.skipTest("node is not on PATH, so the shipped scripts were not parsed")
        for path in files:
            with self.subTest(path=path.relative_to(ROOT)):
                result = subprocess.run([self.node, "--check", str(path)],
                                        capture_output=True, text=True)
                self.assertEqual(0, result.returncode,
                                 f"{path.name} does not parse: {result.stderr.strip()}")


class PythonParseTest(unittest.TestCase):
    def test_every_collector_and_test_compiles(self):
        files = python_files()
        self.assertTrue(files)
        for path in files:
            with self.subTest(path=path.relative_to(ROOT)):
                compile(path.read_text(encoding="utf8"), str(path), "exec")


if __name__ == "__main__":
    unittest.main()
