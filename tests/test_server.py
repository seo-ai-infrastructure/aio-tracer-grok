from fastapi.testclient import TestClient

from collab.markers import compute_markers
from collab.server import create_app, snapshot
from collab.tasks import infer_tree


def test_snapshot_contents(store):
    infer_tree(store, None, "run-a", progress=lambda *_: None)
    compute_markers(store, "run-a")
    snap = snapshot(store, "run-a")
    assert snap["episode"]["root_name"] == "Build a small web game" and snap["episode"]["scope"] == "shared"
    assert len(snap["messages"]) == 12 and "reasoning" not in snap["messages"][0]
    assert sum(m["has_reasoning"] for m in snap["messages"]) == 2
    assert snap["sentences"] and "text" not in snap["sentences"][0]
    assert len(snap["span_task"]) == 13 and len(snap["loops"]) == 1 and len(snap["overlaps"]) == 2
    assert [w["span_id"] for w in snap["waits"]] == ["a:s-cy-5"]
    assert snap["seq"] == store.last_seq()


def test_http_api(store):
    client = TestClient(create_app(store))
    eps = client.get("/api/episodes").json()
    assert [e["id"] for e in eps] == ["run-a", "run-b"] or [e["id"] for e in eps] == ["run-b", "run-a"]
    assert client.get("/api/episodes/run-b/snapshot").json()["episode"]["attrs"] == {"condition": "b"}
    assert client.get("/api/episodes/nope/snapshot").status_code == 404
    assert client.get("/api/messages/a:m2/reasoning").json()["reasoning"].startswith("Bo has")
