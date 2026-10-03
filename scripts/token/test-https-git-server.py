#!/usr/bin/env python3
"""Test-only HTTPS smart-git server (git http-backend) for test-local.sh.

Serves bare repos under ROOT with HTTP Basic auth. The expected
"user:password" is read from the file named by $E2E_EXPECT_AUTH_FILE (a dummy
test token; never printed). Run inside a private network namespace only.

usage: test-https-git-server.py ROOT CERT KEY PORT READY_FILE
"""
from __future__ import annotations

import base64
import http.server
import os
import ssl
import subprocess
import sys

ROOT, CERT, KEY, PORT, READY = sys.argv[1:6]
with open(os.environ["E2E_EXPECT_AUTH_FILE"], "rb") as fh:
    EXPECTED = "Basic " + base64.b64encode(fh.read().strip()).decode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:  # no headers logged
        sys.stderr.write("e2e-server: " + (fmt % args) + "\n")

    def do_GET(self) -> None:
        self.serve_git()

    def do_POST(self) -> None:
        self.serve_git()

    def read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().strip().split(b";")[0], 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def serve_git(self) -> None:
        body = self.read_body()
        if self.headers.get("Authorization", "") != EXPECTED:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="e2e"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        path, _, query = self.path.partition("?")
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "GIT_PROJECT_ROOT": ROOT,
            "GIT_HTTP_EXPORT_ALL": "1",
            "REQUEST_METHOD": self.command,
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(len(body)),
            "REMOTE_USER": "x-access-token",
            "REMOTE_ADDR": "127.0.0.1",
        }
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        if self.headers.get("Git-Protocol"):
            env["GIT_PROTOCOL"] = self.headers["Git-Protocol"]
        proc = subprocess.run(
            ["git", "http-backend"], input=body, env=env, capture_output=True, check=False
        )
        head, _, payload = proc.stdout.partition(b"\r\n\r\n")
        status = 200
        headers = []
        for line in head.split(b"\r\n"):
            if not line:
                continue
            name, _, value = line.decode("latin-1").partition(":")
            if name.lower() == "status":
                status = int(value.strip().split()[0])
            else:
                headers.append((name, value.strip()))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> int:
    httpd = http.server.HTTPServer(("127.0.0.1", int(PORT)), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    with open(READY, "w", encoding="ascii") as fh:
        fh.write("ready\n")
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
