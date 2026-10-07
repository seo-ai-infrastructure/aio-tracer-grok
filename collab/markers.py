"""Markers for the Tasks timeline: retry loops, duplicate effort (overlaps) and wait targets.

All deterministic and source-agnostic; thresholds live in config/markers.yaml.
"""
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

import yaml

from collab.acts import communication_links, store_addressees
from collab.cli import ROOT
from collab.tree import TaskTree, merge_intervals

CONFIG_PATH = ROOT / "config" / "markers.yaml"
POLLING = re.compile(r"\b(check|checking|monitor|monitoring|wait|waiting|poll|polling|watch|watching|scan)\b", re.I)


def loop_kind(labels):
    """'polling' when most attempts are checking/monitoring, else 'retry'."""
    return "polling" if sum(bool(POLLING.search(x or "")) for x in labels) * 2 >= len(labels) else "retry"


def load_config(path=CONFIG_PATH):
    return yaml.safe_load(Path(path).read_text())


def similarity(a, b):
    return SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()


def detect_loops(work, span_task, cfg):
    """Runs of >= min_repeats consecutive work spans by one actor with similar descriptions."""
    by_actor = defaultdict(list)
    for s in sorted(work, key=lambda s: (s["start"], s["id"])):
        by_actor[s["actor"]].append(s)
    loops = []
    for actor, spans in by_actor.items():
        run, sims = [spans[0]], []
        for prev, cur in zip(spans, spans[1:] + [None]):
            sim = similarity(prev["label"], cur["label"]) if cur else 0
            if cur and sim >= cfg["min_similarity"]:
                run.append(cur)
                sims.append(sim)
                continue
            if len(run) >= cfg["min_repeats"]:
                tasks = Counter(span_task.get(s["id"]) for s in run if span_task.get(s["id"]))
                loops.append({"id": f"loop:{actor}:{run[0]['id']}", "actor": actor,
                              "kind": loop_kind([s["label"] for s in run]),
                              "task_id": tasks.most_common(1)[0][0] if tasks else None,
                              "span_ids": [s["id"] for s in run], "count": len(run),
                              "confidence": round(sum(sims) / len(sims), 3)})
            run, sims = ([cur], []) if cur else ([], [])
    return loops


REF = re.compile(r"#\d+")


def same_work(a, b, min_similarity):
    """Two descriptions of the same work: similar wording, and no conflicting PR/issue numbers."""
    ra, rb = set(REF.findall(a or "")), set(REF.findall(b or ""))
    if ra and rb and not ra & rb:
        return False
    return similarity(a, b) >= min_similarity


def detect_overlaps(work, span_task, links, min_duration, window, min_similarity=0.6):
    """Duplicate effort: stretches where >= 2 actors do the same work on the same task node at
    once (their concurrent descriptions match; agents reviewing different PRs under one broad
    task don't count).

    Coordinated when every actor in the stretch has a communication link with another of them
    within `window` of the stretch.
    """
    per_node = defaultdict(lambda: defaultdict(list))
    for s in work:
        node = span_task.get(s["id"])
        if node is not None and s["end"] is not None:
            per_node[node][s["actor"]].append(s)
    out = []
    for node, actors in per_node.items():
        edges = []
        for actor, spans in actors.items():
            for start, end in merge_intervals([(s["start"], s["end"]) for s in spans]):
                edges += [(start, 1, actor), (end, -1, actor)]
        edges.sort(key=lambda e: (e[0], e[1]))
        active, segments, last_t = set(), [], None
        for t, delta, actor in edges:
            if last_t is not None and t > last_t and len(active) >= 2:
                if segments and segments[-1][2] == frozenset(active) and segments[-1][1] == last_t:
                    segments[-1][1] = t
                else:
                    segments.append([last_t, t, frozenset(active)])
            (active.add if delta > 0 else active.discard)(actor)
            last_t = t
        for start, end, group in segments:
            if end - start < min_duration:
                continue
            during = {a: [s["label"] for s in actors[a] if s["start"] < end and s["end"] > start] for a in group}
            members = sorted(group)
            if not any(same_work(x, y, min_similarity) for i, a in enumerate(members) for b in members[i + 1:]
                       for x in during[a] for y in during[b]):
                continue
            near = [(a, b) for a, b, t in links if a in group and b in group and start - window <= t <= end + window]
            talking = {x for pair in near for x in pair}
            out.append({"id": f"overlap:{node}:{start!r}", "task_id": node, "actors": sorted(group),
                        "start": start, "end": end, "coordinated": int(talking >= group)})
    return out


def wait_targets(waits):
    """Wait targets the source recorded (span.attrs.waiting_on)."""
    rows = []
    for s in waits:
        target = (s.get("attrs") or {}).get("waiting_on") or {}
        for kind in ("task", "actor", "external"):
            if target.get(kind):
                rows.append({"span_id": s["id"], "target_kind": kind,
                             "target_id": target[kind] if kind != "external" else None,
                             "target_text": target[kind] if kind == "external" else None,
                             "provenance": "source", "confidence": 1.0})
                break
    return rows


def compute_markers(store, episode_id, cfg=None, with_addressees=True):
    """Recompute loops, overlaps and source wait targets for an episode; returns counts.

    `with_addressees=False` skips rebuilding source/heuristic addressees (the live pipeline
    maintains them per message)."""
    cfg = cfg or load_config()
    members = store.episode_members(episode_id)
    unit = (members["manifest"] or {}).get("time_unit", "s")
    tree = TaskTree(members["tasks"], members["episode"]["root_task_id"])
    span_task = {r["span_id"]: tree.resolve(r["task_id"])
                 for r in store.annotations("span_task", "episode_id = ?", (episode_id,))}
    work = [s for s in members["spans"] if s["kind"] == "work"]
    waits = [s for s in members["spans"] if s["kind"] == "wait"]

    if with_addressees:
        store_addressees(store, members)
    links = communication_links(store, members)
    loops = detect_loops(work, span_task, cfg["loops"])
    overlaps = detect_overlaps(work, span_task, links, cfg["overlaps"]["min_duration"][unit],
                               cfg["overlaps"]["coordination_window"][unit], cfg["overlaps"].get("min_similarity", 0.6))
    eps = [episode_id]
    store.delete("loops", "episode_id = ?", (episode_id,), episode_ids=eps)
    store.upsert("loops", [{**lp, "episode_id": episode_id, "provenance": "heuristic"} for lp in loops], episode_ids=eps)
    store.delete("overlaps", "episode_id = ?", (episode_id,), episode_ids=eps)
    store.upsert("overlaps", [{**ov, "episode_id": episode_id, "provenance": "heuristic", "confidence": None}
                              for ov in overlaps], episode_ids=eps)
    store.upsert("waits", wait_targets(waits), episode_ids=eps)
    return {"loops": len(loops), "overlaps": len(overlaps),
            "uncoordinated": sum(1 for o in overlaps if not o["coordinated"]),
            "waits_with_target": len(wait_targets(waits)), "links": len(links)}
