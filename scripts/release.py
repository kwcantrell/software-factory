#!/usr/bin/env python3
"""Usage: python3 -I scripts/release.py [--root DIR] [--notes-out FILE] [TAG]

Check that a release tag matches the plugin version and print that version's
release notes from CHANGELOG.md.

- TAG must equal "v" + the "version" in .claude-plugin/plugin.json. Without a
  TAG, the plugin's own version is used (so the check command can confirm the
  current version is releasable).
- If the "factory" entry in .claude-plugin/marketplace.json carries a
  "version", it must match too.
- CHANGELOG.md must have a non-empty "## [X.Y.Z]" section for that version; its
  body (up to the next "## " heading or the "[x.y.z]: <url>" link list) is the
  release notes, printed to stdout or written to --notes-out.

Exits 0 when everything matches, 1 with a reason otherwise. Stdlib only.
"""
import argparse
import json
import re
import sys
from pathlib import Path

PLUGIN = "factory"


class Mismatch(Exception):
    pass


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise Mismatch(f"{path} is missing")
    except ValueError as e:
        raise Mismatch(f"{path} is not valid JSON: {e}")


def plugin_version(root):
    version = read_json(root / ".claude-plugin" / "plugin.json").get("version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise Mismatch(f"plugin.json 'version' must be X.Y.Z, got {version!r}")
    return version


def check_marketplace(root, version):
    path = root / ".claude-plugin" / "marketplace.json"
    if not path.exists():
        return
    entries = [p for p in read_json(path).get("plugins", []) if p.get("name") == PLUGIN]
    if not entries:
        raise Mismatch(f"{path} does not list the '{PLUGIN}' plugin")
    listed = entries[0].get("version")
    if listed is not None and listed != version:
        raise Mismatch(f"marketplace.json lists {PLUGIN} {listed} but plugin.json says {version}")


def changelog_section(root, version):
    path = root / "CHANGELOG.md"
    if not path.exists():
        raise Mismatch(f"{path} is missing")
    body, inside = [], False
    for line in path.read_text().splitlines():
        # A section ends at the next "## " heading or at the link definitions closing the file.
        if line.startswith("## ") or re.match(r"\[[^\]]+\]: ", line):
            if inside:
                break
            inside = re.match(rf"## \[{re.escape(version)}\]", line) is not None
            continue
        if inside:
            body.append(line)
    notes = "\n".join(body).strip()
    if not notes:
        raise Mismatch(f"CHANGELOG.md has no '## [{version}]' section with release notes")
    return notes + "\n"


def check(root, tag=None):
    """Return the release notes for the tag, or raise Mismatch."""
    version = plugin_version(root)
    if tag is not None and tag != f"v{version}":
        raise Mismatch(f"tag {tag!r} does not match plugin.json version {version} (expected 'v{version}')")
    check_marketplace(root, version)
    return changelog_section(root, version)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tag", nargs="?", help="release tag, e.g. v0.2.0 (default: the plugin's version)")
    ap.add_argument("--root", default=Path(__file__).resolve().parent.parent, type=Path,
                    help="repository root (default: this script's repository)")
    ap.add_argument("--notes-out", type=Path, help="write the release notes here instead of stdout")
    a = ap.parse_args()
    try:
        notes = check(a.root, a.tag)
    except Mismatch as e:
        sys.exit(f"release check failed: {e}")
    if a.notes_out:
        a.notes_out.write_text(notes)
    else:
        sys.stdout.write(notes)


if __name__ == "__main__":
    main()
