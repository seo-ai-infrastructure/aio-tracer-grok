"""Speech acts: what each sentence does (asks, commits, reports, ...) and which earlier sentence
it responds to.

One structured call labels a window of consecutive messages. Every sentence gets one or more acts
and may link to the earlier sentence it responds to: one in the window, in the messages just before
it, or one of the speaker's recent commitments, so a report can "fulfill" a promise made hours
earlier. Windows don't depend on each other, so they run concurrently or as one batch, and answers
are cached. A rule-based labeler stands in while streaming, for anything the model skips, and when
there's no model.
"""
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

from collab.acts import chunks, placeholders

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "acts.yaml"
PROMPT_VERSION = "acts-v3"

ACTS = ("inform", "narrate", "wait", "question", "answer", "request", "propose", "commit", "accept", "reject",
        "thank", "correct", "social")
RELATIONS = ("answers", "accepts", "rejects", "commits_to", "fulfills", "updates", "acknowledges", "corrects", "elaborates")
TO_OTHERS = {"answers", "accepts", "rejects", "commits_to", "acknowledges"}  # responses to someone else
FORWARD = {"commit", "propose", "request", "question", "wait"}  # a sentence with these acts reports nothing done yet

SYSTEM = """You label speech acts in a group chat where AI agents (and some humans) work toward a shared goal.

Give every sentence marked s1, s2, ... one or more acts:
- inform: states facts, status or results, including summaries of work it did ("The doc lists 12 charities.", "I researched GiveWell's top picks.")
- narrate: describes its own low-level actions on screen, as it does them or just did them ("I'll click Share.", "I see the login page.", "I closed the cookie banner.")
- wait: says it is waiting, pausing or idle ("I'll wait for Claude's update.")
- question: asks for information
- answer: gives information that someone asked for
- request: asks someone to do something, including "can you ...?" and instructions
- propose: suggests a plan, idea or course of action to the group
- commit: promises or volunteers to do a piece of work beyond its next click ("I'll write the summary.", "I can handle outreach.")
- accept: agrees to a request or proposal
- reject: declines or disagrees with a request, proposal or claim
- thank: thanks, praises or acknowledges ("Great work!", "Got it.")
- correct: corrects an earlier statement, its own or someone else's
- social: greetings, jokes, chit-chat, reactions
Narrating the next click or page is "narrate", not "commit". Give two acts only when a sentence clearly does both.

Then link sentences to the earlier sentence they respond to, when the connection is clear:
- answers: an answer to a question (or to a request for information)
- accepts / rejects: agreeing to or declining a request or proposal
- commits_to: a commitment made in response to a request or proposal
- fulfills: reports that the very thing an earlier commitment or request asked for is now done; link to that
  commitment or request. Attempts, partial progress, failures and work on something else are not fulfillments,
  and a promise, plan or intention never is.
- updates: reports progress, an attempt or a problem on an earlier commitment or request, without finishing it
- acknowledges: thanks or acknowledges something said or done
- corrects: corrects the earlier sentence
- elaborates: adds detail to the speaker's own earlier sentence
Answers, accepts, rejects, commits_to and acknowledges respond to someone else; elaborates adds to the
speaker's own earlier sentence. A link goes from an s-sentence to an earlier s-sentence, a c-sentence
(earlier chat) or a k-item (an earlier commitment; they were picked by a rough rule, so ignore any that
promise nothing). Most sentences have no link; when unsure, leave it out. Use only the ids shown."""

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["labels", "links"],
    "properties": {
        "labels": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["s", "acts"],
            "properties": {"s": {"type": "string"}, "acts": {"type": "array", "items": {"type": "string", "enum": list(ACTS)}}}}},
        "links": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["from", "to", "relation"],
            "properties": {"from": {"type": "string"}, "to": {"type": "string"},
                           "relation": {"type": "string", "enum": list(RELATIONS)}}}},
    },
}

# Rules for the stand-in labeler and for picking candidate commitments.
FIRST_PERSON_FUTURE = re.compile(r"\b(?:I(?:'ll| will(?! not)|'m going to| am going to| can(?!'t|not|’t))|let me(?! know))\b", re.I)
SCREEN = re.compile(r"\b(?:click|scroll|typ(?:e|ing)|press|navigat|open(?:ing)?\b|tab\b|screenshot|cursor|button|zoom"
                    r"|refresh|reload|log(?:ging)? ?in|sign(?:ing)? ?in|the page|I (?:can )?see)", re.I)
WAITING = re.compile(r"\b(?:wait(?:ing)?|paus(?:e|ing)|standing by|idle)\b", re.I)
THANKS = re.compile(r"\b(?:thanks|thank you|great (?:job|work)|well done|nice work|appreciate|got it)\b", re.I)
ASKING = re.compile(r"^(?:\S+[,:]\s*)?(?:@\S+\s+)?(?:can|could|would|will) you\b|\bplease\b|\blet (?:me|us) know\b", re.I)
GREETING = re.compile(r"^(?:hi|hey|hello|welcome|good (?:morning|afternoon|evening)|haha|lol|wow)\b", re.I)


def load_config(path=CONFIG_PATH):
    with open(path) as f:
        return yaml.safe_load(f)


def heuristic_acts(text, is_agent):
    """Rule-based acts for one sentence (stand-in for the model)."""
    t = text.strip()
    if WAITING.search(t) and FIRST_PERSON_FUTURE.search(t):
        return ["wait"]
    if t.endswith("?"):
        return ["request"] if ASKING.search(t) else ["question"]
    if THANKS.search(t):
        return ["thank"]
    if ASKING.search(t) or re.match(r"(?i)let's\b", t):
        return ["request"] if ASKING.search(t) else ["propose"]
    if is_agent and FIRST_PERSON_FUTURE.search(t):
        return ["narrate"] if SCREEN.search(t) else ["commit"]
    if is_agent and SCREEN.search(t):
        return ["narrate"]
    if GREETING.search(t):
        return ["social"]
    return ["inform"]


def looks_like_commitment(text):
    return bool(FIRST_PERSON_FUTURE.search(text)) and not SCREEN.search(text) and not text.strip().endswith("?")


def sentence_texts(store, messages):
    """message id -> [(sentence id, text)] in order."""
    text = {m["id"]: m.get("text") or "" for m in messages}
    rows = {m["id"]: [] for m in messages}
    for chunk in chunks(list(rows)):
        for r in store.annotations("sentences", f"message_id IN ({placeholders(chunk)})", chunk):
            rows[r["message_id"]].append((r["idx"], r["id"], text[r["message_id"]][r["start_char"]:r["end_char"]].strip()))
    return {mid: [(sid, s) for _, sid, s in sorted(rs)] for mid, rs in rows.items()}


def addressed(store, messages):
    """message id -> addressees: recipients the source recorded, plus @mentions and vocatives."""
    out = {m["id"]: list(m.get("recipients") or []) for m in messages}
    ids = [m["id"] for m in messages]
    for chunk in chunks(ids):
        for r in store.annotations("addressees", f"message_id IN ({placeholders(chunk)})", chunk):
            if r["actor_id"] not in out[r["message_id"]]:
                out[r["message_id"]].append(r["actor_id"])
    return out


def first_days(messages, n, tz):
    """Messages on the first n calendar days that have any (in the display time zone)."""
    zone = ZoneInfo(tz or "UTC")
    days = []
    out = []
    for m in messages:
        d = datetime.fromtimestamp(m["t"], zone).date()
        if d not in days:
            if len(days) == n:
                break
            days.append(d)
        out.append(m)
    return out


class Episode:
    """What the windows and prompts need from the store."""

    def __init__(self, store, episode_id, cfg, days=None):
        members = store.episode_members(episode_id)
        self.cfg = cfg
        manifest = members["manifest"] or {}
        self.unit = manifest.get("time_unit") or "s"
        self.tz = ZoneInfo(manifest.get("display_tz") or "UTC")
        self.messages = members["messages"]
        self.index = {m["id"]: i for i, m in enumerate(self.messages)}
        self.sentences = sentence_texts(store, self.messages)
        self.to = addressed(store, self.messages)
        self.actors = {a["id"]: a for a in members["actors"]}
        root = store.get("task", members["episode"]["root_task_id"]) if members["episode"].get("root_task_id") else None
        self.goal = (root or {}).get("name") or members["episode"].get("name") or ""
        if days and self.unit != "s":
            raise ValueError("--days needs clock time; this source counts steps")
        labeled = first_days(self.messages, days, manifest.get("display_tz")) if days else self.messages
        self.to_label = [m for m in labeled if self.sentences[m["id"]]]

    def name(self, actor_id):
        a = self.actors.get(actor_id)
        return a["name"] if a else actor_id

    def who(self, actor_id):
        a = self.actors.get(actor_id)
        role = "agent" if a and a["kind"] == "agent" else ((a or {}).get("role") or (a or {}).get("kind") or "unknown")
        return f"{self.name(actor_id)} ({role})"

    def stamp(self, t):
        if self.unit != "s":
            return f"step {t:g}"
        return datetime.fromtimestamp(t, self.tz).strftime("%a %H:%M")

    def is_agent(self, actor_id):
        return (self.actors.get(actor_id) or {}).get("kind") == "agent"


def windows(ep):
    """Consecutive batches of messages to label, each with the context and commitments it may link to."""
    cfg = ep.cfg
    horizon = cfg["horizon"][ep.unit]
    out = []
    for w0 in range(0, len(ep.to_label), cfg["window"]):
        batch = ep.to_label[w0:w0 + cfg["window"]]
        first = ep.index[batch[0]["id"]]
        context = [m for m in ep.messages[max(0, first - cfg["context"]):first] if ep.sentences[m["id"]]]
        seen = {m["id"] for m in context}
        commitments = []
        for speaker in dict.fromkeys(m["sender"] for m in batch):
            found = []
            for m in reversed(ep.messages[:first]):
                if batch[0]["t"] - m["t"] > horizon or len(found) >= cfg["commitments"]:
                    break
                if m["sender"] != speaker or m["id"] in seen:
                    continue
                found += [(m, sid, text) for sid, text in reversed(ep.sentences[m["id"]]) if looks_like_commitment(text)]
            commitments += found[:cfg["commitments"]]
        commitments.sort(key=lambda c: (ep.index[c[0]["id"]], c[1]))
        out.append({"messages": batch, "context": context, "commitments": commitments})
    return out


def clip(text, n):
    text = " ".join(text.split())
    return text if len(text) <= n else text[:n].rstrip() + "…"


def window_prompt(ep, win):
    """The prompt for one window, alias -> sentence id maps for labeled sentences and link targets, and
    each sentence's position and speaker (for the guard)."""
    cfg = ep.cfg
    labeled, targets, order, speaker = {}, {}, {}, {}

    def head(m):
        to = [ep.name(a) for a in ep.to.get(m["id"], []) if a != m["sender"]]
        return f"[{ep.stamp(m['t'])}] {ep.who(m['sender'])}{' → ' + ', '.join(to) if to else ''}:"

    lines = [f"Goal: {ep.goal}", ""]
    if win["commitments"]:
        lines.append("Earlier commitments by people in the messages below (a later sentence may fulfill one):")
        for i, (m, sid, text) in enumerate(win["commitments"], 1):
            targets[f"k{i}"] = sid
            lines.append(f"  k{i} [{ep.stamp(m['t'])}] {ep.name(m['sender'])}: {clip(text, cfg['sentence_chars'])}")
        lines.append("")
    if win["context"]:
        lines.append("Earlier messages (context: link to them, don't label them):")
        n = 0
        for m in win["context"]:
            lines.append(head(m))
            budget = cfg["context_chars"]
            for sid, text in ep.sentences[m["id"]]:
                if budget <= 0:
                    lines.append("  …")
                    break
                n += 1
                targets[f"c{n}"] = sid
                lines.append(f"  c{n} {clip(text, budget)}")
                budget -= len(text)
        lines.append("")
    lines.append("Messages to label:")
    n = 0
    for m in win["messages"]:
        lines.append(head(m))
        for sid, text in ep.sentences[m["id"]]:
            n += 1
            labeled[f"s{n}"] = sid
            lines.append(f"  s{n} {clip(text, cfg['sentence_chars'])}")
    targets.update(labeled)
    for m in [c[0] for c in win["commitments"]] + win["context"] + win["messages"]:
        for k, (sid, _) in enumerate(ep.sentences[m["id"]]):
            order[sid] = (ep.index[m["id"]], k)
            speaker[sid] = m["sender"]
    return {"text": "\n".join(lines), "labeled": labeled, "targets": targets, "order": order, "speaker": speaker}


def guard(prompt, answer):
    """Keep what the evidence allows: known sentences and acts; links to something earlier, responses to
    someone else, elaborations of one's own words, and fulfillments that report something done."""
    labeled, targets, order, speaker = prompt["labeled"], prompt["targets"], prompt["order"], prompt["speaker"]
    acts = {}
    for item in answer.get("labels") or []:
        sid = labeled.get(item.get("s"))
        kinds = [a for a in dict.fromkeys(item.get("acts") or []) if a in ACTS]
        if sid and kinds and sid not in acts:
            acts[sid] = kinds
    links = []
    for item in answer.get("links") or []:
        src, dst, rel = labeled.get(item.get("from")), targets.get(item.get("to")), item.get("relation")
        if not (src and dst and rel in RELATIONS and order[dst] < order[src]) or (src, dst, rel) in links:
            continue
        same = speaker[src] == speaker[dst]
        if (rel in TO_OTHERS and same) or (rel == "elaborates" and not same):
            continue
        if rel in ("fulfills", "updates") and FORWARD & set(acts.get(src, [])):
            continue
        links.append((src, dst, rel))
    return acts, links


def infer_acts(store, llm, episode_id, cfg=None, days=None, batch=False, progress=print):
    """Label the episode's sentences (or those on its first `days` days); returns a summary."""
    cfg = cfg or load_config()
    ep = Episode(store, episode_id, cfg, days)
    prompts = {f"w{i:04d}": window_prompt(ep, win) for i, win in enumerate(windows(ep))}
    answers = {}
    if llm is not None and prompts:
        requests = {k: (p["text"], SCHEMA) for k, p in prompts.items()}
        progress(f"{len(requests)} windows of up to {cfg['window']} messages")
        answers = llm.json_many(PROMPT_VERSION, SYSTEM, requests, effort=cfg["effort"], batch=batch, progress=progress)
    text = {sid: (s, m["sender"]) for m in ep.to_label for sid, s in ep.sentences[m["id"]]}
    act_rows, link_rows, fallback = [], [], 0
    for key, prompt in prompts.items():
        acts, links = guard(prompt, answers[key]) if key in answers else ({}, [])
        for sid in prompt["labeled"].values():
            kinds, provenance = acts.get(sid), "llm"
            if not kinds:
                s, sender = text[sid]
                kinds, provenance = heuristic_acts(s, ep.is_agent(sender)), "heuristic"
                fallback += 1
            act_rows += [{"sentence_id": sid, "act": a, "provenance": provenance, "confidence": None} for a in kinds]
        link_rows += [{"src_id": s, "dst_id": d, "relation": r, "provenance": "llm", "confidence": None} for s, d, r in links]
    ids = [sid for p in prompts.values() for sid in p["labeled"].values()]
    for chunk in chunks(ids):
        store.delete("acts", f"sentence_id IN ({placeholders(chunk)})", chunk, episode_ids=[episode_id])
        store.delete("act_links", f"src_id IN ({placeholders(chunk)})", chunk, episode_ids=[episode_id])
    store.upsert("acts", act_rows, episode_ids=[episode_id])
    store.upsert("act_links", link_rows, episode_ids=[episode_id])
    return {"windows": len(prompts), "messages": len(ep.to_label), "sentences": len(ids), "fallback": fallback,
            "acts": Counter(r["act"] for r in act_rows), "links": Counter(r["relation"] for r in link_rows)}


def heuristic_message_acts(row, sentences, is_agent):
    """Stand-in rows for one streamed message: [{sentence_id, act, provenance, confidence}]."""
    text = row.get("text") or ""
    return [{"sentence_id": s["id"], "act": a, "provenance": "heuristic", "confidence": None}
            for s in sentences for a in heuristic_acts(text[s["start_char"]:s["end_char"]], is_agent)]
