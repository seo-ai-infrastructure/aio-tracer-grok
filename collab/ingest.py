"""Apply neutral records to the store and derive what every record needs (sentences)."""
from collab.sentences import index_messages


def ingest(store, records, log=False):
    """Upsert records, fill implicit episode dataset_id, split new messages into sentences.

    Returns counts per record type plus the number of sentence rows written.
    """
    records = list(records)
    manifests = {r["id"] for r in records if r["record"] == "manifest"}
    for r in records:  # a trace with one manifest may leave episodes' dataset_id implicit
        if r["record"] == "episode" and not r.get("dataset_id") and len(manifests) == 1:
            r["dataset_id"] = next(iter(manifests))
    store.apply_many(records, log=log)
    messages = [store.get("message", r["id"]) for r in records if r["record"] == "message"]
    counts = {}
    for r in records:
        counts[r["record"]] = counts.get(r["record"], 0) + 1
    counts["sentence"] = index_messages(store, messages, log=log)
    return counts
