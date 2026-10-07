"""Who addresses whom, and (from M3) speech acts and links between sentences.

Addressees come from the source when it records recipients; otherwise from explicit
@-mentions and a leading vocative ("Name, ..." / "Name: ...") as a heuristic. The LLM
annotation pass adds its own rows later with provenance 'llm'.
"""
import re


def alias_pattern(actors):
    """Regex alternation of actor names, longest first; returns (pattern, alias -> actor id)."""
    alias = {}
    for a in actors:
        for name in {a["name"], a["id"]}:
            alias.setdefault(name.lower(), a["id"])
    names = sorted(alias, key=len, reverse=True)
    body = "|".join(re.escape(n) for n in names)
    return body, alias


def mention_addressees(messages, actors):
    """Heuristic addressee rows from @mentions and leading vocatives."""
    if not actors:
        return []
    body, alias = alias_pattern(actors)
    tail = r"(?![\w])(?!\.\d)"  # "GPT-5" must not match inside "GPT-5.2"
    at = re.compile(r"@(" + body + ")" + tail, re.I)
    vocative = re.compile(r"^\s*(?:hi |hey |thanks,? |thank you,? )?(" + body + r")\s*[,:]", re.I)
    rows = []
    for m in messages:
        text = m.get("text") or ""
        found = {alias[x.lower()]: 0.9 for x in at.findall(text)}
        for x in vocative.findall(text):
            found.setdefault(alias[x.lower()], 0.7)
        found.pop(m["sender"], None)
        rows += [{"message_id": m["id"], "actor_id": a, "provenance": "heuristic", "confidence": c}
                 for a, c in found.items()]
    return rows


def addressees_for(message, actors, caps):
    """Addressee rows for one message (source recipients, or the mention heuristic)."""
    if caps.get("recipients"):
        return source_addressees([message])
    return mention_addressees([message], [a for a in actors if a["kind"] == "agent"])


def source_addressees(messages):
    return [{"message_id": m["id"], "actor_id": a, "provenance": "source", "confidence": 1.0}
            for m in messages for a in (m.get("recipients") or [])]


def store_addressees(store, members):
    """Write source or heuristic addressees for an episode's messages; returns the rows."""
    caps = (members["manifest"] or {}).get("capabilities") or {}
    messages = members["messages"]
    rows = source_addressees(messages) if caps.get("recipients") else \
        mention_addressees(messages, [a for a in members["actors"] if a["kind"] == "agent"])
    for chunk in chunks([m["id"] for m in messages]):
        store.delete("addressees", f"provenance IN ('source', 'heuristic') AND message_id IN "
                                   f"({placeholders(chunk)})", chunk, log=False)
    store.upsert("addressees", rows, episode_ids=[members["episode"]["id"]])
    return rows


def chunks(xs, n=500):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def placeholders(xs):
    return ", ".join("?" for _ in xs)


def communication_links(store, members):
    """Unordered (actor_a, actor_b, t) contacts: addressed messages, replies and act links."""
    messages = {m["id"]: m for m in members["messages"]}
    links, sentence_message = [], {}
    for chunk in chunks(list(messages)):
        for row in store.annotations("addressees", f"message_id IN ({placeholders(chunk)})", chunk):
            m = messages[row["message_id"]]
            links.append((m["sender"], row["actor_id"], m["t"]))
        for row in store.annotations("sentences", f"message_id IN ({placeholders(chunk)})", chunk):
            sentence_message[row["id"]] = row["message_id"]
    for chunk in chunks(list(sentence_message)):
        for row in store.annotations("act_links", f"src_id IN ({placeholders(chunk)})", chunk):
            src = messages.get(sentence_message.get(row["src_id"]))
            dst = messages.get(sentence_message.get(row["dst_id"]))
            if src and dst:
                links.append((src["sender"], dst["sender"], src["t"]))
    for m in messages.values():
        for r in m.get("reply_to") or []:
            if r in messages:
                links.append((m["sender"], messages[r]["sender"], m["t"]))
    return [(a, b, t) for a, b, t in links if a != b]
