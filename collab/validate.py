"""Check a set of trace records: schema validity plus referential integrity after upserts."""
from collections import defaultdict

from collab.schema import record_errors


def merge(records):
    """Apply put/patch upserts in order; returns {(record_type, id): merged record}."""
    state = {}
    for rec in records:
        key = (rec.get("record"), rec.get("id"))
        if rec.get("op") == "patch" and key in state:
            state[key] = {**state[key], **{k: v for k, v in rec.items() if k != "op"}}
        else:
            state[key] = {k: v for k, v in rec.items() if k != "op"}
    return state


def task_cycles(tasks):
    """Ids of tasks that sit on a parent_id cycle. `tasks` maps id -> task record."""
    on_cycle = set()
    for start in tasks:
        seen, node = [], start
        while node is not None and node in tasks and node not in seen:
            seen.append(node)
            node = tasks[node].get("parent_id")
        if node in seen:  # walked back into our own path
            on_cycle.update(seen[seen.index(node):])
    return on_cycle


def check(records):
    """Return a list of (level, record_type, id, message); level is 'error' or 'warning'."""
    issues = []
    records = list(records)
    for rec in records:
        for err in record_errors(rec):
            issues.append(("error", rec.get("record"), rec.get("id"), err))

    state = merge(records)
    by_type = defaultdict(dict)
    for (rtype, rid), rec in state.items():
        by_type[rtype][rid] = rec
    actors, channels, tasks = by_type["actor"], by_type["channel"], by_type["task"]
    spans, messages, episodes = by_type["span"], by_type["message"], by_type["episode"]

    def ref(level, rtype, rid, value, table, what):
        if value is not None and value not in table:
            issues.append((level, rtype, rid, f"{what} '{value}' does not exist"))

    if len(by_type["manifest"]) != 1:
        issues.append(("warning", "manifest", None, f"expected one manifest, found {len(by_type['manifest'])}"))

    for rid, t in tasks.items():
        ref("error", "task", rid, t.get("parent_id"), tasks, "parent task")
        for a in t.get("assignees") or []:
            ref("error", "task", rid, a, actors, "assignee")
    for rid in sorted(task_cycles(tasks)):
        issues.append(("error", "task", rid, "task is on a parent_id cycle"))

    for rid, ep in episodes.items():
        root = ep.get("root_task_id")
        ref("error", "episode", rid, root, tasks, "root task")
        ref("error", "episode", rid, ep.get("dataset_id"), by_type["manifest"], "dataset (manifest)")
        if root in tasks and tasks[root].get("parent_id") is not None:
            issues.append(("error", "episode", rid, f"root task '{root}' has a parent; a root must have none"))
        for a in ep.get("actors") or []:
            ref("error", "episode", rid, a, actors, "actor")
        for c in ep.get("channels") or []:
            ref("error", "episode", rid, c, channels, "channel")
        if ep.get("end") is not None and ep.get("start") is not None and ep["end"] < ep["start"]:
            issues.append(("error", "episode", rid, "end is before start"))

    for rid, m in messages.items():
        ref("error", "message", rid, m.get("sender"), actors, "sender")
        ref("error", "message", rid, m.get("channel_id"), channels, "channel")
        ref("error", "message", rid, m.get("episode_id"), episodes, "episode")
        for a in m.get("recipients") or []:
            ref("error", "message", rid, a, actors, "recipient")
        for r in m.get("reply_to") or []:
            ref("warning", "message", rid, r, messages, "reply_to message")

    for rid, s in spans.items():
        ref("error", "span", rid, s.get("actor"), actors, "actor")
        ref("error", "span", rid, s.get("parent_id"), spans, "parent span")
        ref("error", "span", rid, s.get("task_id"), tasks, "task")
        ref("error", "span", rid, s.get("episode_id"), episodes, "episode")
        if s.get("end") is not None and s.get("start") is not None and s["end"] < s["start"]:
            issues.append(("error", "span", rid, "end is before start"))
        waiting_on = (s.get("attrs") or {}).get("waiting_on") or {}
        ref("error", "span", rid, waiting_on.get("actor"), actors, "waiting_on actor")
        ref("error", "span", rid, waiting_on.get("task"), tasks, "waiting_on task")

    for rid, ev in by_type["event"].items():
        ref("error", "event", rid, ev.get("actor"), actors, "actor")
        ref("error", "event", rid, ev.get("episode_id"), episodes, "episode")

    # Untagged records are assigned to episodes by time window; flag when that is ambiguous.
    def window_hits(start, end, actor=None, channel=None):
        hits = []
        for ep_id, ep in episodes.items():
            ep_end = ep.get("end") if ep.get("end") is not None else float("inf")
            if start is None or start > ep_end or (end if end is not None else float("inf")) < ep.get("start", 0):
                continue
            if actor is not None and actor not in (ep.get("actors") or []):
                continue
            if channel is not None and ep.get("channels") and channel not in ep["channels"]:
                continue
            hits.append(ep_id)
        return hits

    for rtype, table in (("message", messages), ("span", spans), ("event", by_type["event"])):
        for rid, r in table.items():
            if r.get("episode_id"):
                continue
            if rtype == "span":
                hits = window_hits(r.get("start"), r.get("end"), actor=r.get("actor"))
            else:
                hits = window_hits(r.get("t"), r.get("t"), channel=r.get("channel_id"))
            if len(hits) > 1:
                issues.append(("warning", rtype, rid, f"no episode_id and matches several episodes {hits}"))
    return issues
