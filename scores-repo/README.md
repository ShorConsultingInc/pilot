# pilot-scores

Opt-in score drop box for the [pilot](https://github.com/ShorConsultingInc/pilot) Claude Code mod. Anyone running pilot can publish their weekly scores here with `/pilot share`, and compare against any published engineer or the team median with `/pilot compare <github-login>` or `/pilot compare team`.

**What is shared:** five scores (0-100) per time window, plus their prior-window baselines. No prompts, no code, no file names, no project names, no token counts. See a sample in `scores/`.

**How it works:** `/pilot share` opens an issue on this repo titled `pilot scores` whose body is the JSON payload. A GitHub Action validates it, writes it to `scores/<issue-author-login>.json`, recomputes `scores/team.json` (the median of everyone), commits, and closes the issue. The file name is always the issue author's login, so nobody can publish under someone else's name. Opening an issue needs only a GitHub account, not write access to this repo.

**To stop sharing:** open an issue titled `pilot remove`. The Action deletes your file.

**To run your own:** fork this repo and set `scoresRepo` in pilot's config to `<you>/<fork>`.
