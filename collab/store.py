"""SQLite store for trace records, pipeline annotations, and the delta log used for streaming.

Core tables mirror the record types in collab/schema.py. Annotation tables hold pipeline
output, each row tagged with provenance (source/llm/heuristic/human) and confidence. Every
change is appended to `deltas`, which the server replays to subscribers from any `seq`.
"""
import json
import sqlite3
import threading
import time

from collab.schema import FIELDS

CORE_TABLES = {
    "manifest": "manifest", "actor": "actors", "channel": "channels", "task": "tasks",
    "episode": "episodes", "message": "messages", "span": "spans", "event": "events",
}
# Pipeline-only columns on core tables (not part of the interchange format).
EXTRA_COLUMNS = {"task": ["provenance", "confidence", "merged_into"]}
JSON_COLUMNS = {"capabilities", "attrs", "assignees", "actors", "channels", "recipients", "reply_to",
                "payload", "span_ids", "evidence", "series", "tasks"}

ANNOTATION_DDL = """
CREATE TABLE IF NOT EXISTS sentences (id TEXT PRIMARY KEY, message_id TEXT, idx INTEGER,
    start_char INTEGER, end_char INTEGER, text TEXT);
CREATE INDEX IF NOT EXISTS sentences_message ON sentences(message_id);
CREATE TABLE IF NOT EXISTS span_task (episode_id TEXT, span_id TEXT, task_id TEXT, provenance TEXT,
    confidence REAL, PRIMARY KEY (episode_id, span_id));
CREATE TABLE IF NOT EXISTS sentence_task (episode_id TEXT, sentence_id TEXT, task_id TEXT, provenance TEXT,
    confidence REAL, PRIMARY KEY (episode_id, sentence_id, task_id));
CREATE TABLE IF NOT EXISTS acts (sentence_id TEXT, act TEXT, provenance TEXT, confidence REAL,
    PRIMARY KEY (sentence_id, act));
CREATE TABLE IF NOT EXISTS act_links (src_id TEXT, dst_id TEXT, relation TEXT, provenance TEXT,
    confidence REAL, PRIMARY KEY (src_id, dst_id, relation));
CREATE TABLE IF NOT EXISTS addressees (message_id TEXT, actor_id TEXT, provenance TEXT, confidence REAL,
    PRIMARY KEY (message_id, actor_id));
CREATE TABLE IF NOT EXISTS waits (span_id TEXT PRIMARY KEY, target_kind TEXT, target_id TEXT,
    target_text TEXT, provenance TEXT, confidence REAL);
CREATE TABLE IF NOT EXISTS loops (episode_id TEXT, id TEXT, actor TEXT, kind TEXT, task_id TEXT,
    span_ids TEXT, count INTEGER, provenance TEXT, confidence REAL, PRIMARY KEY (episode_id, id));
CREATE TABLE IF NOT EXISTS overlaps (episode_id TEXT, id TEXT, task_id TEXT, actors TEXT, start REAL,
    "end" REAL, coordinated INTEGER, provenance TEXT, confidence REAL, PRIMARY KEY (episode_id, id));
CREATE TABLE IF NOT EXISTS triggers (episode_id TEXT, task_id TEXT, worker TEXT, triggered_by TEXT, how TEXT,
    evidence TEXT, provenance TEXT, confidence REAL, note TEXT, PRIMARY KEY (episode_id, task_id, worker));
CREATE TABLE IF NOT EXISTS influence (episode_id TEXT, src TEXT, dst TEXT, how TEXT, effort REAL,
    n_tasks INTEGER, tasks TEXT, PRIMARY KEY (episode_id, src, dst, how));
CREATE TABLE IF NOT EXISTS metrics (episode_id TEXT, name TEXT, actor TEXT, value REAL, series TEXT,
    PRIMARY KEY (episode_id, name, actor));
CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, model TEXT, prompt_version TEXT,
    response TEXT, created REAL);
CREATE TABLE IF NOT EXISTS llm_usage (key TEXT, model TEXT, prompt_version TEXT, batch INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER, created REAL);
CREATE TABLE IF NOT EXISTS deltas (seq INTEGER PRIMARY KEY AUTOINCREMENT, t REAL, episode_ids TEXT,
    kind TEXT, payload TEXT);
"""
ANNOTATION_TABLES = ("sentences", "span_task", "sentence_task", "acts", "act_links", "addressees",
                     "waits", "loops", "overlaps", "triggers", "influence", "metrics")
# Derived tables whose shape changed; an old copy (derived data only) is dropped and recreated.
RESHAPED = {"influence": ["episode_id", "src", "dst", "how", "effort", "n_tasks", "tasks"]}


def q(name):
    return '"' + name + '"'


def core_columns(rtype):
    return ["id"] + FIELDS[rtype] + EXTRA_COLUMNS.get(rtype, [])


def encode(row):
    return {k: json.dumps(v) if k in JSON_COLUMNS and v is not None else v for k, v in row.items()}


def decode(row):
    return {k: json.loads(v) if k in JSON_COLUMNS and isinstance(v, str) else v for k, v in dict(row).items()}


def core_ddl():
    stmts = []
    for rtype, table in CORE_TABLES.items():
        cols = ", ".join(f"{q(c)}{' TEXT PRIMARY KEY' if c == 'id' else ''}" for c in core_columns(rtype))
        stmts.append(f"CREATE TABLE IF NOT EXISTS {q(table)} ({cols});")
    stmts += [
        'CREATE INDEX IF NOT EXISTS messages_t ON messages("t");',
        'CREATE INDEX IF NOT EXISTS spans_start ON spans("start");',
        'CREATE INDEX IF NOT EXISTS spans_actor ON spans("actor");',
        'CREATE INDEX IF NOT EXISTS tasks_parent ON tasks("parent_id");',
        'CREATE INDEX IF NOT EXISTS events_t ON events("t");',
    ]
    return "\n".join(stmts)


def in_window(ep, t):
    return t is not None and ep["start"] <= t and (ep["end"] is None or t <= ep["end"])


class Store:
    def __init__(self, path=":memory:"):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        if str(path) != ":memory:":
            self.db.execute("PRAGMA journal_mode=WAL")
        for table, columns in RESHAPED.items():
            existing = [r[1] for r in self.db.execute(f"PRAGMA table_info({q(table)})")]
            if existing and existing != columns:
                self.db.execute(f"DROP TABLE {q(table)}")
        self.db.executescript(core_ddl() + ANNOTATION_DDL)
        self.lock = threading.RLock()
        self._episodes = None
        self._episodes_version = None

    def close(self):
        self.db.close()

    # ---- core records -------------------------------------------------------------------

    def get(self, rtype, rid):
        with self.lock:
            row = self.db.execute(f"SELECT * FROM {q(CORE_TABLES[rtype])} WHERE id = ?", (rid,)).fetchone()
            return decode(row) if row else None

    def all(self, rtype, where="", params=()):
        with self.lock:
            sql = f"SELECT * FROM {q(CORE_TABLES[rtype])} {('WHERE ' + where) if where else ''}"
            return [decode(r) for r in self.db.execute(sql, params)]

    def apply(self, rec, extra=None, log=True):
        """Upsert one record (put or patch) and log a delta; returns the stored row.

        `extra` sets pipeline-only columns, e.g. {"provenance": "llm"} for inferred tasks.
        """
        with self.lock:
            rtype = rec["record"]
            cols = core_columns(rtype)
            given = {k: v for k, v in {**rec, **(extra or {})}.items() if k in cols}
            existing = self.get(rtype, rec["id"]) if rec.get("op") == "patch" else None
            row = {c: None for c in cols}
            if rtype == "task":
                row["provenance"] = "source"
            row.update(existing or {})
            row.update(given)
            enc = encode(row)
            self.db.execute(
                f"INSERT OR REPLACE INTO {q(CORE_TABLES[rtype])} ({', '.join(map(q, cols))}) "
                f"VALUES ({', '.join('?' for _ in cols)})", [enc[c] for c in cols])
            if rtype == "episode":
                self._episodes = None
            if log:
                self.log("record", {"record": rtype, "op": rec.get("op", "put"), "row": row},
                         self.episode_ids_for(rtype, row))
            return row

    def remove(self, rtype, rid, log=True):
        """Delete a core record (pipeline use, e.g. re-running inference); logs a delete delta."""
        with self.lock:
            row = self.get(rtype, rid)
            if row is None:
                return False
            eps = self.episode_ids_for(rtype, row)
            self.db.execute(f"DELETE FROM {q(CORE_TABLES[rtype])} WHERE id = ?", (rid,))
            if rtype == "episode":
                self._episodes = None
            if log:
                self.log("record", {"record": rtype, "op": "delete", "row": {"id": rid}}, eps)
            return True

    def apply_many(self, records, log=True):
        with self.lock, self.db:
            n = 0
            for rec in records:
                self.apply(rec, log=log)
                n += 1
            return n

    # ---- annotations --------------------------------------------------------------------

    def upsert(self, table, rows, episode_ids=None, log=True):
        """Insert or replace annotation rows (dicts keyed by column name)."""
        if table not in ANNOTATION_TABLES:
            raise ValueError(f"unknown annotation table {table}")
        rows = list(rows)
        if not rows:
            return 0
        with self.lock, self.db:
            for row in rows:
                enc = encode(row)
                cols = list(row)
                self.db.execute(f"INSERT OR REPLACE INTO {q(table)} ({', '.join(map(q, cols))}) "
                                f"VALUES ({', '.join('?' for _ in cols)})", [enc[c] for c in cols])
            if log:
                self.log("annotation", {"table": table, "op": "upsert", "rows": rows}, episode_ids)
            return len(rows)

    def delete(self, table, where, params=(), episode_ids=None, log=True):
        if table not in ANNOTATION_TABLES:
            raise ValueError(f"unknown annotation table {table}")
        with self.lock, self.db:
            gone = [decode(r) for r in self.db.execute(f"SELECT * FROM {q(table)} WHERE {where}", params)]
            self.db.execute(f"DELETE FROM {q(table)} WHERE {where}", params)
            if log and gone:
                self.log("annotation", {"table": table, "op": "delete", "rows": gone}, episode_ids)
            return len(gone)

    def annotations(self, table, where="", params=()):
        with self.lock:
            sql = f"SELECT * FROM {q(table)} {('WHERE ' + where) if where else ''}"
            return [decode(r) for r in self.db.execute(sql, params)]

    # ---- episodes and membership --------------------------------------------------------

    def episodes(self):
        """Cached episode list; refreshed when this or another process (e.g. an ingest run while
        the server is up) changes the database."""
        with self.lock:
            version = self.db.execute("PRAGMA data_version").fetchone()[0]
            if self._episodes is None or version != self._episodes_version:
                self._episodes = self.all("episode")
                self._episodes_version = version
            return self._episodes

    def root_of(self, task_id):
        seen = set()
        while task_id is not None and task_id not in seen:
            seen.add(task_id)
            task = self.get("task", task_id)
            if task is None or task["parent_id"] is None:
                return task_id
            task_id = task["parent_id"]
        return task_id

    def episode_ids_for(self, rtype, row):
        """Episodes a record belongs to (for routing deltas); None means global."""
        if rtype in ("manifest", "actor", "channel"):
            return None
        if rtype == "episode":
            return [row["id"]]
        if row.get("episode_id"):
            return [row["episode_id"]]
        eps = self.episodes()
        if rtype == "task":
            root = self.root_of(row["id"])
            return [e["id"] for e in eps if e["root_task_id"] == root]
        if rtype == "message":
            return [e["id"] for e in eps if in_window(e, row["t"])
                    and (not e["channels"] or row["channel_id"] is None or row["channel_id"] in e["channels"])]
        if rtype == "span":
            return [e["id"] for e in eps if row["actor"] in (e["actors"] or [])
                    and (e["end"] is None or row["start"] <= e["end"])
                    and (row["end"] is None or row["end"] >= e["start"])]
        if rtype == "event":
            return [e["id"] for e in eps if in_window(e, row["t"])
                    and (row["actor"] is None or row["actor"] in (e["actors"] or []))]
        return None

    def subtree_tasks(self, root_id):
        with self.lock:
            sql = """WITH RECURSIVE sub(id) AS (SELECT id FROM tasks WHERE id = ?
                     UNION SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
                     SELECT tasks.* FROM tasks JOIN sub ON tasks.id = sub.id"""
            return [decode(r) for r in self.db.execute(sql, (root_id,))]

    def episode_members(self, episode_id):
        """Core records that belong to an episode (explicit episode_id, or window/actor/channel)."""
        ep = self.get("episode", episode_id)
        if ep is None:
            raise KeyError(episode_id)
        end = ep["end"] if ep["end"] is not None else float("inf")
        chans = ep["channels"] or []
        actors = ep["actors"] or []
        ph = lambda xs: ", ".join("?" for _ in xs) or "NULL"
        messages = self.all("message", f"""episode_id = ? OR (episode_id IS NULL AND "t" >= ? AND "t" <= ?
            AND ({'1' if not chans else f'channel_id IS NULL OR channel_id IN ({ph(chans)})'})) ORDER BY "t", id""",
                            (episode_id, ep["start"], end, *chans))
        spans = self.all("span", f"""episode_id = ? OR (episode_id IS NULL AND actor IN ({ph(actors)})
            AND "start" <= ? AND ("end" IS NULL OR "end" >= ?)) ORDER BY "start", id""",
                         (episode_id, *actors, end, ep["start"]))
        events = self.all("event", f"""episode_id = ? OR (episode_id IS NULL AND "t" >= ? AND "t" <= ?
            AND (actor IS NULL OR actor IN ({ph(actors)}))) ORDER BY "t", id""",
                          (episode_id, ep["start"], end, *actors))
        speaker_ids = set(actors) | {m["sender"] for m in messages} | {r for m in messages for r in (m["recipients"] or [])}
        actor_rows = [a for a in self.all("actor") if a["id"] in speaker_ids]
        channel_ids = set(chans) | {m["channel_id"] for m in messages if m["channel_id"]}
        channel_rows = [c for c in self.all("channel") if c["id"] in channel_ids]
        manifests = self.all("manifest")
        manifest = next((x for x in manifests if x["id"] == ep["dataset_id"]), None)
        if manifest is None and len(manifests) == 1:
            manifest = manifests[0]
        return {
            "manifest": manifest,
            "episode": ep,
            "actors": actor_rows,
            "channels": channel_rows,
            "tasks": self.subtree_tasks(ep["root_task_id"]),
            "messages": messages,
            "spans": spans,
            "events": events,
        }

    # ---- LLM result cache -----------------------------------------------------------------

    def cache_get(self, key):
        with self.lock:
            row = self.db.execute("SELECT response FROM llm_cache WHERE key = ?", (key,)).fetchone()
            return json.loads(row[0]) if row else None

    def cache_put(self, key, model, prompt_version, data):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO llm_cache (key, model, prompt_version, response, created) "
                            "VALUES (?, ?, ?, ?, ?)", (key, model, prompt_version, json.dumps(data), time.time()))

    def usage_put(self, key, model, prompt_version, batch, usage):
        """Log one API call's token usage (for cost reports)."""
        with self.lock, self.db:
            self.db.execute("INSERT INTO llm_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (key, model, prompt_version, int(batch), usage.get("input_tokens", 0),
                             usage.get("output_tokens", 0), usage.get("cache_read_input_tokens", 0),
                             usage.get("cache_creation_input_tokens", 0), time.time()))

    # ---- delta log ----------------------------------------------------------------------

    def log(self, kind, payload, episode_ids=None):
        with self.lock:
            cur = self.db.execute("INSERT INTO deltas (t, episode_ids, kind, payload) VALUES (?, ?, ?, ?)",
                                  (time.time(), None if episode_ids is None else json.dumps(episode_ids),
                                   kind, json.dumps(payload)))
            return cur.lastrowid

    def last_seq(self):
        with self.lock:
            return self.db.execute("SELECT COALESCE(MAX(seq), 0) FROM deltas").fetchone()[0]

    def scan_deltas(self, seq, episode_id=None, limit=500):
        """Like deltas_since, but also returns the last seq scanned, so a subscriber can move past
        deltas that belong to other episodes: (deltas, next_seq)."""
        with self.lock:
            rows = self.db.execute("SELECT * FROM deltas WHERE seq > ? ORDER BY seq LIMIT ?", (seq, limit)).fetchall()
        out = []
        for r in rows:
            eps = json.loads(r["episode_ids"]) if r["episode_ids"] else None
            if episode_id is None or eps is None or episode_id in eps:
                out.append({"seq": r["seq"], "t": r["t"], "kind": r["kind"], "episode_ids": eps,
                            "payload": json.loads(r["payload"])})
        return out, (rows[-1]["seq"] if rows else seq)

    def deltas_since(self, seq, episode_id=None, limit=1000):
        """Deltas after `seq`; with episode_id, only those routed to it or global ones."""
        with self.lock:
            rows = self.db.execute("SELECT * FROM deltas WHERE seq > ? ORDER BY seq LIMIT ?", (seq, limit)).fetchall()
        out = []
        for r in rows:
            eps = json.loads(r["episode_ids"]) if r["episode_ids"] else None
            if episode_id is None or eps is None or episode_id in eps:
                out.append({"seq": r["seq"], "t": r["t"], "kind": r["kind"], "episode_ids": eps,
                            "payload": json.loads(r["payload"])})
        return out
