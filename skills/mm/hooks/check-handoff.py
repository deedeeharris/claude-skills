import sys, json, os

data = json.load(sys.stdin)
fp = data.get('tool_input', {}).get('file_path', '')

if 'HANDOFF' not in fp or not os.path.exists(fp):
    sys.exit(0)

patterns = [
    'preserved for audit trail',
    'historical note kept for honesty',
    'old content below',
    'correcting the',
    'initial assessment was',
    're-diagnosed',
]

with open(fp, encoding='utf-8') as f:
    lines = f.readlines()

found = [
    f'  Line {i}: {line.strip()[:100]}'
    for i, line in enumerate(lines, 1)
    if any(p in line.lower() for p in patterns)
]

if found:
    print('⚠️  No Archaeology Test FAILED — fix before continuing:')
    for entry in found:
        print(entry)
    print()
