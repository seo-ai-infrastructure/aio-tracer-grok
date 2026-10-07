#!/usr/bin/env python3
"""
Work out who got whom to work on each task (asked / proposed / joined / self), then the
influence edges: A -> B is B's time on the tasks A triggered for B. Run after infer_tasks.py
and compute_markers.py. Model answers are cached, so re-runs are free.

Usage:
    python scripts/compute_influence.py --episode charity-2025 --dry-run    # counts and a sample prompt, no API call
    python scripts/compute_influence.py --episode charity-2025              # model with evidence (prints the cost)
    python scripts/compute_influence.py --episode charity-2025 --heuristic  # no model
    python scripts/compute_influence.py --episode charity-2025 --review 40  # also write a CSV sample to check by hand
"""
import argparse
import csv
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.cli import DEFAULT_DB, ROOT  # noqa: E402
from collab.influence import SYSTEM, candidates, compute_influence, infer_triggers, trigger_prompt  # noqa: E402
from collab.llm import DEFAULT_MODEL, LLM  # noqa: E402
from collab.store import Store  # noqa: E402
from collab.tree import TaskTree  # noqa: E402


def write_review(store, episode_id, n, path):
    """A stratified sample of triggers with their evidence, and an empty column to mark."""
    ep = store.get("episode", episode_id)
    tree = TaskTree(store.subtree_tasks(ep["root_task_id"]), ep["root_task_id"])
    rows = store.annotations("triggers", "episode_id = ?", (episode_id,))
    by_how = {}
    for r in rows:
        by_how.setdefault(r["how"], []).append(r)
    rng = random.Random(0)
    sample = []
    while len(sample) < min(n, len(rows)):  # round-robin over kinds so rare ones show up
        for how in sorted(by_how):
            if by_how[how] and len(sample) < n:
                sample.append(by_how[how].pop(rng.randrange(len(by_how[how]))))
    names = {a["id"]: a["name"] for a in store.all("actor")}
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["task", "worker", "how", "triggered_by", "evidence", "note", "provenance", "correct? (y/n)", "comment"])
        for r in sample:
            quotes = []
            for mid in r["evidence"] or []:
                m = store.get("message", mid)
                if m:
                    quotes.append(f"{names.get(m['sender'], m['sender'])}: {' '.join(m['text'].split())[:300]}")
            task = " > ".join(tree.tasks[t]["name"] for t in tree.path(tree.resolve(r["task_id"]))[1:])
            w.writerow([task, names.get(r["worker"], r["worker"]), r["how"], names.get(r["triggered_by"], "") or "",
                        "\n".join(quotes), r["note"], r["provenance"], "", ""])
    return len(sample)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--episode", required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--heuristic", action="store_true", help="decide triggers without a model")
    parser.add_argument("--batch", action="store_true", help="submit the calls as one Message Batch (50%% cost, slower)")
    parser.add_argument("--dry-run", action="store_true", help="show counts and a sample prompt; no API call")
    parser.add_argument("--review", type=int, metavar="N", help="write N sampled triggers to output/ for checking")
    args = parser.parse_args()

    store = Store(args.db)
    if store.get("episode", args.episode) is None:
        sys.exit(f"no episode {args.episode!r}; known: {[e['id'] for e in store.episodes()]}")
    if args.dry_run:
        bundles, ctx = candidates(store, args.episode)
        prompts = [trigger_prompt(b, ctx["members"]["manifest"], ctx["names"]) for b in bundles]
        pairs = sum(len(b["workers"]) for b in bundles)
        if prompts:
            sample = max(prompts, key=lambda p: p.count("\nm"))
            print(sample[:2500] + ("\n..." if len(sample) > 2500 else ""))
        chars = sum(len(SYSTEM) + len(p) for p in prompts)
        print(f"\n{len(bundles)} calls (one per task) for {pairs} task-worker pairs; ~{chars // 4:,} input tokens in total "
              f"(chars/4 estimate)")
        return

    llm = None if args.heuristic else LLM(store, model=args.model)
    counts = infer_triggers(store, llm, args.episode, batch=args.batch)
    summary = compute_influence(store, args.episode)
    print(f"triggers: {dict(sorted(counts.items()))}")
    if llm is not None:
        u = llm.usage
        print(f"{u['calls']} API calls ({u['cached']} answered from cache): {u['input_tokens']:,} input "
              f"+ {u['cache_creation_input_tokens'] + u['cache_read_input_tokens']:,} cache tokens, "
              f"{u['output_tokens']:,} output tokens, about ${u['dollars']:.2f}")
    names = {a["id"]: a["name"] for a in store.all("actor")}
    edges = Counter()
    for r in store.annotations("influence", "episode_id = ?", (args.episode,)):
        edges[(r["src"], r["dst"])] += r["effort"]
    print(f"{summary['edges']} edges, {summary['effort'] / 3600:.1f} h of triggered work. Largest:")
    for (src, dst), effort in edges.most_common(8):
        print(f"   {names.get(src, src)} -> {names.get(dst, dst)}: {effort / 60:.0f} min")
    if args.review:
        path = ROOT / "output" / f"influence_review_{args.episode}.csv"
        path.parent.mkdir(exist_ok=True)
        print(f"wrote {write_review(store, args.episode, args.review, path)} rows to {path}")


if __name__ == "__main__":
    main()
