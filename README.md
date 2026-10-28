# Pilot scorecard: your Claude Code scorecard

Pilot scores how *you* work with Claude Code, not how Claude performs. It reads the session transcripts already on your machine, scores five dimensions against your own prior four weeks, names the weakest one with its concrete causes, and runs one-week experiments to fix it. Nothing leaves your machine.

| Dimension | What it reads from your sessions |
|---|---|
| Brief quality | Prompts that correct Claude, task prompts under 12 words |
| Verification | Reads per edit, edits to files never read, commits with no test run, reverts |
| Context hygiene | Tool results over ~200 lines, compactions, peak context size |
| Delegation | Long sessions with no subagent, 5+ file changes without plan mode |
| Flow | Interrupts, permission denials, tool errors |

Thresholds for reads-per-edit and edits-without-read follow the Laurenzo analysis of 6,852 Claude Code sessions (anthropics/claude-code issue 42796).

## Use

```
/pilot                     open the scorecard (scores on first run)
/pilot refresh             re-score after new sessions
/pilot window 30           7, 14, 30 or 60 days; each is scored against the window before it
/pilot experiment          start a one-week rule aimed at your weakest dimension
/pilot experiment stop     measure the delta and end it
/pilot share               publish your scores (numbers only) to the shared repo, under your GitHub login
/pilot compare <login>     show that engineer's scores next to yours; `team` is the median; no arg clears
```

The pane shows, per dimension, the score for the chosen window, the delta against the prior window, and two daily sparklines: the window itself and the window before it, each point a 7-day trailing pool. Buttons switch the window.

While an experiment runs, Pilot nudges with a toast when you break its rule: a short brief, a commit with no test run, a whole-file Read. It never blocks anything.

## Sharing and comparing

Sharing is opt-in and numbers-only: five scores per window plus their baselines. `/pilot share` opens an issue on the scores repo (default `ShorConsultingInc/pilot-scores`, set `scoresRepo` in the plugin config for your own) with the JSON as its body; a GitHub Action there validates it, writes `scores/<your-login>.json`, recomputes the team median and closes the issue. Opening an issue needs a GitHub account and a signed-in `gh`, not write access. The `scores-repo/` folder here is the full scaffold for running your own.

## Install

At the prompt of a terminal session:

```
/plugin install pilot-scorecard --marketplace ShorConsultingInc/pilot
```

Needs `python3` on the path. The analyzer is stdlib only and caches per-transcript summaries in `~/.claude/pilot/cache.json`, so re-scoring is fast.

## What it runs, reads, writes and sends

For the directory's reviewers and for you. The hooks module is `hooks/register.tsx`; every call below is in it.

- **Runs:** `python3 scripts/pilot.py` from the plugin's own folder (with `--since <ISO date>` when ending an experiment), and `gh issue create --repo <scoresRepo> --title "pilot scores" --body-file -` only when you run `/pilot share`. Nothing else is started. The scores JSON is passed to `gh` on stdin; the mod writes no files.
- **Reads:** the analyzer script reads the Claude Code transcripts under `~/.claude/projects` on this machine and caches per-session counts in `~/.claude/pilot/cache.json`. The mod itself reads only the script's JSON output and its own plugin store.
- **Sends:** nothing, unless you run `/pilot share`, which sends the five scores per window plus baselines (see `scores-repo/README.md`) to the GitHub repo named by the `scoresRepo` option, through your own signed-in `gh`.
- **Fetches:** `/pilot compare <login>` reads one file, `https://raw.githubusercontent.com/<scoresRepo>/main/scores/<login>.json`. No other host is contacted.
- **Hooks on tool calls and prompts:** the `prompt.submit`, `tool.call{Bash}` and `tool.call{Read}` hooks only look at the prompt or the command to decide whether to show a toast while an experiment is running. They never rewrite, block or record anything, and pass every event through unchanged.
- **Commands:** registers `/pilot` and answers it itself. It runs no other slash commands.

## Privacy

Everything the analyzer reads stays on your machine: it parses your local Claude Code transcripts, which can contain personal data, and keeps only counts per session in `~/.claude/pilot/cache.json`. Nothing is transmitted unless you run `/pilot share`, which publishes five scores per time window and their baselines, under your GitHub login, to the public scores repository you configured. Those numbers stay there until you open a `pilot remove` issue, which deletes them. There is no server of ours, no telemetry and no analytics.

## What it is not

Not a cost tracker (use ccusage), not a CLAUDE.md rule writer (use claude-reflect), not a team leaderboard. Scores compare you with your own baseline.

## Borrowed ideas

claude-reflect (corrections as signal), nerf-receipts (churn and failure rate per task), context-hogs (context cost per read), claude-hooks-analytics (ship outcomes, active time), lucemia/claude-session-analyzer (Laurenzo thresholds).
