import json
import threading
import time

from fastapi.testclient import TestClient

from collab.adapters.ndjson import follow_records
from collab.checks import compare, episode_fingerprint
from collab.influence import compute_influence, infer_triggers
from collab.ingest import ingest
from collab.live import LivePipeline, Replay, episode_records, timeline
from collab.markers import compute_markers
from collab.server import create_app
from collab.speech import infer_acts
from collab.store import Store
from collab.tasks import infer_tree


def static_build(records_a, records_b):
    s = Store()
    ingest(s, records_a)
    ingest(s, records_b)
    for ep in ("run-a", "run-b"):
        build_episode(s, ep)
    return s


def build_episode(s, ep):
    """What the numbered scripts do after ingest (no model: source trees, heuristic triggers)."""
    infer_tree(s, None, ep, progress=lambda *_: None)
    compute_markers(s, ep)
    infer_acts(s, None, ep, progress=lambda *_: None)
    infer_triggers(s, None, ep, progress=lambda *_: None)
    compute_influence(s, ep)


def replay_build(records, reference=None):
    live = Store()
    pipeline = LivePipeline(live, reference=reference, markers_every=0)
    r = Replay(pipeline, records, speed=float("inf"))
    r.run()  # synchronous: same code path as the thread
    return live, r


def test_replay_matches_static_build(records_a, records_b):
    static = static_build(records_a, records_b)
    live, r = replay_build(records_a + records_b)
    assert r.status()["position"] == r.status()["total"]
    for ep in ("run-a", "run-b"):
        assert compare(episode_fingerprint(static, ep), episode_fingerprint(live, ep)) == {}


def test_replay_of_a_stored_episode_matches(records_a, records_b):
    static = static_build(records_a, records_b)
    live, _ = replay_build(episode_records(static, "run-a"), reference=static)
    assert compare(episode_fingerprint(static, "run-a"), episode_fingerprint(live, "run-a")) == {}


def test_following_a_file_line_by_line_matches(tmp_path, records_a):
    static = Store()
    ingest(static, records_a)
    build_episode(static, "run-a")

    path = tmp_path / "trace.ndjson"
    path.write_text("")
    live = Store()
    pipeline = LivePipeline(live, markers_every=0)
    done = threading.Event()

    def writer():
        with open(path, "a") as f:
            for rec in records_a:
                line = json.dumps(rec)
                f.write(line[:10])  # partial lines must wait for their newline
                f.flush()
                f.write(line[10:] + "\n")
                f.flush()
        time.sleep(0.3)
        done.set()

    threading.Thread(target=writer).start()
    for rec in follow_records(path, poll=0.01, should_stop=done.is_set):
        pipeline.apply(rec)
    pipeline.finish()
    assert compare(episode_fingerprint(static, "run-a"), episode_fingerprint(live, "run-a")) == {}


def test_timeline_opens_spans_then_closes_them(records_a):
    items = timeline(records_a)
    kinds = [r["record"] for _, r in items]
    assert kinds[:6] == ["manifest", "channel", "actor", "actor", "actor", "actor"]
    opened = next(i for i, (_, r) in enumerate(items) if r["id"] == "a:s-bo-1" and r.get("op") != "patch")
    closed = next(i for i, (_, r) in enumerate(items) if r["id"] == "a:s-bo-1" and r.get("op") == "patch")
    assert opened < closed and items[opened][1]["end"] is None and items[closed][1]["end"] == 12


def test_stream_and_ingest_endpoints(records_a):
    store = Store()
    client = TestClient(create_app(store))
    body = "\n".join(json.dumps(r) for r in records_a)
    assert client.post("/api/ingest", content=body).json()["applied"] == len(records_a)
    bad = client.post("/api/ingest", content='{"record": "actor", "id": "x", "name": "X", "kind": "robot"}')
    assert bad.status_code == 400 and "robot" in json.dumps(bad.json())

    res = client.get("/api/episodes/run-a/stream?from_seq=0&once=true")
    events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]
    deltas = [d for batch in events for d in batch]
    assert any(d["kind"] == "record" and d["payload"]["record"] == "message" for d in deltas)
    assert any(d["kind"] == "annotation" and d["payload"]["table"] == "sentences" for d in deltas)
    assert all(d["episode_ids"] in (None, ["run-a"]) for d in deltas)
    last = int([line for line in res.text.splitlines() if line.startswith("id: ")][-1][4:])
    resumed = client.get("/api/episodes/run-a/stream?once=true", headers={"Last-Event-ID": str(last)})
    assert "data:" not in resumed.text  # nothing new since the last event
    assert client.get("/api/info").json()["mode"] == "static"
