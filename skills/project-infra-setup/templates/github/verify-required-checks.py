"""Compare required status-check names in a ruleset JSON with the check names produced by workflow YAML files.

Usage: python -I verify-required-checks.py ruleset-main.json ci.yml pr-title.yml
Exit 0 = every required context is produced by a job; 1 = a required check has no job (PR blocked forever);
2 = bad usage or unreadable input.
No third-party dependencies: reads the `jobs:` block by indentation (job ids at 2 spaces, keys at 4).

Matrix jobs: GitHub reports one check per combination, named `<job name> (<value>[, <value>])`, never the bare job
name. This script expands simple inline matrices (`key: [a, b]`, no include/exclude) into those names. A required
context that only a matrix job could produce under its bare name FAILS. A matrix it cannot expand, or a job name
containing an expression (`${{ ... }}`), produces no checkable names, so requiring it also FAILS (fail closed).
"""
import itertools
import json
import re
import sys

USAGE = (
    "usage: verify-required-checks.py <ruleset.json> <workflow.yml> [<workflow.yml> ...]\n"
    "example: python -I verify-required-checks.py ruleset-main.json ci.yml pr-title.yml"
)


def job_names(path):
    """Return ({check name: file}, [notes]). Check name = job `name:` if set, else the job id; matrix jobs expand."""
    names = {}
    notes = []
    in_jobs = False
    cur = None  # {"id", "name", "matrix": bool, "in_matrix": bool, "keys": {key: [values]}, "unexpandable": bool}

    def flush():
        if not cur:
            return
        label = cur["name"] or cur["id"]
        if "${{" in label:
            notes.append(f"WARN {path}: job '{cur['id']}' name contains an expression; its check names cannot be verified")
            return
        if not cur["matrix"]:
            names[label] = path
            return
        if cur["unexpandable"] or not cur["keys"]:
            notes.append(f"WARN {path}: job '{cur['id']}' uses a matrix this script cannot expand; its checks cannot be verified")
            return
        for combo in itertools.product(*cur["keys"].values()):
            names[f"{label} ({', '.join(combo)})"] = path

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if re.match(r"^jobs:\s*(#.*)?$", line):
                in_jobs = True
                continue
            if not in_jobs:
                continue
            if re.match(r"^\s*(#.*)?$", line):  # blank or comment-only lines never end the jobs block
                continue
            if re.match(r"^\S", line):  # next top-level key ends the jobs block
                break
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*(#.*)?$", line)
            if m:
                flush()
                cur = {"id": m.group(1), "name": None, "matrix": False, "in_matrix": False, "keys": {}, "unexpandable": False}
                continue
            if not cur:
                continue
            n = re.match(r"^    name:\s*(.+?)\s*$", line)
            if n:
                raw = n.group(1)
                q = re.match(r"""^(['"])(.*?)\1""", raw)  # quoted scalar: take the text inside the quotes
                cur["name"] = q.group(2) if q else re.split(r"\s+#", raw, maxsplit=1)[0].strip()
            if re.match(r"^      matrix:", line):
                cur["matrix"] = True
                cur["in_matrix"] = True
                if re.match(r"^      matrix:\s*\S", line):  # inline or expression matrix
                    cur["unexpandable"] = True
                continue
            if cur["in_matrix"]:
                if re.match(r"^ {0,6}\S", line):  # any line at matrix-key indentation or shallower ends the matrix block
                    cur["in_matrix"] = False
                    continue
                if re.match(r"^        (include|exclude):", line):
                    cur["unexpandable"] = True
                    continue
                kv = re.match(r"^        ([A-Za-z0-9_-]+):\s*\[(.*)\]\s*(#.*)?$", line)
                if kv:
                    cur["keys"][kv.group(1)] = [v.strip().strip("'\"") for v in kv.group(2).split(",") if v.strip()]
                elif re.match(r"^        [A-Za-z0-9_-]+:\s*\S", line) or re.match(r"^        [A-Za-z0-9_-]+:\s*$", line):
                    cur["unexpandable"] = True
    flush()
    return names, notes


def main(argv):
    if len(argv) < 3:
        print(USAGE)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as fh:
            ruleset = json.load(fh)
        required = set()
        for rule in ruleset["rules"]:
            if rule["type"] == "required_status_checks":
                required |= {c["context"] for c in rule["parameters"]["required_status_checks"]}
        produced = {}
        for wf in argv[2:]:
            found, notes = job_names(wf)
            for note in notes:
                print(note)
            produced.update(found)
    except (OSError, ValueError, KeyError) as exc:
        print(f"ERROR: {exc}")
        print(USAGE)
        return 2
    missing = sorted(required - set(produced))
    extra = sorted(set(produced) - required)
    print("required :", sorted(required))
    print("produced :", sorted(produced))
    print("required but no job produces it:", missing)
    print("jobs that are not required (informational):", extra)
    print("RESULT:", "FAIL" if missing else "OK")
    return 1 if missing else 0


sys.exit(main(sys.argv))
