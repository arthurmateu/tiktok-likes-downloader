#!/usr/bin/env python3
"""
Tests for tools/helper.py, run the way Chromium runs it: as a child process
started with an extension origin, spoken to over a length-prefixed pipe, and
then over HTTP on the port it says it got.

    python tools/test_helper.py

Nothing here opens Explorer or a dialog — `show` is only asked for the cases
that refuse before getting that far — and nothing is written outside a
temporary folder, except the helper's own helper.log beside it.
"""

import http.client
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
TOKEN = "0123456789abcdef-test-token"


def send(proc, payload):
    body = json.dumps(payload).encode("utf-8")
    proc.stdin.write(struct.pack("<I", len(body)) + body)
    proc.stdin.flush()


def receive(proc):
    head = proc.stdout.read(4)
    if len(head) < 4:
        return None
    (size,) = struct.unpack("<I", head)
    return json.loads(proc.stdout.read(size).decode("utf-8"))


def stop(proc):
    """Close the pipe, the way the browser does, and wait for the helper to go."""
    proc.stdin.close()
    code = proc.wait(timeout=10)
    proc.stdout.close()
    return code


def host(*messages):
    """Start the helper the way the browser does and hand it `messages`."""
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "helper.py"), ORIGIN + "/"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        cwd=HERE,
    )
    for msg in messages:
        send(proc, msg)
    return proc


class Served(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="ttarchive-helper-"))
        cls.root = cls.dir / "archive"
        cls.other = cls.dir / "other"
        cls.root.mkdir()
        cls.other.mkdir()
        cls.proc = host({"cmd": "start", "token": TOKEN, "root": str(cls.root), "port": 0})
        cls.ready = receive(cls.proc)
        cls.port = cls.ready["port"]

    @classmethod
    def tearDownClass(cls):
        stop(cls.proc)
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        # Back where the class started, whatever a test pointed it at.
        status, body, _ = self.call("POST", "/api/root", json.dumps({"path": str(self.root)}).encode(), self.auth())
        self.assertTrue(json.loads(body)["ok"])

    # -------------------------------------------------------------- helpers

    def call(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", host or f"127.0.0.1:{self.port}")
        for k, v in (headers or {}).items():
            conn.putheader(k, v)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data, res

    def auth(self, **more):
        return {"X-Ttarchive-Token": TOKEN, **more}

    def put(self, rel, data):
        return self.call("PUT", "/" + rel, data, self.auth())

    # ---------------------------------------------------------------- tests

    def test_ready_reports_the_folder(self):
        self.assertEqual(self.ready["type"], "ready")
        self.assertEqual(self.ready["root"], str(self.root.resolve()))
        self.assertTrue(self.ready["rootOk"])
        self.assertGreater(self.port, 0)

    def test_write_then_read_back(self):
        data = bytes(range(256)) * 40
        status, body, _ = self.put("videos/7001.mp4", data)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["bytes"], len(data))
        self.assertEqual((self.root / "videos" / "7001.mp4").read_bytes(), data)
        self.assertFalse((self.root / "videos" / "7001.mp4.ttarchive-part").exists(), "a .part file was left behind")

        status, got, res = self.call("GET", "/videos/7001.mp4", headers=self.auth())
        self.assertEqual((status, got), (200, data))
        self.assertEqual(res.getheader("Content-Type"), "video/mp4")
        self.assertEqual(res.getheader("Accept-Ranges"), "bytes")

    def test_overwrite_replaces(self):
        self.put("archive.json", b'{"version": 1}')
        self.put("archive.json", b'{"version": 2}')
        self.assertEqual((self.root / "archive.json").read_bytes(), b'{"version": 2}')

    def test_ranges(self):
        data = b"0123456789"
        self.put("audio/42.mp3", data)
        status, got, res = self.call("GET", "/audio/42.mp3", headers=self.auth(Range="bytes=2-5"))
        self.assertEqual((status, got), (206, b"2345"))
        self.assertEqual(res.getheader("Content-Range"), "bytes 2-5/10")

        status, got, _ = self.call("GET", "/audio/42.mp3", headers=self.auth(Range="bytes=7-"))
        self.assertEqual((status, got), (206, b"789"))
        status, got, _ = self.call("GET", "/audio/42.mp3", headers=self.auth(Range="bytes=-3"))
        self.assertEqual((status, got), (206, b"789"))
        status, got, _ = self.call("GET", "/audio/42.mp3", headers=self.auth(Range="bytes=4-400"))
        self.assertEqual((status, got), (206, b"456789"))

        status, _, res = self.call("GET", "/audio/42.mp3", headers=self.auth(Range="bytes=10-"))
        self.assertEqual(status, 416)
        self.assertEqual(res.getheader("Content-Range"), "bytes */10")

    def test_head_gives_the_size(self):
        self.put("images/9_01.jpg", b"x" * 1234)
        status, body, res = self.call("HEAD", "/images/9_01.jpg", headers=self.auth())
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(res.getheader("Content-Length"), "1234")
        status, _, _ = self.call("HEAD", "/images/missing.jpg", headers=self.auth())
        self.assertEqual(status, 404)

    def test_etag_revalidates(self):
        self.put("viewer.html", b"<p>one</p>")
        _, _, res = self.call("GET", "/viewer.html", headers=self.auth())
        tag = res.getheader("ETag")
        status, _, _ = self.call("GET", "/viewer.html", headers=self.auth(**{"If-None-Match": tag}))
        self.assertEqual(status, 304)
        time.sleep(0.02)
        self.put("viewer.html", b"<p>two, longer</p>")
        status, got, _ = self.call("GET", "/viewer.html", headers=self.auth(**{"If-None-Match": tag}))
        self.assertEqual((status, got), (200, b"<p>two, longer</p>"))

    def test_listing(self):
        self.put("videos/1.mp4", b"a")
        self.put("videos/2.mp4", b"b")
        (self.root / "videos" / "3.mp4.ttarchive-part").write_bytes(b"half")
        status, body, _ = self.call("GET", "/api/list?dir=videos", headers=self.auth())
        listing = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue({"1.mp4", "2.mp4"} <= set(listing["files"]))
        self.assertNotIn("3.mp4.ttarchive-part", listing["files"], "a write still arriving was listed")

        status, body, _ = self.call("GET", "/api/list?dir=", headers=self.auth())
        self.assertIn("videos", json.loads(body)["dirs"])
        status, body, _ = self.call("GET", "/api/list?dir=nothing-here", headers=self.auth())
        self.assertEqual(json.loads(body), {"ok": True, "files": [], "dirs": []})

    def test_token_is_required(self):
        self.put("videos/5.mp4", b"secret")
        for path in ("/videos/5.mp4", "/api/list?dir=videos", "/api/hello", "/"):
            status, _, _ = self.call("GET", path)
            self.assertEqual(status, 401, path)
        status, _, _ = self.call("GET", "/videos/5.mp4", headers={"X-Ttarchive-Token": "wrong"})
        self.assertEqual(status, 401)
        status, _, _ = self.call("PUT", "/videos/6.mp4", b"no")
        self.assertEqual(status, 401)
        self.assertFalse((self.root / "videos" / "6.mp4").exists())

    def test_query_and_cookie_read_but_do_not_write(self):
        self.put("videos/8.mp4", b"eight")
        status, got, _ = self.call("GET", f"/videos/8.mp4?t={TOKEN}")
        self.assertEqual((status, got), (200, b"eight"))
        status, got, _ = self.call("GET", "/videos/8.mp4", headers={"Cookie": f"other=1; ttarchive={TOKEN}"})
        self.assertEqual((status, got), (200, b"eight"))

        status, _, _ = self.call("PUT", f"/videos/9.mp4?t={TOKEN}", b"nine")
        self.assertEqual(status, 401)
        status, _, _ = self.call("PUT", "/videos/9.mp4", b"nine", {"Cookie": f"ttarchive={TOKEN}"})
        self.assertEqual(status, 401)
        self.assertFalse((self.root / "videos" / "9.mp4").exists())

    def test_front_door_sets_the_cookie(self):
        status, _, res = self.call("GET", f"/?t={TOKEN}")
        self.assertEqual(status, 302)
        self.assertEqual(res.getheader("Location"), "/viewer.html")
        cookie = res.getheader("Set-Cookie")
        self.assertIn(f"ttarchive={TOKEN}", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)

    def test_other_hosts_are_refused(self):
        self.put("videos/10.mp4", b"ten")
        status, _, _ = self.call("GET", "/videos/10.mp4", headers=self.auth(), host="evil.example")
        self.assertEqual(status, 421)
        status, _, _ = self.call("GET", "/videos/10.mp4", headers=self.auth(), host=f"localhost:{self.port}")
        self.assertEqual(status, 200)

    def test_paths_stay_inside_the_folder(self):
        (self.other / "outside.txt").write_text("not yours")
        for path in (
            "/..%2Fother%2Foutside.txt",
            "/videos/..%2F..%2Fother%2Foutside.txt",
            "/videos%5C..%5C..%5Cother%5Coutside.txt",
            "/C:%2Fx.txt",
        ):
            status, body, _ = self.call("GET", path, headers=self.auth())
            self.assertEqual(status, 400, path)
            self.assertNotIn(b"not yours", body)
            status, _, _ = self.call("PUT", path, b"overwritten", self.auth())
            self.assertEqual(status, 400, path)
        self.assertEqual((self.other / "outside.txt").read_text(), "not yours")

        status, _, _ = self.call("PUT", "/videos/x.mp4.ttarchive-part", b"x", self.auth())
        self.assertEqual(status, 400)

    def test_cors_answers_the_extension_only(self):
        pre = {"Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "x-ttarchive-token"}
        status, _, res = self.call("OPTIONS", "/videos/1.mp4", headers={"Origin": ORIGIN, **pre})
        self.assertEqual(status, 204)
        self.assertEqual(res.getheader("Access-Control-Allow-Origin"), ORIGIN)
        self.assertIn("X-Ttarchive-Token", res.getheader("Access-Control-Allow-Headers"))

        status, _, res = self.call("OPTIONS", "/videos/1.mp4", headers={"Origin": "https://evil.example", **pre})
        self.assertIsNone(res.getheader("Access-Control-Allow-Origin"))
        self.assertIsNone(res.getheader("Access-Control-Allow-Headers"))

        self.put("videos/11.mp4", b"x")
        _, _, res = self.call("GET", "/videos/11.mp4", headers=self.auth(Origin=ORIGIN))
        self.assertEqual(res.getheader("Access-Control-Allow-Origin"), ORIGIN)
        _, _, res = self.call("GET", "/videos/11.mp4", headers=self.auth(Origin="https://evil.example"))
        self.assertIsNone(res.getheader("Access-Control-Allow-Origin"))

    def test_changing_the_folder(self):
        status, body, _ = self.call("POST", "/api/root", json.dumps({"path": str(self.other)}).encode(), self.auth())
        self.assertEqual(json.loads(body), {"ok": True, "root": str(self.other.resolve()), "rootOk": True})
        self.put("videos/12.mp4", b"there")
        self.assertTrue((self.other / "videos" / "12.mp4").exists())

        status, body, _ = self.call(
            "POST", "/api/root", json.dumps({"path": str(self.dir / "nope")}).encode(), self.auth()
        )
        self.assertFalse(json.loads(body)["ok"])
        status, body, _ = self.call("GET", "/api/hello", headers=self.auth())
        self.assertEqual(json.loads(body)["root"], str(self.other.resolve()), "a bad folder replaced a good one")

        status, _, _ = self.call("POST", "/api/root", json.dumps({"path": str(self.root)}).encode())
        self.assertEqual(status, 401)

    def test_parallel_writes(self):
        blobs = {f"videos/{n}.mp4": bytes([n % 256]) * (300_000 + n) for n in range(100, 116)}
        results = {}

        def write(rel, data):
            results[rel] = self.put(rel, data)[0]

        threads = [threading.Thread(target=write, args=item) for item in blobs.items()]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(set(results.values()), {200})
        for rel, data in blobs.items():
            self.assertEqual((self.root / rel).read_bytes(), data, rel)

    def test_missing_viewer_says_how_to_make_one(self):
        (self.root / "viewer.html").unlink(missing_ok=True)
        status, body, _ = self.call("GET", "/viewer.html", headers=self.auth())
        self.assertEqual(status, 404)
        self.assertIn(b"Write viewer.html", body)


class Lifecycle(unittest.TestCase):
    def test_exits_when_the_pipe_closes(self):
        with tempfile.TemporaryDirectory() as root:
            proc = host({"cmd": "start", "token": TOKEN, "root": root, "port": 0})
            port = receive(proc)["port"]
            self.assertEqual(stop(proc), 0)
            with self.assertRaises(OSError):
                http.client.HTTPConnection("127.0.0.1", port, timeout=2).connect()

    def test_missing_folder_is_reported_not_forgotten(self):
        gone = str(Path(tempfile.gettempdir()) / "ttarchive-helper-not-here")
        proc = host({"cmd": "start", "token": TOKEN, "root": gone, "port": 0})
        try:
            ready = receive(proc)
            self.assertEqual(ready["root"], gone)
            self.assertFalse(ready["rootOk"])
        finally:
            stop(proc)

    def test_no_token_no_server(self):
        proc = host({"cmd": "start", "root": None, "port": 0})
        self.assertEqual(receive(proc)["type"], "error")
        stop(proc)

    def test_a_busy_port_falls_back(self):
        with tempfile.TemporaryDirectory() as root:
            first = host({"cmd": "start", "token": TOKEN, "root": root, "port": 0})
            taken = receive(first)["port"]
            second = host({"cmd": "start", "token": TOKEN, "root": root, "port": taken})
            try:
                port = receive(second)["port"]
                self.assertNotEqual(port, taken, "two helpers share one port")
            finally:
                for proc in (first, second):
                    stop(proc)

    def test_show_refuses_before_opening_anything(self):
        with tempfile.TemporaryDirectory() as root:
            cases = [
                ({"cmd": "show", "root": root, "path": "../escape.mp4"}, "bad path"),
                ({"cmd": "show", "root": root, "path": "videos/nope.mp4"}, "not-found"),
                ({"cmd": "show", "root": None, "path": "videos/1.mp4"}, None),
                ({"cmd": "frobnicate"}, None),
            ]
            for msg, error in cases:
                proc = host(msg)
                res = receive(proc)
                stop(proc)
                self.assertFalse(res["ok"], msg)
                if error:
                    self.assertEqual(res["error"], error, msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
