#!/usr/bin/env python3
"""Export a self-contained skill-root source ZIP without private repository history."""

import argparse
import sys
from pathlib import Path

from release_common import ROOT, build_archive


def build(output):
    return build_archive(output, source=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=ROOT / "dist/telegram-session-bridge-source.zip"
    )
    args = parser.parse_args()
    try:
        output = build(args.output)
    except (OSError, ValueError):
        print(
            "Release build failed: invalid publication input or output", file=sys.stderr
        )
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
