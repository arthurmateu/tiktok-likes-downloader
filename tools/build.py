#!/usr/bin/env python3
"""
Assemble loadable extension folders for each browser.

The repo root is a valid Chromium extension on its own — that's what
`manifest.json` is — but Firefox needs its own manifest at the root of whatever
folder you point `about:debugging` at, and the two can't both be called
`manifest.json`. So this copies the shared source into `dist/<target>/` and
drops the right manifest in beside it.

    python tools/build.py                  # both targets
    python tools/build.py firefox          # just one
    python tools/build.py --zip            # also produce dist/<target>.zip
    python tools/build.py firefox --dev    # include src/dev/ (self-test pages)

Dev-only files (the syntax harness, src/dev/, Chromium's generated ruleset
cache) are left out unless --dev is passed.
"""

import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

TARGETS = {
    "chrome": "manifest.json",
    "firefox": "manifest.firefox.json",
}

# Copied verbatim into every target.
PAYLOAD = ["src", "rules"]

# Never shipped, in any target.
EXCLUDE_DIRS = {"dev", "__pycache__"}
EXCLUDE_NAMES = {".DS_Store"}


def strip_comments(node):
    """
    Drop `_comment…` keys. They document the source but reach the browser as
    unknown properties, and Gecko validates declarativeNetRequest rules a good
    deal more strictly than Chromium does.
    """
    if isinstance(node, dict):
        return {
            k: strip_comments(v)
            for k, v in node.items()
            if not k.startswith("_comment")
        }
    if isinstance(node, list):
        return [strip_comments(v) for v in node]
    return node


def write_json(dest: Path, data) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(strip_comments(data), indent="\t", ensure_ascii=False)
    dest.write_text(text + "\n", encoding="utf-8")


def copy_payload(dest: Path, dev: bool) -> int:
    excluded = EXCLUDE_DIRS - {"dev"} if dev else EXCLUDE_DIRS
    count = 0
    for entry in PAYLOAD:
        src = ROOT / entry
        if not src.exists():
            continue
        for path in src.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT)
            if excluded & set(rel.parts) or path.name in EXCLUDE_NAMES:
                continue
            out = dest / rel
            if path.suffix == ".json":
                # Parsed rather than copied, so a malformed rule fails here
                # instead of in the browser's extension console.
                write_json(out, json.loads(path.read_text(encoding="utf-8")))
            else:
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, out)
            count += 1
    return count


def build(target: str, make_zip: bool, dev: bool) -> None:
    manifest_src = ROOT / TARGETS[target]
    if not manifest_src.exists():
        raise SystemExit(f"missing {manifest_src.name}")

    manifest = json.loads(manifest_src.read_text(encoding="utf-8"))

    dest = DIST / target
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    files = copy_payload(dest, dev)
    write_json(dest / "manifest.json", manifest)

    note = " +dev" if dev else ""
    if make_zip:
        archive = DIST / f"{target}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(dest.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(dest))
        note += f" -> {archive.relative_to(ROOT)}"

    print(f"{target:8} {files + 1:3} files  {dest.relative_to(ROOT)}{note}")


def main(argv: list[str]) -> None:
    make_zip = "--zip" in argv
    dev = "--dev" in argv
    names = [a for a in argv if not a.startswith("-")] or list(TARGETS)

    unknown = set(names) - set(TARGETS)
    if unknown:
        raise SystemExit(f"unknown target(s): {', '.join(sorted(unknown))}")

    for name in names:
        build(name, make_zip, dev)


if __name__ == "__main__":
    main(sys.argv[1:])
