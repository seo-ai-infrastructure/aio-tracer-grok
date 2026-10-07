import pytest

from collab.tree import TaskTree, active_profile, general_spans, max_active, merge, move, rollup


@pytest.fixture
def parts(store):
    m = store.episode_members("run-a")
    work = [s for s in m["spans"] if s["kind"] == "work"]
    span_task = {s["id"]: s["task_id"] for s in work if s["task_id"]}
    return m["tasks"], work, span_task


def test_any_depth_shape(parts):
    tasks, _, _ = parts
    tree = TaskTree(tasks, "a:root")
    assert tree.depth("a:ui") == 3 and tree.depth("a:design") == 1
    assert tree.path("a:input") == ["a:root", "a:build", "a:frontend", "a:input"]
    assert tree.max_depth() == 3
    assert tree.breadth_per_level() == [1, 3, 4, 2]
    assert tree.is_leaf("a:design") and not tree.is_leaf("a:frontend")


def test_rollup_heights_count_distinct_actors(parts):
    tasks, work, span_task = parts
    tree = TaskTree(tasks, "a:root")
    r = rollup(tree, work, span_task)
    assert r["a:frontend"] == {"bo": [(2, 30)], "ada": [(20, 28)]}
    assert max_active(r["a:frontend"]) == 2
    assert max_active(r["a:backend"]) == 1
    assert max_active(r["a:root"]) == 3  # steps 20-22: ada, bo, cy
    assert active_profile({"x": [(0, 5)], "y": [(5, 8)]}) == [(0, 1), (5, 1), (8, 0)]


def test_general_rows_hold_work_on_internal_nodes(parts):
    tasks, work, span_task = parts
    tree = TaskTree(tasks, "a:root")
    assert [s["id"] for s in general_spans(tree, work, span_task, "a:build")] == ["a:s-ada-2"]
    assert [s["id"] for s in general_spans(tree, work, span_task, "a:frontend")] == ["a:s-bo-2"]
    assert general_spans(tree, work, span_task, "a:ui") == []


def test_move_refuses_cycles(parts):
    tasks, _, _ = parts
    by_id = {t["id"]: t for t in tasks}
    assert move(by_id, "a:landing", "a:build")["parent_id"] == "a:build"
    with pytest.raises(ValueError):
        move(by_id, "a:build", "a:ui")


def test_merge_keeps_ids_resolvable(parts):
    tasks, work, span_task = parts
    by_id = {t["id"]: t for t in tasks}
    for t in merge(by_id, "a:announce", "a:landing"):
        by_id[t["id"]] = t
    tree = TaskTree(list(by_id.values()), "a:root")
    assert tree.resolve("a:announce") == "a:landing"
    assert "a:announce" not in tree.live
    assert set(rollup(tree, work, span_task)["a:landing"]) == {"bo", "cy", "ada"}
    with pytest.raises(ValueError):
        merge(by_id, "a:build", "a:ui")  # into its own descendant
