"""
End-to-end run of the extension with the local helper, clicked through the way
a person would, against the helper as it is really installed.

    python tools/e2e/helper_flow.py

Needs `python tools/helper.py install` to have been run — from Windows Terminal,
like any install — and nothing else: the extension is loaded fresh into a
throwaway profile, which is what a newly cloned checkout looks like to Chromium.

The browser is started outside whatever app this script runs in, through WMI,
and headless. Outside, because a terminal inside a packaged app (the Claude
desktop app's) sees that app's private copy of the registry, and a browser it
starts inherits the same view, so everything would pass for a browser the user
doesn't have. Headless, so nothing appears on screen while the machine is in use.
TTARCHIVE_TEST_NO_WINDOWS keeps the helper from opening the folder dialog or
Explorer — the dialog is answered with TTARCHIVE_TEST_PICK — and what it was
asked lands in tools/helper.log, which is what the checks read.

The helper takes over the real archive to begin with, as it would for you; that
part only reads. Everything that writes is pointed at a scratch archive built
from a few of the real one's posts. Both the profile and the scratch archive are
deleted afterwards.
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
import helper  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent
SCRATCH = Path(tempfile.gettempdir()) / "ttarchive-e2e"
PROFILE = SCRATCH / "profile"
ARCHIVE = SCRATCH / "archive"
CHROME = r"C:\Program Files\Chromium\Application\chrome.exe"
PORT = 9333
EXT = helper.extension_id()
ARCHIVE_URL = f"chrome-extension://{EXT}/src/archive/archive.html"
HELPER_LOG = REPO / "tools" / "helper.log"

results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)


# ------------------------------------------------------------ outside the app


def outside(command: str) -> None:
    """Run `command` from a process the WMI service starts: outside any app package."""
    subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='{command}'}} | Out-Null"],
        capture_output=True, check=True,
    )


def registered_manifest() -> dict:
    """
    The helper's host manifest, found the way a browser started from the taskbar
    finds it: the registry as seen from outside, then the file it names. The file
    can be read from here — it is in the checkout, which no package redirects.
    """
    out = SCRATCH / "registration.txt"
    key = rf"HKCU\Software\Chromium\NativeMessagingHosts\{helper.HOST}"
    outside(f'cmd.exe /c "reg query {key} /ve > "{out}" 2>&1"')
    for _ in range(40):
        time.sleep(0.25)
        try:
            lines = out.read_text(errors="replace").splitlines()
        except OSError:
            continue
        if lines:
            value = next((line.split("REG_SZ", 1)[1].strip() for line in lines if "REG_SZ" in line), None)
            return helper.read_json(Path(value)) if value else {}
    return {}


def launch_outside() -> None:
    env = f"set TTARCHIVE_TEST_NO_WINDOWS=1&& set TTARCHIVE_TEST_PICK={ARCHIVE}&& "
    args = (
        f'"{CHROME}" --headless --user-data-dir="{PROFILE}" --remote-debugging-port={PORT} --no-first-run '
        f'--no-default-browser-check --window-size=1280,900 --load-extension="{REPO}" '
        f"--disable-features=DisableLoadExtensionCommandLineSwitch about:blank"
    )
    outside(f'cmd.exe /c "{env}{args}"')
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1)
            return
        except OSError:
            time.sleep(0.5)
    raise SystemExit("Chromium did not come up")


def stop_browser() -> None:
    try:
        CDP(PORT).call("Browser.close")
    except Exception:
        pass
    # Anything left of it, by the profile it was started on.
    time.sleep(2)
    subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='python.exe'\" | "
         f"Where-Object {{ $_.CommandLine -like '*{SCRATCH.name}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}"],
        capture_output=True,
    )
    time.sleep(1)


# -------------------------------------------------------------------- setup


def build_archive(real: Path):
    """A few real posts, copied — never the live archive, for anything that writes."""
    shutil.rmtree(ARCHIVE, ignore_errors=True)
    for d in ("videos", "images", "audio"):
        (ARCHIVE / d).mkdir(parents=True)
    state = json.loads((real / "archive.json").read_text(encoding="utf-8"))
    vids, photos = [], []
    for i in state.get("likeOrder", []):
        it = state["items"].get(i) or {}
        if it.get("status") != "saved":
            continue
        if it.get("type") == "photo" and len(photos) < 2:
            imgs, aud = sorted((real / "images").glob(f"{i}*")), list((real / "audio").glob(f"{i}.*"))
            if imgs and aud:
                photos.append(i)
                for f in imgs + aud:
                    shutil.copy2(f, ARCHIVE / f.parent.name)
        elif it.get("type") != "photo" and len(vids) < 4 and (real / "videos" / f"{i}.mp4").exists():
            vids.append(i)
            shutil.copy2(real / "videos" / f"{i}.mp4", ARCHIVE / "videos")
        if len(vids) == 4 and len(photos) == 2:
            break
    keep = set(vids) | set(photos)
    small = {**state, "items": {k: v for k, v in state["items"].items() if k in keep},
             "likeOrder": [i for i in state["likeOrder"] if i in keep]}
    (ARCHIVE / "archive.json").write_text(json.dumps(small), encoding="utf-8")
    return vids, photos


# ---------------------------------------------------------------- page bits


def archive_page(c, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        t = c.find(lambda t: t["type"] == "page" and t["url"] == ARCHIVE_URL)
        if t:
            s = c.attach(t["targetId"])
            try:
                c.wait(s, "document.readyState === 'complete' && !!document.getElementById('pickFolder')", timeout=10)
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


def new_log_lines(before):
    try:
        return HELPER_LOG.read_text(encoding="utf-8").splitlines()[before:]
    except OSError:
        return []


def log_length():
    try:
        return len(HELPER_LOG.read_text(encoding="utf-8").splitlines())
    except OSError:
        return 0


# --------------------------------------------------------------------- run


def main():
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    try:
        manifest = registered_manifest()
        ok = f"chrome-extension://{EXT}/" in manifest.get("allowed_origins", []) and Path(manifest.get("path", "")).is_file()
        check("the helper is registered, for this extension's fixed id, where a browser started from the taskbar looks",
              ok, "" if ok else "run `python tools\\helper.py install` from Windows Terminal")
        if not ok:
            return
        real = helper.remembered_folders(f"chrome-extension://{EXT}/")
        real = next((p for p in real if (p / "archive.json").is_file()), None)
        if not real:
            check("there is an archive on record to take over", False)
            return
        vids, photos = build_archive(real)
        launch_outside()
        try:
            run(real, vids, photos)
        finally:
            stop_browser()
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)
        print(f"\n{sum(results)}/{len(results)} passed")
        sys.exit(0 if results and all(results) else 1)


def run(real, vids, photos):
    c = CDP(PORT)
    c.open(ARCHIVE_URL)
    s = archive_page(c)

    # --- 1. a freshly loaded extension, with the helper installed: nothing to choose
    c.wait(s, "/Found|Could not/.test(document.getElementById('log').innerText)", timeout=30)
    check("there is no storage menu to choose from", c.eval(s, "document.getElementById('storage') === null"))
    check("no helper notice", not visible(c, s, "helperSetup"), text(c, s, "helperProblem")[:120])
    check("the helper took over the archive the browser's picker chose, without being asked",
          c.eval(s, "document.getElementById('folderName').title") == str(real), c.eval(s, "document.getElementById('folderName').title"))
    log = text(c, s, "log")
    check("…and read it", "Found" in log, log.strip().splitlines()[-1][:120])

    # --- 2. Change folder… goes through the helper's dialog (answered without a window)
    before = log_length()
    click(c, s, "#pickFolder")
    check("the button is held while the dialog is open", c.eval(s, "document.getElementById('pickFolder').disabled"))
    c.wait(s, f"document.getElementById('folderName').title === {json.dumps(str(ARCHIVE))}", timeout=20)
    c.wait(s, "/Found 6|failed/.test(document.getElementById('log').innerText)", timeout=20)
    new = new_log_lines(before)
    check("the helper's dialog answered", any(" pick " in f" {l} " and '"ok": true' in l for l in new), " | ".join(new)[:200])
    cards = c.eval(s, "['statPosts','statVideos'].map(i => document.getElementById(i).textContent)")
    check("the chosen folder is the one read", cards == [str(len(vids) + len(photos)), str(len(vids))], str(cards))

    # --- 3. Library: playback from the helper, then Show in folder
    c.eval(s, "document.querySelector('.tab[data-panel=library]').click(); 1")
    time.sleep(3)
    c.eval(s, "document.querySelector('#grid > *').click(); 1")
    time.sleep(2)
    v = json.loads(c.eval(s, "JSON.stringify((v => v ? {src: v.src.split('?')[0], ready: v.readyState} : null)(document.querySelector('#lbStage video')))") or "null")
    check("a video plays from the helper", bool(v) and v["src"].startswith("http://127.0.0.1:") and v["ready"] >= 2, str(v))
    before = log_length()
    click(c, s, ".lb-folder")
    time.sleep(3)
    new = new_log_lines(before)
    note = c.eval(s, "(document.querySelector('.lb-folder-note') || {}).innerText || ''")
    check("Show in folder is answered by the helper, in the folder it writes",
          any(" show " in f" {l} " and '"ok": true' in l and ARCHIVE.name in l for l in new) and not note, (" | ".join(new) or note)[:200])

    # --- 4. with no folder of its own, Show in folder looks where the browser's picker chose
    c.eval(s, "chrome.runtime.sendMessage({type: 'helper-root', root: null})")
    before = log_length()
    c.eval(s, "document.querySelector('.lb-folder').click(); 1")
    time.sleep(3)
    new = new_log_lines(before)
    check("…and with none, in the folder the browser's picker chose",
          any(" show " in f" {l} " and '"ok": true' in l and str(real).replace("\\", "\\\\") in l for l in new), " | ".join(new)[:200])
    c.eval(s, f"chrome.runtime.sendMessage({{type: 'helper-root', root: {json.dumps(str(ARCHIVE))}}})")
    c.eval(s, "document.getElementById('lbClose').click(); 1")

    # --- 5. the Library in a tab, live
    before_t = {t["targetId"] for t in c.targets()}
    c.eval(s, "document.getElementById('openLibrary').click(); 1")
    time.sleep(3)
    tab = next((t for t in c.targets() if t["targetId"] not in before_t and t["type"] == "page"), None)
    check("Open in a tab lands on the helper's Library",
          bool(tab) and tab["url"].startswith("http://127.0.0.1:") and tab["url"].endswith("/viewer.html"), tab and tab["url"])
    if tab:
        t = c.attach(tab["targetId"])
        c.wait(t, "!document.getElementById('banner').classList.contains('hidden')", timeout=10)
        banner = c.eval(t, "document.getElementById('banner').innerText")
        check("…connected to the extension", "Connected to the extension" in banner, banner.split("\n")[0])
        c.eval(t, "document.querySelector('#grid > *').click(); 1")
        time.sleep(2)
        before = log_length()
        c.eval(t, "document.querySelector('.lb-folder').click(); 1")
        time.sleep(3)
        check("…and its Show in folder reaches the helper too", any('"ok": true' in l for l in new_log_lines(before)))


if __name__ == "__main__":
    main()
