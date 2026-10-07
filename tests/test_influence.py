import re
import sqlite3

import pytest

from collab.influence import candidates, compute_influence, guard, infer_triggers
from collab.llm import LLM, CacheMiss
from collab.markers import compute_markers
from collab.mentions import task_terms, term_regex
from collab.store import Store
from collab.tasks import infer_tree


@pytest.fixture
def run_a(store):
    infer_tree(store, None, "run-a", progress=lambda *_: None)  # ground-truth tree: copied, no model
    compute_markers(store, "run-a")  # also stores addressees, which candidates() uses
    return store


def triggers(store, ep="run-a"):
    return {(r["task_id"], r["worker"]): r for r in store.annotations("triggers", "episode_id = ?", (ep,))}


def test_terms_include_acronyms_but_not_generic_ones():
    root = {"name": "Build a small web game"}
    assert task_terms({"name": "Game UI"}, root) == ["Game UI", "UI"]
    assert task_terms({"name": "Review PR queue"}, root) == ["Review PR queue", "review", "queue"]
    assert task_terms({"name": "X", "attrs": {"anchors": ["PR #6"]}}, root) == ["PR #6"]
    rx = term_regex(["UI"])
    assert rx.search("start on the UI?") and not rx.search("GUIDE")


def test_candidates_collect_mentions_and_addressed_messages(run_a):
    bundles, _ = candidates(run_a, "run-a")
    by_task = {b["task_id"]: b for b in bundles}
    assert "a:root" not in by_task
    assert set(by_task) == {"a:design", "a:build", "a:ui", "a:frontend", "a:backend", "a:input", "a:landing", "a:announce"}
    [ask] = [m for m in by_task["a:ui"]["messages"] if m["id"] == "a:m2"]
    assert ask["mentions"] and ask["to"] == ["bo"] and ask["alias"].startswith("m")
    assert [w["actor"] for w in by_task["a:input"]["workers"]] == ["ada", "bo"]


def test_heuristic_triggers_on_the_fixture(run_a):
    infer_triggers(run_a, None, "run-a", progress=lambda *_: None)
    t = triggers(run_a)
    assert (t["a:ui", "bo"]["how"], t["a:ui", "bo"]["triggered_by"], t["a:ui", "bo"]["evidence"]) == ("asked", "ada", ["a:m2"])
    assert (t["a:input", "bo"]["how"], t["a:input", "bo"]["triggered_by"]) == ("asked", "ada")
    assert t["a:input", "ada"]["how"] == "self"  # started at the same step as Bo
    assert (t["a:landing", "cy"]["how"], t["a:landing", "cy"]["triggered_by"]) == ("joined", "bo")
    assert t["a:landing", "bo"]["how"] == "self" and t["a:backend", "cy"]["how"] == "self"
    assert {r["provenance"] for r in t.values()} == {"heuristic"}


def test_influence_edges_sum_the_workers_time(run_a):
    infer_triggers(run_a, None, "run-a", progress=lambda *_: None)
    summary = compute_influence(run_a, "run-a")
    edges = {(r["src"], r["dst"], r["how"]): r for r in run_a.annotations("influence", "episode_id = 'run-a'")}
    assert set(edges) == {("ada", "bo", "asked"), ("bo", "cy", "joined")}
    assert (edges["ada", "bo", "asked"]["effort"], edges["ada", "bo", "asked"]["tasks"]) == (20, ["a:input", "a:ui"])
    assert edges["bo", "cy", "joined"]["effort"] == 10
    assert summary == {"edges": 2, "rows": 2, "effort": 30}


BUNDLE = {
    "workers": [{"actor": "a", "name": "A", "first": 10}, {"actor": "b", "name": "B", "first": 20}],
    "messages": [{"alias": "m1", "id": "x1", "t": 5, "sender": "c", "sender_name": "C", "to": ["b"], "mentions": True, "text": ""},
                 {"alias": "m2", "id": "x2", "t": 8, "sender": "a", "sender_name": "A", "to": [], "mentions": True, "text": ""}],
}


def answer(**kw):
    return {"workers": [{"worker": "B", "how": "asked", "triggered_by": "C", "evidence": ["m1"], "note": "", **kw}]}


def test_guard_accepts_backed_claims():
    assert guard(BUNDLE, answer())["b"] == {"by": "c", "how": "asked", "evidence": ["x1"], "note": ""}


def test_guard_rejects_unbacked_or_impossible_claims():
    assert guard(BUNDLE, answer(evidence=["m9"]))["b"]["how"] == "joined"  # alias doesn't exist: no backing
    assert guard(BUNDLE, answer(evidence=["m2"]))["b"]["by"] == "a"  # m2 isn't from C -> joined A
    joined_later = {"workers": [{"worker": "A", "how": "joined", "triggered_by": "B", "evidence": [], "note": ""}]}
    assert guard(BUNDLE, joined_later)["a"] == {"by": None, "how": "self", "evidence": [], "note": ""}
    self_named = {"workers": [{"worker": "B", "how": "self", "triggered_by": "C", "evidence": [], "note": ""}]}
    assert guard(BUNDLE, self_named)["b"]["by"] is None
    assert guard(BUNDLE, {"workers": [{"worker": "Z", "how": "asked", "triggered_by": "C", "evidence": [], "note": ""}]}) == {}


class ScriptedModel:
    """For "Input handling": Bo accepted Ada's offer and handed her keyboard input (Ada asked by Bo)."""

    def json_many(self, prompt_version, system, requests, effort="medium", batch=False, progress=print):
        out = {}
        for key, (user, schema) in requests.items():
            if "Task: Build the game > Frontend > Input handling" in user:
                alias = re.search(r"^(m\d+) \|[^\n]*take keyboard events", user, re.M).group(1)
                out[key] = {"workers": [
                    {"worker": "Ada", "how": "asked", "triggered_by": "Bo", "evidence": [alias], "note": "Bo handed over keyboard"},
                    {"worker": "Bo", "how": "self", "triggered_by": "nobody", "evidence": [], "note": ""}]}
        return out


def test_model_answers_win_and_missing_ones_fall_back(run_a):
    infer_triggers(run_a, ScriptedModel(), "run-a", progress=lambda *_: None)
    t = triggers(run_a)
    assert (t["a:input", "ada"]["how"], t["a:input", "ada"]["triggered_by"], t["a:input", "ada"]["provenance"]) == ("asked", "bo", "llm")
    assert t["a:input", "ada"]["evidence"] == ["a:m7"] and t["a:input", "bo"]["how"] == "self"
    assert t["a:ui", "bo"]["provenance"] == "heuristic"  # no answer for that task
    compute_influence(run_a, "run-a")
    edges = {(r["src"], r["dst"]): r["effort"] for r in run_a.annotations("influence", "episode_id = 'run-a'")}
    assert edges == {("ada", "bo"): 10, ("bo", "ada"): 8, ("bo", "cy"): 10}


def test_old_influence_table_is_rebuilt(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE influence (episode_id TEXT, "window" TEXT, src TEXT, dst TEXT, exchange REAL, '
               'influence REAL, evidence TEXT, PRIMARY KEY (episode_id, "window", src, dst))')
    db.commit()
    db.close()
    s = Store(path)
    assert [r[1] for r in s.db.execute("PRAGMA table_info(influence)")] == \
        ["episode_id", "src", "dst", "how", "effort", "n_tasks", "tasks"]


def test_offline_model_never_calls_the_api():
    llm = LLM(Store(), client=object(), offline=True)  # any API use would fail on this client
    with pytest.raises(CacheMiss):
        llm.json("v", "sys", "user", {"type": "object"})
    assert llm.json_many("v", "sys", {"k": ("user", {"type": "object"})}) == {}
