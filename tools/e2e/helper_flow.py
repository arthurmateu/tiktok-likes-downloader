"""
End-to-end run of the local-helper flow, clicked through the way a person
would, in a copy of your own Chromium profile.

    python tools/e2e/helper_flow.py

Headless, so nothing appears on screen or takes focus while the machine is in
use. The helpers are told by TTARCHIVE_TEST_NO_WINDOWS not to open the folder
dialog or Explorer — the dialog is answered with TTARCHIVE_TEST_PICK — and each
records what it was asked in helper.log / last-call.json, which is what the
checks read. Needs both helpers installed (tools/helper.py install,
tools/show_in_folder.py install).

The profile copy leaves out caches, cookies and saved logins, so it is signed
in to nothing. Anything that writes goes to a scratch archive built from a few
of the real archive's posts; the real archive is only read. Both are deleted
afterwards.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from cdp import CDP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from show_in_folder import picked_folders, unpacked_ids  # noqa: E402

SCRATCH = Path(tempfile.gettempdir()) / "ttarchive-e2e"
PROFILE = SCRATCH / "profile"
ARCHIVE = SCRATCH / "archive"
REAL_PROFILE = Path(os.environ["LOCALAPPDATA"]) / "Chromium" / "User Data"
CHROME = r"C:\Program Files\Chromium\Application\chrome.exe"
EXT = unpacked_ids()[0]
# The archive the browser's own picker last chose: read from, never written to.
REAL_ARCHIVE = next(p for p in picked_folders(EXT) if (p / "archive.json").is_file())
ARCHIVE_URL = f"chrome-extension://{EXT}/src/archive/archive.html"
HELPER_LOG = Path(os.environ["LOCALAPPDATA"]) / "ttarchive-helper" / "helper.log"
OLD_LAST_CALL = Path(os.environ["LOCALAPPDATA"]) / "ttarchive-show-in-folder" / "last-call.json"

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)


def copy_profile():
    shutil.rmtree(PROFILE, ignore_errors=True)
    subprocess.run(
        ["robocopy", str(REAL_PROFILE / "Default"), str(PROFILE / "Default"), "/E", "/NFL", "/NDL", "/NJH", "/NJS",
         "/NP", "/R:0", "/W:0", "/XD", "Cache", "Code Cache", "GPUCache", "Dawn*", "Shared Dictionary", "Network",
         "/XF", "Login Data*", "Web Data*", "Cookies*"],
        capture_output=True,
    )
    shutil.copy2(REAL_PROFILE / "Local State", PROFILE / "Local State")


def build_archive():
    """A few real posts, copied — never the live archive, for anything that writes."""
    shutil.rmtree(ARCHIVE, ignore_errors=True)
    for d in ("videos", "images", "audio"):
        (ARCHIVE / d).mkdir(parents=True)
    state = json.loads((REAL_ARCHIVE / "archive.json").read_text(encoding="utf-8"))
    vids, photos = [], []
    for i in state.get("likeOrder", []):
        it = state["items"].get(i) or {}
        if it.get("status") != "saved":
            continue
        if it.get("type") == "photo" and len(photos) < 2:
            imgs, aud = sorted((REAL_ARCHIVE / "images").glob(f"{i}*")), list((REAL_ARCHIVE / "audio").glob(f"{i}.*"))
            if imgs and aud:
                photos.append(i)
                for f in imgs + aud:
                    shutil.copy2(f, ARCHIVE / f.parent.name)
        elif it.get("type") != "photo" and len(vids) < 4 and (REAL_ARCHIVE / "videos" / f"{i}.mp4").exists():
            vids.append(i)
            shutil.copy2(REAL_ARCHIVE / "videos" / f"{i}.mp4", ARCHIVE / "videos")
        if len(vids) == 4 and len(photos) == 2:
            break
    keep = set(vids) | set(photos)
    small = {**state, "items": {k: v for k, v in state["items"].items() if k in keep},
             "likeOrder": [i for i in state["likeOrder"] if i in keep]}
    (ARCHIVE / "archive.json").write_text(json.dumps(small), encoding="utf-8")
    return vids, photos


def launch():
    env = {**os.environ, "TTARCHIVE_TEST_NO_WINDOWS": "1", "TTARCHIVE_TEST_PICK": str(ARCHIVE)}
    proc = subprocess.Popen(
        [CHROME, "--headless", f"--user-data-dir={PROFILE}", "--remote-debugging-port=9333", "--no-first-run",
         "--no-default-browser-check", "--window-size=1280,900", "about:blank"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(60):
        try:
            urllib.request.urlopen("http://127.0.0.1:9333/json/version", timeout=1)
            return proc
        except OSError:
            time.sleep(0.5)
    raise SystemExit("Chromium did not come up")


def archive_page(c, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        t = c.find(lambda t: t["type"] == "page" and t["url"] == ARCHIVE_URL)
        if t:
            s = c.attach(t["targetId"])
            try:
                c.wait(s, "document.readyState === 'complete' && !!document.getElementById('storage')", timeout=10)
                return s
            except Exception:
                pass
        time.sleep(0.3)
    raise TimeoutError("no archive page")


def click(c, s, selector):
    r = json.loads(c.eval(s, f"JSON.stringify(document.querySelector({json.dumps(selector)}).getBoundingClientRect())"))
    x, y = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        c.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}, session=s)


def visible(c, s, id_):
    return c.eval(s, f"(e => !!e && !e.classList.contains('hidden') && e.offsetParent !== null)(document.getElementById('{id_}'))")


def text(c, s, id_):
    return c.eval(s, f"(document.getElementById('{id_}') || {{}}).innerText || ''")


def log_lines(path):
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []


def main():
    print("copying profile + building scratch archive…", flush=True)
    copy_profile()
    vids, photos = build_archive()
    proc = launch()
    try:
        run(vids, photos)
    finally:
        try:
            CDP().call("Browser.close")
        except Exception:
            pass
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(1)
        shutil.rmtree(SCRATCH, ignore_errors=True)
    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)


def run(vids, photos):
    c = CDP()
    c.open(ARCHIVE_URL)
    s = archive_page(c)
    # Browser storage to start with, whatever the real profile was last left on.
    # Its worker is left alone: if that is stale, it is the first thing to check.
    c.eval(s, "chrome.storage.local.remove(['backend', 'helper'])")
    c.call("Page.reload", session=s)
    time.sleep(1)
    s = archive_page(c)
    time.sleep(1)
    check("starts on Browser storage", c.eval(s, "document.getElementById('storage').value") == "browser")

    # --- 1. choose the helper, the way the user did, with the old worker still running
    c.eval(s, "(e => { e.value = 'helper'; e.dispatchEvent(new Event('change')); })(document.getElementById('storage')); 1")
    time.sleep(2)
    s = archive_page(c)
    c.wait(s, "!document.getElementById('helperSetup').classList.contains('hidden') || /Found/.test(document.getElementById('log').innerText)", timeout=15)
    # A copied profile runs the worker the real one last registered, which is
    # stale whenever the extension has changed since it was last reloaded.
    stale = visible(c, s, "helperReload")
    if stale:
        check("an old background is recognised, and the page offers to reload the extension", True, text(c, s, "helperProblem")[:110])
        check("…without a folder button that can only fail", not visible(c, s, "pickFolder"))
        check("…and without the install instructions", not visible(c, s, "helperInstall"))

        # --- 2. reload the extension from that button; the page should come back by itself
        click(c, s, "#helperReload")
        time.sleep(4)
        c = CDP()
        s = archive_page(c, timeout=20)
        check("the archive page reopens after the reload", True)
    else:
        print("SKIP  the profile's background is current, so there is no stale one to recognise", flush=True)
    c.wait(s, "document.getElementById('storage').value === 'helper'", timeout=10)
    time.sleep(1.5)
    check("Storage still says Local helper", c.eval(s, "document.getElementById('storage').value") == "helper")
    check("no problem notice now", not visible(c, s, "helperSetup"), text(c, s, "helperProblem")[:100])
    check("Choose folder… is offered", visible(c, s, "pickFolder"))

    # --- 3. choose the folder through the helper's dialog (answered without a window)
    before = len(log_lines(HELPER_LOG))
    click(c, s, "#pickFolder")
    check("the button is held while the dialog is open", c.eval(s, "document.getElementById('pickFolder').disabled"))
    c.wait(s, "/Found|failed/.test(document.getElementById('log').innerText)", timeout=20)
    log = text(c, s, "log")
    check("the folder is read through the helper", "Found" in log and "failed" not in log, log.strip().splitlines()[-1][:120])
    new = log_lines(HELPER_LOG)[before:]
    check("the helper's dialog was what answered", any(l.split(" ", 2)[-1].startswith("pick ") and '"ok": true' in l for l in new), " | ".join(new)[:200])
    check("the button is free again", not c.eval(s, "document.getElementById('pickFolder').disabled"))
    check("the folder is the one chosen", c.eval(s, "document.getElementById('folderName').title") == str(ARCHIVE))
    cards = c.eval(s, "['statPosts','statVideos'].map(i => document.getElementById(i).textContent)")
    check("posts and videos counted", cards == [str(len(vids) + len(photos)), str(len(vids))], str(cards))

    # --- 4. Library: playback from the helper, then Show in folder
    c.eval(s, "document.querySelector('.tab[data-panel=library]').click(); 1")
    time.sleep(3)
    c.eval(s, "document.querySelector('#grid > *').click(); 1")
    time.sleep(2)
    v = json.loads(c.eval(s, "JSON.stringify((v => v ? {src: v.src.split('?')[0], ready: v.readyState} : null)(document.querySelector('#lbStage video')))") or "null")
    check("a video plays from the helper", bool(v) and v["src"].startswith("http://127.0.0.1:") and v["ready"] >= 2, str(v))
    before = len(log_lines(HELPER_LOG))
    click(c, s, ".lb-folder")
    time.sleep(3)
    new = log_lines(HELPER_LOG)[before:]
    note = c.eval(s, "(document.querySelector('.lb-folder-note') || {}).innerText || ''")
    check("Show in folder is answered by the local helper", any(" show " in f" {l} " and '"ok": true' in l for l in new) and not note, (" | ".join(new) or note)[:200])

    # --- 5. Show in folder when the local helper has no folder: falls back to the old helper
    old_before = OLD_LAST_CALL.stat().st_mtime if OLD_LAST_CALL.exists() else 0
    saved = c.eval(s, "chrome.storage.local.get('helper').then(o => JSON.stringify(o.helper))")
    c.eval(s, "chrome.storage.local.get('helper').then(o => chrome.storage.local.set({helper: {...o.helper, root: null}}))")
    c.eval(s, "document.querySelector('.lb-folder').click(); 1")
    time.sleep(3)
    old_after = OLD_LAST_CALL.stat().st_mtime if OLD_LAST_CALL.exists() else 0
    last = json.loads(OLD_LAST_CALL.read_text(encoding="utf-8")) if OLD_LAST_CALL.exists() else {}
    note = c.eval(s, "(document.querySelector('.lb-folder-note') || {}).innerText || ''")
    check("…and without a folder in it, the old helper takes over", old_after > old_before and last.get("answer", {}).get("ok") is True and not note,
          f"{last.get('answer')} {note}"[:200])
    c.eval(s, f"chrome.storage.local.set({{helper: {saved}}})")
    c.eval(s, "document.getElementById('lbClose').click(); 1")

    # --- 6. the Library in a tab, live
    before_t = {t["targetId"] for t in c.targets()}
    c.eval(s, "document.getElementById('openLibrary').click(); 1")
    time.sleep(3)
    tab = next((t for t in c.targets() if t["targetId"] not in before_t and t["type"] == "page"), None)
    check("Open in a tab lands on the helper's Library", bool(tab) and tab["url"].startswith("http://127.0.0.1:") and tab["url"].endswith("/viewer.html"), tab and tab["url"])
    if tab:
        t = c.attach(tab["targetId"])
        c.wait(t, "!document.getElementById('banner').classList.contains('hidden')", timeout=10)
        banner = c.eval(t, "document.getElementById('banner').innerText")
        check("…connected to the extension", "Connected to the extension" in banner, banner.split("\n")[0])
        c.eval(t, "document.querySelector('#grid > *').click(); 1")
        time.sleep(2)
        before = len(log_lines(HELPER_LOG))
        c.eval(t, "document.querySelector('.lb-folder').click(); 1")
        time.sleep(3)
        new = log_lines(HELPER_LOG)[before:]
        check("…and its Show in folder reaches the helper too", any('"ok": true' in l for l in new), " | ".join(new)[:200])

    # --- 7. back to Browser storage: nothing the helper set up is left in the way
    c.eval(s, "(e => { e.value = 'browser'; e.dispatchEvent(new Event('change')); })(document.getElementById('storage')); 1")
    time.sleep(2)
    s = archive_page(c)
    time.sleep(1)
    check("switching back lands on Browser storage", c.eval(s, "document.getElementById('storage').value") == "browser")
    check("…with no helper notice", not visible(c, s, "helperSetup"))


if __name__ == "__main__":
    main()
