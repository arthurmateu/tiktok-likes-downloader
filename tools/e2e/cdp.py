"""Minimal Chrome DevTools Protocol client over a raw websocket, stdlib only."""

import base64
import itertools
import json
import os
import socket
import struct
import time
import urllib.request

PORT = 9333


class WS:
    def __init__(self, url, timeout=120):
        rest = url[len("ws://"):]
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.decode(errors="replace"))

    def send(self, text):
        data = text.encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        self.sock.sendall(bytes(hdr) + masked)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        msg = b""
        while True:
            b1, b2 = self._read(2)
            fin, op = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b2 & 0x80:
                self._read(4)
            data = self._read(n)
            if op == 8:
                raise ConnectionError("websocket closed")
            if op in (9, 10):
                continue
            msg += data
            if fin:
                return msg.decode()


class CDP:
    def __init__(self, port=PORT):
        ver = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=10))
        self.ws = WS(ver["webSocketDebuggerUrl"])
        self.ids = itertools.count(1)
        self.events = []

    def call(self, method, params=None, session=None):
        i = next(self.ids)
        msg = {"id": i, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(json.dumps(msg))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == i:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m["result"]
            self.events.append(m)

    def targets(self):
        return self.call("Target.getTargets")["targetInfos"]

    def attach(self, target_id):
        s = self.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]
        self.call("Runtime.enable", session=s)
        return s

    def open(self, url):
        tid = self.call("Target.createTarget", {"url": url})["targetId"]
        return tid, self.attach(tid)

    def find(self, pred):
        for t in self.targets():
            if pred(t):
                return t
        return None

    def eval(self, session, expr):
        r = self.call(
            "Runtime.evaluate",
            {"expression": expr, "awaitPromise": True, "returnByValue": True, "userGesture": True},
            session,
        )
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError(d.get("exception", {}).get("description") or d.get("text"))
        return r["result"].get("value")

    def wait(self, session, expr, timeout=30, every=0.25):
        end = time.time() + timeout
        while time.time() < end:
            v = self.eval(session, expr)
            if v:
                return v
            time.sleep(every)
        raise TimeoutError(expr)

    def console(self, session=None):
        out = []
        for e in self.events:
            if e.get("method") == "Runtime.consoleAPICalled" and (session is None or e.get("sessionId") == session):
                out.append(" ".join(str(a.get("value", a.get("description", ""))) for a in e["params"]["args"]))
            if e.get("method") == "Runtime.exceptionThrown" and (session is None or e.get("sessionId") == session):
                out.append("EXCEPTION " + json.dumps(e["params"]["exceptionDetails"])[:400])
        return out
