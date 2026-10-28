#!/usr/bin/env python3
"""pilot: score how an engineer works with Claude Code, from local transcripts.

Reads every ~/.claude/projects/*/*.jsonl, summarizes each session once (cached by
size+mtime), scores five dimensions against the engineer's own prior 4 weeks, and
prints one JSON report. Stdlib only. Nothing leaves the machine.

  python3 pilot.py                 # 7/14/30/60-day windows vs the prior window, plus 120 daily points
  python3 pilot.py --since ISO     # adds a "since" window starting at ISO (experiments)
  python3 pilot.py --selftest      # runs the built-in check
"""
import json, os, re, sys, time
from datetime import datetime, timedelta, timezone

PROJECTS = os.path.expanduser("~/.claude/projects")
CACHE = os.path.expanduser("~/.claude/pilot/cache.json")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# Handing work to another agent or session, by the Agent tool or the desktop app's side sessions.
DELEGATE_TOOLS = {"Agent", "Workflow", "SendMessage", "mcp__ccd_session__start_session",
                  "mcp__ccd_session__hand_off_to_session"}
CORRECTION = re.compile(r"^\s*(no[,.!\s]|nope|wrong|not that|that's not|that is not|i meant|actually,|don't |do not |stop[,.!\s]|undo|revert)", re.I)
TESTS = re.compile(r"\b(pytest|npm test|npm run test|yarn test|pnpm test|jest|vitest|go test|cargo test|phpunit|rspec|mix test|dotnet test|swift test|xcodebuild test)\b")
COMMIT = re.compile(r"\bgit commit\b")
REVERT = re.compile(r"\bgit (revert|reset --hard|checkout -- |restore )")
BIG_RESULT = 8000      # chars of one tool result, about 200 lines
GAP = 10 * 60          # seconds of silence that ends "active" time
LONG_SESSION = 60      # tool calls; past this, delegation is expected


def ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def result_len(content):
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(c.get("text", "")) for c in content if isinstance(c, dict))
    return 0


def summarize(path):
    s = dict(path=path, project="", first=None, last=None, active=0.0, prompts=0, short=0,
             corrections=0, interrupts=0, tools=0, reads=0, edits=0, edits_unread=0,
             edited_files=0, results=0, big_results=0, errors=0, denials=0, compactions=0,
             tests=0, commits=0, commits_untested=0, reverts=0, agents=0, plan=0,
             peak_context=0, out_tokens=0, models={})
    read_paths, edited, prev_t, tested = set(), set(), None, False
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("isSidechain"):
                continue
            t = ts(o.get("timestamp", "")) if o.get("timestamp") else None
            if t:
                s["first"] = s["first"] or t
                if prev_t and 0 < t - prev_t <= GAP:
                    s["active"] += t - prev_t
                prev_t, s["last"] = t, t
            if o.get("isCompactSummary"):
                s["compactions"] += 1
            kind, msg = o.get("type"), o.get("message") or {}
            if not s["project"] and o.get("cwd"):
                s["project"] = os.path.basename(o["cwd"].rstrip("/")) or o["cwd"]
            if kind == "user":
                c = msg.get("content")
                if isinstance(c, str):
                    if o.get("isMeta") or c.startswith("<"):
                        continue
                    if "[Request interrupted" in c:
                        s["interrupts"] += 1
                        continue
                    s["prompts"] += 1
                    if CORRECTION.search(c):
                        s["corrections"] += 1
                    elif len(c.split()) < 12 and not c.startswith("/"):
                        s["short"] += 1
                elif isinstance(c, list):
                    for item in c:
                        if not isinstance(item, dict):
                            continue
                        if item.get("type") == "tool_result":
                            s["results"] += 1
                            if item.get("is_error"):
                                s["errors"] += 1
                            if result_len(item.get("content")) > BIG_RESULT:
                                s["big_results"] += 1
                        elif item.get("type") == "text" and "[Request interrupted" in item.get("text", ""):
                            s["interrupts"] += 1
                d = (o.get("permissionDecision") or {}).get("decision")
                if d in ("reject", "deny"):
                    s["denials"] += 1
            elif kind == "assistant":
                u = msg.get("usage") or {}
                ctx = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                s["peak_context"] = max(s["peak_context"], ctx)
                s["out_tokens"] += u.get("output_tokens", 0)
                if msg.get("model"):
                    s["models"][msg["model"]] = s["models"].get(msg["model"], 0) + 1
                for item in msg.get("content") or []:
                    if not isinstance(item, dict) or item.get("type") != "tool_use":
                        continue
                    name, inp = item.get("name", ""), item.get("input") or {}
                    s["tools"] += 1
                    fp = inp.get("file_path") or inp.get("notebook_path") or ""
                    if name == "Read":
                        s["reads"] += 1
                        read_paths.add(fp)
                    elif name in EDIT_TOOLS:
                        s["edits"] += 1
                        edited.add(fp)
                        if name != "Write" and fp not in read_paths:
                            s["edits_unread"] += 1
                    elif name == "Bash":
                        cmd = inp.get("command", "")
                        if TESTS.search(cmd):
                            s["tests"] += 1
                            tested = True
                        if COMMIT.search(cmd):
                            s["commits"] += 1
                            if not tested:
                                s["commits_untested"] += 1
                            tested = False
                        if REVERT.search(cmd):
                            s["reverts"] += 1
                    elif name in DELEGATE_TOOLS:
                        s["agents"] += 1
                    elif name == "EnterPlanMode":
                        s["plan"] += 1
    s["edited_files"] = len(edited)
    return s


def load_sessions():
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    try:
        cache = json.load(open(CACHE))
    except Exception:
        cache = {}
    out, fresh = [], {}
    for proj in sorted(os.listdir(PROJECTS)) if os.path.isdir(PROJECTS) else []:
        d = os.path.join(PROJECTS, proj)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if not name.endswith(".jsonl"):
                continue
            p = os.path.join(d, name)
            st = os.stat(p)
            key = f"{st.st_size}:{int(st.st_mtime)}"
            hit = cache.get(p)
            s = hit["summary"] if hit and hit["key"] == key else summarize(p)
            fresh[p] = {"key": key, "summary": s}
            if s["prompts"] >= 2 and s["first"]:
                out.append(s)
    json.dump(fresh, open(CACHE, "w"))
    return out


# (key, label, numerator, denominator, good, bad). Score 100 at good, 0 at bad, linear between.
# Rates are pooled across the window's sessions, not averaged per session.
METRICS = {
    "brief": [
        ("corrections", "prompts that correct Claude", "corrections", "prompts", 0.05, 0.30),
        ("short", "task prompts under 12 words", "short", "prompts", 0.10, 0.50),
    ],
    "verify": [
        ("read_edit", "reads per edit (Laurenzo: 6 good, 2 degraded)", "reads", "edits", 6.0, 2.0),
        ("edits_unread", "edits to files never read", "edits_unread", "edits", 0.05, 0.40),
        ("untested", "commits with no test run before them", "commits_untested", "commits", 0.10, 0.80),
        ("reverts", "reverts per commit", "reverts", "commits", 0.0, 0.30),
    ],
    "context": [
        ("big_results", "tool results over ~200 lines", "big_results", "results", 0.05, 0.30),
        ("compactions", "compactions per session", "compactions", "n", 0.0, 2.0),
        ("peak_context", "peak context tokens per session", "peak_context_sum", "n", 60000, 160000),
    ],
    "delegate": [
        ("solo_long", "long sessions (60+ tool calls) with no subagent", "solo_long", "long", 0.20, 0.90),
        ("no_plan", "5+ file changes without plan mode", "no_plan", "multi", 0.30, 1.00),
    ],
    "flow": [
        ("interrupts", "interrupts per prompt", "interrupts", "prompts", 0.02, 0.20),
        ("denials", "permission denials per tool call", "denials", "tools", 0.0, 0.05),
        ("errors", "tool errors per tool call", "errors", "tools", 0.03, 0.15),
    ],
}
NAMES = {"brief": "Brief quality", "verify": "Verification", "context": "Context hygiene",
         "delegate": "Delegation", "flow": "Flow"}


def pooled(sessions):
    t = {k: 0 for k in ("corrections", "prompts", "short", "reads", "edits", "edits_unread",
                        "commits_untested", "commits", "reverts", "big_results", "results",
                        "compactions", "peak_context_sum", "solo_long", "long", "no_plan",
                        "multi", "interrupts", "denials", "errors", "tools")}
    t["n"] = len(sessions)
    for s in sessions:
        for k in t:
            if k in s:
                t[k] += s[k]
        t["peak_context_sum"] += s["peak_context"]
        if s["tools"] >= LONG_SESSION:
            t["long"] += 1
            t["solo_long"] += s["agents"] == 0
        if s["edited_files"] >= 5:
            t["multi"] += 1
            t["no_plan"] += s["plan"] == 0
    return t


def score_one(x, good, bad):
    if good == bad:
        return 100.0
    v = (bad - x) / (bad - good)
    return max(0.0, min(1.0, v)) * 100


def score(sessions):
    """Returns {dim: (score|None, [(label, value, metric_score)...])}."""
    t = pooled(sessions)
    out = {}
    for dim, ms in METRICS.items():
        parts = []
        for key, label, num, den, good, bad in ms:
            if t[den] == 0:
                continue
            x = t[num] / t[den]
            parts.append((label, x, score_one(x, good, bad)))
        out[dim] = (sum(p[2] for p in parts) / len(parts) if parts else None, parts)
    return out


WINDOWS = (7, 14, 30, 60)
DAILY_DAYS = 120   # the pane shows up to 60 days plus the prior 60 as overlay


def dims_for(cur, prior):
    """Scores `cur` sessions, baseline from `prior`. Returns (dims, weakest)."""
    c, p = score(cur), score(prior) if prior else {}
    dims, weakest = [], None
    for dim in METRICS:
        sc, parts = c[dim]
        worst = sorted(parts, key=lambda x: x[2])[:3]
        dims.append({
            "key": dim, "name": NAMES[dim],
            "score": None if sc is None else round(sc),
            "baseline": None if not p or p[dim][0] is None else round(p[dim][0]),
            "causes": [f"{x[0]}: {x[1]:.2f}" for x in worst if x[2] < 100],
        })
        if sc is not None and (weakest is None or sc < weakest[1]):
            weakest = (dim, sc)
    return dims, (weakest[0] if weakest else None)


def between(sessions, lo, hi):
    return [s for s in sessions if lo <= s["last"] < hi]


def report(sessions, since=None, now=None):
    now = now or time.time()
    day = 86400
    windows = {}
    for w in WINDOWS:
        cur, prior = between(sessions, now - w * day, now + 1), between(sessions, now - 2 * w * day, now - w * day)
        dims, weakest = dims_for(cur, prior)
        windows[str(w)] = {"sessions": len(cur), "weakest": weakest, "dims": dims}
    if since is not None:
        span = max(now - since, day)
        dims, weakest = dims_for(between(sessions, since, now + 1), between(sessions, since - span, since))
        windows["since"] = {"sessions": len(between(sessions, since, now + 1)), "weakest": weakest, "dims": dims}
    # One point per day, each a 7-day trailing pool so a quiet day does not zero the line.
    daily = []
    for i in range(DAILY_DAYS - 1, -1, -1):
        end = now - i * day
        pool = between(sessions, end - 7 * day, end + 1)
        sc = score(pool) if pool else {}
        daily.append({
            "day": datetime.fromtimestamp(end, timezone.utc).strftime("%Y-%m-%d"),
            "scores": {d: (None if not sc or sc[d][0] is None else round(sc[d][0])) for d in METRICS},
        })
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "windows": windows,
        "daily": daily,
    }


def selftest():
    import tempfile
    rows = [
        {"type": "user", "timestamp": "2026-10-01T10:00:00Z", "cwd": "/x/proj", "message": {"role": "user", "content": "Fix the login bug please and add a test for it"}},
        {"type": "assistant", "timestamp": "2026-10-01T10:00:05Z", "message": {"model": "m", "usage": {"input_tokens": 10, "cache_read_input_tokens": 50000}, "content": [
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "a.py"}},
            {"type": "tool_use", "name": "Bash", "input": {"command": "git commit -m x"}}]}},
        {"type": "user", "timestamp": "2026-10-01T10:01:00Z", "message": {"role": "user", "content": [{"type": "tool_result", "is_error": True, "content": "x" * 9000}]}},
        {"type": "user", "timestamp": "2026-10-01T10:02:00Z", "message": {"role": "user", "content": "no, I meant the signup bug"}},
        {"type": "user", "timestamp": "2026-10-01T10:02:30Z", "message": {"role": "user", "content": "[Request interrupted by user]"}},
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(r) for r in rows))
    s = summarize(f.name)
    assert (s["prompts"], s["corrections"], s["short"], s["interrupts"]) == (2, 1, 1, 1), s
    assert (s["edits"], s["edits_unread"], s["commits_untested"], s["errors"], s["big_results"]) == (1, 1, 1, 1, 1), s
    assert s["peak_context"] == 50010 and s["active"] == 150.0, s
    r = report([s], now=ts("2026-10-02T00:00:00Z"))
    w = r["windows"]["7"]
    by = {d["key"]: d for d in w["dims"]}
    assert w["weakest"] == "brief" and by["brief"]["score"] == 0, w
    assert by["verify"]["score"] == 25 and by["delegate"]["score"] is None, w
    assert set(r["windows"]) == {"7", "14", "30", "60"} and len(r["daily"]) == 120, r["windows"].keys()
    assert r["daily"][-1]["scores"]["brief"] == 0 and r["daily"][0]["scores"]["brief"] is None, r["daily"][-1]
    rows2 = [dict(rows[0]), {"type": "assistant", "timestamp": "2026-10-01T10:00:05Z", "message": {"content": [
        {"type": "tool_use", "name": "mcp__ccd_session__start_session", "input": {}}]}}]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(r) for r in rows2))
    assert summarize(f.name)["agents"] == 1, "side sessions count as delegation"
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    since = None
    if "--since" in sys.argv:
        since = ts(sys.argv[sys.argv.index("--since") + 1])
    print(json.dumps(report(load_sessions(), since=since)))
