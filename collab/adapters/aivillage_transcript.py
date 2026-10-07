"""Interim AI Village adapter: the website-export transcript (village-transcript.json) -> records.

Used until Hugging Face access is approved; the HF adapter then supersedes it. It covers what
the transcript has: one chat channel (no rooms), computer sessions, waits, consolidations and
other events. Episodes (shared-goal periods) come from config/aivillage_episodes.yaml.
"""
import hashlib
import json
import re
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "data" / "village-transcript.json"
EPISODES_PATH = ROOT / "config" / "aivillage_episodes.yaml"

ORGANIZERS = {"adam", "zak", "Shoshannah", "admin", "george"}  # the AI Digest team
SYSTEM_SPEAKERS = {"automated"}
CHANNEL = "main"
DATASET = "aivillage"
WAIT_CAP = 30 * 60  # a WAIT lasts until the agent's next action, at most this long (seconds)
PAIR_WINDOW = 2  # WAIT/PAUSE are logged together with their "I'll wait" message; skip that pairing
EVENT_TYPES = {"SEARCH_HISTORY": "search_history", "REQUEST_HUMAN_HELPER": "request_human_helper",
               "CANCEL_REQUEST_FOR_HUMAN_HELPER": "cancel_request_human_helper", "CONSOLIDATE": "consolidate"}
DOMAIN_NOTES = ("Agents are frontier AI models in a shared group chat with human organizers and viewers. "
                "Work items are computer-use sessions described by the agent's stated goal; agents often "
                "narrate their own actions and post 'I'll wait' status messages. They coordinate through "
                "shared artifacts such as documents, GitHub pull requests and websites.")
FAMILIES = [("Claude", r"claude|opus|sonnet|haiku|fable"), ("GPT", r"gpt|^o\d"), ("Gemini", r"gemini"),
            ("Grok", r"grok"), ("DeepSeek", r"deepseek"), ("Kimi", r"kimi"), ("GLM", r"glm")]


def to_epoch(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "unknown"


def hashed(prefix, *parts):
    return prefix + hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:12]


def family(name):
    for fam, pattern in FAMILIES:
        if re.search(pattern, name, re.I):
            return fam
    return "Other"


def parse_duration(text):
    """'5 seconds' -> 5, '10 minutes' -> 600, '1 hour 30 minutes' -> 5400; unknown -> 0."""
    units = {"s": 1, "sec": 1, "second": 1, "m": 60, "min": 60, "minute": 60, "h": 3600, "hr": 3600, "hour": 3600}
    total = 0
    for n, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([a-z]+)", (text or "").lower()):
        total += float(n) * units.get(unit.rstrip("s") if unit not in units else unit, 0)
    return total


def load_episodes(path=EPISODES_PATH):
    return yaml.safe_load(Path(path).read_text())["episodes"]


def actor_record(name, is_user):
    if not is_user:
        return {"record": "actor", "id": slug(name), "name": name, "kind": "agent",
                "attrs": {"model": name, "family": family(name)}}
    if name in SYSTEM_SPEAKERS:
        return {"record": "actor", "id": slug(name), "name": name, "kind": "system", "role": "automated"}
    return {"record": "actor", "id": slug(name), "name": name, "kind": "human",
            "role": "organizer" if name in ORGANIZERS else "viewer"}


def day_spans(events):
    """Spans for one day: computer sessions and consolidation stretches (work), WAIT/PAUSE (wait)."""
    day_end = to_epoch(events[-1]["timestamp"])
    by_agent = defaultdict(list)
    for e in events:
        if e["type"] not in ("USER_TALK",):
            by_agent[e.get("agentName") or e.get("speakerName")].append(e)
    spans, seen = [], Counter()

    def add(agent, start, end, kind, label, attrs):
        key = (agent, start, kind)
        seen[key] += 1
        spans.append({"record": "span", "id": hashed("s-", agent, start, kind, seen[key]), "actor": slug(agent),
                      "start": start, "end": max(start, end), "kind": kind, "label": label or "", "attrs": attrs})

    for agent, evs in by_agent.items():
        times = [to_epoch(e["timestamp"]) for e in evs]
        has_sessions = any(e["type"] == "START_USING_COMPUTER" for e in evs)
        session = consolidating = None
        for i, (e, t) in enumerate(zip(evs, times)):
            j = bisect_right(times, t + PAIR_WINDOW, lo=i + 1)
            nxt = times[j] if j < len(times) else day_end
            typ = e["type"]
            if typ == "START_USING_COMPUTER":
                if session:
                    add(agent, session[0], t, "work", session[1], session[2])
                session = (t, e.get("goal"), {"source": "computer_session", "reasoning": e.get("thinking")})
            elif typ == "STOP_USING_COMPUTER" and session:
                add(agent, session[0], t, "work", session[1], session[2])
                session = None
            elif typ in ("WAIT", "PAUSE"):
                if consolidating:
                    add(agent, consolidating[0], t, "work", consolidating[1], consolidating[2])
                    consolidating = None
                cap = WAIT_CAP if typ == "WAIT" else parse_duration(e.get("duration"))
                add(agent, t, min(nxt, t + cap, day_end), "wait", typ.lower(),
                    {"source": typ, "duration": e.get("duration"), "reasoning": e.get("thinking")})
            elif typ == "CONSOLIDATE" and not has_sessions:
                if consolidating:
                    add(agent, consolidating[0], t, "work", consolidating[1], consolidating[2])
                consolidating = (t, e.get("goal"), {"source": "consolidate", "reasoning": e.get("thinking")})
        if session:
            add(agent, session[0], day_end, "work", session[1], session[2])
        if consolidating:
            add(agent, consolidating[0], max(times[-1], consolidating[0]), "work", consolidating[1], consolidating[2])
    for s in spans:
        s["attrs"] = {k: v for k, v in s["attrs"].items() if v is not None}
    return spans


def records(transcript_path=DEFAULT_PATH, episodes=None, days=None):
    """Yield neutral records for the selected days (default: every day inside a configured episode)."""
    episodes = load_episodes() if episodes is None else episodes
    wanted = set(days) if days else {d for ep in episodes for d in range(ep["days"][0], ep["days"][1] + 1)}
    transcript = json.load(open(transcript_path, encoding="utf-8"))
    selected = [d for d in transcript["days"] if d["day"] in wanted and d["events"]]

    actors = {}
    for d in selected:
        for e in d["events"]:
            name = e.get("speakerName") or e.get("agentName")
            actors.setdefault(name, actor_record(name, e["type"] == "USER_TALK"))

    village = transcript.get("village", {})
    yield {"record": "manifest", "id": DATASET, "name": f"AI Village ({village.get('name', 'transcript')})",
           "time_unit": "s", "display_tz": "America/Los_Angeles",
           "capabilities": {"spans": True, "action_spans": False, "reasoning": True, "channels": False,
                            "recipients": False, "reply_to": False, "task_tree": False},
           "attrs": {"source": "village-transcript.json", "village_id": village.get("id"),
                     "domain_notes": DOMAIN_NOTES,
                     "family_order": ["Gemini", "Claude", "GPT"]}}  # stable color slots across episodes
    yield {"record": "channel", "id": CHANNEL, "name": "Village chat"}
    yield from actors.values()

    bounds = {}  # day -> (first ts, last ts, agents active)
    for d in selected:
        events = d["events"]
        agents = {slug(e.get("agentName") or e.get("speakerName")) for e in events if e["type"] != "USER_TALK"}
        bounds[d["day"]] = (to_epoch(events[0]["timestamp"]), to_epoch(events[-1]["timestamp"]), agents)
        seen = Counter()
        for e in events:
            name = e.get("speakerName") or e.get("agentName")
            t = to_epoch(e["timestamp"])
            seen[(e["timestamp"], name, e["type"])] += 1
            ordinal = seen[(e["timestamp"], name, e["type"])]
            if e["type"] in ("AGENT_TALK", "USER_TALK"):
                msg = {"record": "message", "id": hashed("m-", e["timestamp"], name, e["type"], ordinal), "t": t,
                       "sender": slug(name), "channel_id": CHANNEL, "text": e.get("content") or ""}
                if e.get("thinking"):
                    msg["reasoning"] = e["thinking"]
                yield msg
            elif e["type"] in EVENT_TYPES:
                payload = {k: v for k, v in e.items() if k not in ("timestamp", "time", "type", "agentName")}
                yield {"record": "event", "id": hashed("e-", e["timestamp"], name, e["type"], ordinal), "t": t,
                       "actor": slug(name), "type": EVENT_TYPES[e["type"]], "payload": payload}
        yield from day_spans(events)

    for ep in episodes:
        days_in = [day for day in bounds if ep["days"][0] <= day <= ep["days"][1]]
        if not days_in:
            continue
        start = min(bounds[day][0] for day in days_in)
        end = max(bounds[day][1] for day in days_in)
        agents = sorted(set().union(*(bounds[day][2] for day in days_in)))
        root = f"{ep['id']}:goal"
        yield {"record": "task", "id": root, "name": ep["goal"], "scope": ep.get("scope", "shared"),
               "start": start, "end": end, "attrs": {"days": ep["days"]}}
        yield {"record": "episode", "id": ep["id"], "name": ep["goal"], "dataset_id": DATASET,
               "root_task_id": root, "start": start,
               "end": end, "actors": agents, "channels": [CHANNEL],
               "attrs": {"source": "aivillage", "days": ep["days"], "pilot": bool(ep.get("pilot"))}}
