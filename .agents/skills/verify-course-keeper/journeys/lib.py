"""Shared plumbing for the Course Keeper journeys.

A journey drives the control CLI as subprocesses, exactly as an agent would.
`journey(fn)` starts a run, runs doctor, calls fn(run), and always stops the
run. On success the last stdout line is "PASS <evidence dir>".
"""
from contextlib import contextmanager
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback

CONTROL = Path(__file__).resolve().parent.parent / "control"

# Stable text in the plugin's own model requests (prompts/*.md, hooks/logic.ts).
MARKERS = {
    "check": "It is a check that the Course Keeper plugin runs on a copy of this session",
    "check-head": "# The check",
    "extract": "Decide whether it states a standing instruction",
    "learn": "# Learn from a catch",
    "excerpt": "This is a check that the Course Keeper plugin runs on a coding session",
}
PLUGIN_FORKS = ("check", "learn", "excerpt")


class JourneyFailure(Exception):
    def __init__(self, what, expected, seen):
        super().__init__(what)
        self.what, self.expected, self.seen = what, expected, seen


def expect(condition, what, expected, seen):
    if not condition:
        raise JourneyFailure(what, expected, seen)


def flat(text):
    return " ".join(text.split())


def has(view, text):
    return text in view or flat(text) in flat(view)


def carries(request, name):
    return MARKERS[name] in request.get("last_user", "")


def is_messages(request):
    return request["method"] == "POST" and request["path"].split("?")[0] == "/v1/messages"


def is_main(request):
    """A main-thread request: not the haiku extract and not one of the plugin's forks."""
    return (is_messages(request) and "haiku" not in (request.get("model") or "")
            and not carries(request, "extract")
            and not any(carries(request, name) for name in PLUGIN_FORKS))


def is_check(request):
    return is_messages(request) and carries(request, "check")


def is_extract(request):
    """The plugin's haiku call that looks for a standing instruction in a prompt."""
    return is_messages(request) and carries(request, "extract")


def is_learn(request):
    return is_messages(request) and carries(request, "learn")


def is_excerpt(request):
    return is_messages(request) and carries(request, "excerpt")


def message_in(request):
    """The text between <message> and </message> of an extract request."""
    text = request["last_user"]
    start = text.find("<message>\n")
    end = text.rfind("\n</message>")
    return text[start + len("<message>\n"):end] if 0 <= start < end else None


def since(run, mark):
    """The /v1/messages requests logged after sequence number mark."""
    return [r for r in run.requests() if r["seq"] > mark and is_messages(r)]


def extracts(run, mark):
    """The extract requests logged after sequence number mark."""
    return [r for r in run.requests() if r["seq"] > mark and is_extract(r)]


def final(answer):
    """The block that withFinalAnswer puts before a fork prompt for this answer."""
    return "<final_answer>\n" + answer + "\n</final_answer>"


def deviation(reference, alert, instead, evidence, note):
    """A check reply in the exact format at the end of prompts/check.md.
    An alert dict with these five keys fits as deviation(**alert)."""
    return (f"verdict: deviation\nreference: {reference}\nalert: {alert}\n"
            f"instead: {instead}\nevidence: \"{evidence}\"\nnote: {note}")


def quoted_sentence(text):
    """quotedSentence in hooks/logic.ts: the text in quotation marks, then a period unless
    the text already ends with . ? or ! (closing quotes or brackets after that mark count)."""
    return f'"{text}"' if re.search(r"[.?!][\"'”’)\]]*$", text) else f'"{text}".'


def note_text(a):
    """noteText in hooks/logic.ts: the note that "Tell the agent" sends for alert a."""
    return (f"Course Keeper alert on {a['reference']}. "
            f"Evidence: {quoted_sentence(a['evidence'])} Note: {a['note']}")


def notice(*added):
    """addedNotice in hooks/logic.ts: each instruction cut to 80 characters (clean)."""
    quoted = "; ".join(f'"{text if len(text) <= 80 else text[:79].rstrip() + "…"}"'
                       for text in added)
    return (f"Course Keeper noted a standing instruction: {quoted}" if len(added) == 1
            else f"Course Keeper noted {len(added)} standing instructions: {quoted}")


def learn_draft(sentence, place, quote, act):
    """A learn reply in the exact format at the end of prompts/learn.md."""
    return (f"result: draft\nquote: \"{quote}\"\nact: {act}\n"
            "forms: converting it, planning to convert it, recommending a conversion\n"
            "variant: The agent converts the tax amounts to dollars in the PDF writer.\n"
            f"place: {place}\nsentence: {sentence}\n"
            "allowed: Show an amount that the amounts module already converted.")


def section(text, start, end):
    """The text between heading `start` and heading `end`."""
    i = text.find(start)
    if i < 0:
        return ""
    j = text.find(end, i + len(start))
    return text[i + len(start):j if j >= 0 else len(text)]


class Run:
    def __init__(self):
        self.dir = None
        self.evidence = None

    def ctl(self, *args, check=True, timeout=180):
        argv = [sys.executable, str(CONTROL), *args]
        result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
        if check and result.returncode != 0:
            raise JourneyFailure(f"control {args[0]} failed (exit {result.returncode})",
                                 "exit 0", (result.stdout + result.stderr).strip())
        return result

    def start(self, *options):
        out = self.ctl("start", *options).stdout.strip().split("\n")
        self.dir, self.evidence = out[0], out[1]

    def doctor(self):
        result = self.ctl("doctor", self.dir, check=False)
        (Path(self.evidence) / "doctor-report.txt").write_text(result.stdout + result.stderr)
        expect(result.returncode == 0, "doctor", "every check ok",
               (result.stdout + result.stderr).strip())

    def send(self, text):
        self.ctl("send", self.dir, text)

    def keys(self, *keys):
        self.ctl("keys", self.dir, *keys)

    def focus(self, save=None):
        """Gives the alert row the keyboard. Returns the label of the focused button."""
        result = self.ctl("focus", self.dir, check=False)
        label = result.stdout.strip()
        expect(result.returncode == 0 and re.match(r"[1-4]: ", label),
               "ctrl+x tab focuses the row", "one button of the row in inverse video",
               (result.stdout + result.stderr).strip())
        if save:
            Path(self.evidence, save + ".txt").write_text(label + "\n")
        return label

    def press(self, which, what=None):
        """control press (both surfaces). Returns the pressed button's label. A refusal fails
        the journey on the promise `what` (default: that the button is drawn)."""
        result = self.ctl("press", self.dir, which, check=False)
        expect(result.returncode == 0, what or f"the row draws button {which!r} and takes a press",
               f"control press {which} exits 0", (result.stdout + result.stderr).strip())
        return result.stdout.strip()

    def attach(self):
        """control attach (desktop). Returns its output line."""
        return self.ctl("attach", self.dir).stdout.strip()

    def messages(self, kind=None, save=None):
        """control messages (desktop): the system frames the host received, as dicts."""
        args = ["messages", self.dir] + (["--type", kind] if kind else []) + \
               (["--save", save] if save else [])
        return [json.loads(line) for line in self.ctl(*args).stdout.splitlines() if line.strip()]

    def tree(self, save=None):
        """control screen --tree (desktop): the latest AbovePrompt tree, or None."""
        args = ["screen", self.dir, "--tree"] + (["--save", save] if save else [])
        return json.loads(self.ctl(*args).stdout)

    def screen(self, visible=False, ansi=False, save=None):
        args = ["screen", self.dir] + (["--visible"] if visible else []) + \
               (["--ansi"] if ansi else []) + (["--save", save] if save else [])
        return self.ctl(*args).stdout

    def wait(self, text, timeout=30, gone=False, after=None, visible=False, save=None):
        self.expect_wait(text, f"screen {'without' if gone else 'with'} {text!r}",
                         timeout=timeout, gone=gone, after=after, visible=visible, save=save)

    def expect_wait(self, text, what, timeout=30, gone=False, after=None, visible=False,
                    save=None):
        """Like wait, but a timeout fails the journey on the promise `what`."""
        args = ["wait", self.dir, text, "--timeout", str(timeout)]
        args += ["--gone"] if gone else []
        args += ["--after", after] if after is not None else []
        args += ["--visible"] if visible else []
        args += ["--save", save] if save else []
        result = self.ctl(*args, check=False, timeout=timeout + 60)
        expect(result.returncode == 0, what,
               f"the screen {'loses' if gone else 'shows'} {text!r} within {timeout}s",
               result.stderr.strip())

    def reply(self, when, text, model=None, times=None, unless=(), delay=None):
        """control reply. Returns the rule's name, "rule N", as the request log's
        matched field names it."""
        args = ["reply", self.dir, "--when", when, "--text", text]
        args += ["--model", model] if model else []
        args += ["--times", str(times)] if times is not None else []
        for substring in unless:
            args += ["--unless", substring]
        args += ["--delay", str(delay)] if delay is not None else []
        return self.ctl(*args).stdout.strip()

    def command(self, arg, result, label, timeout=30, what=None):
        """Enters /course-keeper <arg> and waits for `result` in its answer.
        With what, a timeout fails on that promise instead of on the screen text."""
        text = ("/course-keeper " + arg).rstrip()
        mark = "❯ " + text + "\n"
        # `send` returns once the prompt took the text, so the last echo of
        # the command is this one and an older answer never satisfies the wait.
        self.send(text)
        if what is None:
            self.wait(result, timeout=timeout, after=mark, save=label)
        else:
            self.expect_wait(result, what, timeout=timeout, after=mark, save=label)
        view = Path(self.evidence, label + ".txt").read_text()
        return view[view.rfind(mark):]

    def requests(self, save=None):
        if save:
            self.ctl("requests", self.dir, "--save", save)
        path = Path(self.evidence) / "model-requests.jsonl"
        if not path.exists():
            return []
        rows = []
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass  # a line that the endpoint is still writing; the next read holds it whole
        return rows

    def last_seq(self):
        rows = self.requests()
        return rows[-1]["seq"] if rows else 0

    def wait_request(self, matches, what, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            for request in self.requests():
                if matches(request):
                    return request
            if time.monotonic() >= deadline:
                self.requests(save="requests-timeout")
                raise JourneyFailure(f"model request: {what}", what,
                                     "no such request; see requests-timeout.txt")
            time.sleep(0.2)

    def store(self, save=None):
        args = ["store", self.dir] + (["--save", save] if save else [])
        entry = json.loads(self.ctl(*args).stdout)
        return entry["record"] if entry else None

    def wait_store(self, matches, what, timeout=15, save=None):
        deadline = time.monotonic() + timeout
        record = None
        while True:
            record = self.store()
            if record is not None and matches(record):
                if save:
                    self.store(save=save)
                return record
            if time.monotonic() >= deadline:
                self.store(save=(save or "store") + "-timeout")
                raise JourneyFailure(f"stored record: {what}", what,
                                     json.dumps(record, indent=2))
            time.sleep(0.2)

    def stop(self):
        """control stop. Returns (evidence dir, stopped, output): stopped is False when stop
        exited non-zero (a process of the run still runs, or stop could not run)."""
        if self.dir is None:
            return None, True, ""
        try:
            result = self.ctl("stop", self.dir, check=False)
        except subprocess.TimeoutExpired as error:
            return self.evidence, False, f"control stop timed out: {error}"
        return (result.stdout.strip() or self.evidence, result.returncode == 0,
                (result.stdout + result.stderr).strip())


CLEANUP = "cleanup: every process of the run stopped"


def cleanup_failure(output):
    return JourneyFailure(CLEANUP, "control stop exits 0", output)


def print_failure(failure):
    print(f"FAIL {failure.what}\nexpected: {failure.expected}\nseen: {failure.seen}", flush=True)


def journey(fn, *start_options):
    run = Run()
    status = 0
    try:
        run.start(*start_options)
        print("run", run.dir, flush=True)
        run.doctor()
        fn(run)
    except JourneyFailure as failure:
        status = 1
        print_failure(failure)
    except BaseException:
        status = 1
        print("FAIL the journey raised an error\n" + traceback.format_exc(), flush=True)
    finally:
        evidence, stopped, output = run.stop()
    if not stopped:
        status = 1  # a journey that already failed keeps its first failure and adds this line
        print_failure(cleanup_failure(output))
    if status:
        print(f"evidence: {evidence}")
        sys.exit(status)
    print("PASS", evidence)


def step(name):
    print("step", name, flush=True)


@contextmanager
def second_run(*start_options, parent=None, label="second-run", doctor=True):
    """Starts another run inside a journey, runs doctor, yields its Run and always stops it.

    With parent, the parent run's evidence gets <label>-evidence.txt, which names the
    second run's evidence directory. doctor=False skips the doctor, whose /course-keeper
    is a person's command and so marks the session as having a person.
    """
    other = Run()
    failed = False
    try:
        other.start(*start_options)
        print("run", other.dir, flush=True)
        if doctor:
            other.doctor()
        yield other
    except BaseException:
        failed = True
        raise
    finally:
        evidence, stopped, output = other.stop()
        if parent is not None and evidence:
            Path(parent.evidence, label + "-evidence.txt").write_text(f"{evidence}\n")
        print(f"{label} evidence", evidence, flush=True)
        if not stopped:
            if failed:  # keep the first failure; add the cleanup line
                print_failure(cleanup_failure(f"{label}: {output}"))
            else:
                raise cleanup_failure(f"{label}: {output}")


# ---------------------------------------------------------------- turns

def ask(run, prompt, answer, label, timeout=45):
    """The person types a prompt and the scripted agent's answer appears. Nothing more is
    awaited: the turn's check and extract calls may still be in flight."""
    run.send(prompt)
    run.wait("⏺ " + answer, timeout=timeout, after="❯ " + prompt, save=label)


def turn(run, prompt, answer, label, check=True, extract=False, outcome=None, timeout=45):
    """One whole turn: the person types a prompt, the agent's answer appears, and the plugin
    has finished with the turn. Returns (mark, record): the last request seq before the
    prompt and the stored record after the turn.

    Waits for the answer; with check, for the check request that carries this answer; with
    extract, for the extract request that carries this prompt; and always for the store's
    lastCheck at or after the turn's start with checkingSince null (with outcome, also for
    exactly that outcome). Pass check=False when no check request is expected (checks off,
    no vision) and extract=True only when the prompt must start an extract call.
    """
    mark = run.last_seq()
    started = time.time() * 1000
    ask(run, prompt, answer, label, timeout=timeout)
    if check:
        run.wait_request(lambda r: r["seq"] > mark and is_check(r)
                         and final(answer) in r["last_user"], f"the check of {label}",
                         timeout=timeout)
    if extract:
        run.wait_request(lambda r: r["seq"] > mark and is_extract(r) and prompt in r["last_user"],
                         f"the extract call of {label}", timeout=timeout)

    def ended(record):
        last = record.get("lastCheck") or {}
        return (last.get("at", 0) >= started and record.get("checkingSince") is None
                and (outcome is None or last.get("outcome") == outcome))
    record = run.wait_store(ended, f"the check of {label} ended"
                            + (f" with {outcome!r}" if outcome else ""), timeout=timeout)
    return mark, record


def script_turn(run, prompt, answer, haiku=None, check="verdict: none"):
    """Rules for one typed prompt: its haiku reply (if any), its main turn and its check
    reply (if any). The main rule carries --unless with the extract marker, so the haiku
    call, which quotes the same prompt, can never consume it. Returns the rule names by
    role: {"haiku": ..., "main": ..., "check": ...} (None when not registered)."""
    rules = {"haiku": None, "main": None, "check": None}
    if haiku is not None:
        rules["haiku"] = run.reply(prompt, haiku, model="haiku", times=1)
    rules["main"] = run.reply(prompt, answer, times=1, unless=[MARKERS["extract"]])
    if check is not None:
        rules["check"] = run.reply(final(answer), check, times=1)
    return rules


def unscripted(run):
    """Asserts that every model request got a scripted reply (none got the default)."""
    result = run.ctl("requests", run.dir, "--unscripted", check=False)
    expect(result.returncode == 0, "every model request got a scripted reply",
           "control requests --unscripted exits 0", result.stdout + result.stderr)


def last_check_at(run):
    """The time of the stored lastCheck in ms, or 0."""
    record = run.store()
    return ((record or {}).get("lastCheck") or {}).get("at", 0)


def wait_check(run, after_at, outcome, label, timeout=45, watch=None):
    """Waits until the store records a check newer than `after_at` with `outcome`.
    With watch (a substring), also polls the visible pane and returns, as the second item,
    every toast text that held watch."""
    deadline = time.monotonic() + timeout
    seen = []
    while True:
        if watch:
            seen += [t for t in toasts(run.screen(visible=True)) if watch in t]
        record = run.store()
        last = (record or {}).get("lastCheck") or {}
        if last.get("at", 0) > after_at and last.get("outcome") == outcome:
            run.store(save=label)
            return record, seen
        if time.monotonic() >= deadline:
            run.store(save=label + "-timeout")
            raise JourneyFailure(f"a check after this turn ends with {outcome!r}", outcome,
                                 json.dumps(last))
        time.sleep(0.15)


# ---------------------------------------------------------------- toasts

def toasts(view):
    """The texts of the boxed toasts on a visible pane, each joined into one line.

    Claude Code draws a toast as a box at the top right: a ╭ line, a title line
    (the plugin's name), the wrapped text, and a ╰ line.
    """
    lines = view.split("\n")
    found = []
    for i, line in enumerate(lines):
        col = line.rfind("╭")
        if col < 0:
            continue
        body = []
        for below in lines[i + 1:]:
            at = below.find("│", max(0, col - 3))
            corner = below.find("╰", max(0, col - 3))
            if 0 <= corner <= col + 3:
                break
            if at < 0 or at > col + 3:
                body = None
                break
            inner = below[at + 1:].rstrip()
            body.append(inner[:-1] if inner.endswith("│") else inner)
        if body:
            found.append(flat(" ".join(body)))
    return found


def watch_toast(run, text, label, timeout=20, family=None):
    """Polls the visible pane until a toast holds `text`, saves that frame, then waits until
    no toast holds `family` (default: `text`). Returns the seconds the toast stayed (first
    seen to first frame without it)."""
    gone_when = family or text
    deadline = time.monotonic() + timeout
    while True:
        view = run.screen(visible=True)
        held = [t for t in toasts(view) if text in t]
        if held:
            seen = time.monotonic()
            Path(run.evidence, label + ".txt").write_text(view)
            break
        if time.monotonic() >= deadline:
            Path(run.evidence, label + "-timeout.txt").write_text(view)
            raise JourneyFailure(f"toast {text!r}", text, f"toasts seen last: {toasts(view)}")
        time.sleep(0.1)
    expect(held[0].startswith("course-keeper "), "the toast is titled by the plugin",
           "course-keeper " + text, held[0])
    while time.monotonic() < seen + timeout:
        if not any(gone_when in t for t in toasts(run.screen(visible=True))):
            return round(time.monotonic() - seen, 1)
        time.sleep(0.2)
    raise JourneyFailure("the toast goes", f"no toast {timeout}s after it showed", text)


# ---------------------------------------------------------------- learn

def store_has_no_draft(run, label):
    """Waits until the store holds no learn draft and no learn step in flight."""
    return run.wait_store(lambda r: "learn" not in r and r.get("learningSince") is None,
                          "no draft and no learn step in flight", save=label)


def project_files(run):
    """The fixture project's file paths, relative and sorted."""
    root = Path(run.dir, "scratch/project")
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))

