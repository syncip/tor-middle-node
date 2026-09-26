#!/usr/bin/env python3
"""Small read-only dashboard for the Tor middle relay.

Talks to Tor through the local control socket and serves a single page
plus a JSON API. Standard library only.

Security model:
  * Read-only. The control client only ever sends the commands in
    ALLOWED_COMMANDS. It never changes Tor's configuration.
  * Exit guard: if Tor ever reports an exit policy that accepts anything,
    or ExitRelay != 0, the dashboard halts Tor immediately.
  * No peer IP addresses or fingerprints are shown - only counts.
  * Optional HTTP basic auth (DASHBOARD_PASSWORD); publish the port on
    127.0.0.1 only.
"""

import base64
import binascii
import hmac
import json
import os
import signal
import socket
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONTROL_SOCKET = os.environ.get("CONTROL_SOCKET", "/run/tor/control")
DATA_DIR = os.environ.get("DASHBOARD_DATA", "/var/lib/tor-dashboard")
PORT = int(os.environ.get("DASHBOARD_PORT", "8080"))
PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
OR_PORT = int(os.environ.get("OR_PORT", "9001"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

LIVE_SECONDS = 600          # 10 minutes of 1-second samples
MINUTE_POINTS = 24 * 60     # 24 hours of 1-minute averages
DAYS_KEPT = 90
POLL_INTERVAL = 5
SAVE_INTERVAL = 60

ALLOWED_COMMANDS = ("PROTOCOLINFO", "AUTHENTICATE", "GETINFO", "GETCONF",
                    "SETEVENTS BW", "SIGNAL HALT")

SETTINGS_KEYS = [
    "Nickname", "ContactInfo", "ORPort", "Address", "DirCache",
    "ExitRelay", "ExitPolicy", "IPv6Exit", "BridgeRelay", "SocksPort",
    "RelayBandwidthRate", "RelayBandwidthBurst", "MaxAdvertisedBandwidth",
    "AccountingMax", "AccountingStart", "MyFamily", "Sandbox",
]


def log(msg):
    print(f"[dashboard] {msg}", flush=True)


# ---------------------------------------------------------------------
# Tor control protocol client (minimal, whitelisted)
# ---------------------------------------------------------------------
class ControlError(Exception):
    pass


class TorControl:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect(path)
        self.file = self.sock.makefile("rb")
        self.lock = threading.Lock()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def _readline(self):
        line = self.file.readline()
        if not line:
            raise ControlError("control connection closed")
        return line.decode("utf-8", "replace").rstrip("\r\n")

    def read_reply(self):
        """Returns (status, [(key_or_line, data_lines)])."""
        lines = []
        while True:
            line = self._readline()
            if len(line) < 4:
                raise ControlError(f"malformed reply: {line!r}")
            status, sep, rest = line[:3], line[3], line[4:]
            if sep == "+":
                data = []
                while True:
                    d = self._readline()
                    if d == ".":
                        break
                    data.append(d[1:] if d.startswith("..") else d)
                lines.append((rest, data))
            else:
                lines.append((rest, None))
            if sep == " ":
                return status, lines

    def command(self, cmd):
        if "\r" in cmd or "\n" in cmd or not cmd.startswith(ALLOWED_COMMANDS):
            raise ControlError(f"command not allowed: {cmd.split(' ')[0]}")
        with self.lock:
            self.sock.sendall(cmd.encode() + b"\r\n")
            status, lines = self.read_reply()
        if not status.startswith("2"):
            raise ControlError(f"{cmd.split(' ')[0]} failed: {status} {lines[-1][0]}")
        return lines

    def authenticate(self):
        lines = self.command("PROTOCOLINFO 1")
        cookie_file = None
        for rest, _ in lines:
            if rest.startswith("AUTH ") and "COOKIEFILE=" in rest:
                cookie_file = rest.split("COOKIEFILE=", 1)[1]
                if cookie_file.startswith('"'):
                    cookie_file = cookie_file[1:cookie_file.index('"', 1)]
        if not cookie_file:
            raise ControlError("Tor offers no cookie authentication")
        with open(cookie_file, "rb") as f:
            cookie = f.read()
        self.command("AUTHENTICATE " + binascii.hexlify(cookie).decode())

    def getinfo(self, *keys):
        out = {}
        for rest, data in self.command("GETINFO " + " ".join(keys)):
            if data is not None:
                key = rest.rstrip("=")
                out[key] = "\n".join(data)
            elif "=" in rest:
                key, value = rest.split("=", 1)
                out[key] = value
        return out

    def getinfo_optional(self, key, default=None):
        try:
            return self.getinfo(key).get(key, default)
        except ControlError:
            return default

    def getconf(self, *keys):
        out = {}
        for rest, _ in self.command("GETCONF " + " ".join(keys)):
            key, _, value = rest.partition("=")
            out.setdefault(key, []).append(value)
        return {k: ", ".join(v for v in vals if v) for k, vals in out.items()}


def connect():
    ctl = TorControl(CONTROL_SOCKET)
    ctl.authenticate()
    return ctl


# ---------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------
class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.live = deque(maxlen=LIVE_SECONDS)       # (ts, read, written)
        self.minutes = deque(maxlen=MINUTE_POINTS)   # (ts, avg_read, avg_written)
        self._minute = None                          # [minute_ts, read, written, n]
        self.days = {}                               # "YYYY-MM-DD" -> [read, written]
        self.total = [0, 0]
        self.first_seen = time.time()
        self.persist = True
        self.dirty = False
        self.load()

    @property
    def path(self):
        return os.path.join(DATA_DIR, "stats.json")

    def load(self):
        try:
            with open(self.path) as f:
                data = json.load(f)
            self.days = {k: [int(v[0]), int(v[1])] for k, v in data.get("days", {}).items()}
            self.total = [int(x) for x in data.get("total", [0, 0])]
            self.first_seen = float(data.get("first_seen", self.first_seen))
            self.minutes.extend(tuple(m) for m in data.get("minutes", []))
            log(f"loaded statistics from {self.path}")
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError) as e:
            log(f"could not load statistics ({e}), starting fresh")

    def save(self):
        if not self.persist or not self.dirty:
            return
        with self.lock:
            data = {
                "days": self.days, "total": self.total,
                "first_seen": self.first_seen, "minutes": list(self.minutes),
            }
            self.dirty = False
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(data, f)
            os.replace(tmp, self.path)
        except OSError as e:
            self.persist = False
            log(f"cannot write {self.path} ({e}); statistics are kept in memory only")

    def add_bw(self, read, written):
        now = time.time()
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.lock:
            self.live.append((int(now), read, written))
            d = self.days.setdefault(day, [0, 0])
            d[0] += read
            d[1] += written
            self.total[0] += read
            self.total[1] += written
            minute = int(now // 60 * 60)
            if self._minute and self._minute[0] != minute:
                m, r, w, n = self._minute
                self.minutes.append((m, r // max(n, 1), w // max(n, 1)))
                self._minute = None
            if self._minute is None:
                self._minute = [minute, 0, 0, 0]
            self._minute[1] += read
            self._minute[2] += written
            self._minute[3] += 1
            if len(self.days) > DAYS_KEPT:
                for k in sorted(self.days)[:-DAYS_KEPT]:
                    del self.days[k]
            self.dirty = True

    def snapshot(self):
        with self.lock:
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            month = today[:7]
            month_total = [0, 0]
            for k, v in self.days.items():
                if k.startswith(month):
                    month_total[0] += v[0]
                    month_total[1] += v[1]
            return {
                "today": self.days.get(today, [0, 0]),
                "month": month_total,
                "total": list(self.total),
                "since": self.first_seen,
                "days": sorted(self.days.items())[-30:],
                "persisted": self.persist,
            }

    def live_series(self, since=0):
        with self.lock:
            return [s for s in self.live if s[0] > since]

    def minute_series(self):
        with self.lock:
            return list(self.minutes)


STATS = Stats()
STATUS = {"connected": False, "error": "starting", "updated": 0}
STATUS_LOCK = threading.Lock()


# ---------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------
def event_loop():
    """Subscribes to BW events (one per second) for live traffic."""
    while True:
        ctl = None
        try:
            ctl = connect()
            ctl.command("SETEVENTS BW")
            ctl.sock.settimeout(120)
            while True:
                _, lines = ctl.read_reply()
                for rest, _ in lines:
                    parts = rest.split()
                    if len(parts) >= 3 and parts[0] == "BW":
                        STATS.add_bw(int(parts[1]), int(parts[2]))
        except (OSError, ControlError, ValueError) as e:
            log(f"event connection: {e}; retrying in 5s")
        finally:
            if ctl:
                ctl.close()
        time.sleep(5)


def count_tcp_connections():
    """Counts established TCP connections, split by direction.

    Inbound = local port is the ORPort. Only counts, never addresses.
    """
    inbound = outbound = 0
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path) as f:
                next(f)
                for line in f:
                    parts = line.split()
                    if len(parts) < 4 or parts[3] != "01":   # 01 = ESTABLISHED
                        continue
                    local_port = int(parts[1].rsplit(":", 1)[1], 16)
                    remote_port = int(parts[2].rsplit(":", 1)[1], 16)
                    if local_port == PORT or remote_port == PORT:
                        continue   # dashboard's own HTTP connections
                    if local_port == OR_PORT:
                        inbound += 1
                    else:
                        outbound += 1
        except (OSError, StopIteration, ValueError):
            continue
    return inbound, outbound


def check_exit_safety(ctl, conf):
    """Halts Tor if it would ever act as an exit."""
    # The effective policy is only available once Tor has built its
    # descriptor ("551 Descriptor still rebuilding" before that).
    policy = ctl.getinfo_optional("exit-policy/full")
    rules = [r.strip() for r in (policy or "").replace(",", "\n").splitlines() if r.strip()]
    accepts = [r for r in rules if r.startswith("accept")]
    problems = []
    if accepts:
        problems.append(f"exit policy accepts traffic: {accepts[:3]}")
    expected = {"ExitRelay": "0", "ExitPolicy": "reject *:*", "IPv6Exit": "0",
                "BridgeRelay": "0", "SocksPort": "0"}
    for key, value in expected.items():
        if conf.get(key) != value:
            problems.append(f"{key}={conf.get(key)!r}")
    if problems:
        log("CRITICAL: relay is no longer a pure middle relay: " + "; ".join(problems))
        log("CRITICAL: halting Tor now.")
        try:
            ctl.command("SIGNAL HALT")
        except (OSError, ControlError):
            pass
        return False, problems
    return True, rules if policy is not None else None


def parse_orconns(text):
    counts = {}
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            counts[parts[1]] = counts.get(parts[1], 0) + 1
    return counts


def poll_once(ctl):
    info = ctl.getinfo("version", "uptime", "traffic/read", "traffic/written",
                       "network-liveness", "status/bootstrap-phase",
                       "orconn-status", "accounting/enabled")
    conf = ctl.getconf(*SETTINGS_KEYS)
    safe, detail = check_exit_safety(ctl, conf)

    fingerprint = ctl.getinfo_optional("fingerprint")
    flags, consensus = [], None
    if fingerprint:
        ns = ctl.getinfo_optional(f"ns/id/{fingerprint}")
        if ns:
            for line in ns.splitlines():
                if line.startswith("s "):
                    flags = line[2:].split()
                elif line.startswith("w ") and "Bandwidth=" in line:
                    consensus = line.split("Bandwidth=", 1)[1].split()[0]

    accounting = None
    if info.get("accounting/enabled") == "1":
        accounting = {}
        for key in ("accounting/bytes", "accounting/bytes-left",
                    "accounting/interval-start", "accounting/interval-end",
                    "accounting/hibernating"):
            accounting[key.split("/", 1)[1]] = ctl.getinfo_optional(key)

    inbound, outbound = count_tcp_connections()
    return {
        "connected": True,
        "error": None,
        "updated": time.time(),
        "tor": {
            "version": info.get("version"),
            "uptime": int(info.get("uptime") or 0),
            "fingerprint": fingerprint,
            "address": ctl.getinfo_optional("address"),
            "bootstrap": info.get("status/bootstrap-phase"),
            "liveness": info.get("network-liveness"),
            "reachable_or": ctl.getinfo_optional("status/reachability-succeeded/or"),
            "flags": flags,
            "consensus_bandwidth": consensus,
            "in_consensus": bool(flags),
        },
        "traffic": {
            "read_since_start": int(info.get("traffic/read") or 0),
            "written_since_start": int(info.get("traffic/written") or 0),
        },
        "connections": {
            "tor_or_connections": parse_orconns(info.get("orconn-status")),
            "tcp_inbound": inbound,
            "tcp_outbound": outbound,
        },
        "accounting": accounting,
        "settings": conf,
        "safety": {"ok": safe, "exit_policy": detail if safe else [], "problems": [] if safe else detail},
    }


def poll_loop():
    ctl = None
    last_save = time.time()
    while True:
        try:
            if ctl is None:
                ctl = connect()
                log("connected to Tor control socket")
            result = poll_once(ctl)
            with STATUS_LOCK:
                STATUS.clear()
                STATUS.update(result)
        except (OSError, ControlError, ValueError) as e:
            with STATUS_LOCK:
                STATUS["connected"] = False
                STATUS["error"] = str(e)
            if ctl:
                ctl.close()
            ctl = None
        if time.time() - last_save >= SAVE_INTERVAL:
            STATS.save()
            last_save = time.time()
        time.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; "
                               "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "tor-dashboard"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass   # no access log: nothing about visitors ends up in docker logs

    def _authorized(self):
        if not PASSWORD:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return False
        _, _, given = decoded.partition(":")
        return hmac.compare_digest(given.encode(), PASSWORD.encode())

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in {**SECURITY_HEADERS, **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj):
        self._send(200, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._send(200, b"ok\n", "text/plain")
        if not self._authorized():
            return self._send(401, b"authentication required\n", "text/plain",
                              {"WWW-Authenticate": 'Basic realm="tor-relay", charset="UTF-8"'})
        if path in STATIC_FILES:
            name, ctype = STATIC_FILES[path]
            with open(os.path.join(STATIC_DIR, name), "rb") as f:
                return self._send(200, f.read(), ctype)
        if path == "/api/status":
            with STATUS_LOCK:
                status = dict(STATUS)
            status["stats"] = STATS.snapshot()
            return self._json(status)
        if path == "/api/live":
            since = 0
            if "since=" in self.path:
                try:
                    since = int(self.path.split("since=", 1)[1].split("&")[0])
                except ValueError:
                    since = 0
            return self._json({"now": int(time.time()), "live": STATS.live_series(since)})
        if path == "/api/history":
            return self._json({"minutes": STATS.minute_series()})
        return self._send(404, b"not found\n", "text/plain")

    do_HEAD = do_GET

    def _method_not_allowed(self):
        self._send(405, b"read-only\n", "text/plain", {"Allow": "GET, HEAD"})

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _method_not_allowed


class Server(ThreadingHTTPServer):
    daemon_threads = True
    address_family = socket.AF_INET6

    def server_bind(self):
        # Dual-stack if the kernel supports IPv6, else fall back to IPv4.
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


def make_server():
    try:
        return Server(("::", PORT), Handler)
    except OSError:
        Server.address_family = socket.AF_INET
        return Server(("0.0.0.0", PORT), Handler)


def main():
    if os.geteuid() == 0:
        log("refusing to run as root")
        sys.exit(1)
    threading.Thread(target=event_loop, daemon=True).start()
    threading.Thread(target=poll_loop, daemon=True).start()
    server = make_server()

    def stop(signum, frame):
        STATS.dirty = True
        STATS.save()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    log(f"listening on port {PORT}" + (" (basic auth enabled)" if PASSWORD else ""))
    try:
        server.serve_forever()
    finally:
        STATS.save()


if __name__ == "__main__":
    main()
