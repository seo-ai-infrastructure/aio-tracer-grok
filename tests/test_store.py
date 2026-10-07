from collab.store import Store


def test_put_then_patch_opens_and_closes_a_span():
    s = Store()
    s.apply({"record": "span", "id": "s1", "actor": "a", "start": 10, "end": None, "kind": "work", "label": "x"})
    s.apply({"record": "span", "op": "patch", "id": "s1", "end": 20})
    row = s.get("span", "s1")
    assert (row["start"], row["end"], row["label"]) == (10, 20, "x")


def test_json_columns_round_trip(store):
    ep = store.get("episode", "run-a")
    assert ep["actors"] == ["ada", "bo", "cy"] and ep["attrs"] == {"condition": "a"}
    assert store.get("span", "a:s-cy-5")["attrs"] == {"waiting_on": {"task": "a:input"}}


def test_episode_members_respect_explicit_tags(store):
    a = store.episode_members("run-a")
    b = store.episode_members("run-b")
    assert len(a["messages"]) == 12 and len(b["messages"]) == 7
    assert all(m["id"].startswith("a:") for m in a["messages"])
    assert {s["id"] for s in b["spans"]} == {"b:s-ada-1", "b:s-bo-1", "b:s-cy-1", "b:s-cy-2", "b:s-bo-2", "b:s-ada-2"}
    assert {t["id"] for t in a["tasks"]} == {"a:root", "a:design", "a:build", "a:frontend", "a:ui", "a:input",
                                            "a:backend", "a:launch", "a:landing", "a:announce"}
    assert "ov" in {x["id"] for x in a["actors"]}  # humans who spoke are included
    assert a["manifest"]["time_unit"] == "step"


def test_untagged_records_use_the_time_window():
    s = Store()
    s.apply_many([
        {"record": "task", "id": "r", "name": "Goal"},
        {"record": "episode", "id": "e", "root_task_id": "r", "start": 100, "end": 200, "actors": ["a"], "channels": ["c"]},
        {"record": "message", "id": "in", "t": 150, "sender": "a", "channel_id": "c", "text": "x"},
        {"record": "message", "id": "late", "t": 250, "sender": "a", "channel_id": "c", "text": "x"},
        {"record": "message", "id": "other-room", "t": 150, "sender": "a", "channel_id": "d", "text": "x"},
        {"record": "span", "id": "overlaps", "actor": "a", "start": 90, "end": 110, "kind": "work"},
        {"record": "span", "id": "someone-else", "actor": "b", "start": 120, "end": 130, "kind": "work"},
    ])
    m = s.episode_members("e")
    assert [x["id"] for x in m["messages"]] == ["in"]
    assert [x["id"] for x in m["spans"]] == ["overlaps"]


def test_deltas_are_routed_to_episodes(store):
    seq = store.last_seq()
    store.apply({"record": "span", "op": "patch", "id": "a:s-bo-4", "end": 43})
    store.apply({"record": "actor", "op": "patch", "id": "bo", "role": "builder"})
    store.upsert("loops", [{"episode_id": "run-b", "id": "l1", "actor": "cy", "count": 4}], episode_ids=["run-b"])
    for_a = store.deltas_since(seq, "run-a")
    assert [d["payload"].get("record") or d["payload"]["table"] for d in for_a] == ["span", "actor"]
    assert [d["payload"].get("record") or d["payload"]["table"] for d in store.deltas_since(seq, "run-b")] == ["actor", "loops"]
    assert for_a[0]["payload"]["row"]["end"] == 43


def test_task_deltas_follow_the_root(store):
    seq = store.last_seq()
    store.apply({"record": "task", "id": "a:new", "name": "New", "parent_id": "a:ui"}, extra={"provenance": "llm"})
    [d] = store.deltas_since(seq)
    assert d["episode_ids"] == ["run-a"]
    assert store.get("task", "a:new")["provenance"] == "llm"
    assert store.get("task", "a:ui")["provenance"] == "source"


def test_episode_list_sees_other_processes(tmp_path):
    server, ingester = Store(tmp_path / "c.db"), Store(tmp_path / "c.db")
    assert server.episodes() == []
    ingester.apply_many([{"record": "task", "id": "r", "name": "Goal"},
                         {"record": "episode", "id": "e", "root_task_id": "r", "start": 0, "actors": []}])
    assert [e["id"] for e in server.episodes()] == ["e"]


def test_annotations_upsert_and_delete(store):
    store.upsert("span_task", [{"episode_id": "run-a", "span_id": "a:s-bo-1", "task_id": "a:ui",
                                "provenance": "source", "confidence": 1.0}])
    assert store.annotations("span_task")[0]["task_id"] == "a:ui"
    assert store.delete("span_task", "episode_id = ?", ("run-a",)) == 1
    assert store.annotations("span_task") == []
