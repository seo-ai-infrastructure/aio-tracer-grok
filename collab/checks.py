"""Fingerprints of an episode's records and derived tables, for the replay invariant:
replaying a source through the live pipeline must end in the same state as a static build."""
import hashlib
import json

from collab.acts import chunks, placeholders

DERIVED = ("sentences", "span_task", "sentence_task", "acts", "act_links", "addressees", "waits", "loops",
           "overlaps", "triggers", "influence", "metrics")


def _digest(rows):
    blob = json.dumps(sorted(json.dumps(r, sort_keys=True) for r in rows))
    return hashlib.sha256(blob.encode()).hexdigest()[:16], len(rows)


def episode_fingerprint(store, episode_id):
    """{table: (digest, row count)} over the episode's core records and annotations."""
    m = store.episode_members(episode_id)
    out = {k: _digest(m[k]) for k in ("actors", "channels", "tasks", "messages", "spans", "events")}
    out["episode"] = _digest([m["episode"]])
    message_ids = [x["id"] for x in m["messages"]]
    span_ids = [x["id"] for x in m["spans"]]

    def rows(table, column, ids):
        acc = []
        for chunk in chunks(ids):
            acc += store.annotations(table, f"{column} IN ({placeholders(chunk)})", chunk)
        return acc

    sentences = rows("sentences", "message_id", message_ids)
    sentence_ids = [s["id"] for s in sentences]
    out["sentences"] = _digest(sentences)
    out["acts"] = _digest(rows("acts", "sentence_id", sentence_ids))
    out["act_links"] = _digest(rows("act_links", "src_id", sentence_ids))
    out["addressees"] = _digest(rows("addressees", "message_id", message_ids))
    out["waits"] = _digest(rows("waits", "span_id", span_ids))
    for table in ("span_task", "sentence_task", "loops", "overlaps", "triggers", "influence", "metrics"):
        out[table] = _digest(store.annotations(table, "episode_id = ?", (episode_id,)))
    return out


def compare(a, b):
    """Tables whose fingerprints differ: {table: (a, b)}."""
    return {k: (a.get(k), b.get(k)) for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)}
