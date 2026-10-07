#!/usr/bin/env python3
"""
Check a neutral trace file (NDJSON) against schema/trace.schema.json and for referential
integrity (unknown actors, parent cycles, episode roots, ambiguous episode membership, ...).

Usage:
    python scripts/validate_trace.py tests/fixtures/sim_small_a.ndjson
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.adapters.ndjson import read_records  # noqa: E402
from collab.cli import print_issues  # noqa: E402
from collab.validate import check  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("paths", nargs="+", type=Path, help="one or more NDJSON files, checked together")
    args = parser.parse_args()

    records = [rec for p in args.paths for rec in read_records(p)]
    issues = check(records)
    n_errors = print_issues(issues)
    print(f"{len(records):,} records, {n_errors} errors, {len(issues) - n_errors} warnings")
    sys.exit(1 if n_errors else 0)


if __name__ == "__main__":
    main()
