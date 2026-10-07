"""Influence: who got whom to work, in the Tasks view's unit (work time).

For each (task, worker) pair - every task below the root with work attached directly - decide
what got the worker onto the task:
    asked     someone explicitly asked or assigned this worker
    proposed  someone proposed the task to the group and the worker took it up
    joined    the worker joined work someone else had already started
    self      the worker's own initiative
    none      a routine duty nobody in particular initiated
A's influence on B is B's time on the tasks A triggered for B, kept per `how` so the view can
filter. An LLM decides from candidate messages and cites them; a heuristic stands in while
streaming or when no model is available. Guards check every answer against the evidence.
"""
import bisect
from collections import Counter, defaultdict
from pathlib import Path

import yaml

from collab.acts import chunks, placeholders
from collab.cli import ROOT
from collab.mentions import task_regexes
from collab.tasks import fmt_time
from collab.tree import TaskTree

PROMPT_VERSION = "triggers-v1"
CONFIG_PATH = ROOT / "config" / "influence.yaml"
HOWS = ("asked", "proposed", "joined", "self", "none")
CREDITED = ("asked", "proposed", "joined")

SYSTEM = """You work out who got each agent working on a task, in a team of AI agents (and some
humans) collaborating through a group chat.

You see one task (with its place in the task tree), the agents who worked on it with when they
first started, and chat messages from around then. For each worker, decide what got them onto
this task:
- "asked": someone explicitly asked, assigned or invited this worker (by name, @-mention, or
  clearly addressing them) to do this task or this part of it.
- "proposed": someone proposed or announced this task to the group (not to this worker in
  particular) and the worker then took it up.
- "joined": the worker joined work someone else had already started on this task, without
  being asked and not in response to a proposal.
- "self": the worker started it on their own initiative, including offering to do it.
- "none": a routine or standing duty that nobody in particular initiated, such as a daily
  ritual or a rule the organizers set for everyone.

Rules:
- triggered_by is the person who asked or proposed, or for "joined" the worker who had already
  started; use "nobody" for "self" and "none".
- evidence: the aliases of the messages that show it (the ask, the proposal, the worker taking
  it up). Leave it empty if no message shows it.
- Someone offering to help is not asking. A worker who accepts an offer and hands over part of
  the work is asking the helper to do that part.
- Use only the evidence given. When the messages don't show who triggered a worker, answer
  "self" for the first worker and "joined" (triggered_by the earlier worker) for later ones."""


def load_config(path=CONFIG_PATH):
    return yaml.safe_load(Path(path).read_text())


def episode_context(store, episode_id):
    members = store.episode_members(episode_id)
    tree = TaskTree(members["tasks"], members["episode"]["root_task_id"])
    span_task = {r["span_id"]: tree.resolve(r["task_id"])
                 for r in store.annotations("span_task", "episode_id = ?", (episode_id,))}
    return members, tree, span_task


def work_pairs(tree, spans, span_task):
    """{(task, worker): {first, time, labels}} for closed work attached directly to non-root tasks."""
    out = {}
    for s in sorted(spans, key=lambda s: s["start"]):
        task = span_task.get(s["id"])
        if s["kind"] != "work" or task is None or task == tree.root_id or s["end"] is None:
            continue
        p = out.setdefault((task, s["actor"]), {"first": s["start"], "time": 0.0, "labels": []})
        p["time"] += s["end"] - s["start"]
        if s["label"] and s["label"] not in p["labels"]:
            p["labels"].append(s["label"])
    return out


def _snippet(text, at, width):
    text = " ".join((text or "").split())
    if len(text) <= width:
        return text
    start = max(0, min(at - width // 3, len(text) - width))
    return ("…" if start else "") + text[start:start + width] + ("…" if start + width < len(text) else "")


def candidates(store, episode_id, cfg=None):
    """Per task: its workers and the chat messages that could show who got them started.

    Returns (bundles, context). A bundle has the task, its path, its workers (by first start)
    and up to `max_candidates` messages that mention the task or address one of its workers,
    from `lookback` before the first worker started to `lookahead` after the last one did.
    """
    cfg = cfg or load_config()
    members, tree, span_task = episode_context(store, episode_id)
    unit = (members["manifest"] or {}).get("time_unit", "s")
    lookback, lookahead, cap = cfg["lookback"][unit], cfg["lookahead"][unit], cfg["max_candidates"]
    pairs = work_pairs(tree, members["spans"], span_task)
    messages = sorted(members["messages"], key=lambda m: (m["t"], m["id"]))
    times = [m["t"] for m in messages]
    to = defaultdict(set)
    for chunk in chunks([m["id"] for m in messages]):
        for r in store.annotations("addressees", f"message_id IN ({placeholders(chunk)})", chunk):
            to[r["message_id"]].add(r["actor_id"])
    regexes = task_regexes(tree)
    names = {a["id"]: a["name"] for a in members["actors"]}

    by_task = defaultdict(list)
    for (task, worker), p in pairs.items():
        by_task[task].append({"actor": worker, "name": names.get(worker, worker), **p})
    bundles = []
    for task, workers in by_task.items():
        workers.sort(key=lambda w: (w["first"], w["actor"]))
        lo = workers[0]["first"] - lookback
        hi = workers[-1]["first"] + lookahead
        ids = {w["actor"] for w in workers}
        rx = regexes.get(task)
        mention, addressed = [], []
        for m in messages[bisect.bisect_left(times, lo):bisect.bisect_right(times, hi)]:
            hit = rx.search(m["text"] or "") if rx else None
            if hit:
                mention.append((m, hit.start()))
            elif to[m["id"]] & ids:
                addressed.append((m, 0))
        if len(mention) > cap:  # keep how the task was raised and how it was taken up
            mention = mention[:cap // 2] + mention[-(cap - cap // 2):]
        chosen = mention + addressed[-max(0, cap - len(mention)):] if cap > len(mention) else mention
        chosen.sort(key=lambda x: (x[0]["t"], x[0]["id"]))
        msgs = [{"alias": f"m{i + 1}", "id": m["id"], "t": m["t"], "sender": m["sender"],
                 "sender_name": names.get(m["sender"], m["sender"]), "to": sorted(to[m["id"]]),
                 "mentions": (m, at) in mention, "text": _snippet(m["text"], at, cfg["snippet_chars"])}
                for i, (m, at) in enumerate(chosen)]
        bundles.append({"task_id": task, "task": tree.tasks[task],
                        "path": [tree.tasks[t]["name"] for t in tree.path(task)],
                        "workers": workers, "messages": msgs})
    bundles.sort(key=lambda b: b["workers"][0]["first"])
    return bundles, {"members": members, "tree": tree, "pairs": pairs, "names": names}


def trigger_prompt(bundle, manifest, names):
    unit = (manifest or {}).get("time_unit", "s")
    lines = [f"Team goal: {bundle['path'][0]}", f"Task: {' > '.join(bundle['path'][1:])}"]
    if bundle["task"].get("description"):
        lines.append(f"About this task: {bundle['task']['description']}")
    lines += ["", "Workers on this task (first session, time spent, what they said they were doing):"]
    for w in bundle["workers"]:
        span = f"{w['time']:g} steps" if unit == "step" else f"{w['time'] / 60:.0f} min"
        lines.append(f"- {w['name']}: first at {fmt_time(w['first'], manifest)}, {span}; e.g. "
                     + "; ".join(w["labels"][:3]))
    lines += ["", "Messages from around when they started (alias | time | sender -> addressed to | text):"]
    for m in bundle["messages"]:
        target = f" -> {', '.join(names.get(a, a) for a in m['to'])}" if m["to"] else ""
        lines.append(f"{m['alias']} | {fmt_time(m['t'], manifest)} | {m['sender_name']}{target} | {m['text']}")
    if not bundle["messages"]:
        lines.append("(no messages mention this task in that period)")
    notes = ((manifest or {}).get("attrs") or {}).get("domain_notes")
    if notes:
        lines += ["", f"Notes about this data source: {notes}"]
    return "\n".join(lines)


def people(bundle):
    """Names the model may use for triggered_by: workers and message senders."""
    out = {w["name"]: w["actor"] for w in bundle["workers"]}
    for m in bundle["messages"]:
        out.setdefault(m["sender_name"], m["sender"])
    return out


def trigger_schema(bundle):
    names = sorted(people(bundle)) + ["nobody"]
    aliases = [m["alias"] for m in bundle["messages"]]
    evidence_item = {"type": "string", "enum": aliases} if aliases else {"type": "string"}
    return {
        "type": "object",
        "properties": {"workers": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "worker": {"type": "string", "enum": [w["name"] for w in bundle["workers"]]},
                "how": {"type": "string", "enum": list(HOWS)},
                "triggered_by": {"type": "string", "enum": names},
                "evidence": {"type": "array", "items": evidence_item},
                "note": {"type": "string"},
            },
            "required": ["worker", "how", "triggered_by", "evidence", "note"],
            "additionalProperties": False,
        }}},
        "required": ["workers"],
        "additionalProperties": False,
    }


def _earliest_other(bundle, worker, first):
    earlier = [w for w in bundle["workers"] if w["actor"] != worker and w["first"] < first]
    return min(earlier, key=lambda w: w["first"])["actor"] if earlier else None


def guard(bundle, answer):
    """Check a model answer against the evidence: {worker id: trigger dict} for valid entries."""
    who = people(bundle)
    first = {w["actor"]: w["first"] for w in bundle["workers"]}
    by_alias = {m["alias"]: m for m in bundle["messages"]}
    out = {}
    for item in answer.get("workers") or []:
        worker = who.get(item.get("worker"))
        if worker not in first or worker in out:
            continue
        how = item.get("how") if item.get("how") in HOWS else "self"
        by = who.get(item.get("triggered_by"))
        evidence = [by_alias[a] for a in item.get("evidence") or [] if a in by_alias]
        if how in ("asked", "proposed") and (by in (None, worker) or not any(m["sender"] == by for m in evidence)):
            by = _earliest_other(bundle, worker, first[worker])  # the claim isn't backed by a message from them
            how = "joined" if by else "self"
        if how == "joined" and (by in (None, worker) or first.get(by, float("inf")) >= first[worker]):
            by = _earliest_other(bundle, worker, first[worker])
            how = "joined" if by else "self"
        if how in ("self", "none"):
            by = None
        out[worker] = {"by": by, "how": how, "evidence": [m["id"] for m in evidence], "note": item.get("note") or ""}
    return out


def heuristic(bundle):
    """Asked: the latest message to the worker about the task before they started; proposed: the
    earliest mention by someone else; joined: someone else started first; otherwise self."""
    out = {}
    for w in bundle["workers"]:
        before = [m for m in bundle["messages"] if m["t"] <= w["first"] and m["sender"] != w["actor"] and m["mentions"]]
        asked = [m for m in before if w["actor"] in m["to"]]
        if asked:
            out[w["actor"]] = {"by": asked[-1]["sender"], "how": "asked", "evidence": [asked[-1]["id"]], "note": ""}
        elif before:
            out[w["actor"]] = {"by": before[0]["sender"], "how": "proposed", "evidence": [before[0]["id"]], "note": ""}
        else:
            by = _earliest_other(bundle, w["actor"], w["first"])
            out[w["actor"]] = {"by": by, "how": "joined" if by else "self", "evidence": [], "note": ""}
    return out


def infer_triggers(store, llm, episode_id, cfg=None, batch=False, progress=print):
    """Decide the trigger of every (task, worker) pair and store them; returns counts by `how`.

    With llm=None the heuristic decides everything (provenance 'heuristic')."""
    cfg = cfg or load_config()
    bundles, ctx = candidates(store, episode_id, cfg)
    manifest = ctx["members"]["manifest"]
    answers = {}
    if llm is not None and bundles:
        requests = {b["task_id"]: (trigger_prompt(b, manifest, ctx["names"]), trigger_schema(b)) for b in bundles}
        answers = llm.json_many(PROMPT_VERSION, SYSTEM, requests, effort=cfg["effort"], batch=batch, progress=progress)
    rows = []
    for b in bundles:
        decided = guard(b, answers[b["task_id"]]) if b["task_id"] in answers else {}
        fallback = heuristic(b)
        for w in b["workers"]:
            t = decided.get(w["actor"])
            provenance = "llm" if t else "heuristic"
            t = t or fallback[w["actor"]]
            rows.append({"episode_id": episode_id, "task_id": b["task_id"], "worker": w["actor"],
                         "triggered_by": t["by"], "how": t["how"], "evidence": t["evidence"],
                         "provenance": provenance, "confidence": None, "note": t["note"]})
    store.delete("triggers", "episode_id = ?", (episode_id,), episode_ids=[episode_id])
    store.upsert("triggers", rows, episode_ids=[episode_id])
    return dict(Counter(r["how"] for r in rows))


def compute_influence(store, episode_id):
    """Aggregate triggers into edges (src, dst, how) weighted by the worker's time; returns a summary."""
    members, tree, span_task = episode_context(store, episode_id)
    pairs = work_pairs(tree, members["spans"], span_task)
    edges = defaultdict(lambda: {"effort": 0.0, "tasks": set()})
    for r in store.annotations("triggers", "episode_id = ?", (episode_id,)):
        if r["how"] not in CREDITED or not r["triggered_by"] or r["triggered_by"] == r["worker"]:
            continue
        task = tree.resolve(r["task_id"])
        p = pairs.get((task, r["worker"]))
        if p is None:
            continue
        e = edges[(r["triggered_by"], r["worker"], r["how"])]
        e["effort"] += p["time"]
        e["tasks"].add(task)
    rows = [{"episode_id": episode_id, "src": src, "dst": dst, "how": how, "effort": e["effort"],
             "n_tasks": len(e["tasks"]), "tasks": sorted(e["tasks"])} for (src, dst, how), e in edges.items()]
    store.delete("influence", "episode_id = ?", (episode_id,), episode_ids=[episode_id])
    store.upsert("influence", rows, episode_ids=[episode_id])
    return {"edges": len({(r["src"], r["dst"]) for r in rows}), "rows": len(rows),
            "effort": sum(r["effort"] for r in rows)}
