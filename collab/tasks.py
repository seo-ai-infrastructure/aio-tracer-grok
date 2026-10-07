"""Task-tree inference, per episode.

If the source provides the tree (work spans carry task_id), those assignments are copied with
provenance 'source'. Otherwise the tree is built top-down with an LLM: each call sees one
node's work items and either splits the node into >= 2 children or keeps it as a leaf, giving
a reason. Items left unassigned stay on the node as its own ("general") work. Guards are
enforced in code, not trusted to the model.
"""
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

from collab.cli import ROOT

PROMPT_VERSION = "tasks-v2"
CONFIG_PATH = ROOT / "config" / "tasks.yaml"
STATUSES = ["done", "abandoned", "blocked", "ongoing"]

SYSTEM = """You organize the recorded work of a team of AI agents into a task tree.

You are shown one node of the tree (the root is the team's goal) and the work items recorded
under it. Each work item is a stretch of activity with the agent's own short description of
what it was doing; identical descriptions are grouped, with a count.

Decide whether this node should be split into subtasks:
- Split only when the items clearly form two or more distinct pieces of work (different
  artifacts, features, documents or activities). Otherwise keep the node as a leaf.
- Split by what the work is for, never by when it happened. Do not make children for days,
  sessions, weeks or phases of time: the tree is drawn on a timeline that already shows time,
  and work on the same feature or artifact on different days belongs to the same child.
  Recurring kinds of work (reviewing and merging, testing, coordination) are good children.
- Children must not overlap. Assign each item group to at most one child. Leave an item
  unassigned when it is general work on this node rather than on one child.
- Each child needs enough items to matter (the minimum is given below) unless it is a
  distinct named artifact, such as a specific pull request, document or bug.
- Name children in 2-5 words, reusing concrete names from the items (e.g. "PR #6",
  "Landing page", "Master index doc"). Summarize each child in one sentence.
- anchors: distinctive terms that identify the child's work in chat messages, such as
  artifact names, numbers or keywords. Prefer specific terms over generic words.
- status (for this node and each child), judged only from the items: "done" if the work
  visibly concluded, "abandoned" if it was dropped, "blocked" if it kept failing or waiting,
  otherwise "ongoing".
- Use only the evidence given. Do not invent work."""

SPLIT_SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string", "enum": ["split", "keep"]},
        "reason": {"type": "string"},
        "status": {"type": "string", "enum": STATUSES},
        "children": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "summary": {"type": "string"},
                "anchors": {"type": "array", "items": {"type": "string"}},
                "status": {"type": "string", "enum": STATUSES},
                "items": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["name", "summary", "anchors", "status", "items"],
            "additionalProperties": False,
        }},
    },
    "required": ["decision", "reason", "status", "children"],
    "additionalProperties": False,
}


def load_config(path=CONFIG_PATH):
    return yaml.safe_load(Path(path).read_text())


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "task"


def fmt_time(t, manifest):
    if (manifest or {}).get("time_unit") == "step":
        return f"step {t:g}"
    tz = ZoneInfo((manifest or {}).get("display_tz") or "UTC")
    return datetime.fromtimestamp(t, tz).strftime("%a %m-%d %H:%M")


def group_items(spans, actor_names):
    """Group work spans by normalized label -> [{id, label, span_ids, actors, start, end}]."""
    groups = {}
    for s in sorted(spans, key=lambda s: s["start"]):
        key = " ".join((s["label"] or "(no description)").lower().split())
        g = groups.setdefault(key, {"label": s["label"] or "(no description)", "span_ids": [], "actors": [],
                                    "start": s["start"], "end": s["end"]})
        g["span_ids"].append(s["id"])
        name = actor_names.get(s["actor"], s["actor"])
        if name not in g["actors"]:
            g["actors"].append(name)
        g["end"] = max(g["end"] or s["start"], s["end"] or s["start"])
    return [{"id": f"g{i}", **g} for i, g in enumerate(groups.values())]


def split_prompt(path_names, node, groups, cfg, remaining_depth, manifest):
    lines = [f"Goal (root of the tree): {path_names[0]}",
             f"Path to this node: {' > '.join(path_names)}"]
    if node.get("description"):
        lines.append(f"This node: {node['name']} - {node['description']}")
    lines += ["", f"Work items at this node ({sum(len(g['span_ids']) for g in groups)} items in {len(groups)} groups).",
              "Columns: group id | count | agents | time range | description"]
    for g in groups:
        span = f"{fmt_time(g['start'], manifest)} -> {fmt_time(g['end'], manifest)}"
        lines.append(f"{g['id']} | x{len(g['span_ids'])} | {', '.join(g['actors'])} | {span} | {g['label']}")
    lines += ["", f"Minimum items per child: {cfg['min_spans_per_node']} (unless a distinct named artifact).",
              f"Levels allowed below this node: {remaining_depth}."]
    notes = ((manifest or {}).get("attrs") or {}).get("domain_notes")
    if notes:
        lines += ["", f"Notes about this data source: {notes}"]
    return "\n".join(lines)


TIME_WORDS = re.compile(r"\b(day|days|session|sessions|week|weeks|phase|morning|afternoon|evening|sprint|round)\s*[\d#]"
                        r"|\bday\s+(one|two|three|four|five|six|seven)\b|\b\d{1,2}/\d{1,2}\b"
                        r"|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*day\b", re.I)


def time_split_problem(result, groups):
    """Why an answer looks like a split by time rather than by work (None if it doesn't).

    Flags answers where at least half the children are named after time periods ("Day 338 ...").
    Children that merely happen at different times are fine: features are often built one after
    another (checking time ranges misfired on 14 of 78 pilot calls)."""
    children = [c for c in result.get("children") or [] if c.get("items")]
    if result.get("decision") != "split" or len(children) < 2:
        return None
    named = [c["name"] for c in children if TIME_WORDS.search(c["name"])]
    if len(named) * 2 >= len(children):
        return f"children are named after time periods: {', '.join(named[:4])}"
    return None


def apply_guards(result, groups, cfg):
    """Enforce the split rules on an LLM answer. Returns (decision, reason, children, leftover_groups)."""
    by_id = {g["id"]: g for g in groups}
    taken, children = set(), []
    for child in result.get("children") or []:
        gids = [gid for gid in child["items"] if gid in by_id and gid not in taken]
        n = sum(len(by_id[gid]["span_ids"]) for gid in gids)
        if not gids or (n < cfg["min_spans_per_node"] and not child.get("anchors")):
            continue  # too thin: its items stay with the parent
        taken.update(gids)
        children.append({**child, "groups": [by_id[gid] for gid in gids]})
    leftover = [g for g in groups if g["id"] not in taken]
    reason = result.get("reason", "")
    if result.get("decision") != "split":
        return "keep", reason, [], groups
    if len(children) < 2:
        return "keep", f"{reason} [guard: fewer than 2 viable children]".strip(), [], groups
    return "split", reason, children, leftover


def source_assignments(store, episode_id, members):
    """Copy source-provided span -> task assignments; returns the number copied."""
    rows = [{"episode_id": episode_id, "span_id": s["id"], "task_id": s["task_id"], "provenance": "source",
             "confidence": 1.0} for s in members["spans"] if s["kind"] == "work" and s.get("task_id")]
    store.delete("span_task", "episode_id = ?", (episode_id,), episode_ids=[episode_id])
    store.upsert("span_task", rows, episode_ids=[episode_id])
    return len(rows)


def ask(llm, prompts, cfg, batch=False, progress=print):
    """Answer {node_id: prompt}: one Message Batch, or concurrent synchronous calls."""
    if not prompts:
        return {}
    if batch:
        return llm.json_batch(PROMPT_VERSION, SYSTEM, list(prompts.items()), SPLIT_SCHEMA,
                              effort=cfg["effort"], progress=progress)
    with ThreadPoolExecutor(max_workers=min(8, len(prompts))) as pool:
        futures = {k: pool.submit(llm.json, PROMPT_VERSION, SYSTEM, p, SPLIT_SCHEMA, effort=cfg["effort"])
                   for k, p in prompts.items()}
        return {k: f.result() for k, f in futures.items()}


def clear_inferred(store, episode_id, root_id):
    for t in store.subtree_tasks(root_id):
        if t["id"] != root_id and t["provenance"] == "llm":
            store.remove("task", t["id"])
    store.delete("span_task", "episode_id = ?", (episode_id,), episode_ids=[episode_id])


def infer_tree(store, llm, episode_id, cfg=None, batch=False, progress=print):
    """Build (or copy) the task tree for one episode; returns a summary dict."""
    cfg = cfg or load_config()
    members = store.episode_members(episode_id)
    ep, manifest = members["episode"], members["manifest"]
    root = store.get("task", ep["root_task_id"])
    caps = (manifest or {}).get("capabilities") or {}
    work = [s for s in members["spans"] if s["kind"] == "work"]
    if caps.get("task_tree") and any(s.get("task_id") for s in work):
        n = source_assignments(store, episode_id, members)
        return {"source": "source", "assigned": n, "tasks": len(members["tasks"]), "calls": 0}

    # Build the whole tree in memory; the store changes only once every call has succeeded.
    names = {a["id"]: a["name"] for a in members["actors"]}
    span_start = {s["id"]: s["start"] for s in work}
    assignments = {}  # span id -> task id
    decisions = {}
    new_tasks = []
    frontier = [(root, [root["name"]], group_items(work, names), 0)]
    calls = 0
    while frontier:
        to_ask, next_frontier = [], []
        for node, path, groups, depth in frontier:
            n_spans = sum(len(g["span_ids"]) for g in groups)
            if depth + 1 >= cfg["max_depth"]:
                decisions[node["id"]] = ("keep", "max_depth reached", None)
            elif n_spans <= cfg["split_min_spans"]:
                decisions[node["id"]] = ("keep", f"only {n_spans} work spans", None)
            else:
                prompt = split_prompt(path, node, groups, cfg, cfg["max_depth"] - depth - 1, manifest)
                to_ask.append((node, path, groups, depth, prompt))
                continue
            for g in groups:
                for sid in g["span_ids"]:
                    assignments[sid] = node["id"]
        answers = ask(llm, {n["id"]: p for n, _, _, _, p in to_ask}, cfg, batch, progress)
        calls += len(to_ask)
        # A split by time (days, sessions) duplicates the timeline: re-ask once with a correction.
        retry, groups_of = {}, {n["id"]: g for n, _, g, _, _ in to_ask}
        for node, _, groups, _, prompt in to_ask:
            problem = time_split_problem(answers[node["id"]], groups)
            if problem:
                retry[node["id"]] = (f"{prompt}\n\nAn earlier answer split this node by time ({problem}). "
                                     "Split by what the work is for instead, or keep the node whole.")
        if retry:
            progress(f"  re-asking {len(retry)} node(s) that were split by time")
            for node_id, answer in ask(llm, retry, cfg, batch, progress).items():
                problem = time_split_problem(answer, groups_of[node_id])
                if problem and problem.startswith("children are named"):
                    answer = {"decision": "keep", "status": answer.get("status", "ongoing"), "children": [],
                              "reason": f"[guard: split by time twice - {problem}]"}
                answers[node_id] = answer
            calls += len(retry)
        for node, path, groups, depth, _ in to_ask:
            answer = answers[node["id"]]
            decision, reason, children, leftover = apply_guards(answer, groups, cfg)
            decisions[node["id"]] = (decision, reason, answer.get("status"))
            for g in leftover:
                for sid in g["span_ids"]:
                    assignments[sid] = node["id"]
            used = set()
            for child in children:
                cid = f"{node['id']}/{slug(child['name'])}"
                while cid in used:
                    cid += "-2"
                used.add(cid)
                spans = [sid for g in child["groups"] for sid in g["span_ids"]]
                rec = {"record": "task", "id": cid, "name": child["name"], "description": child["summary"],
                       "parent_id": node["id"], "status": child["status"], "start": min(span_start[s] for s in spans),
                       "attrs": {"anchors": child["anchors"], "n_spans": len(spans)}}
                new_tasks.append(rec)
                next_frontier.append((rec, path + [child["name"]], child["groups"], depth + 1))
            progress(f"  {' > '.join(path)}: {decision} ({len(children)} children) - {reason[:100]}")
        frontier = next_frontier

    clear_inferred(store, episode_id, root["id"])
    root_rec = {"attrs": root["attrs"], "status": root["status"]}
    by_id = {**{t["id"]: t for t in new_tasks}, root["id"]: root_rec}
    for task_id, (decision, reason, status) in decisions.items():
        task = by_id[task_id]
        task["attrs"] = {**(task.get("attrs") or {}), "decision": decision, "reason": reason}
        if status:  # a node's own call sees all its items, so its status wins over the parent's guess
            task["status"] = status
    for rec in new_tasks:
        store.apply(rec, extra={"provenance": "llm"})
    store.apply({"record": "task", "op": "patch", "id": root["id"], "attrs": root_rec["attrs"],
                 **({"status": root_rec["status"]} if root_rec.get("status") else {})})
    store.upsert("span_task", [{"episode_id": episode_id, "span_id": sid, "task_id": tid, "provenance": "llm",
                                "confidence": None} for sid, tid in assignments.items()], episode_ids=[episode_id])
    tasks = store.subtree_tasks(root["id"])
    return {"source": "llm", "assigned": len(assignments), "tasks": len(tasks), "calls": calls}
