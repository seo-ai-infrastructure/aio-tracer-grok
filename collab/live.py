"""Streaming: apply records one at a time with incremental processing, and replay stored data.

The live pipeline keeps the same tables as a static build. Each record gets cheap, immediate
processing (sentences, addressees, rule-based speech acts, a provisional task assignment); markers are refreshed
periodically; `finish()` reruns the same processors a static build uses, so a replay that runs
to the end yields the same derived tables as the static build (the replay invariant).
"""
import threading
import time

from collab.acts import addressees_for
from collab.influence import compute_influence, infer_triggers
from collab.llm import LLMError
from collab.markers import compute_markers, wait_targets
from collab.sentences import sentence_rows
from collab.speech import heuristic_message_acts, infer_acts
from collab.tasks import infer_tree

STRUCTURE = ("manifest", "channel", "actor", "task", "episode")  # replayed first, at the start


class LivePipeline:
    def __init__(self, store, llm=None, reference=None, markers_every=3.0, influence_every=10.0):
        """`reference`: a store whose span->task assignments to reuse (e.g. the static build)."""
        self.store = store
        self.llm = llm
        self.reference = reference
        self.markers_every = markers_every
        self.influence_every = influence_every
        self.dirty = set()
        self.influence_dirty = set()
        self.last_markers = 0.0
        self.last_influence = 0.0

    def apply(self, rec):
        store = self.store
        row = store.apply(rec, log=True)
        rtype = rec["record"]
        if rtype == "message" and "text" in rec:
            eps = store.episode_ids_for("message", row)
            old = [r["id"] for r in store.annotations("sentences", "message_id = ?", (row["id"],))]
            if old:
                store.delete("acts", f"sentence_id IN ({', '.join('?' for _ in old)})", old, episode_ids=eps)
            store.delete("sentences", "message_id = ?", (row["id"],), episode_ids=eps)
            sentences = sentence_rows(row["id"], row["text"])
            store.upsert("sentences", sentences, episode_ids=eps)
            if eps:
                sender = store.get("actor", row["sender"]) or {}
                store.upsert("acts", heuristic_message_acts(row, sentences, sender.get("kind") == "agent"), episode_ids=eps)
            if eps:
                store.delete("addressees", "message_id = ? AND provenance IN ('source', 'heuristic')", (row["id"],), log=False)
                store.upsert("addressees", addressees_for(row, store.all("actor"), self._caps(eps[0])), episode_ids=eps)
            self.dirty.update(eps or [])
        elif rtype == "span":
            eps = store.episode_ids_for("span", row)
            if row["kind"] == "work" and rec.get("op") != "patch":
                for ep_id in eps or []:
                    task = self._provisional_task(ep_id, row)
                    if task:
                        store.upsert("span_task", [{"episode_id": ep_id, "span_id": row["id"], "task_id": task[0],
                                                    "provenance": task[1], "confidence": task[2]}], episode_ids=[ep_id])
            if row["kind"] == "wait" and (row.get("attrs") or {}).get("waiting_on"):
                store.upsert("waits", wait_targets([row]), episode_ids=eps)
            self.dirty.update(eps or [])
        return row

    def _caps(self, episode_id):
        ep = self.store.get("episode", episode_id)
        manifests = self.store.all("manifest")
        m = next((x for x in manifests if ep and x["id"] == ep.get("dataset_id")), manifests[0] if len(manifests) == 1 else None)
        return (m or {}).get("capabilities") or {}

    def _provisional_task(self, episode_id, span):
        if span.get("task_id") and self.store.get("task", span["task_id"]):
            return span["task_id"], "source", 1.0
        if self.reference is not None:
            rows = self.reference.annotations("span_task", "episode_id = ? AND span_id = ?", (episode_id, span["id"]))
            if rows:
                task = rows[0]["task_id"]
                if self.store.get("task", task) is None:  # bring the inferred node (and ancestors) over
                    self._copy_task_path(task)
                return task, rows[0]["provenance"], rows[0]["confidence"]
        return None  # unassigned: the view shows it on the goal row until the tree is (re)built

    def _copy_task_path(self, task_id):
        chain = []
        while task_id and self.store.get("task", task_id) is None:
            t = self.reference.get("task", task_id)
            if t is None:
                break
            chain.append(t)
            task_id = t["parent_id"]
        for t in reversed(chain):
            extra = {k: t[k] for k in ("provenance", "confidence", "merged_into")}
            self.store.apply({"record": "task", **{k: v for k, v in t.items() if k not in extra}}, extra=extra)

    def tick(self, force=False):
        """Refresh markers for episodes that changed, at most every `markers_every` seconds."""
        now = time.time()
        if self.dirty and (force or now - self.last_markers >= self.markers_every):
            for ep_id in sorted(self.dirty):
                compute_markers(self.store, ep_id, with_addressees=False)  # kept current per message
            self.influence_dirty |= self.dirty
            self.dirty.clear()
            self.last_markers = now
        # Influence while streaming: heuristic triggers (the model pass runs in finish()).
        if self.influence_dirty and (force or now - self.last_influence >= self.influence_every):
            for ep_id in sorted(self.influence_dirty):
                infer_triggers(self.store, None, ep_id, progress=lambda *_: None)
                compute_influence(self.store, ep_id)
            self.influence_dirty.clear()
            self.last_influence = now

    def finish(self):
        """Rerun the static processors so derived tables match a static build. Without a model,
        inferred trees are left as provisionally assigned (copied from the reference) and triggers
        come from the heuristic."""
        for ep in self.store.episodes():
            if self._caps(ep["id"]).get("task_tree") or self.llm is not None:
                try:
                    infer_tree(self.store, self.llm, ep["id"], progress=lambda *_: None)
                except LLMError:  # an offline model without a cached tree: keep the provisional one
                    pass
            compute_markers(self.store, ep["id"])
            infer_acts(self.store, self.llm, ep["id"], progress=lambda *_: None)
            infer_triggers(self.store, self.llm, ep["id"], progress=lambda *_: None)
            compute_influence(self.store, ep["id"])
        self.dirty.clear()
        self.influence_dirty.clear()


def timeline(records):
    """Order records for replay: structure first, then (time, record) with spans opened at their
    start and closed by a patch at their end. Returns [(t, record)]."""
    out = []
    for rec in records:
        rtype = rec["record"]
        if rtype in STRUCTURE:
            out.append((float("-inf"), rec))
        elif rtype == "span":
            end = rec.get("end")
            out.append((rec["start"], {**rec, "end": None}))
            if end is not None:
                out.append((end, {"record": "span", "op": "patch", "id": rec["id"], "end": end}))
        else:
            out.append((rec.get("t", float("-inf")), rec))
    order = {r: i for i, r in enumerate(STRUCTURE)}
    out.sort(key=lambda x: (x[0], order.get(x[1]["record"], len(STRUCTURE)), x[1].get("op") == "patch"))
    return out


def episode_records(store, episode_id):
    """The neutral records of one stored episode (what a source would have sent)."""
    m = store.episode_members(episode_id)
    clean = lambda rtype, row, drop=(): {"record": rtype, **{k: v for k, v in row.items() if v is not None and k not in drop}}
    recs = [clean("manifest", m["manifest"])] if m["manifest"] else []
    recs += [clean("channel", c) for c in m["channels"]]
    recs += [clean("actor", a) for a in m["actors"]]
    recs += [clean("task", t, ("provenance", "confidence", "merged_into")) for t in m["tasks"] if t["provenance"] == "source"]
    recs.append(clean("episode", m["episode"]))
    recs += [clean("message", x) for x in m["messages"]]
    recs += [clean("span", x) for x in m["spans"]]
    recs += [clean("event", x) for x in m["events"]]
    return recs


class Replay(threading.Thread):
    """Feed records through a LivePipeline with source time scaled by `speed` (inf = no waiting).
    Long idle gaps are capped at `max_wait` real seconds so nights don't stall the replay."""

    def __init__(self, pipeline, records, speed=60.0, max_wait=2.0, on_done=None):
        super().__init__(daemon=True)
        self.pipeline = pipeline
        self.items = timeline(records)
        self.speed = speed
        self.max_wait = max_wait
        self.on_done = on_done
        self.paused = threading.Event()
        self.stopped = threading.Event()
        self.position = 0
        self.clock = None  # source time of the last applied record

    def run(self):
        last_t = None
        for i, (t, rec) in enumerate(self.items):
            while self.paused.is_set() and not self.stopped.is_set():
                time.sleep(0.1)
            if self.stopped.is_set():
                return
            if last_t is not None and t > last_t and self.speed != float("inf"):
                time.sleep(min(self.max_wait, (t - last_t) / self.speed))
            if t != float("-inf"):
                last_t = t
                self.clock = t
            self.pipeline.apply(rec)
            self.pipeline.tick()
            self.position = i + 1
        self.pipeline.finish()
        if self.on_done:
            self.on_done()

    def status(self):
        return {"position": self.position, "total": len(self.items), "speed": self.speed,
                "paused": self.paused.is_set(), "done": self.position >= len(self.items) and not self.is_alive(),
                "clock": self.clock}
