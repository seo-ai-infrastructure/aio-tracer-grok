#!/usr/bin/env python3
"""
Build the task tree for an episode (goal -> tasks of any depth) and assign work spans to it.

Sources that provide a tree are copied as-is; otherwise the tree is inferred top-down with
Claude (see collab/tasks.py and config/tasks.yaml). Results are cached, so re-runs are free.

Usage:
    python scripts/infer_tasks.py --episode rpg-with-saboteurs --dry-run   # show the first prompt, no API call
    python scripts/infer_tasks.py --episode rpg-with-saboteurs             # infer and print the tree
    python scripts/infer_tasks.py --episode rpg-with-saboteurs --batch     # use Message Batches (50% cost, slower)
    python scripts/infer_tasks.py --episode rpg-with-saboteurs --show      # print the stored tree
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.cli import DEFAULT_DB  # noqa: E402
from collab.llm import DEFAULT_MODEL, LLM  # noqa: E402
from collab.store import Store  # noqa: E402
from collab.tasks import SYSTEM, group_items, load_config, split_prompt, infer_tree  # noqa: E402
from collab.tree import TaskTree  # noqa: E402


def print_tree(store, episode_id):
    ep = store.get("episode", episode_id)
    tasks = store.subtree_tasks(ep["root_task_id"])
    tree = TaskTree(tasks, ep["root_task_id"])
    counts = {}
    for row in store.annotations("span_task", "episode_id = ?", (episode_id,)):
        counts[row["task_id"]] = counts.get(row["task_id"], 0) + 1
    for tid in tree.preorder():
        t = tree.tasks[tid]
        sub = sum(counts.get(x, 0) for x in tree.subtree(tid))
        attrs = t["attrs"] or {}
        why = f"  [{attrs['decision']}: {attrs.get('reason', '')[:80]}]" if attrs.get("decision") else ""
        print(f"{'   ' * tree.depth(tid)}{t['name']}  ({sub} spans, {counts.get(tid, 0)} direct"
              f"{', ' + t['status'] if t['status'] else ''}){why}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--episode", required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--batch", action="store_true", help="submit each tree level as a Message Batch")
    parser.add_argument("--dry-run", action="store_true", help="print the root prompt and its size; no API call")
    parser.add_argument("--show", action="store_true", help="only print the stored tree")
    args = parser.parse_args()

    store = Store(args.db)
    if store.get("episode", args.episode) is None:
        sys.exit(f"no episode {args.episode!r}; known: {[e['id'] for e in store.episodes()]}")
    if args.show:
        print_tree(store, args.episode)
        return
    if args.dry_run:
        members = store.episode_members(args.episode)
        root = store.get("task", members["episode"]["root_task_id"])
        names = {a["id"]: a["name"] for a in members["actors"]}
        groups = group_items([s for s in members["spans"] if s["kind"] == "work"], names)
        cfg = load_config()
        prompt = split_prompt([root["name"]], root, groups, cfg, cfg["max_depth"] - 1, members["manifest"])
        print(prompt[:3000] + ("\n..." if len(prompt) > 3000 else ""))
        chars = len(SYSTEM) + len(prompt)
        print(f"\nroot call: {len(groups)} groups, ~{chars // 4:,} input tokens (chars/4 estimate)")
        return

    llm = LLM(store, model=args.model)
    summary = infer_tree(store, llm, args.episode, batch=args.batch)
    u = llm.usage
    print(f"\n{summary}\n{u['calls']} API calls ({u['cached']} answered from cache): {u['input_tokens']:,} input "
          f"+ {u['cache_creation_input_tokens'] + u['cache_read_input_tokens']:,} cache tokens, "
          f"{u['output_tokens']:,} output tokens, about ${u['dollars']:.2f}\n")
    print_tree(store, args.episode)


if __name__ == "__main__":
    main()
