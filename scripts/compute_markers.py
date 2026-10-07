#!/usr/bin/env python3
"""
Compute Tasks-timeline markers for an episode: retry loops, duplicate effort (coordinated or
not) and wait targets. Run after infer_tasks.py so overlaps know which task each span is on.

Usage:
    python scripts/compute_markers.py --episode rpg-with-saboteurs
    python scripts/compute_markers.py --all
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.cli import DEFAULT_DB  # noqa: E402
from collab.markers import compute_markers  # noqa: E402
from collab.store import Store  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--episode")
    group.add_argument("--all", action="store_true")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    store = Store(args.db)
    episodes = [e["id"] for e in store.episodes()] if args.all else [args.episode]
    for ep in episodes:
        summary = compute_markers(store, ep)
        print(f"{ep}: {summary}")
        for loop in sorted(store.annotations("loops", "episode_id = ?", (ep,)), key=lambda x: -x["count"])[:5]:
            labels = [store.get("span", s)["label"] for s in loop["span_ids"][:3]]
            print(f"   loop x{loop['count']} {loop['actor']}: {' / '.join(labels)}")


if __name__ == "__main__":
    main()
