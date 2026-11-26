"""The desktop stand-in host that `control start --surface desktop` runs.

The host plays the Claude desktop app's role for one Claude Code session. It
starts a Claude Code binary (by default the desktop app's own pinned build) in
the SDK stream-json mode in which the app's Agent SDK starts it, and it speaks
the app's protocol to it: initialize, ui_attach surface "desktop", user frames
in the app's envelope, ui_render AbovePrompt with the app's props and ui_press
as the app's main process sends a click. It does not start the desktop app.

The host is a daemon (`control _host RUN`). It records every frame in both
directions in evidence/frames.jsonl and serves token-guarded commands on a
loopback port that it writes to scratch/host.json. The control CLI is its only
client. Python 3 standard library only.

What each field is based on (READ in the app bundle, or ASSUMED) is listed in
the docstrings below. Nothing here proves how the app paints the row.
"""
import ctypes
import ctypes.util
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

APP_CLI_ROOT = Path.home() / "Library" / "Application Support" / "Claude" / "claude-code"
APP_CLI_EXE = Path("claude.app", "Contents", "MacOS", "claude")
CLIENT_ID = "desktop-1"  # the app sends desktop-<webContents id>; the integer is set at runtime
# The app probes these and sends them with ui_attach (READ).
ANSWERS = ["ui_copy", "ui_prompt_read", "ui_prompt_fill", "ui_prompt_suggest",
           "ui_read_selection"]
# The app's argv for a local session, in the SDK's order (READ). --debug-file is the
# stand-in's own addition: it records what $.ui.notify resolved to.
APP_ARGV = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
            "--permission-prompt-tool=stdio", "--setting-sources=user,project,local",
            "--permission-mode=default", "--include-partial-messages"]
BODY_ROWS = 30  # props.scroll.bodyRows: ASSUMED (the app measures it)
TAKE_TIMEOUT = 120


class HostError(Exception):
    pass


def version_tuple(text):
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in match.groups()) if match else None


def app_builds():
    """The desktop app's verified Claude Code builds, newest first: [(version, path)].
    A build is verified when its folder holds the app's .verified marker."""
    found = []
    try:
        markers = list(APP_CLI_ROOT.glob("*/*/.verified"))
    except OSError:
        markers = []
    for marker in markers:
        exe = marker.parent / APP_CLI_EXE
        version = version_tuple(marker.parent.parent.name)
        if version and exe.is_file() and os.access(exe, os.X_OK):
            found.append((version, marker.stat().st_mtime, exe))
    found.sort(reverse=True)
    return [(".".join(map(str, v)), exe) for v, _, exe in found]


def is_app_build(path):
    """True when path is one of the desktop app's verified Claude Code builds."""
    try:
        resolved = Path(path).resolve()
    except OSError:
        return False
    return any(exe.resolve() == resolved for _, exe in app_builds())


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def request_id():
    """A request id as the SDK makes one: Math.random().toString(36).substring(2, 13)."""
    return "".join(secrets.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(11))


def write_json(path, value):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(value, indent=2))
    os.replace(tmp, path)


# ---------------------------------------------------------------- process identity

class _BsdInfo(ctypes.Structure):
    """struct proc_bsdinfo (sys/proc_info.h), read with PROC_PIDTBSDINFO."""
    _fields_ = [("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32),
                ("pbi_xstatus", ctypes.c_uint32), ("pbi_pid", ctypes.c_uint32),
                ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
                ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32),
                ("pbi_rgid", ctypes.c_uint32), ("pbi_svuid", ctypes.c_uint32),
                ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
                ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32),
                ("pbi_nfiles", ctypes.c_uint32), ("pbi_pgid", ctypes.c_uint32),
                ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
                ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32),
                ("pbi_start_tvsec", ctypes.c_uint64), ("pbi_start_tvusec", ctypes.c_uint64)]


def linux_identity(pid, root="/proc"):
    """proc_identity on Linux: the start time is field 22 of <root>/<pid>/stat (clock ticks
    since boot), and the path is the target of <root>/<pid>/exe."""
    try:
        stat = Path(root, str(int(pid)), "stat").read_text()
    except (OSError, ValueError):
        return None
    # The command name sits in parentheses and may hold spaces or ")": the numbered fields
    # start after the last ")". Field 22 of the line is the 20th of those.
    fields = stat[stat.rfind(")") + 1:].split()
    if len(fields) < 20:
        return None
    try:
        path = os.readlink(os.path.join(root, str(int(pid)), "exe"))
    except OSError:
        path = ""
    return {"start": fields[19], "path": path}


def proc_identity(pid):
    """{"start": <start time>, "path": executable} of a live pid, or None when the pid does
    not exist or this shell may not read it. macOS: read through libproc (no subprocess, so
    it works where `ps` is refused), start as "<seconds>.<microseconds>". Linux: read from
    /proc, start in clock ticks since boot. A sandboxed shell reads only the processes that
    the same command started. A pid and its start time name one process: a reused pid has a
    later start time."""
    if not pid:
        return None
    if sys.platform.startswith("linux"):
        return linux_identity(pid)
    try:
        lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib")
    except OSError:
        return None
    if not hasattr(lib, "proc_pidinfo"):
        return None  # a platform without libproc's process info
    info = _BsdInfo()
    size = lib.proc_pidinfo(int(pid), 3, ctypes.c_uint64(0), ctypes.byref(info),
                            ctypes.sizeof(info))
    if size != ctypes.sizeof(info) or info.pbi_pid != int(pid):
        return None
    buf = ctypes.create_string_buffer(4096)
    n = lib.proc_pidpath(int(pid), buf, ctypes.sizeof(buf))
    return {"start": f"{info.pbi_start_tvsec}.{info.pbi_start_tvusec:06d}",
            "path": buf.value.decode(errors="replace") if n > 0 else ""}


def same_process(recorded, now):
    """True when identity `now` is the process that `recorded` names."""
    return (bool(recorded) and bool(now) and recorded.get("start") == now.get("start")
            and (not recorded.get("path") or not now.get("path")
                 or recorded["path"] == now["path"]))


# ---------------------------------------------------------------- the tree as text

def find_buttons(node, out=None):
    out = [] if out is None else out
    if isinstance(node, dict):
        if node.get("type") == "Button":
            out.append(node)
        for value in node.values():
            find_buttons(value, out)
    elif isinstance(node, list):
        for value in node:
            find_buttons(value, out)
    return out


def children(node):
    props = node.get("props") or {}
    return props.get("children", node.get("children"))


def is_drawn(tree):
    """False for no tree and for the engine's own tree (the plugin called next(e))."""
    return isinstance(tree, dict) and tree.get("type") not in (None, "engine")


def inline_text(node):
    """The text of a node and its nested children, joined: a Text's strings and the strings
    of the Texts inside it."""
    if isinstance(node, (str, int, float)) and not isinstance(node, bool):
        return str(node)
    if isinstance(node, list):
        return "".join(inline_text(x) for x in node)
    if not isinstance(node, dict):
        return ""
    ch = children(node)
    return inline_text(ch) if ch is not None else ""


def button_text(node):
    """A Button as the harness writes it: its label, or the text of its children when it has
    no label, in brackets, then a note of its hotkey, variant, role and autoFocus when it
    carries them. A hotkey is printed only when the Button carries one."""
    props = node.get("props") or {}
    label = props.get("label")
    text = str(label) if label is not None else inline_text(children(node))
    notes = []
    if props.get("hotkey") is not None:
        notes.append(f"hotkey {props['hotkey']}")
    for name in ("variant", "role"):
        if props.get(name) is not None:
            notes.append(f"{name} {props[name]}")
    if props.get("autoFocus"):
        notes.append("autoFocus")
    return f"[ {text} ]" + (f"  ⟨{', '.join(notes)}⟩" if notes else "")


def drawn_children(node):
    """The children of a node that draw something, flattened out of nested lists."""
    out = []

    def add(x):
        if isinstance(x, list):
            for y in x:
                add(y)
        elif isinstance(x, dict):
            if x.get("type") == "Box" and not drawn_children(x):
                return  # an empty spacer Box draws nothing
            out.append(x)
        elif x not in (None, "", False, True):
            out.append(x)

    add(children(node) if isinstance(node, dict) else node)
    return out


def tree_lines(tree):
    """The harness's own text of an AbovePrompt tree: one line per drawn element in tree
    order. A Box draws no line; a Box below the root that holds two or more drawn elements
    indents them by two spaces. A Button is "[ label ]" (see button_text), an Svg is
    "⟨svg: alt⟩", a Text is its whole content with its nested Texts. A Text with maxLines
    is printed whole, with a note of the limit: the app cuts it, the harness cannot. Notes in
    ⟨ ⟩ are the harness's. The app paints the same tree with its own layout, which this
    text does not show."""
    out = []

    def walk(node, depth, is_root=False):
        pad = "  " * depth
        if not isinstance(node, dict):
            out.append(pad + str(node))
            return
        kind = node.get("type")
        props = node.get("props") or {}
        if kind == "Box":
            kids = drawn_children(node)
            inner = depth + (1 if len(kids) > 1 and not is_root else 0)
            for kid in kids:
                walk(kid, inner)
        elif kind == "Button":
            out.append(pad + button_text(node))
        elif kind == "Svg":
            out.append(pad + f"⟨svg: {props.get('alt')}⟩")
        elif kind in ("Text", "Markdown"):
            line = inline_text(node)
            if props.get("maxLines") is not None:
                limit = props["maxLines"]
                line += (f"  ⟨maxLines {limit}: the app shows at most {limit} lines; the "
                         "harness shows the whole text⟩")
            out.append(pad + line)
        else:
            out.append(pad + f"⟨{kind}⟩ " + inline_text(node))

    walk(tree, 0, is_root=True)
    return out


def buttons_text(buttons):
    return ", ".join(button_text(b) for b in buttons) if buttons else "none (nothing is drawn)"


DISMISS_WORDS = ("dismiss", "✕")


def pick_button(which, buttons):
    """(button, None) for the Button that `which` names, or (None, error text).

    A digit names the Button whose hotkey prop is that digit, and nothing else. "dismiss" or
    "✕" names the Button with role dismiss (the card's close Button has no label of its
    own). Any other text names the Button whose label (or, without a label, its text) equals
    it, ignoring case, else the one Button whose label holds it."""
    w = which.strip()

    def shown(b):
        props = b.get("props") or {}
        label = props.get("label")
        return str(label) if label is not None else inline_text(children(b))

    listing = f"The drawn buttons: {buttons_text(buttons)}."
    if w.isdigit():
        hit = [b for b in buttons if str((b.get("props") or {}).get("hotkey")) == w]
        if not hit:
            return None, (f"No drawn Button carries hotkey {w!r}; press takes a hotkey only when "
                          f"a Button carries one. {listing}")
        return hit[-1], None  # the app clicks the last button with that hotkey (READ)
    if w.lower() in DISMISS_WORDS:
        hit = [b for b in buttons if (b.get("props") or {}).get("role") == "dismiss"]
        if not hit:
            return None, f"No drawn Button has role dismiss. {listing}"
        return hit[-1], None
    hit = [b for b in buttons if shown(b).lower() == w.lower()]
    if not hit:
        hit = [b for b in buttons if w.lower() in shown(b).lower()]
    if not hit:
        return None, f"No button {which!r} is drawn. {listing}"
    if len(hit) > 1:
        return None, (f"{which!r} names {len(hit)} buttons: {buttons_text(hit)}. Give more of "
                      "the label.")
    return hit[0], None


# ---------------------------------------------------------------- the daemon

class Host:
    def __init__(self, p, cfg, synthetic_key):
        self.p, self.cfg, self.key = p, cfg, synthetic_key
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.frames_lock = threading.Lock()
        self.pending = {}
        self.system = []
        self.transcript = []
        self.session_id = None
        self.capabilities = None
        self.init_response = None
        self.running = False
        self.ended_by = None    # "result" or "idle": the signal that ended the last turn
        self.deferred = []
        self.taken = {}         # our user frame uuid -> threading.Event
        self.ours = set()       # uuids of the user frames the host wrote
        self.attached = False
        self.surfaces = None
        self.render_seq = 0
        self.render_applied = 0
        self.last_render = None
        self.renders = 0
        self.render_wanted = threading.Event()
        self.proc = None
        self.cli_exit = None    # the CLI's exit code, once its stdout closed and it was reaped
        self.cli_identity = None  # proc_identity of the CLI, read after initialize (after exec)
        self.prompt_text = {}   # plugin prompt uuid -> its text from the session transcript

    # --- frames
    def record(self, direction, frame):
        line = json.dumps({"t": round(time.time(), 3), "dir": direction, "frame": frame})
        with self.frames_lock:
            with open(self.p["evidence"] / "frames.jsonl", "a") as f:
                f.write(line + "\n")

    def write(self, frame):
        self.record("host->cli", frame)
        data = (json.dumps(frame, separators=(",", ":")) + "\n").encode()
        with self.write_lock:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def exit_text(self):
        """Why no answer can come: the CLI's exit code and the tail of its stderr."""
        try:
            lines = (self.p["evidence"] / "cli-stderr.log").read_text(errors="replace") \
                .strip().splitlines()
        except OSError:
            lines = []
        tail = " | ".join(lines[-5:])[-600:] or "(empty)"
        return (f"the CLI exited with code {self.cli_exit} before it answered; the tail of its "
                f"stderr (evidence/cli-stderr.log): {tail}")

    def cli_exited(self):
        """Reaps the CLI once its stdout closed, and answers every pending request with the
        exit, so that no caller waits for its timeout."""
        try:
            code = self.proc.wait(10)
        except subprocess.TimeoutExpired:
            code = "unknown: its stdout closed, but it runs on"
        with self.lock:
            self.cli_exit = code
            pending, self.pending = list(self.pending.values()), {}
        self.record("host-note", {"note": "CLI stdout closed", "code": code})
        for slot in pending:
            slot["response"] = {"subtype": "error", "error": self.exit_text()}
            slot["event"].set()
        for event in list(self.taken.values()):
            event.set()  # send() reads cli_exit and reports it

    def request(self, body, timeout=60):
        rid = request_id()
        slot = {"event": threading.Event(), "response": None}
        with self.lock:
            if self.cli_exit is not None:
                return {"subtype": "error", "error": self.exit_text()}
            self.pending[rid] = slot
        try:
            self.write({"request_id": rid, "type": "control_request", "request": body})
        except OSError:  # the CLI closed its stdin: it exited or is exiting
            if slot["event"].wait(15):
                return slot["response"]
            with self.lock:
                self.pending.pop(rid, None)
            return {"subtype": "error", "error": "the CLI closed its stdin before the request "
                                                 "was written"}
        if not slot["event"].wait(timeout):
            with self.lock:
                self.pending.pop(rid, None)
            return {"subtype": "timeout", "request_id": rid,
                    "error": f"no control_response within {timeout}s"}
        return slot["response"]

    # --- the process
    def env(self):
        """The app's overlay and the SDK's additions (READ), without OAuth and apiHost, which
        the isolation replaces with a synthetic key and the run's loopback endpoint.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is the stand-in's (ASSUMED off in the app)."""
        c = self.cfg
        e = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(self.p["home"]),
            "CLAUDE_CONFIG_DIR": str(self.p["profile"]),
            "ANTHROPIC_API_KEY": self.key,
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{c['port']}",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_ENTRYPOINT": "claude-desktop",
            "CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS": "",
            "CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP": "1",
            "CLAUDE_CODE_DESKTOP_APP_VERSION": "0.0.0-standin",
            "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL": "true",
            "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES": "false",
            "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1",
            "CLAUDE_CODE_SIMPLE": "0",
            "CLAUDE_AGENT_SDK_MCP_NO_PREFIX": "0",
            "MCP_CONNECTION_NONBLOCKING": "true",
            "API_TIMEOUT_MS": "900000",
            "PYTHONDONTWRITEBYTECODE": "1",
            "DISABLE_MICROCOMPACT": "1",
            "NODE_USE_SYSTEM_CA": "1",
            "CLAUDE_AGENT_SDK_VERSION": "0.3.330",
            "CLAUDE_CODE_SDK_READS_SESSION_STATE": "1",
            "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING": "true",
            # The app loads a registry install through the CLI's own loader; the stand-in
            # loads this checkout as course-keeper@inline.
            "CLAUDE_CODE_PLUGIN_DIRS": c["repo"],
        }
        if c.get("notifications_host"):
            # The app sets it only under its server gate 295049503 (READ).
            e["CLAUDE_CODE_NOTIFICATIONS_HOST"] = "1"
        return e

    def spawn(self):
        env = self.env()
        argv = [self.cfg["cli"], *APP_ARGV,
                "--debug-file=" + str(self.p["evidence"] / "cli-debug.log")]
        launcher = ["/usr/bin/env", "-i", *[f"{k}={v}" for k, v in env.items()]]
        write_json(self.p["evidence"] / "spawn.json", {
            "launcher": "/usr/bin/env -i <env>", "argv": argv, "env": env,
            "cwd": str(self.p["project"])})
        self.stderr = open(self.p["evidence"] / "cli-stderr.log", "ab")
        self.proc = subprocess.Popen([*launcher, *argv], cwd=str(self.p["project"]),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.stderr, start_new_session=True)
        threading.Thread(target=self.reader, daemon=True).start()
        threading.Thread(target=self.renderer, daemon=True).start()

    def reader(self):
        for raw in self.proc.stdout:
            raw = raw.strip()
            if not raw:
                continue
            try:
                frame = json.loads(raw)
            except ValueError:
                self.record("cli->host", {"unparsed": raw.decode(errors="replace")})
                continue
            self.record("cli->host", frame)
            try:
                self.dispatch(frame)
            except Exception as error:  # keep reading
                self.record("host-error", {"error": repr(error)})
        self.cli_exited()

    def mark_taken(self, ids):
        with self.lock:
            for i in ids:
                if i in self.taken:
                    self.taken[i].set()

    def dispatch(self, f):
        kind = f.get("type")
        if kind == "control_response":
            r = f.get("response") or {}
            with self.lock:
                slot = self.pending.pop(r.get("request_id"), None)
            if slot:
                slot["response"] = r
                slot["event"].set()
            return
        if kind == "control_request":
            return self.answer_cli(f)
        if kind == "command_lifecycle":
            cid = f.get("command_uuid")
            self.mark_taken([cid])
            with self.lock:
                if f.get("state") == "started" and cid not in self.ours \
                        and not any(r.get("uuid") == cid for r in self.transcript):
                    # A turn the host did not start: a plugin's prompt. The stream carries
                    # only its uuid; screen() reads its text from the session transcript.
                    self.transcript.append({"role": "plugin prompt", "uuid": cid})
            return
        if kind == "system":
            sub = f.get("subtype")
            if sub == "init":
                self.session_id = f.get("session_id") or self.session_id
                if f.get("capabilities") is not None:
                    self.capabilities = f.get("capabilities")
                return
            with self.lock:
                self.system.append(f)
            if sub == "status":
                self.mark_taken(f.get("user_message_uuids") or [])
            if sub == "session_state_changed":
                if f.get("state") == "running":
                    with self.lock:
                        self.running = True
                        self.ended_by = None  # a new turn: no completion seen for it yet
                elif f.get("state") == "idle":
                    self.turn_ended("idle")
                self.render_wanted.set()  # isWorking flipped
            if sub == "ui_invalidate":
                self.render_wanted.set()  # the app asks again for every mounted site
            return
        if kind == "assistant":
            msg = f.get("message") or {}
            text = "".join(b.get("text", "") for b in msg.get("content") or []
                           if isinstance(b, dict) and b.get("type") == "text")
            if text and not f.get("parent_tool_use_id"):
                # A command's answer arrives as an assistant frame with model "<synthetic>"
                # and local_command_source (observed in 2.1.330 and 2.1.332).
                role = "command" if f.get("local_command_source") else "agent"
                with self.lock:
                    self.transcript.append({"role": role, "text": text})
            return
        if kind == "user":
            msg = f.get("message") or {}
            content = msg.get("content")
            if isinstance(content, str):
                with self.lock:
                    self.transcript.append({"role": "echo", "text": content,
                                            "origin": f.get("origin")})
            return
        if kind == "result":
            self.turn_ended("result")
            self.render_wanted.set()  # isWorking may have flipped
            return

    def answer_cli(self, f):
        req = f.get("request") or {}
        if req.get("subtype") == "can_use_tool":
            self.write({"type": "control_response", "response": {
                "subtype": "success", "request_id": f.get("request_id"),
                "response": {"behavior": "deny",
                             "message": "The stand-in host denies every tool."}}})
            return
        self.write({"type": "control_response", "response": {
            "subtype": "error", "request_id": f.get("request_id"),
            "error": f"the stand-in host does not answer {req.get('subtype')}"}})

    # --- protocol steps
    def initialize(self):
        """The subset of the app's initialize body that touches no tool (READ)."""
        r = self.request({"subtype": "initialize", "perTaskStopAffordance": True,
                          "rapidFollowupPreempt": True}, timeout=90)
        self.init_response = r
        write_json(self.p["evidence"] / "initialize.json", r)
        caps = ((r or {}).get("response") or {}).get("capabilities")
        if caps is not None:
            self.capabilities = caps
        return r

    def serves_ui(self):
        return isinstance(self.capabilities, list) and "ui_surface_v1" in self.capabilities

    def attach(self):
        """ui_attach as the app sends it while the session's view is mounted (READ). It has
        no viewport (the app sends one only when isFullscreen is known) and no draws."""
        if not self.serves_ui():
            return {"subtype": "error",
                    "error": "the CLI does not advertise ui_surface_v1; the app sends no ui_attach"}
        r = self.request({"subtype": "ui_attach", "surface": "desktop", "client_id": CLIENT_ID,
                          "answers": ANSWERS})
        if r.get("subtype") == "success":
            with self.lock:
                self.attached = True
                self.surfaces = (r.get("response") or {}).get("surfaces")
            self.render_wanted.set()
        return r

    def props(self):
        """AbovePrompt props as the app builds them (READ): maxRows 12 by default. bodyColumns
        and bodyRows are measured by the app; here they are set (ASSUMED values)."""
        c = self.cfg
        return {"hasSurvey": False, "isWorking": self.running, "maxRows": c["max_rows"],
                "bodyColumns": c["columns"],
                "scroll": {"offset": 0, "bodyRows": BODY_ROWS}, "view": {}}

    def render(self):
        with self.lock:
            self.render_seq += 1
            seq = self.render_seq
            body = {"subtype": "ui_render", "surface": "desktop", "client_id": CLIENT_ID,
                    "component": "AbovePrompt", "instance_id": "above-prompt",
                    "props": self.props(), "content_rows": 0, "keyed": []}
        r = self.request(body)
        with self.lock:
            self.renders += 1
            if r.get("subtype") == "success" and seq > self.render_applied:
                self.render_applied = seq
                self.last_render = r.get("response")
        return r

    def renderer(self):
        """Asks AbovePrompt again on every invalidation and isWorking flip, as the app does,
        but only while attached and while the CLI advertises ui_surface_v1."""
        while True:
            self.render_wanted.wait()
            self.render_wanted.clear()
            if self.attached and self.serves_ui():
                try:
                    self.render()
                except Exception as error:
                    self.record("host-error", {"render": repr(error)})

    def user_frame(self, text, bare=False, reminder=None):
        """The app's live send of a typed prompt (READ): client_platform "desktop_app" and no
        origin. A command is the same frame with "/name args". With a pending reminder the
        content is an array whose first block holds it. bare leaves out client_platform: no
        person's frame looks like that."""
        f = {"type": "user", "uuid": str(uuid.uuid4()), "session_id": self.session_id or "",
             "parent_tool_use_id": None}
        if not bare:
            f["client_platform"] = "desktop_app"
        f["timestamp"] = now_iso()
        content = text
        if reminder is not None:
            content = [{"type": "text", "text": f"<system-reminder>\n{reminder}\n</system-reminder>\n\n"},
                       {"type": "text", "text": text}]
        f["message"] = {"role": "user", "content": content}
        return f

    def write_user(self, entry):
        frame = entry["frame"]
        with self.lock:
            self.running = True
            self.transcript.append({"role": "you", "uuid": frame["uuid"], "text": entry["text"],
                                    "bare": entry["bare"], "reminder": entry["reminder"]})
        self.write(frame)
        self.render_wanted.set()  # isWorking flipped

    def turn_ended(self, signal_name):
        """One completion signal ends the running turn and releases at most one held prompt.
        The CLI ends a turn with a result frame and then session_state_changed idle (observed
        in 2.1.330). Whichever of the two comes first ends the turn; the other one for the same
        turn is skipped, so that it cannot release a second prompt. The next "running" state
        frame starts a new turn. A CLI that sends only one of the two works the same way."""
        with self.lock:
            other = "idle" if signal_name == "result" else "result"
            if self.ended_by == other:
                self.ended_by = None  # the second signal of the turn that already ended
                return
            self.ended_by = signal_name
            self.running = False
            entry = self.deferred.pop(0) if self.deferred else None
            if entry:
                entry["written"] = True
        if entry:
            self.write_user(entry)

    def send(self, text, bare=False, reminder=None, timeout=TAKE_TIMEOUT):
        """Writes the frame, or holds it while a turn runs as the app does (READ), and returns
        once the CLI took it: a command_lifecycle or status frame names its uuid."""
        frame = self.user_frame(text, bare, reminder)
        event = threading.Event()
        entry = {"frame": frame, "text": text, "bare": bare, "reminder": reminder,
                 "written": False}
        with self.lock:
            self.taken[frame["uuid"]] = event
            self.ours.add(frame["uuid"])
            deferred = self.running
            if deferred:
                self.deferred.append(entry)
            else:
                entry["written"] = True
        if self.cli_exit is not None:
            return {"uuid": frame["uuid"], "error": self.exit_text()}
        if not deferred:
            try:
                self.write_user(entry)
            except OSError:
                event.wait(15)  # the reader notes the exit
        took = event.wait(timeout)
        if self.cli_exit is not None:
            return {"uuid": frame["uuid"], "error": self.exit_text()}
        if not took:
            with self.lock:  # a held frame that was not written yet is dropped, never sent late
                if not entry["written"] and entry in self.deferred:
                    self.deferred.remove(entry)
                written = entry["written"]
            self.record("host-note", {"note": "send timed out", "uuid": frame["uuid"],
                                      "case": "sent, not acknowledged" if written else
                                      "not sent: the turn before it did not end; dropped"})
            return {"uuid": frame["uuid"], "deferred": deferred, "taken": False,
                    "written": written}
        return {"uuid": frame["uuid"], "deferred": deferred, "taken": took, "written": True}

    def press(self, which):
        """ui_press as the app's main process sends a click (READ): plugin, handle, key (the
        Button's element key), surface and press_id; no client_id and no render. The button
        comes from a fresh render, so it is the one drawn now. No keyboard handler, focus or
        hotkey cue of the app runs: a hotkey only selects the Button that carries it."""
        if not self.attached:
            return {"error": "No button is drawn: the host has not attached (ui_attach)."}
        r = self.render()
        if r.get("subtype") != "success":
            return {"error": f"ui_render failed: {json.dumps(r)[:400]}"}
        tree = (r.get("response") or {}).get("tree")
        buttons = find_buttons(tree) if is_drawn(tree) else []
        hit, error = pick_button(which, buttons)
        if error:
            return {"error": error}
        props = hit.get("props") or {}
        target = hit.get("press") or {}
        body = {"subtype": "ui_press", "plugin": target.get("plugin"),
                "handle": target.get("handle"), "key": props.get("key"),
                "surface": "desktop", "press_id": str(uuid.uuid4())}
        body = {k: v for k, v in body.items() if v is not None}
        answer = self.request(body)
        label = props.get("label")
        return {"label": str(label) if label is not None else inline_text(children(hit)),
                "hotkey": props.get("hotkey"), "sent": body, "answer": answer}

    # --- what a person is shown
    def plugin_prompt(self, cid):
        """(text, origin) of a prompt the host did not send, from the run's own session
        transcript under the private profile, or None while the row is not written yet."""
        if cid in self.prompt_text:
            return self.prompt_text[cid]
        for path in self.p["profile"].glob("projects/*/*.jsonl"):
            try:
                lines = path.read_text(errors="replace").splitlines()
            except OSError:
                continue
            for line in lines:
                if cid not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("uuid") != cid:
                    continue
                content = (row.get("message") or {}).get("content")
                text = content if isinstance(content, str) else "\n".join(
                    b.get("text", "") for b in content or [] if isinstance(b, dict))
                self.prompt_text[cid] = (text, row.get("origin") or {})
                return self.prompt_text[cid]
        return None

    def screen(self):
        with self.lock:
            rows = list(self.transcript)
            render = self.last_render
            attached = self.attached
        out = []

        def block(first, rest, text):
            lines = text.split("\n")
            out.append((first + lines[0]).rstrip())
            out.extend((rest + line).rstrip() for line in lines[1:])

        for row in rows:
            role = row["role"]
            text = row.get("text")
            if role == "you":
                notes = []
                if row.get("bare"):
                    notes.append("stand-in: sent without client_platform")
                if row.get("reminder") is not None:
                    notes.append("stand-in: sent with a system-reminder block")
                block("❯ ", "  ", text + (f"  [{'; '.join(notes)}]" if notes else ""))
            elif role == "agent":
                block("⏺ ", "  ", text)
            elif role == "command":
                block("  ⎿  ", "     ", text)
            elif role == "plugin prompt":
                found = self.plugin_prompt(row["uuid"])
                if found is None:
                    out.append("▸ Prompt from a plugin (its text is not in the session "
                               "transcript yet)")
                else:
                    name = found[1].get("name") or found[1].get("kind") or "a plugin"
                    block(f"▸ Prompt from the {name} plugin: ", "  ", found[0])
            elif role == "echo":
                block("❯ ", "  ", text)
        tree = (render or {}).get("tree")
        c = self.cfg
        header = (f"──── above the prompt: AbovePrompt, surface desktop, maxRows {c['max_rows']}, "
                  f"bodyColumns {c['columns']}; the harness's text of the CLI's tree, not the "
                  "app's painting ────")
        if not attached:
            row = ["(not attached: the host sends no ui_render before ui_attach)"]
        elif render is None:
            row = ["(no ui_render answered yet)"]
        elif not is_drawn(tree):
            row = ["(nothing drawn)"]
        else:
            row = tree_lines(tree)
        return {"transcript": "\n".join(out), "header": header, "row": "\n".join(row),
                "tree": tree, "attached": attached, "working": self.running}

    def health(self):
        resp = (self.init_response or {}).get("response") or {}
        return {"ok": True, "pid": os.getpid(), "cli_pid": self.proc.pid if self.proc else None,
                "cli_alive": self.proc is not None and self.cli_exit is None
                and self.proc.poll() is None,
                "cli_exit": self.cli_exit,
                "attached": self.attached, "surfaces": self.surfaces,
                "initialize": (self.init_response or {}).get("subtype"),
                "version": resp.get("claude_code_version"),
                "commands": [c.get("name") for c in resp.get("commands") or []],
                "capabilities": self.capabilities, "renders": self.renders,
                "working": self.running, "deferred": len(self.deferred)}


def daemon(p, cfg, synthetic_key):
    host = Host(p, cfg, synthetic_key)
    token = cfg["token"]

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def reply(self, value, status=200):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            if self.headers.get("X-Run-Token") != token:
                return self.reply({"error": "token"}, 403)
            a = json.loads(raw or b"{}")
            cmd = self.path.strip("/")
            try:
                if cmd == "health":
                    return self.reply(host.health())
                if cmd == "attach":
                    return self.reply(host.attach())
                if cmd == "send":
                    return self.reply(host.send(a["text"], a.get("bare", False),
                                                a.get("reminder"), a.get("timeout", TAKE_TIMEOUT)))
                if cmd == "press":
                    return self.reply(host.press(a["which"]))
                if cmd == "screen":
                    return self.reply(host.screen())
                if cmd == "messages":
                    with host.lock:
                        return self.reply({"system": list(host.system)})
                if cmd == "stop":
                    self.reply({"ok": True})
                    threading.Thread(target=shutdown, daemon=True).start()
                    return None
                return self.reply({"error": "unknown command " + cmd}, 404)
            except Exception as error:
                return self.reply({"error": repr(error)}, 500)

    def shutdown():
        """Closes the CLI's stdin first, as the SDK does, then stops the CLI as stop_child
        says."""
        time.sleep(0.1)
        how = stop_child(host)
        host.record("host-note", {"note": "stopped", "cli": how, "code": host.proc.poll()})
        os._exit(0)

    def on_signal(signum, _frame):
        """A signal to the host (stop's fallback, or an interrupted start) stops the CLI
        first: the CLI runs in its own process group, so nothing else would."""
        how = stop_child(host, waits=(1, 2, 1)) if host.proc else "never spawned"
        host.record("host-note", {"note": f"host got {signal.Signals(signum).name}",
                                  "cli": how})
        os._exit(1)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, on_signal)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    me = {"pid": os.getpid(), "identity": proc_identity(os.getpid())}
    try:
        host.spawn()
        # Record the child before any protocol reply, so that stop finds it whatever happens
        # next. The env launcher may not have exec'd the CLI yet: keep the start time only.
        early = proc_identity(host.proc.pid)
        host.cli_identity = dict(early, path="") if early else None
        write_json(p["host"], {**me, "cli_pid": host.proc.pid, "cli_identity": host.cli_identity})
        init = host.initialize()
        if init.get("subtype") != "success":
            # A failed start: stop and reap the CLI here, record why, and exit.
            how = stop_child(host)
            host.record("host-note", {"note": "initialize failed; the host stopped its CLI",
                                      "cli": how, "code": host.proc.poll()})
            write_json(p["host"], {**me, "cli_pid": host.proc.pid,
                                   "cli_identity": host.cli_identity, "cli_exit": host.cli_exit,
                                   "cli_stopped": how, "initialize": init.get("subtype"),
                                   "error": init.get("error")})
            os._exit(1)
        # After initialize the env launcher has exec'd the CLI, so the path is the CLI's.
        if host.cli_exit is None:
            host.cli_identity = proc_identity(host.proc.pid) or host.cli_identity
        if not cfg.get("attach_later") and host.serves_ui() and host.cli_exit is None:
            host.attach()
        write_json(p["host"], {**me, "port": server.server_address[1],
                               "cli_pid": host.proc.pid, "cli_identity": host.cli_identity,
                               "cli_exit": host.cli_exit, "initialize": init.get("subtype"),
                               "error": init.get("error")})
    except BaseException as error:
        how = stop_child(host) if host.proc else "never spawned"
        host.record("host-note", {"note": f"start failed: {error!r}; the host stopped its CLI",
                                  "cli": how})
        raise
    server.serve_forever()


def stop_child(host, waits=(8, 5, 5)):
    """Closes the CLI's stdin. Only when the CLI does not exit, it signals the CLI's own
    process group (SIGTERM, then SIGKILL), and only while the CLI is this host's unreaped
    child with the start time recorded at spawn: an unreaped child's pid is not reused.
    Reaps the CLI and returns what happened."""
    try:
        host.proc.stdin.close()
    except Exception:
        pass
    how = "exited after its stdin closed"
    for (sig, name), wait in zip(((signal.SIGTERM, "SIGTERM"), (signal.SIGKILL, "SIGKILL")),
                                 waits):
        try:
            host.proc.wait(wait)
            break
        except subprocess.TimeoutExpired:
            pass
        if not same_process(host.cli_identity, proc_identity(host.proc.pid)):
            how = (f"not signalled: pid {host.proc.pid} no longer shows the start time "
                   "recorded at spawn")
            break
        how = f"{name} to its own process group"
        try:
            os.killpg(host.proc.pid, sig)
        except OSError as error:
            how += f" refused: {error}"
    else:
        try:
            host.proc.wait(waits[2])
        except subprocess.TimeoutExpired:
            how += ", STILL RUNNING"
    return how


# ---------------------------------------------------------------- the client

def call(p, cfg, cmd, payload=None, timeout=30):
    """One command to the run's host. Raises HostError when no host answers."""
    try:
        h = json.loads(Path(p["host"]).read_text())
    except (OSError, ValueError):
        raise HostError(f"No desktop host recorded its port in {p['host']}") from None
    if not h.get("port"):
        raise HostError(f"The desktop host has not finished its start (no port in {p['host']})")
    req =urllib.request.Request(f"http://127.0.0.1:{h['port']}/{cmd}", method="POST",
                                 data=json.dumps(payload or {}).encode(),
                                 headers={"X-Run-Token": cfg["token"]})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return json.loads(r.read())
    except (OSError, ValueError, urllib.error.URLError) as error:
        raise HostError(f"The desktop host on port {h['port']} did not answer {cmd}: {error}") \
            from None
