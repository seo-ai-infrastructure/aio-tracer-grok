#!/usr/bin/env python3
"""
Check the replay invariant for an episode: replaying it through the live pipeline (at maximum
speed, reusing the static build's LLM cache and task assignments) must end in exactly the same
records and derived tables as the static build.

Usage:
    python scripts/check_replay.py --episode rpg-with-saboteurs
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.checks import compare, episode_fingerprint  # noqa: E402
from collab.cli import DEFAULT_DB  # noqa: E402
from collab.live import LivePipeline, Replay, episode_records  # noqa: E402
from collab.llm import LLM  # noqa: E402
from collab.store import Store  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--episode", required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--with-llm", action="store_true",
                        help="rebuild inferred trees at the end (answers come from the static build's cache)")
    args = parser.parse_args()

    static = Store(args.db)
    live = Store()
    llm = LLM(static, offline=True) if args.with_llm else None  # answers only from the static build's cache
    replay = Replay(LivePipeline(live, llm=llm, reference=static, markers_every=5), episode_records(static, args.episode),
                    speed=float("inf"))
    replay.run()
    diff = compare(episode_fingerprint(static, args.episode), episode_fingerprint(live, args.episode))
    for table, (a, b) in diff.items():
        print(f"  DIFFERS {table}: static {a} vs replay {b}")
    print(f"{args.episode}: {replay.status()['total']:,} replayed records; "
          + ("replay matches the static build" if not diff else f"{len(diff)} tables differ"))
    sys.exit(1 if diff else 0)


if __name__ == "__main__":
    main()
