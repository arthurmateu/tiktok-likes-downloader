"""
End-to-end run of the extension with the local helper, clicked through the way
a person would, against the helper as it is really installed.

    python3 tools/e2e/helper_flow.py

Needs the helper installed (`python3 tools/helper.py install`), a Chromium-family
browser, and an archive the extension's folder picker has chosen before — the
test copies a few of its posts to work on. The extension is loaded fresh into a
throwaway profile, which is what a newly cloned checkout looks like to the
browser.

The browser is found among the usual install locations, Chromium first since
branded Chrome ignores --load-extension; TTARCHIVE_TEST_BROWSER names one
outright. It runs headless, so nothing appears on screen while the machine is in
use. TTARCHIVE_TEST_NO_WINDOWS keeps the helper from opening the folder dialog
or a file manager — the dialog is answered with TTARCHIVE_TEST_PICK — and what
it was asked lands in tools/helper.log, which is what the checks read.

On Windows the browser, and the registry lookup, go through a process the WMI
service starts. A terminal inside a packaged desktop app sees that app's private
copy of the registry, and a browser it starts inherits the same view, so
everything would pass for a browser nobody else has; WMI's processes are
outside any package.

The helper takes over the real archive to begin with, as it would for anyone;
that part only reads. Everything that writes is pointed at a scratch archive
built from a few of the real one's posts. Both the profile and the scratch
archive are deleted afterwards.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from pathlib import Path

from cdp import CDP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import helper  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent
SCRATCH = Path(tempfile.gettempdir()) / "ttarchive-e2e"
PROFILE = SCRATCH / "profile"
ARCHIVE = SCRATCH / "archive"
PORT = 9333
EXT = helper.extension_id()
ARCHIVE_URL = f"chrome-extension://{EXT}/src/archive/archive.html"
HELPER_LOG = REPO / "tools" / "helper.log"

results = []
browser_proc = None


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)


# ----------------------------------------------------------------- the browser


def find_browser() -> tuple[str, str] | None:
    """(which of helper.BROWSERS, its executable): TTARCHIVE_TEST_BROWSER, or the first installed."""
    named = os.environ.get("TTARCHIVE_TEST_BROWSER")
    if named:
        lowered = named.lower()
        kind = next((b for b in ("Edge", "Brave", "Chromium") if b.lower() in lowered), "Chrome")
        return kind, named
    if helper.WINDOWS:
        roots = [os.environ.get(v) for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        places = [
            ("Chromium", r"Chromium\Application\chrome.exe"),
            ("Chrome", r"Google\Chrome\Application\chrome.exe"),
            ("Edge", r"Microsoft\Edge\Application\msedge.exe"),
            ("Brave", r"BraveSoftware\Brave-Browser\Application\brave.exe"),
        ]
        for kind, rel in places:
            for root in filter(None, roots):
                if (Path(root) / rel).is_file():
                    return kind, str(Path(root) / rel)
    elif helper.MACOS:
        for kind, app in (("Chromium", "Chromium"), ("Chrome", "Google Chrome"), ("Edge", "Microsoft Edge"),
                          ("Brave", "Brave Browser")):
            exe = Path("/Applications") / f"{app}.app" / "Contents" / "MacOS" / app
            if exe.is_file():
                return kind, str(exe)
    else:
        for kind, names in (("Chromium", ("chromium", "chromium-browser")), ("Chrome", ("google-chrome", "google-chrome-stable")),
                            ("Edge", ("microsoft-edge",)), ("Brave", ("brave-browser", "brave"))):
            for name in names:
                if shutil.which(name):
                    return kind, shutil.which(name)
    return None


# Windows: no console window for any of the shells below. A test that runs
# while someone is using the machine must not flash windows or take the focus.
QUIET = {"creationflags": subprocess.CREATE_NO_WINDOW} if helper.WINDOWS else {}


def outside(command: str) -> None:
    """Windows: run `command` from a process the WMI service starts, outside any app package, hidden."""
    subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "$hidden = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow = [uint16]0}; "
         f"Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
         f"-Arguments @{{CommandLine='{command}'; ProcessStartupInformation=$hidden}} | Out-Null"],
        capture_output=True, check=True, **QUIET,
    )


def registered_manifest(kind: str) -> dict:
    """The helper's host manifest, found where `kind` of browser looks for it."""
    if not helper.WINDOWS:
        return helper.read_json(helper.data_dir(kind) / "NativeMessagingHosts" / f"{helper.HOST}.json")
    # The registry as a browser started from the Start menu sees it, then the file
    # it names, which is in the checkout and so redirected by no package.
    out = SCRATCH / "registration.txt"
    key = rf"HKCU\{helper.BROWSERS[kind][0][0]}\NativeMessagingHosts\{helper.HOST}"
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


def launch(exe: str, offline: bool = False) -> None:
    """`offline`: TikTok unreachable, so a sync gets as far as opening its tab and sends TikTok nothing."""
    global browser_proc
    args = [exe, "--headless", f"--user-data-dir={PROFILE}", f"--remote-debugging-port={PORT}", "--no-first-run",
            "--no-default-browser-check", "--window-size=1280,900", f"--load-extension={REPO}",
            "--disable-features=DisableLoadExtensionCommandLineSwitch", "about:blank"]
    if offline:
        args.insert(-1, "--host-resolver-rules=MAP *.tiktok.com ~NOTFOUND,MAP tiktok.com ~NOTFOUND")
    if helper.WINDOWS:
        quoted = " ".join(f'"{a}"' if " " in a else a for a in args)
        outside(f'cmd.exe /c "set TTARCHIVE_TEST_NO_WINDOWS=1&& set TTARCHIVE_TEST_PICK={ARCHIVE}&& {quoted}"')
    else:
        env = {**os.environ, "TTARCHIVE_TEST_NO_WINDOWS": "1", "TTARCHIVE_TEST_PICK": str(ARCHIVE)}
        browser_proc = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1)
            return
        except OSError:
            time.sleep(0.5)
    raise SystemExit("the browser did not come up")


def stop_browser() -> None:
    try:
        CDP(PORT).call("Browser.close")
    except Exception:
        pass
    time.sleep(2)
    if browser_proc:
        browser_proc.kill()
    elif helper.WINDOWS:
        # Anything left of it, by the profile it was started on.
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{SCRATCH.name}*' }} | "
             "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
            capture_output=True, **QUIET,
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
        found = find_browser()
        if not found:
            check("a Chromium-family browser to run", False, "none found; name one with TTARCHIVE_TEST_BROWSER")
            return
        kind, exe = found
        print(f"using {kind}: {exe}", flush=True)
        manifest = registered_manifest(kind)
        ok = f"chrome-extension://{EXT}/" in manifest.get("allowed_origins", []) and Path(manifest.get("path", "")).is_file()
        check(f"the helper is registered with {kind}, for this extension's fixed id", ok,
              "" if ok else "run `python3 tools/helper.py install` first")
        if not ok:
            return
        real = next((p for p in helper.remembered_folders(f"chrome-extension://{EXT}/") if (p / "archive.json").is_file()), None)
        if not real:
            check("an archive the extension's picker has chosen, to copy posts from", False)
            return
        vids, photos = build_archive(real)
        launch(exe)
        try:
            library = run(real, vids, photos)
        except Exception:
            # Would otherwise vanish under the sys.exit below.
            traceback.print_exc()
            check("the run got to the end", False)
            return
        finally:
            stop_browser()
        # Its own start, on the same profile: a browser just started has no
        # archive page open, which is the case under test, and TikTok can be cut
        # off for this part alone — headless Chromium stops playing HEVC with it.
        launch(exe, offline=True)
        try:
            library_sync(CDP(PORT), library)
        except Exception:
            traceback.print_exc()
            check("the Library's sync got to the end", False)
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
        c.eval(t, "document.getElementById('lbClose').click(); 1")
    return tab and tab["url"]


def engine(c):
    return c.find(lambda t: t["url"].endswith("/src/archive/archive.html?engine"))


def library_sync(c, url):
    """--- 6. the Library syncs with the archive page closed, run out of sight"""
    if not url:
        check("a Library address to open", False)
        return
    # --load-extension installs it afresh on every start, and a fresh install
    # opens an archive page; the person this is about has none open.
    time.sleep(2)
    for x in c.targets():
        if x["type"] == "page" and x["url"] == ARCHIVE_URL:
            c.call("Target.closeTarget", {"targetId": x["targetId"]})
    _, t = c.open(url)
    c.wait(t, "document.readyState === 'complete' && !!document.getElementById('banner')", timeout=15)
    banner = "document.getElementById('banner').innerText"
    said = lambda: " ".join((c.eval(t, banner) or "").split())
    c.wait(t, f"/Connected|closed/.test({banner})", timeout=15)
    check("with the archive page closed, the Library is still connected, with Sync",
          "Connected to the extension" in said() and c.eval(t, "!document.querySelector('#banner .btn.primary').disabled"),
          said()[:120])
    check("…and nothing runs out of sight until it is asked to sync", engine(c) is None)

    c.eval(t, "document.querySelector('#banner .btn.primary').click(); 1")
    until(c, t, f"/Syncing|Could not start/.test({banner})", 90)
    check("Sync likes starts a run out of sight", engine(c) is not None and "Syncing" in said(), said()[:160])

    # An archive page opened mid-run neither closes it nor runs a second sync beside it.
    c.open(ARCHIVE_URL)
    s = archive_page(c)
    until(c, s, "/Found|Could not/.test(document.getElementById('log').innerText)", 30)
    check("…an archive page opened meanwhile leaves it running", engine(c) is not None)
    c.eval(s, "document.getElementById('startSync').click(); 1")
    until(c, s, "/Not started/.test(document.getElementById('log').innerText)", 10)
    log = text(c, s, "log")
    check("…and its own Sync is refused while it runs", "already running in the background" in log,
          " ".join(l for l in log.splitlines() if "Not started" in l)[-160:])

    # TikTok can't be reached, so the run ends on the tab never loading.
    until(c, t, f"/stopped:/.test({banner})", 90)
    check("the Library says how the run ended", "did not load the profile" in said(), said()[:200])
    check("the archive page reads archive.json again after it",
          until(c, s, "/reading it again/.test(document.getElementById('log').innerText)", 10))
    end = time.time() + 10
    while engine(c) and time.time() < end:
        time.sleep(0.3)
    check("…and the page out of sight closes, the archive page being open", engine(c) is None)


def until(c, s, expr, timeout):
    """c.wait, as a yes or no rather than an exception."""
    try:
        c.wait(s, expr, timeout=timeout)
        return True
    except TimeoutError:
        return False

if __name__ == "__main__":
    main()
