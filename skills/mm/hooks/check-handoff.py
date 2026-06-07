import json
import os
import sys

try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(0)
tool_input = data.get("tool_input", {})
fp = tool_input.get("TargetFile") or tool_input.get("file_path") or ""

if "HANDOFF" not in fp or not os.path.exists(fp):
    sys.exit(0)

patterns = [
    "preserved for audit trail",
    "historical note kept for honesty",
    "old content below",
    "correcting the",
    "initial assessment was",
    "re-diagnosed",
]

with open(fp, encoding="utf-8") as f:
    lines = f.readlines()

scan_lines = []
for line in lines:
    if line.lower().startswith("## section 4 archive"):
        break
    scan_lines.append(line)

found = [
    f"  Line {i}: {line.strip()[:100].encode('ascii', 'backslashreplace').decode('ascii')}"
    for i, line in enumerate(scan_lines, 1)
    if any(pattern in line.lower() for pattern in patterns)
]

if found:
    print("No Archaeology Test FAILED - fix before continuing:")
    for entry in found:
        print(entry)
    print()
    sys.exit(1)
