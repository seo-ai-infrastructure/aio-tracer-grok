from collab.acts import mention_addressees
from collab.markers import compute_markers, detect_loops, detect_overlaps
from collab.tasks import infer_tree

CFG = {"loops": {"min_repeats": 4, "min_similarity": 0.5},
       "overlaps": {"min_duration": {"s": 60, "step": 1}, "coordination_window": {"s": 900, "step": 5}}}


def test_fixture_markers(store):
    infer_tree(store, None, "run-a", progress=lambda *_: None)  # source tree: no LLM needed
    summary = compute_markers(store, "run-a", CFG)
    assert summary["loops"] == 1 and summary["overlaps"] == 2 and summary["uncoordinated"] == 1
    [loop] = store.annotations("loops", "episode_id = 'run-a'")
    assert loop["actor"] == "cy" and loop["count"] == 4 and loop["task_id"] == "a:backend" and loop["kind"] == "retry"
    assert loop["span_ids"] == ["a:s-cy-1", "a:s-cy-2", "a:s-cy-3", "a:s-cy-4"]
    overlaps = {o["task_id"]: o for o in store.annotations("overlaps", "episode_id = 'run-a'")}
    assert overlaps["a:input"]["actors"] == ["ada", "bo"] and overlaps["a:input"]["coordinated"] == 1
    assert (overlaps["a:input"]["start"], overlaps["a:input"]["end"]) == (20, 28)
    assert overlaps["a:landing"]["actors"] == ["bo", "cy"] and overlaps["a:landing"]["coordinated"] == 0
    [wait] = store.annotations("waits")
    assert (wait["span_id"], wait["target_kind"], wait["target_id"]) == ("a:s-cy-5", "task", "a:input")


def test_markers_are_recomputed_not_duplicated(store):
    infer_tree(store, None, "run-a", progress=lambda *_: None)
    compute_markers(store, "run-a", CFG)
    compute_markers(store, "run-a", CFG)
    assert len(store.annotations("loops", "episode_id = 'run-a'")) == 1
    assert len(store.annotations("overlaps", "episode_id = 'run-a'")) == 2


def test_run_b_has_no_loops_and_a_coordinated_overlap(store):
    infer_tree(store, None, "run-b", progress=lambda *_: None)
    assert compute_markers(store, "run-b", CFG)["loops"] == 0
    [ov] = store.annotations("overlaps", "episode_id = 'run-b'")
    assert ov["task_id"] == "b:ui" and ov["coordinated"] == 1
    [wait] = store.annotations("waits", "span_id = 'b:s-cy-1'")
    assert (wait["target_kind"], wait["target_id"]) == ("actor", "ada")


def test_loop_needs_consecutive_similar_labels():
    mk = lambda i, label: {"id": f"s{i}", "actor": "x", "start": i, "end": i + 1, "label": label}
    spans = [mk(0, "Upload PNG to doc"), mk(1, "Upload PNG & embed"), mk(2, "Write summary"),
             mk(3, "Upload PNG to memo"), mk(4, "Upload the PNG"), mk(5, "Upload PNG again"), mk(6, "Upload PNG, retry")]
    [loop] = detect_loops(spans, {}, CFG["loops"])
    assert loop["span_ids"] == ["s3", "s4", "s5", "s6"]  # the unrelated span breaks the first run
    assert loop["kind"] == "retry"
    polls = [mk(i, label) for i, label in enumerate(["Check for new PRs", "Check for new open PRs",
                                                     "Monitor for new PRs", "Check for PRs"])]
    assert detect_loops(polls, {}, CFG["loops"])[0]["kind"] == "polling"


def test_short_overlaps_are_ignored():
    work = [{"id": "a", "actor": "x", "start": 0, "end": 100, "label": "Review PR #7"},
            {"id": "b", "actor": "y", "start": 70, "end": 200, "label": "Review PR #7 again"}]
    assert detect_overlaps(work, {"a": "t", "b": "t"}, [], min_duration=60, window=900) == []
    [ov] = detect_overlaps(work, {"a": "t", "b": "t"}, [], min_duration=10, window=900)
    assert (ov["start"], ov["end"], ov["coordinated"]) == (70, 100, 0)


def test_different_work_at_the_same_time_is_not_duplicate_effort():
    mk = lambda i, actor, label: {"id": i, "actor": actor, "start": 0, "end": 100, "label": label}
    on_t = lambda *ids: {i: "t" for i in ids}
    different_prs = [mk("a", "x", "Review PR #52 combat"), mk("b", "y", "Review PR #48 combat")]
    assert detect_overlaps(different_prs, on_t("a", "b"), [], min_duration=10, window=900) == []
    unrelated = [mk("a", "x", "Write landing page copy"), mk("b", "y", "Debug the save system")]
    assert detect_overlaps(unrelated, on_t("a", "b"), [], min_duration=10, window=900) == []
    same_pr = [mk("a", "x", "Review PR #52 combat"), mk("b", "y", "Review PR #52 combat abilities")]
    assert len(detect_overlaps(same_pr, on_t("a", "b"), [], min_duration=10, window=900)) == 1


def test_mentions_and_vocatives():
    actors = [{"id": "gpt-5", "name": "GPT-5"}, {"id": "gpt-5-2", "name": "GPT-5.2"},
              {"id": "opus-cc", "name": "Opus 4.5 (Claude Code)"}, {"id": "haiku", "name": "Claude Haiku 4.5"}]
    msgs = [{"id": "m1", "sender": "haiku", "text": "@Opus 4.5 (Claude Code) approved, thanks @GPT-5.2!"},
            {"id": "m2", "sender": "opus-cc", "text": "GPT-5, can you rebase? Also cc @GPT-5."},
            {"id": "m3", "sender": "haiku", "text": "Talking to myself @Claude Haiku 4.5"}]
    rows = {(r["message_id"], r["actor_id"]): r["confidence"] for r in mention_addressees(msgs, actors)}
    assert rows == {("m1", "opus-cc"): 0.9, ("m1", "gpt-5-2"): 0.9, ("m2", "gpt-5"): 0.9}
