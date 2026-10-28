#!/usr/bin/env python3
"""Folds one 'pilot scores' or 'pilot remove' issue into scores/. Env: TITLE, BODY, LOGIN."""
import json, os, re, statistics, sys

DIMS = ("brief", "verify", "context", "delegate", "flow")
WINDOWS = ("7", "14", "30", "60")
login = os.environ["LOGIN"]
assert re.fullmatch(r"[A-Za-z0-9-]{1,39}", login), "bad login"
path = f"scores/{login}.json"

if os.environ["TITLE"].strip() == "pilot remove":
    if os.path.exists(path):
        os.remove(path)
else:
    body = os.environ["BODY"]
    body = body[body.find("{"): body.rfind("}") + 1]      # tolerate a fenced block around the JSON
    data = json.loads(body)
    clean = {"login": login, "generatedAt": str(data.get("generatedAt", ""))[:25], "windows": {}}
    for w in WINDOWS:
        dims = (data.get("windows") or {}).get(w, {}).get("dims") or []
        clean["windows"][w] = {
            d["key"]: {"score": d.get("score"), "baseline": d.get("baseline")}
            for d in dims if d.get("key") in DIMS
            and all(v is None or (isinstance(v, (int, float)) and 0 <= v <= 100) for v in (d.get("score"), d.get("baseline")))
        }
    json.dump(clean, open(path, "w"), indent=1)

people = [json.load(open(f"scores/{f}")) for f in sorted(os.listdir("scores")) if f.endswith(".json") and f != "team.json"]
team = {"login": "team", "people": len(people), "windows": {}}
for w in WINDOWS:
    team["windows"][w] = {}
    for d in DIMS:
        vals = [p["windows"].get(w, {}).get(d, {}).get("score") for p in people]
        vals = [v for v in vals if v is not None]
        team["windows"][w][d] = {"score": round(statistics.median(vals)) if vals else None, "baseline": None}
json.dump(team, open("scores/team.json", "w"), indent=1)
print(f"folded {login}; team of {len(people)}")
