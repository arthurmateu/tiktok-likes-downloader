#!/usr/bin/env python3
"""
The archive's local helper: everything the extension needs from outside the
browser, as one native-messaging host for Chrome, Chromium, Edge and Brave, on
Windows, macOS and Linux.

    python3 tools/helper.py install      # once
    python3 tools/helper.py uninstall

It is optional. Without it the extension writes through File System Access and
everything but Show in folder works. Once it is installed the extension uses it
on its own — there is nothing to switch on:

  - it owns the archive folder. The extension still reads the likes list and
    downloads every file in your own TikTok session, then hands each file to
    this over HTTP on 127.0.0.1, which writes it with an ordinary path: no
    folder permission to grant again every browser session.
  - it serves the folder, so the Library opens in a tab at
    http://127.0.0.1:8737/ and streams media by range.
  - it shows an archived file in the system's file manager — Show in folder.

The browser starts it, and what it does depends on the first message:

  start {token, root, port}   the extension's background holds this pipe open,
                              and this serves HTTP until the browser closes it
  pick  {initial}             opens a folder dialog and answers with the choice
  show  {path, root}          shows a file in the file manager

pick and show are processes of their own, started by a click, rather than
requests to the running server: a process the browser has just started from
a click may bring a window to the front, which on Windows a server that has
been running for an hour may not — its dialog would open behind the browser.

Where the archive is, when the extension hasn't said: the folder the browser's
own picker last chose for it. Chromium records that, path and all, in the
profile's Preferences, so an archive written through File System Access is
taken over without anyone pointing at it again.

`install` registers this file where it is — nothing is copied, so updating the
checkout updates the helper. The extension's id comes from the `key` in
manifest.json and is the same everywhere, so it doesn't matter whether the
extension has been loaded yet.
"""

import base64
import hashlib
import hmac
import http.cookies
import http.server
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
from email.utils import formatdate
from pathlib import Path, PurePosixPath

HOST = "com.ttarchive.helper"
VERSION = 2

WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"

REPO = Path(__file__).resolve().parent.parent

# What `install` writes for the browser to start: a launcher naming this
# machine's Python and this checkout's path, so generated, and gitignored.
NATIVE = REPO / "tools" / "native-host"

# The browsers it is registered for, and where each keeps its profiles:
# (Windows registry key, Windows data dir under %LOCALAPPDATA%), and the data
# dir under ~/Library/Application Support on macOS and $XDG_CONFIG_HOME
# (~/.config) on Linux. A browser reads native-messaging hosts from its own
# registry key on Windows and from NativeMessagingHosts/ in its data dir
# elsewhere.
BROWSERS = {
    "Chrome": ((r"Software\Google\Chrome", r"Google\Chrome\User Data"), "Google/Chrome", "google-chrome"),
    "Chromium": ((r"Software\Chromium", r"Chromium\User Data"), "Chromium", "chromium"),
    "Edge": ((r"Software\Microsoft\Edge", r"Microsoft\Edge\User Data"), "Microsoft Edge", "microsoft-edge"),
    "Brave": (
        (r"Software\BraveSoftware\Brave-Browser", r"BraveSoftware\Brave-Browser\User Data"),
        "BraveSoftware/Brave-Browser",
        "BraveSoftware/Brave-Browser",
    ),
}

# What earlier, Windows-only versions installed, which `install` and
# `uninstall` clear away: a separate Show in folder host, and copies of both
# helpers in %LOCALAPPDATA%.
LEGACY_HOSTS = ("com.ttarchive.show_in_folder",)
LEGACY_DIRS = ("ttarchive-show-in-folder", "ttarchive-helper")

# The id src/lib/backends/fsa.js gives its folder picker, which is what Chromium
# files the picked folder under.
PICKER_ID = "ttarchive-root"

TOKEN_HEADER = "X-Ttarchive-Token"
COOKIE = "ttarchive"

# What the Library is, as far as the address bar is concerned: the folder's own
# viewer.html, which the extension writes after every sync.
LIBRARY = "viewer.html"

# A write lands under this name and is renamed into place once it is whole, so
# a file the listing reports is never one still arriving. Listings skip it.
PART = ".ttarchive-part"

CHUNK = 1 << 20

TYPES = {
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".json": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
}

LOG = Path(__file__).with_name("helper.log")


def log(line: str) -> None:
    """
    What the helper did, beside it: every start, pick and show, and every
    failure. stdout is the native-messaging pipe — anything else written to it
    is a corrupt message to the browser — and stderr goes nowhere anyone reads.
    When a button seems to do nothing, whether a line appeared here says
    whether the browser got this far.
    """
    try:
        if LOG.exists() and LOG.stat().st_size > 256_000:
            LOG.unlink()
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except OSError:
        pass


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def extension_id() -> str:
    """The id the `key` in manifest.json gives the extension, wherever it is loaded from."""
    key = read_json(REPO / "manifest.json").get("key")
    if not key:
        raise SystemExit("manifest.json has no key, so the extension has no fixed id to register.")
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def data_dir(browser: str) -> Path:
    """Where `browser` keeps its profiles on this system."""
    windows, macos, linux = BROWSERS[browser]
    if WINDOWS:
        return Path(os.environ["LOCALAPPDATA"]) / windows[1]
    if MACOS:
        return Path.home() / "Library" / "Application Support" / macos
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / linux


# ------------------------------------------------------------- the browser's record


def profiles():
    for browser in BROWSERS:
        base = data_dir(browser)
        if base.is_dir():
            yield from (prefs.parent for prefs in base.glob("*/Preferences"))


def picked_folders(ext_id: str | None = None) -> list[Path]:
    """
    Folders the browser's own picker chose for the extension, most likely first:
    the last one picked under the picker's id, then every folder the extension
    holds a grant on. A list, since more than one profile can have it.

    With no `ext_id`, any extension's record under the same picker id — which is
    how an archive chosen before the extension had a fixed id is still found.
    """
    found = []

    def add(path):
        if path and Path(path) not in found:
            found.append(Path(path))

    for profile in profiles():
        exceptions = read_json(profile / "Preferences").get("profile", {}).get("content_settings", {}).get("exceptions", {})
        last = exceptions.get("file_system_last_picked_directory", {})
        chosen = exceptions.get("file_system_access_chooser_data", {})
        if ext_id:
            origins = [f"chrome-extension://{ext_id}/,*"]
        else:
            origins = [o for o, e in last.items() if f"custom-id-{PICKER_ID}" in e.get("setting", {})]
        for origin in origins:
            add(last.get(origin, {}).get("setting", {}).get(f"custom-id-{PICKER_ID}", {}).get("path"))
            for entry in chosen.get(origin, {}).get("setting", {}).get("chosen-objects", []):
                if entry.get("is-directory"):
                    add(entry.get("path"))
    return found


def remembered_folders(origin: str) -> list[Path]:
    """
    The archive the browser's picker chose, for this extension's id and then for
    any, that is still there — those holding an archive.json first.
    """
    ext_id = origin.split("/")[2] if origin.startswith("chrome-extension://") else None
    candidates = [p for p in picked_folders(ext_id) + picked_folders() if p.is_dir()]
    seen = []
    for p in sorted(candidates, key=lambda p: not (p / "archive.json").is_file()):
        if p not in seen:
            seen.append(p)
    return seen


# ------------------------------------------------------------------ the pipe


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
    message is still not something to write to, serve, or show unchecked.
    """
    if not isinstance(rel, str) or not rel or "\\" in rel or ":" in rel:
        return None
    parts = PurePosixPath(rel).parts
    if not parts or parts[0] == "/" or any(p in ("", ".", "..") for p in parts):
        return None
    path = (root / Path(*parts)).resolve()
    return path if path.is_relative_to(root.resolve()) else None


# ---------------------------------------------------------------- the desktop


def reveal(path: Path) -> None:
    """Show `path` in the system's file manager, selected where the system can."""
    # Set by automated end-to-end runs, which drive a browser nobody is looking at
    # and must not open windows on the desktop of whoever is using the machine.
    # The request is still answered, and logged.
    if os.environ.get("TTARCHIVE_TEST_NO_WINDOWS"):
        return
    if WINDOWS:
        reveal_windows(path)
    elif MACOS:
        subprocess.run(["open", "-R", str(path)], check=False)
    else:
        reveal_freedesktop(path)


def reveal_windows(path: Path) -> None:
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


def reveal_freedesktop(path: Path) -> None:
    """
    The freedesktop.org file-manager interface selects the file, in every file
    manager that implements it (GNOME Files, Dolphin, Nemo, Caja, Thunar…) —
    asked through whichever D-Bus client is installed. Failing all of them, the
    folder opens with nothing selected.
    """
    uri = path.as_uri()
    attempts = [
        ["gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path",
         "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", f"['{uri}']", ""],
        ["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
         "org.freedesktop.FileManager1.ShowItems", f"array:string:{uri}", "string:"],
    ]
    for command in attempts:
        try:
            if subprocess.run(command, capture_output=True, timeout=5).returncode == 0:
                return
        except (OSError, subprocess.TimeoutExpired):
            pass
    subprocess.Popen(["xdg-open", str(path.parent)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ------------------------------------------------------------------ the folder


class Folder:
    """The archive root, which the extension can change while this runs."""

    def __init__(self, path):
        self._lock = threading.Lock()
        # Kept even if it isn't there right now, unlike a path `set` is handed: the
        # extension remembered it, and saying it is missing — a drive not plugged
        # in — beats forgetting it.
        self._path = Path(path) if isinstance(path, str) and path else None

    def set(self, path) -> bool:
        """False, and nothing changed, if `path` isn't a folder. None forgets it."""
        if path is None:
            new = None
        elif isinstance(path, str) and path and Path(path).is_dir():
            new = Path(path).resolve()
        else:
            return False
        with self._lock:
            self._path = new
        return True

    def get(self) -> Path | None:
        """The root, or None while none is set or it isn't there — a drive unplugged."""
        with self._lock:
            path = self._path
        return path if path is not None and path.is_dir() else None

    def describe(self) -> dict:
        with self._lock:
            path = self._path
        return {"root": str(path) if path else None, "rootOk": self.get() is not None}


def replace(src: Path, dst: Path) -> None:
    """
    os.replace, retried. On Windows a file that another request is still reading
    — the Library streaming a video that is being fetched again, a tab reading
    archive.json — can't be replaced until that read lets go, and cloud-synced
    folders hold files open on their own schedule too.
    """
    for attempt in range(10):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.2 * (attempt + 1))


# ------------------------------------------------------------------- the server


class Helper:
    def __init__(self, token: str, root, origin: str):
        self.token = token
        # The extension's origin as a browser sends it, without the trailing slash
        # Chromium puts on the one it starts a host with.
        self.origin = origin.rstrip("/")
        self.folder = Folder(root)


RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"ttarchive-helper/{VERSION}"

    def log_message(self, format, *args):
        pass

    @property
    def app(self) -> Helper:
        return self.server.app

    # ---------------------------------------------------------- plumbing

    def parse(self) -> None:
        self.url = urllib.parse.urlsplit(self.path)
        self.query = urllib.parse.parse_qs(self.url.query)

    def host_ok(self) -> bool:
        """
        Only this address, by name or number. Anything else is a name some page
        pointed here — DNS rebinding — and is not to be answered as if it were us.
        """
        port = self.server.server_address[1]
        return self.headers.get("Host", "").lower() in (f"127.0.0.1:{port}", f"localhost:{port}")

    def authorised(self, header_only: bool = False) -> bool:
        """
        The token, from a header (the extension), the query (a media URL, or the
        address the Library is opened at) or the cookie that address sets (the
        Library's own requests, which are relative paths and can't carry it).

        Writes take the header alone. A page on another site can't send one to
        this origin without a CORS preflight, and this answers those for the
        extension and nobody else.
        """
        token = self.headers.get(TOKEN_HEADER)
        if not token and not header_only:
            token = (self.query.get("t") or [None])[0] or self.cookie()
        return bool(token) and hmac.compare_digest(token.encode(), self.app.token.encode())

    def cookie(self):
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie") or "")
        except http.cookies.CookieError:
            return None
        morsel = jar.get(COOKIE)
        return morsel.value if morsel else None

    def cors(self) -> None:
        # The extension's own origin and nothing else: a page on any other site
        # gets no CORS headers, so it can't read what this serves.
        if self.headers.get("Origin") == self.app.origin:
            self.send_header("Access-Control-Allow-Origin", self.app.origin)
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag")
        self.send_header("Vary", "Origin")

    def reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def page(self, status: int, title: str, text: str) -> None:
        body = (
            f'<!doctype html><meta charset="utf-8"><title>{title}</title>'
            f'<body style="font:15px system-ui;margin:3em auto;max-width:36em;color:#ddd;background:#111">'
            f"<h1 style=\"font-size:1.2em\">{title}</h1><p>{text}</p>"
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def denied(self) -> None:
        self.page(
            401,
            "TikTok archive",
            "This is the archive's local helper. Open the Library from the archiver's own page — "
            "<b>Library</b>, then <b>Open in a tab</b> — and this address works from then on.",
        )

    def guarded(self, fn) -> None:
        """A write: checked, run, and answered with the reason if it fails."""
        self.parse()
        if not self.host_ok():
            self.close_connection = True
            return self.reply(421, {"ok": False, "error": "wrong host"})
        if not self.authorised(header_only=True):
            # The body is still unread, and on a kept-alive connection it would be
            # read as the next request.
            self.close_connection = True
            return self.reply(401, {"ok": False, "error": "not-authorised"})
        try:
            fn()
        except Exception as err:
            log(f"{self.command} {self.url.path}: {err!r}")
            self.close_connection = True
            try:
                self.reply(500, {"ok": False, "error": str(err) or err.__class__.__name__})
            except OSError:
                pass

    # ---------------------------------------------------------- reads

    def do_GET(self):
        self.read(head=False)

    def do_HEAD(self):
        self.read(head=True)

    def read(self, head: bool) -> None:
        self.parse()
        if not self.host_ok():
            return self.reply(421, {"ok": False, "error": "wrong host"})
        if not self.authorised():
            return self.denied()
        path = self.url.path
        if path == "/":
            return self.front()
        if path == "/api/hello":
            return self.reply(200, {"ok": True, "version": VERSION, **self.app.folder.describe()})
        if path == "/api/list":
            return self.listing()
        if path.startswith("/api/"):
            return self.reply(404, {"ok": False, "error": "no such endpoint"})
        return self.send_file(head)

    def front(self) -> None:
        """
        The archive page opens the Library at /?t=<token>. The token becomes a
        cookie, so the page's own requests for media are let in, and the address
        bar ends up on something worth bookmarking.
        """
        fresh = (self.query.get("t") or [None])[0]
        self.send_response(302)
        if fresh:
            # Lax, not Strict: the first visit is a navigation from the extension's
            # page, which is another site, and Strict would hold the cookie back from
            # the redirect it sets it on. Lax still keeps it off another site's
            # requests for an image or a video here — the way a page elsewhere could
            # otherwise test which posts this archive holds.
            self.send_header("Set-Cookie", f"{COOKIE}={fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000")
        self.send_header("Location", "/" + LIBRARY)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def listing(self) -> None:
        root = self.app.folder.get()
        if root is None:
            return self.reply(409, {"ok": False, "error": "no-folder"})
        rel = (self.query.get("dir") or [""])[0]
        where = root if rel == "" else resolve(root, rel)
        if where is None:
            return self.reply(400, {"ok": False, "error": "bad path"})
        files, dirs = [], []
        try:
            with os.scandir(where) as entries:
                for entry in entries:
                    if entry.is_dir():
                        dirs.append(entry.name)
                    elif entry.is_file() and not entry.name.endswith(PART):
                        files.append(entry.name)
        except (FileNotFoundError, NotADirectoryError):
            pass
        self.reply(200, {"ok": True, "files": files, "dirs": dirs})

    def byte_range(self, size: int):
        """None for the whole file, False for a range past its end, else (start, end)."""
        header = self.headers.get("Range")
        if not header:
            return None
        m = RANGE.match(header.strip())
        # Several ranges, or none that parses: the whole file is a valid answer.
        if not m or not (m[1] or m[2]):
            return None
        if m[1]:
            start = int(m[1])
            end = min(int(m[2]), size - 1) if m[2] else size - 1
        else:
            start, end = max(0, size - int(m[2])), size - 1
        if start >= size or start > end:
            return False
        return start, end

    def send_file(self, head: bool) -> None:
        root = self.app.folder.get()
        if root is None:
            return self.page(409, "No archive folder", "The helper has no archive folder set yet.")
        rel = urllib.parse.unquote(self.url.path.lstrip("/"))
        target = resolve(root, rel)
        if target is None:
            return self.page(400, "Bad path", "That isn't a path inside the archive.")
        try:
            f = open(target, "rb")
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError, PermissionError):
            if rel == LIBRARY:
                return self.page(
                    404,
                    "No Library in this folder yet",
                    f"{LIBRARY} is written after every sync. Press <b>Write viewer.html</b> on the archiver's page to make one now.",
                )
            return self.page(404, "Not found", "That file isn't in the archive.")

        with f:
            st = os.fstat(f.fileno())
            size = st.st_size
            tag = f'"{size:x}-{st.st_mtime_ns:x}"'
            span = self.byte_range(size)
            if span is False:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.cors()
                self.end_headers()
                return
            if span is None and self.headers.get("If-None-Match") == tag:
                self.send_response(304)
                self.send_header("ETag", tag)
                self.cors()
                self.end_headers()
                return

            start, end = span or (0, size - 1)
            length = max(0, end - start + 1)
            self.send_response(206 if span else 200)
            self.send_header("Content-Type", TYPES.get(target.suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", tag)
            self.send_header("Last-Modified", formatdate(st.st_mtime, usegmt=True))
            # Asked again on every use, and cheap to answer: archive.json and
            # viewer.html are rewritten in place, and the ETag says when.
            self.send_header("Cache-Control", "no-cache")
            if span:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.cors()
            self.end_headers()
            if head or not length:
                return

            f.seek(start)
            remaining = length
            try:
                while remaining:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except OSError:
                # A media element drops range requests all the time — on a seek, or a
                # thumbnail scrolled out of view. Nothing to report.
                remaining = -1
            if remaining:
                self.close_connection = True

    # ---------------------------------------------------------- writes

    def do_PUT(self):
        self.guarded(self.put)

    def do_POST(self):
        self.guarded(self.post)

    def put(self) -> None:
        root = self.app.folder.get()
        if root is None:
            self.close_connection = True
            return self.reply(409, {"ok": False, "error": "no-folder"})
        target = resolve(root, urllib.parse.unquote(self.url.path.lstrip("/")))
        if target is None or target.name.endswith(PART):
            self.close_connection = True
            return self.reply(400, {"ok": False, "error": "bad path"})
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            self.close_connection = True
            return self.reply(411, {"ok": False, "error": "no Content-Length"})

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + PART)
        written = 0
        try:
            with open(part, "wb") as out:
                while written < length:
                    chunk = self.rfile.read(min(CHUNK, length - written))
                    if not chunk:
                        break
                    out.write(chunk)
                    written += len(chunk)
            if written != length:
                raise ConnectionError(f"the upload stopped at {written} of {length} bytes")
            replace(part, target)
        except BaseException:
            part.unlink(missing_ok=True)
            raise
        self.reply(200, {"ok": True, "bytes": written})

    def post(self) -> None:
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 64_000)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.close_connection = True
            return self.reply(400, {"ok": False, "error": "bad JSON"})
        if self.url.path == "/api/root":
            path = body.get("path")
            if not self.app.folder.set(path):
                return self.reply(200, {"ok": False, "error": f"not a folder: {path}"})
            log(f"root is now {self.app.folder.describe()['root']}")
            return self.reply(200, {"ok": True, **self.app.folder.describe()})
        self.reply(404, {"ok": False, "error": "no such endpoint"})

    def do_OPTIONS(self):
        self.parse()
        if not self.host_ok():
            return self.reply(421, {"ok": False, "error": "wrong host"})
        self.send_response(204)
        self.cors()
        if self.headers.get("Origin") == self.app.origin:
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST")
            self.send_header("Access-Control-Allow-Headers", f"{TOKEN_HEADER}, Content-Type, Range")
            self.send_header("Access-Control-Max-Age", "600")
            if self.headers.get("Access-Control-Request-Private-Network"):
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # Python's HTTP servers set SO_REUSEADDR, which on Windows lets a second
    # process bind a port that is already taken and share its requests.
    # Elsewhere it only lets a restarted helper have its port straight back.
    allow_reuse_address = not WINDOWS
    allow_reuse_port = False


def bind(preferred: int, app: Helper) -> Server:
    """
    The port the Library was opened on last time, so a bookmark of it keeps
    working — retried briefly, since the helper this one replaces may still be
    letting go of it — and any free port if that one stays taken.
    """
    server = None
    for _ in range(6 if preferred else 1):
        try:
            server = Server(("127.0.0.1", preferred), Handler)
            break
        except OSError:
            time.sleep(0.25)
    if server is None:
        server = Server(("127.0.0.1", 0), Handler)
    server.app = app
    return server


def run(msg: dict, origin: str) -> None:
    token = msg.get("token")
    if not isinstance(token, str) or len(token) < 16:
        send_message({"type": "error", "error": "the extension sent no token"})
        return
    root, adopted = msg.get("root"), False
    if not root:
        # Nothing chosen yet: take over the archive the browser's picker has been
        # writing, so switching to the helper never means pointing at it again.
        found = remembered_folders(origin)
        if found:
            root, adopted = str(found[0]), True
    app = Helper(token, root, origin)
    try:
        server = bind(int(msg.get("port") or 0), app)
    except OSError as err:
        send_message({"type": "error", "error": f"could not listen on 127.0.0.1: {err}"})
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    log(f"serving {app.folder.describe()['root']}{' (taken over from the browser picker)' if adopted else ''} on 127.0.0.1:{port} for {origin}")
    send_message({"type": "ready", "version": VERSION, "port": port, "adopted": adopted, **app.folder.describe()})

    # Nothing more is expected down the pipe. The extension holds it open for as
    # long as it wants this running and closes it when it doesn't — or the browser
    # exits — and either way that is the signal to stop.
    while read_message() is not None:
        pass
    server.shutdown()
    log("stopped")


# ------------------------------------------------------------- one-shot asks

TITLE = "Choose the TikTok archive folder"


def ask_folder(initial: str) -> str | None:
    """The system's own folder dialog where there is one to ask for; Tk's otherwise."""
    # The same switch as in reveal(): an automated run names the folder to
    # answer with, or "cancel", and no dialog opens.
    if os.environ.get("TTARCHIVE_TEST_NO_WINDOWS"):
        chosen = os.environ.get("TTARCHIVE_TEST_PICK", "cancel")
        return None if chosen == "cancel" else chosen
    if MACOS:
        return ask_folder_macos(initial)
    if not WINDOWS:
        for command in (
            ["zenity", "--file-selection", "--directory", f"--title={TITLE}", f"--filename={initial}/"],
            ["kdialog", "--getexistingdirectory", initial, "--title", TITLE],
        ):
            if shutil.which(command[0]):
                out = subprocess.run(command, capture_output=True, text=True)
                chosen = out.stdout.strip()
                return chosen if out.returncode == 0 and chosen else None
    return ask_folder_tk(initial)


def ask_folder_macos(initial: str) -> str | None:
    quoted = initial.replace("\\", "\\\\").replace('"', '\\"')
    out = subprocess.run(
        ["osascript", "-e", "tell current application", "-e", "activate", "-e",
         f'POSIX path of (choose folder with prompt "{TITLE}" default location (POSIX file "{quoted}"))',
         "-e", "end tell"],
        capture_output=True, text=True,
    )
    chosen = out.stdout.strip()
    # Cancelling is an error as far as AppleScript is concerned, with nothing on stdout.
    return chosen.rstrip("/") or "/" if out.returncode == 0 and chosen else None


def ask_folder_tk(initial: str) -> str | None:
    try:
        import tkinter
        from tkinter import filedialog
    except ImportError:
        raise RuntimeError(
            "no folder dialog to open: install zenity, kdialog or Python's tkinter (python3-tk)"
        ) from None
    if WINDOWS:
        import ctypes

        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # or the dialog is drawn blurred
        except (AttributeError, OSError):
            pass
        # The browser started this from a click, so it may take the foreground, and
        # pass that on to the dialog it opens.
        ctypes.windll.user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
    tk = tkinter.Tk()
    tk.withdraw()
    tk.attributes("-topmost", True)
    try:
        chosen = filedialog.askdirectory(parent=tk, initialdir=initial, mustexist=True, title=TITLE)
    finally:
        tk.destroy()
    return str(Path(chosen)) if chosen else None


def default_folder() -> Path:
    videos = Path.home() / ("Movies" if MACOS else "Videos")
    return videos if videos.is_dir() else Path.home()


def pick(msg: dict, origin: str) -> dict:
    initial = msg.get("initial")
    if not (isinstance(initial, str) and Path(initial).is_dir()):
        found = remembered_folders(origin)
        initial = str(found[0] if found else default_folder())
    chosen = ask_folder(initial)
    return {"ok": True, "root": chosen} if chosen else {"ok": False, "error": "cancelled"}


def show(msg: dict, origin: str) -> dict:
    """
    In the folder the helper writes, when the extension names it; otherwise in
    the one the browser's picker chose, which is where File System Access wrote
    and which it never tells the extension.
    """
    root = msg.get("root")
    roots = [Path(root)] if isinstance(root, str) and Path(root).is_dir() else remembered_folders(origin)
    if not roots:
        return {"ok": False, "error": "no archive folder on record — choose one on the archiver's page"}
    tried = None
    for folder in roots:
        path = resolve(folder, msg.get("path"))
        if path is None:
            return {"ok": False, "error": "bad path"}
        if path.is_file():
            reveal(path)
            return {"ok": True, "path": str(path)}
        tried = tried or path
    return {"ok": False, "error": "not-found", "path": str(tried)}


def serve(origin: str) -> None:
    if WINDOWS:
        import msvcrt

        # The length prefix is binary, and a text-mode stdout turns a 0x0A in it into two bytes.
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    msg = read_message()
    if msg is None:
        return
    cmd = msg.get("cmd")
    if cmd == "start":
        run(msg, origin)
        return
    try:
        if cmd == "pick":
            res = pick(msg, origin)
        elif cmd == "show":
            res = show(msg, origin)
        else:
            res = {"ok": False, "error": f"unknown command {cmd}"}
    except Exception as err:  # an answer, rather than a host that just died
        res = {"ok": False, "error": str(err)}
    log(f"{cmd} {json.dumps(msg.get('path') or msg.get('initial'))} -> {json.dumps(res)}")
    send_message(res)


# ----------------------------------------------------------------- installing


def redirected_into() -> str | None:
    """
    On Windows, the app package this process runs inside the private copy of,
    if any.

    A terminal opened inside a packaged desktop app runs with that app's view of
    the user's files and registry: what it writes to %LOCALAPPDATA% and
    HKCU\\Software lands in the package's own copy, which nothing started from
    outside the package can see. An install run there would report success,
    and a browser started from the Start menu would answer "Specified native
    messaging host not found."

    A file written to %LOCALAPPDATA% gives it away on resolving: a redirected one
    resolves to %LOCALAPPDATA%\\Packages\\<package>\\LocalCache\\....
    """
    if not WINDOWS:
        return None
    local = Path(os.environ["LOCALAPPDATA"])
    probe = local / f"ttarchive-probe-{os.getpid()}"
    try:
        probe.write_bytes(b"")
        real = probe.resolve()
    except OSError:
        return None
    finally:
        probe.unlink(missing_ok=True)
    try:
        rel = real.relative_to(local / "Packages")
    except ValueError:
        return None
    return rel.parts[0] if len(rel.parts) > 2 and rel.parts[1].lower() == "localcache" else None


def refuse_if_redirected(command: str) -> None:
    """
    Checked before anything is written or removed. Uninstalling from inside a
    package is worse than installing there: registry deletions become markers
    in its private copy that hide the real entries from that app for good,
    while file deletions go through to the real files.
    """
    package = redirected_into()
    if not package:
        return
    # ASCII: a Windows console prints anything else as mojibake.
    raise SystemExit(
        f"Nothing done: this terminal runs inside the app package {package}, and Windows\n"
        f"keeps what it changes in your registry private to that app - your browser\n"
        f"would never see it.\n\n"
        f"Run it from a terminal opened from the Start menu instead:\n\n"
        f"    python tools\\helper.py {command}\n"
    )


def write_launcher() -> Path:
    """What the browser runs: this Python, on this file, wherever they both are."""
    NATIVE.mkdir(parents=True, exist_ok=True)
    here = Path(__file__).resolve()
    if WINDOWS:
        # Chromium on Windows can only launch an executable or a batch file.
        launcher = NATIVE / "helper.bat"
        launcher.write_text(f'@echo off\n"{sys.executable}" "{here}" %*\n', encoding="utf-8", newline="\r\n")
    else:
        launcher = NATIVE / "helper"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{here}" "$@"\n', encoding="utf-8")
        launcher.chmod(0o755)
    return launcher


def host_manifest(launcher: Path) -> dict:
    return {
        "name": HOST,
        "description": "The archive's local helper for TikTok Likes Archiver",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id()}/"],
    }


def manifest_paths() -> dict[str, Path]:
    """Where each browser reads the host's manifest from, outside Windows."""
    return {browser: data_dir(browser) / "NativeMessagingHosts" / f"{HOST}.json" for browser in BROWSERS}


def install() -> None:
    refuse_if_redirected("install")
    manifest = host_manifest(write_launcher())
    text = json.dumps(manifest, indent="\t") + "\n"

    if WINDOWS:
        import winreg

        path = NATIVE / f"{HOST}.json"
        path.write_text(text, encoding="utf-8")
        for windows, _, _ in BROWSERS.values():
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"{windows[0]}\\NativeMessagingHosts\\{HOST}") as reg:
                winreg.SetValueEx(reg, "", 0, winreg.REG_SZ, str(path))
        registered = list(BROWSERS)
        clear_legacy()
    else:
        # Only for browsers that are here: writing into the data dir of one that
        # isn't would leave a folder behind for nothing.
        registered = []
        for browser, path in manifest_paths().items():
            if data_dir(browser).is_dir():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
                registered.append(browser)
        if not registered:
            raise SystemExit(
                "Found no Chrome, Chromium, Edge or Brave profile to register with.\n"
                "Start the browser once, then run this again."
            )

    print(f"Installed: {Path(__file__).resolve()}")
    print(f"  for extension {manifest['allowed_origins'][0].split('/')[2]}, in {', '.join(registered)}")
    print(f"  with {sys.executable}")
    print("The extension picks it up on its own; no browser restart needed.")


def uninstall() -> None:
    refuse_if_redirected("uninstall")
    if WINDOWS:
        import winreg

        for windows, _, _ in BROWSERS.values():
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{windows[0]}\\NativeMessagingHosts\\{HOST}")
            except FileNotFoundError:
                pass
        clear_legacy()
    else:
        for path in manifest_paths().values():
            path.unlink(missing_ok=True)
    shutil.rmtree(NATIVE, ignore_errors=True)
    print("Uninstalled. The extension goes back to writing through the browser.")


def clear_legacy() -> None:
    import winreg

    for host in LEGACY_HOSTS:
        for windows, _, _ in BROWSERS.values():
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{windows[0]}\\NativeMessagingHosts\\{host}")
            except FileNotFoundError:
                pass
    for name in LEGACY_DIRS:
        shutil.rmtree(Path(os.environ["LOCALAPPDATA"]) / name, ignore_errors=True)


def main(argv: list[str]) -> None:
    if not argv:
        print(__doc__.strip())
        return
    # The browser starts a host with the caller's origin as the first argument.
    if argv[0].startswith("chrome-extension://"):
        serve(argv[0])
        return
    if argv == ["install"]:
        install()
    elif argv == ["uninstall"]:
        uninstall()
    else:
        raise SystemExit("usage: python3 tools/helper.py install | uninstall")


if __name__ == "__main__":
    main(sys.argv[1:])
