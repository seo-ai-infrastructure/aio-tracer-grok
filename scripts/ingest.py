#!/usr/bin/env python3
"""
Load a source into the collab store (SQLite) as neutral trace records, then split messages
into sentences.

Sources:
    ndjson                 a neutral trace file (what a simulation writes)
    aivillage-transcript   data/village-transcript.json, days from config/aivillage_episodes.yaml

Usage:
    python scripts/ingest.py --source ndjson tests/fixtures/sim_small_a.ndjson
    python scripts/ingest.py --source aivillage-transcript                 # all configured episodes
    python scripts/ingest.py --source aivillage-transcript --days 338-348  # just the pilot days
    python scripts/ingest.py --source aivillage-transcript --days 338-348 --export output/rpg.ndjson
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.adapters import aivillage_transcript, ndjson  # noqa: E402
from collab.cli import DEFAULT_DB, parse_days, print_issues  # noqa: E402
from collab.ingest import ingest  # noqa: E402
from collab.store import Store  # noqa: E402
from collab.validate import check  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--source", required=True, choices=["ndjson", "aivillage-transcript"])
    parser.add_argument("path", nargs="?", type=Path, help="input file (default for aivillage-transcript: "
                                                           "data/village-transcript.json)")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--days", type=parse_days, help="aivillage: day or range, e.g. 338-348")
    parser.add_argument("--export", type=Path, help="also write the neutral records to this NDJSON file")
    parser.add_argument("--no-validate", action="store_true", help="skip schema/integrity checks")
    parser.add_argument("--log-deltas", action="store_true", help="record deltas (only needed while streaming)")
    args = parser.parse_args()

    t0 = time.time()
    if args.source == "ndjson":
        if not args.path:
            parser.error("ndjson needs a path")
        records = list(ndjson.read_records(args.path))
    else:
        days = range(args.days[0], args.days[1] + 1) if args.days else None
        records = list(aivillage_transcript.records(args.path or aivillage_transcript.DEFAULT_PATH, days=days))
    print(f"read {len(records):,} records in {time.time() - t0:.1f}s")

    if not args.no_validate:
        issues = check(records)
        if print_issues(issues):
            sys.exit("not ingesting: fix the errors above (or pass --no-validate)")
    if args.export:
        args.export.parent.mkdir(parents=True, exist_ok=True)
        print(f"wrote {ndjson.write_records(args.export, records):,} records to {args.export}")

    args.db.parent.mkdir(parents=True, exist_ok=True)
    store = Store(args.db)
    counts = ingest(store, records, log=args.log_deltas)
    print(f"stored in {args.db}: " + ", ".join(f"{counts.get(k, 0):,} {k}s" for k in
                                                ("episode", "actor", "message", "span", "event", "sentence")))
    for ep in store.episodes():
        m = store.episode_members(ep["id"])
        print(f"  episode {ep['id']}: {len(m['actors'])} actors, {len(m['messages']):,} messages, "
              f"{len(m['spans']):,} spans, {len(m['tasks'])} tasks")


if __name__ == "__main__":
    main()
