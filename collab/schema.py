"""Neutral trace format: record types, enums, and JSON-schema validation of single records.

A trace is NDJSON: one record per line. The `record` field names the record type (`kind` is
taken by actor and span kinds). Records are upserts by (record, id); `op: "patch"` updates
only the fields given, so a stream can open a span and close it later.
"""
import json
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schema" / "trace.schema.json"

RECORD_TYPES = ("manifest", "actor", "channel", "task", "episode", "message", "span", "event")
ACTOR_KINDS = ("agent", "human", "system")
SPAN_KINDS = ("work", "wait", "action", "other")
TASK_STATUSES = ("done", "abandoned", "blocked", "ongoing")
PROVENANCE = ("source", "llm", "heuristic", "human")

# Fields each record type carries (besides record/op/id), in storage order.
FIELDS = {
    "manifest": ["name", "time_unit", "display_tz", "capabilities", "attrs"],
    "actor": ["name", "kind", "role", "attrs"],
    "channel": ["name", "attrs"],
    "task": ["name", "description", "parent_id", "scope", "assignees", "start", "end", "status", "attrs"],
    "episode": ["name", "dataset_id", "root_task_id", "start", "end", "actors", "channels", "attrs"],
    "message": ["t", "sender", "channel_id", "recipients", "reply_to", "text", "reasoning", "episode_id", "attrs"],
    "span": ["actor", "start", "end", "kind", "label", "parent_id", "task_id", "episode_id", "attrs"],
    "event": ["t", "actor", "type", "payload", "episode_id"],
}


@lru_cache(maxsize=1)
def validator():
    return Draft202012Validator(json.loads(SCHEMA_PATH.read_text()))


def record_errors(rec):
    """Schema problems for one record as readable strings; empty if the record is valid."""
    errors = []
    for e in validator().iter_errors(rec):
        # if/then/else wrappers produce a generic top-level error; report the specific ones instead
        leaves = [c for c in e.context] if e.context else [e]
        for leaf in leaves:
            where = "/".join(map(str, leaf.absolute_path)) or "<record>"
            errors.append(f"{where}: {leaf.message}")
    return errors
