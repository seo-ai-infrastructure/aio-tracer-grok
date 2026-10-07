from collab.schema import record_errors
from collab.validate import check, merge


def errors(issues):
    return [i for i in issues if i[0] == "error"]


def test_fixtures_are_clean(records_a, records_b):
    assert check(records_a) == []
    assert check(records_b) == []
    assert check(records_a + records_b) == []  # shared actors/manifest, distinct episodes


def test_schema_rejects_bad_enum_unknown_field_and_missing_required():
    assert record_errors({"record": "actor", "id": "x", "name": "X", "kind": "robot"})
    assert record_errors({"record": "channel", "id": "c", "name": "c", "colour": "red"})
    assert record_errors({"record": "span", "id": "s", "actor": "a", "kind": "work"})  # no start
    assert record_errors({"record": "span", "id": "s"}) != []


def test_patch_may_be_partial():
    assert record_errors({"record": "span", "op": "patch", "id": "s", "end": 9}) == []
    assert record_errors({"record": "span", "op": "patch", "id": "s", "kind": "nap"})  # still typed


def test_patch_merges_into_earlier_put():
    state = merge([
        {"record": "span", "id": "s", "actor": "a", "start": 1, "kind": "work", "end": None},
        {"record": "span", "op": "patch", "id": "s", "end": 5},
    ])
    assert state[("span", "s")] == {"record": "span", "id": "s", "actor": "a", "start": 1, "kind": "work", "end": 5}


def test_referential_integrity(records_a):
    broken = records_a + [
        {"record": "span", "id": "x1", "actor": "nobody", "start": 1, "end": 2, "kind": "work", "episode_id": "run-a"},
        {"record": "span", "id": "x2", "actor": "ada", "start": 5, "end": 2, "kind": "work", "episode_id": "run-a"},
        {"record": "message", "id": "x3", "t": 1, "sender": "ada", "text": "hi", "reply_to": ["gone"], "episode_id": "run-a"},
        {"record": "task", "id": "t1", "name": "T1", "parent_id": "t2"},
        {"record": "task", "id": "t2", "name": "T2", "parent_id": "t1"},
        {"record": "episode", "id": "bad-root", "root_task_id": "a:ui", "start": 0, "actors": ["ada"]},
    ]
    issues = check(broken)
    msgs = {(i[2], i[3]) for i in issues}
    assert ("x1", "actor 'nobody' does not exist") in msgs
    assert ("x2", "end is before start") in msgs
    assert ("warning", "message", "x3", "reply_to message 'gone' does not exist") in issues
    assert {i[2] for i in issues if "cycle" in i[3]} == {"t1", "t2"}
    assert any(i[2] == "bad-root" and "has a parent" in i[3] for i in errors(issues))


def test_untagged_records_matching_several_episodes_are_flagged(records_a, records_b):
    untagged = {"record": "message", "id": "u1", "t": 3, "sender": "ada", "channel_id": "team", "text": "hi"}
    issues = check(records_a + records_b + [untagged])
    assert any(i[2] == "u1" and "several episodes" in i[3] for i in issues)
