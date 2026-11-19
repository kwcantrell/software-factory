"""Tests for scripts/release.py: the tag/version check and changelog extraction the release workflow runs.

Run: python3 -I -B -m unittest discover -s tests
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RELEASE = REPO / "scripts" / "release.py"

CHANGELOG = """# Changelog

## [Unreleased]

- Something new.

## [1.2.0] - 2026-01-02

### Added

- The 1.2 feature.

## [1.1.0] - 2026-01-01

- Older.

[1.2.0]: https://example.invalid/v1.2.0
[1.1.0]: https://example.invalid/v1.1.0
"""


class ReleaseCheck(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / ".claude-plugin").mkdir()
        self.write_plugin("1.2.0")
        self.write_marketplace(None)
        (self.root / "CHANGELOG.md").write_text(CHANGELOG)

    def write_plugin(self, version):
        (self.root / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "factory", "version": version}))

    def write_marketplace(self, version):
        entry = {"name": "factory", "source": "./"}
        if version:
            entry["version"] = version
        (self.root / ".claude-plugin" / "marketplace.json").write_text(
            json.dumps({"name": "software-factory", "plugins": [entry]}))

    def run_release(self, *args, root=None):
        return subprocess.run([sys.executable, "-I", str(RELEASE), "--root", str(root or self.root), *args],
                              capture_output=True, text=True)

    def test_matching_tag_passes_and_prints_that_versions_notes(self):
        p = self.run_release("v1.2.0")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "### Added\n\n- The 1.2 feature.\n")

    def test_notes_out_writes_file(self):
        out = self.root / "notes.md"
        p = self.run_release("v1.2.0", "--notes-out", str(out))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "")
        self.assertIn("The 1.2 feature.", out.read_text())
        self.assertNotIn("Older", out.read_text())

    def test_last_section_stops_at_link_definitions(self):
        self.write_plugin("1.1.0")
        p = self.run_release("v1.1.0")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "- Older.\n")

    def test_mismatched_tag_fails(self):
        for tag in ("v1.1.0", "1.2.0", "v1.2.0-rc1", "v1.2"):
            with self.subTest(tag=tag):
                p = self.run_release(tag)
                self.assertEqual(p.returncode, 1, p.stdout)
                self.assertIn("does not match plugin.json version 1.2.0", p.stderr)

    def test_marketplace_version_must_match_when_present(self):
        self.write_marketplace("1.2.0")
        self.assertEqual(self.run_release("v1.2.0").returncode, 0)
        self.write_marketplace("1.1.0")
        p = self.run_release("v1.2.0")
        self.assertEqual(p.returncode, 1)
        self.assertIn("marketplace.json lists factory 1.1.0", p.stderr)

    def test_missing_changelog_section_fails(self):
        self.write_plugin("1.3.0")
        p = self.run_release("v1.3.0")
        self.assertEqual(p.returncode, 1)
        self.assertIn("no '## [1.3.0]' section", p.stderr)

    def test_empty_changelog_section_fails(self):
        (self.root / "CHANGELOG.md").write_text("# Changelog\n\n## [1.2.0] - 2026-01-02\n\n## [1.1.0]\n\n- x\n")
        self.assertEqual(self.run_release("v1.2.0").returncode, 1)

    def test_without_tag_checks_the_plugin_version(self):
        self.assertEqual(self.run_release().returncode, 0)
        self.write_plugin("9.9.9")
        self.assertEqual(self.run_release().returncode, 1)

    def test_plugin_json_is_found_through_the_marketplace_source(self):
        (self.root / "plugins" / "factory" / ".claude-plugin").mkdir(parents=True)
        (self.root / "plugins" / "factory" / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "factory", "version": "1.1.0"}))
        (self.root / ".claude-plugin" / "marketplace.json").write_text(json.dumps(
            {"name": "software-factory", "plugins": [{"name": "factory", "source": "./plugins/factory"}]}))
        self.assertEqual(self.run_release("v1.1.0").stdout, "- Older.\n")
        self.assertEqual(self.run_release("v1.2.0").returncode, 1)

    def test_this_repository_is_releasable_at_its_current_version(self):
        version = json.loads((REPO / "plugins" / "factory" / ".claude-plugin" / "plugin.json").read_text())["version"]
        p = self.run_release(f"v{version}", root=REPO)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(p.stdout.strip())
        self.assertEqual(self.run_release("v0.0.0", root=REPO).returncode, 1)


if __name__ == "__main__":
    unittest.main()
