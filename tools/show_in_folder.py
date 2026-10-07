#!/usr/bin/env python3
"""
The native helper behind the Library's "Show in folder" button. Windows only.

Chromium's own downloads page can show a file because Chromium wrote that file
and kept its path. This extension writes the archive through File System Access
instead — the only way to write into a folder you chose — and that API never
tells the extension where anything is on disk, while no extension API opens
Explorer on a file it didn't download. So this runs outside the browser: the
extension sends an archive-relative path, `videos/<id>.mp4`, and this opens
Explorer with that file selected.

It is never told where the archive is. Chromium records the folder an extension
picked, full path and all, in the profile's Preferences, and starts a helper
with the extension's origin as its first argument; so the folder is looked up
afresh on every press, and picking a different one in the extension just works.

    python tools/show_in_folder.py install      # once
    python tools/show_in_folder.py uninstall

`install` finds the extension's id itself, by looking for an unpacked extension
loaded from this repo in every Chrome, Chromium, Edge and Brave profile. Two
overrides exist for when that isn't enough: `--id <id>` adds an id it couldn't
find, and `--root <folder>` names the archive outright, checked before
Chromium's record of it.

It copies this file into %LOCALAPPDATA%\\ttarchive-show-in-folder beside a .bat
that runs it with this same Python, writes the host manifest, and registers it
under HKCU for those four browsers. Nothing is written outside the current
user's profile.

Firefox needs none of this: it downloads the archive itself, so `downloads.show`
already knows where every file is.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

HOST = "com.ttarchive.show_in_folder"

# Only meaningful when run from the repo, which is where `install` runs from.
REPO = Path(__file__).resolve().parent.parent

# The id src/lib/backends/fsa.js gives its folder picker, which is what Chromium
# files the picked folder under.
PICKER_ID = "ttarchive-root"

# Each browser reads only its own registry key, and keeps its own profiles.
BROWSERS = {
    r"Software\Google\Chrome\NativeMessagingHosts": r"Google\Chrome\User Data",
    r"Software\Chromium\NativeMessagingHosts": r"Chromium\User Data",
    r"Software\Microsoft\Edge\NativeMessagingHosts": r"Microsoft\Edge\User Data",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts": r"BraveSoftware\Brave-Browser\User Data",
}


def local_appdata() -> Path:
    return Path(os.environ["LOCALAPPDATA"])


def install_dir() -> Path:
    return local_appdata() / "ttarchive-show-in-folder"


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def profiles():
    for data in BROWSERS.values():
        base = local_appdata() / data
        if base.is_dir():
            yield from (prefs.parent for prefs in base.glob("*/Preferences"))


def picked_folders(ext_id: str) -> list[Path]:
    """
    The archive folder as Chromium recorded it: the last folder picked under the
    extension's picker id, then every folder the extension holds a grant on.
    A list, since more than one profile can have the extension.
    """
    origin = f"chrome-extension://{ext_id}/,*"
    found = []
    for profile in profiles():
        prefs = read_json(profile / "Preferences")
        exceptions = prefs.get("profile", {}).get("content_settings", {}).get("exceptions", {})
        last = exceptions.get("file_system_last_picked_directory", {}).get(origin, {}).get("setting", {})
        paths = [last.get(f"custom-id-{PICKER_ID}", {}).get("path")]
        chosen = exceptions.get("file_system_access_chooser_data", {}).get(origin, {}).get("setting", {})
        paths += [o.get("path") for o in chosen.get("chosen-objects", []) if o.get("is-directory")]
        for p in paths:
            if p and Path(p) not in found:
                found.append(Path(p))
    return found


def unpacked_ids() -> list[str]:
    """Ids of this extension as loaded unpacked from this repo, in any profile."""
    ids = []
    for profile in profiles():
        for name in ("Secure Preferences", "Preferences"):
            settings = read_json(profile / name).get("extensions", {}).get("settings", {})
            for ext_id, entry in settings.items():
                # Installed extensions have relative paths into the profile; only an
                # unpacked one has an absolute path, and only ours has this one.
                path = Path(entry.get("path") or "")
                if path.is_absolute() and path.resolve().is_relative_to(REPO) and ext_id not in ids:
                    ids.append(ext_id)
    return ids


# ------------------------------------------------------------------ the host


def read_message():
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return None
    (size,) = struct.unpack("<I", head)
    return json.loads(sys.stdin.buffer.read(size).decode("utf-8"))


def send_message(payload) -> None:
    body = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
    sys.stdout.buffer.flush()


def resolve(root: Path, rel) -> Path | None:
    """
    The file an archive-relative path names, or None if it names anything outside
    the archive. Only the extension can reach this helper, but a path out of a
    message is still not something to hand Explorer unchecked.
    """
    if not isinstance(rel, str) or not rel or "\\" in rel or ":" in rel:
        return None
    parts = PurePosixPath(rel).parts
    if not parts or parts[0] == "/" or any(p in ("", ".", "..") for p in parts):
        return None
    path = (root / Path(*parts)).resolve()
    return path if path.is_relative_to(root.resolve()) else None


def select_in_explorer(path: Path) -> None:
    # Set by automated end-to-end runs, which drive a browser nobody is looking at
    # and must not open windows on the desktop of whoever is using the machine.
    # The request is still answered, and recorded in last-call.json / helper.log.
    if os.environ.get("TTARCHIVE_TEST_NO_WINDOWS"):
        return

    import ctypes
    from ctypes import wintypes

    shell32 = ctypes.windll.shell32
    shell32.ILCreateFromPathW.argtypes = [wintypes.LPCWSTR]
    shell32.ILCreateFromPathW.restype = ctypes.c_void_p
    shell32.ILFree.argtypes = [ctypes.c_void_p]
    shell32.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, wintypes.DWORD]

    # The browser launched us from a click, so we may take the foreground — and
    # can pass that on. Without this Explorer opens behind the browser window.
    ctypes.windll.user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
    ctypes.windll.ole32.CoInitialize(None)

    # What the browser's own "Show in folder" calls: it reuses an Explorer window
    # already open on the folder, where `explorer /select` opens a new one each time.
    pidl = shell32.ILCreateFromPathW(str(path))
    try:
        ok = pidl and shell32.SHOpenFolderAndSelectItems(pidl, 0, None, 0) == 0
    finally:
        if pidl:
            shell32.ILFree(pidl)
    if not ok:
        subprocess.Popen(["explorer", f"/select,{path}"])


def handle(msg, ext_id: str) -> dict:
    roots = []
    override = read_json(Path(__file__).parent / "config.json").get("root")
    if override:
        roots.append(Path(override))
    roots += [r for r in picked_folders(ext_id) if r not in roots]
    if not roots:
        return {"ok": False, "error": "the browser has no record of the archive folder — choose it again on the Sync tab"}

    tried = None
    for root in roots:
        path = resolve(root, (msg or {}).get("path"))
        if path is None:
            return {"ok": False, "error": "bad path"}
        if path.is_file():
            select_in_explorer(path)
            return {"ok": True, "path": str(path)}
        tried = tried or path
    return {"ok": False, "error": "not-found", "path": str(tried)}


def serve(origin: str) -> None:
    import msvcrt

    # The length prefix is binary, and a text-mode stdout turns a 0x0A in it into two bytes.
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    ext_id = origin.split("/")[2]
    while (msg := read_message()) is not None:
        try:
            res = handle(msg, ext_id)
        except Exception as err:  # an answer, rather than a host that just died
            res = {"ok": False, "error": str(err)}
        send_message(res)
        remember(origin, msg, res)


def remember(origin: str, msg, res: dict) -> None:
    """
    The last press as the helper saw it, beside the helper. When the button seems
    to do nothing, whether this file moved says whether the browser got this far.
    """
    entry = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "origin": origin, "request": msg, "answer": res}
    try:
        (Path(__file__).parent / "last-call.json").write_text(json.dumps(entry, indent="\t") + "\n", encoding="utf-8")
    except OSError:
        pass


# ----------------------------------------------------------------- installing


def install(ids: list[str], root: Path | None) -> None:
    import winreg

    dest = install_dir()
    manifest_path = dest / f"{HOST}.json"

    # Ids accumulate: the same extension loaded from two folders is two ids, and
    # re-running this for one must not lock the other out.
    origins = read_json(manifest_path).get("allowed_origins", [])
    for ext_id in ids + unpacked_ids():
        origin = f"chrome-extension://{ext_id}/"
        if origin not in origins:
            origins.append(origin)
    if not origins:
        raise SystemExit(
            "Couldn't find the extension in any Chrome, Chromium, Edge or Brave profile.\n"
            "Load it unpacked from this folder first, or pass --id <id>."
        )

    dest.mkdir(parents=True, exist_ok=True)
    if root is not None:
        root = root.expanduser().resolve()
        if not root.is_dir():
            raise SystemExit(f"Not a folder: {root}")
        (dest / "config.json").write_text(json.dumps({"root": str(root)}, indent="\t") + "\n", encoding="utf-8")

    shutil.copy2(__file__, dest / "show_in_folder.py")
    # Chromium on Windows can only launch an executable or a batch file, and this
    # Python is the one known to work.
    (dest / "show_in_folder.bat").write_text(
        f'@echo off\n"{sys.executable}" "%~dp0show_in_folder.py" %*\n', encoding="utf-8", newline="\r\n"
    )
    manifest = {
        "name": HOST,
        "description": "Shows an archived TikTok in Explorer for TikTok Likes Archiver",
        "path": str(dest / "show_in_folder.bat"),
        "type": "stdio",
        "allowed_origins": origins,
    }
    manifest_path.write_text(json.dumps(manifest, indent="\t") + "\n", encoding="utf-8")

    for key in BROWSERS:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"{key}\\{HOST}") as reg:
            winreg.SetValueEx(reg, "", 0, winreg.REG_SZ, str(manifest_path))

    print(f"Installed in {dest}")
    for origin in origins:
        ext_id = origin.split("/")[2]
        folders = [root] if root else picked_folders(ext_id)
        where = ", ".join(map(str, folders)) or "none picked yet — it is looked up on every press"
        print(f"  extension {ext_id}\n    archive folder: {where}")
    print("Show in folder works now — no browser restart needed.")


def uninstall() -> None:
    import winreg

    for key in BROWSERS:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{key}\\{HOST}")
        except FileNotFoundError:
            pass
    shutil.rmtree(install_dir(), ignore_errors=True)
    print("Uninstalled.")


def main(argv: list[str]) -> None:
    if not argv:
        print(__doc__.strip())
        return
    # Chromium starts a host with the caller's origin as the first argument.
    if argv[0].startswith("chrome-extension://"):
        serve(argv[0])
        return

    if sys.platform != "win32":
        raise SystemExit("Show in folder is Windows only for now.")

    cmd, rest = argv[0], argv[1:]
    if cmd == "uninstall":
        uninstall()
        return
    if cmd != "install":
        raise SystemExit(f"unknown command: {cmd}")

    ids, root = [], None
    while rest:
        flag = rest.pop(0)
        if flag in ("--id", "--root") and not rest:
            raise SystemExit(f"{flag} needs a value")
        if flag == "--id":
            ids.append(rest.pop(0).strip())
        elif flag == "--root":
            root = Path(rest.pop(0))
        else:
            raise SystemExit(f"unknown option: {flag}")
    install(ids, root)


if __name__ == "__main__":
    main(sys.argv[1:])
