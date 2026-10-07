#!/usr/bin/env python3
"""
The local helper: the archive folder, owned by a process outside the browser.

Experimental, and only used once it is chosen on the archive page. With it on,
the extension still does everything that needs TikTok — reading the likes list
and downloading the media, both in your own logged-in session — but no longer
writes through File System Access. It hands each file to this instead, over
HTTP on 127.0.0.1, and this writes it with an ordinary path. That gets three
things the browser won't give an extension:

  - no folder permission to grant again every browser session;
  - the folder served at a real address, so the Library opens in a tab at
    http://127.0.0.1:8737/ and streams media by range instead of reading each
    file into memory first;
  - Explorer opened on a file by its real path, without reading the browser's
    profile to find out where the archive is.

    python tools/helper.py install      # once
    python tools/helper.py uninstall

Chromium starts it over native messaging, and what it does depends on the
first message:

  start {token, root, port}   the extension's background holds this pipe open,
                              and this serves HTTP until the browser closes it
  pick  {initial}             opens a folder dialog and answers with the choice
  show  {root, path}          selects a file in Explorer

pick and show are processes of their own, started by a click, rather than
requests to the running server: Windows lets a process take the foreground only
when the foreground process has just started it, so a dialog or an Explorer
window opened by a server that has been running for an hour opens behind the
browser.

Windows only, like show_in_folder.py, whose profile lookups and Explorer call
this reuses — `install` copies both into %LOCALAPPDATA%\\ttarchive-helper.
"""

import hmac
import http.cookies
import http.server
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.parse
from email.utils import formatdate
from pathlib import Path

from show_in_folder import (
    BROWSERS,
    local_appdata,
    picked_folders,
    read_json,
    read_message,
    refuse_if_redirected,
    resolve,
    select_in_explorer,
    send_message,
    unpacked_ids,
)

HOST = "com.ttarchive.helper"
VERSION = 1

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


def install_dir() -> Path:
    return local_appdata() / "ttarchive-helper"


def log(line: str) -> None:
    """
    Failures, beside the helper. stdout is the native-messaging pipe — anything
    else written to it is a corrupt message to the browser — and stderr goes
    nowhere anyone reads.
    """
    try:
        if LOG.exists() and LOG.stat().st_size > 256_000:
            LOG.unlink()
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except OSError:
        pass


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
    allow_reuse_address = False
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
    app = Helper(token, msg.get("root"), origin)
    try:
        server = bind(int(msg.get("port") or 0), app)
    except OSError as err:
        send_message({"type": "error", "error": f"could not listen on 127.0.0.1: {err}"})
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    log(f"serving {app.folder.describe()['root']} on 127.0.0.1:{port} for {origin}")
    send_message({"type": "ready", "version": VERSION, "port": port, **app.folder.describe()})

    # Nothing more is expected down the pipe. The extension holds it open for as
    # long as it wants this running and closes it when it doesn't — or the browser
    # exits — and either way that is the signal to stop.
    while read_message() is not None:
        pass
    server.shutdown()
    log("stopped")


# ------------------------------------------------------------- one-shot asks


def ask_folder(initial: str) -> str | None:
    # The same switch as in show_in_folder.select_in_explorer: an automated run
    # names the folder to answer with, or "cancel", and no dialog opens.
    if os.environ.get("TTARCHIVE_TEST_NO_WINDOWS"):
        chosen = os.environ.get("TTARCHIVE_TEST_PICK", "cancel")
        return None if chosen == "cancel" else chosen

    import ctypes
    import tkinter
    from tkinter import filedialog

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
        chosen = filedialog.askdirectory(
            parent=tk, initialdir=initial, mustexist=True, title="Choose the TikTok archive folder"
        )
    finally:
        tk.destroy()
    return str(Path(chosen)) if chosen else None


def pick(msg: dict, origin: str) -> dict:
    initial = msg.get("initial")
    if not (isinstance(initial, str) and Path(initial).is_dir()):
        # The first time round, the folder the browser's own picker last chose for
        # this extension — the archive it has been writing into until now.
        found = [p for p in picked_folders(origin.split("/")[2]) if p.is_dir()]
        initial = str(found[0]) if found else str(Path.home() / "Videos")
    chosen = ask_folder(initial)
    return {"ok": True, "root": chosen} if chosen else {"ok": False, "error": "cancelled"}


def show(msg: dict) -> dict:
    root = msg.get("root")
    if not (isinstance(root, str) and Path(root).is_dir()):
        return {"ok": False, "error": "the helper has no archive folder — choose one on the archiver's page"}
    path = resolve(Path(root), msg.get("path"))
    if path is None:
        return {"ok": False, "error": "bad path"}
    if not path.is_file():
        return {"ok": False, "error": "not-found", "path": str(path)}
    select_in_explorer(path)
    return {"ok": True, "path": str(path)}


def serve(origin: str) -> None:
    if sys.platform == "win32":
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
            res = show(msg)
        else:
            res = {"ok": False, "error": f"unknown command {cmd}"}
    except Exception as err:  # an answer, rather than a host that just died
        res = {"ok": False, "error": str(err)}
    # Every click, as the helper saw it: when a button seems to do nothing, whether
    # a line appeared here says whether the browser got this far.
    log(f"{cmd} {json.dumps(msg.get('path') or msg.get('initial'))} -> {json.dumps(res)}")
    send_message(res)


# ----------------------------------------------------------------- installing


def install(ids: list[str]) -> None:
    import winreg

    dest = install_dir()
    manifest_path = dest / f"{HOST}.json"

    # Ids accumulate, as in show_in_folder.py: the same extension loaded from two
    # folders is two ids, and re-running this for one must not lock the other out.
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
    here = Path(__file__).resolve().parent
    shutil.copy2(here / "helper.py", dest / "helper.py")
    shutil.copy2(here / "show_in_folder.py", dest / "show_in_folder.py")
    (dest / "helper.bat").write_text(
        f'@echo off\n"{sys.executable}" "%~dp0helper.py" %*\n', encoding="utf-8", newline="\r\n"
    )
    manifest = {
        "name": HOST,
        "description": "Writes and serves the archive folder for TikTok Likes Archiver",
        "path": str(dest / "helper.bat"),
        "type": "stdio",
        "allowed_origins": origins,
    }
    manifest_path.write_text(json.dumps(manifest, indent="\t") + "\n", encoding="utf-8")

    for key in BROWSERS:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"{key}\\{HOST}") as reg:
            winreg.SetValueEx(reg, "", 0, winreg.REG_SZ, str(manifest_path))

    refuse_if_redirected(manifest_path, "python tools/helper.py install")
    print(f"Installed in {dest}")
    for origin in origins:
        print(f"  extension {origin.split('/')[2]}")
    # ASCII: a Windows console prints anything else as mojibake.
    print("Choose 'Local helper' under Storage on the archiver's page. No browser restart needed.")


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
        raise SystemExit("The helper is Windows only for now.")

    cmd, rest = argv[0], argv[1:]
    if cmd == "uninstall":
        uninstall()
        return
    if cmd != "install":
        raise SystemExit(f"unknown command: {cmd}")

    ids = []
    while rest:
        flag = rest.pop(0)
        if flag != "--id" or not rest:
            raise SystemExit("usage: helper.py install [--id <extension id>]...")
        ids.append(rest.pop(0).strip())
    install(ids)


if __name__ == "__main__":
    main(sys.argv[1:])
