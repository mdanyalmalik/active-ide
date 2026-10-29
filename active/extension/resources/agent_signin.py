# Copyright (c) Active contributors. Licensed under the MIT License.
"""Drives a coding agent's browser sign-in in a hidden pseudo-terminal so Active
can show its own UI instead of a terminal.

Two modes:
  menu     the agent's interactive app offers "Log in with browser"; answer its
           prompts the way a person would.
  command  the agent has a dedicated login command (Muse Code: `muse login`); run it,
           let it open the browser, and wait for it to exit.
It runs in a throwaway directory so a "trust this folder?" prompt never grants
trust to a real project.

    python3 agent_signin.py <menu|command> <scratch-dir> <timeout-seconds> <binary> [args...]

Emits JSON lines on stdout:
    {"event": "status", "stage": "starting|trust|choosing|waitingForBrowser|finishing", "text": "..."}
    {"event": "url", "url": "https://..."}
    {"event": "code", "code": "ABCD-EFGH"}
    {"event": "done", "ok": true|false, "reason": "...", "transcript": "..."}
Send "cancel" on stdin to stop.
"""

import json
import os
import re
import select
import signal
import struct
import sys
import time

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]")
# Cursor positioning separates lines on full-screen apps; keep it as a line break.
MOVE = re.compile(r"\x1b\[\d*;?\d*H")
CURSOR_QUERY = b"\x1b[6n"
URL = re.compile(r"https?://[^\s\"'<>\x1b]+")
TRUST = re.compile(r"\btrust\b.*\b(folder|workspace|directory|project)\b|\bdo you trust\b", re.I | re.S)
METHOD = re.compile(r"(sign|log) ?in with (your |a )?browser", re.I)
API_OPTION = re.compile(r"(paste|enter|set) (an )?api key", re.I)
OPEN_PROMPT = re.compile(r"press enter to open", re.I)
CODE = re.compile(r"code[^\n]*:\s*\n?\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)")
SUCCESS = re.compile(r"signed in|logged in|authenticated|login successful|sign-in complete|you'?re all set|welcome back", re.I)
FAILURE = re.compile(r"(sign|log)[- ]?in (failed|was cancelled|was canceled|was denied|denied|expired)|authentication (failed|denied)|access denied", re.I)
DOWN = "\x1b[B"


def emit(**payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 5 or sys.argv[1] not in ("menu", "command"):
        emit(event="done", ok=False, reason="usage: agent_signin.py <menu|command> <scratch-dir> <timeout> <binary> [args...]")
        return 2
    mode, scratch = sys.argv[1], sys.argv[2]
    deadline = time.time() + float(sys.argv[3])
    argv = sys.argv[4:]
    try:
        import fcntl
        import pty
        import termios
    except ImportError:
        emit(event="done", ok=False, reason="unsupported-platform")
        return 1

    os.makedirs(scratch, exist_ok=True)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(scratch)
        os.environ["TERM"] = "xterm-256color"
        os.environ.setdefault("COLUMNS", "120")
        os.environ.setdefault("LINES", "40")
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            sys.stderr.write(f"exec failed: {error}\n")
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    transcript = ""
    handled_trust = False
    handled_method = mode == "command"
    seen_urls = set()
    seen_code = None
    opened = False
    success_at = None
    emit(event="status", stage="starting", text="Starting sign-in")
    if mode == "command":
        emit(event="status", stage="waitingForBrowser", text="Waiting for you to approve in your browser")

    def send(keys):
        os.write(fd, keys.encode())

    def finish(ok, reason):
        emit(event="done", ok=ok, reason=reason, transcript=transcript[-4000:])
        for keys in ("\x03", "\x03", "/exit\r"):
            try:
                send(keys)
                time.sleep(0.2)
            except OSError:
                break
        time.sleep(0.5)
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        return 0 if ok else 1

    while True:
        if time.time() > deadline:
            return finish(False, "timeout")
        readable, _, _ = select.select([fd, sys.stdin], [], [], 0.25)
        if sys.stdin in readable:
            line = sys.stdin.readline()
            if not line or line.strip() == "cancel":
                return finish(False, "cancelled")
        if fd in readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                if mode == "command":
                    _, status = os.waitpid(pid, 0)
                    ok = os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
                    emit(event="done", ok=ok, reason="signed-in" if ok else "the login command failed", transcript=transcript[-4000:])
                    return 0 if ok else 1
                return finish(success_at is not None, "signed-in" if success_at else "the agent exited before sign-in finished")
            if CURSOR_QUERY in chunk:
                # Terminal apps wait for a cursor position report before drawing; answer like a terminal would.
                send("\x1b[1;1R")
            text = ANSI.sub("", MOVE.sub("\n", chunk.decode("utf-8", "replace"))).replace("\r", "\n")
            transcript += text
            recent = transcript[-3000:]
            for url in URL.findall(text):
                url = url.rstrip(".,)")
                if url not in seen_urls:
                    seen_urls.add(url)
                    emit(event="url", url=url)
            code = CODE.search(recent)
            if code and code.group(1) != seen_code:
                seen_code = code.group(1)
                emit(event="code", code=seen_code)
            if not opened and OPEN_PROMPT.search(text):
                opened = True
                emit(event="status", stage="waitingForBrowser", text="Opening your browser")
                send("\r")
                continue
            if not handled_trust and TRUST.search(recent) and not METHOD.search(recent):
                handled_trust = True
                emit(event="status", stage="trust", text="Preparing a sign-in workspace")
                send("y\r" if re.search(r"[\(\[]y/n[\)\]]", recent, re.I) else "\r")
                continue
            if not handled_method and METHOD.search(recent):
                handled_method = True
                emit(event="status", stage="choosing", text="Choosing browser sign-in")
                last = [m.start() for m in METHOD.finditer(recent)][-1]
                menu = recent[max(0, last - 400):]
                numbered = re.search(r"(\d)[.)]\s*(sign|log) ?in with (your |a )?browser", menu, re.I)
                browser_at = METHOD.search(menu).start()
                api = API_OPTION.search(menu)
                if numbered:
                    send(numbered.group(1) + "\r")
                elif api and api.start() < browser_at:
                    send(DOWN + "\r")
                else:
                    send("\r")
                emit(event="status", stage="waitingForBrowser", text="Waiting for you to approve in your browser")
                continue
            if mode == "menu" and handled_method and success_at is None and SUCCESS.search(text):
                success_at = time.time()
                emit(event="status", stage="finishing", text="Signed in, finishing up")
                return finish(True, "signed-in")
            if mode == "menu" and handled_method and FAILURE.search(text):
                return finish(False, "sign-in was not completed")


if __name__ == "__main__":
    sys.exit(main())
