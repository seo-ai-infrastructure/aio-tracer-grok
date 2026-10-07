import json
import re
from types import SimpleNamespace

import pytest

from collab.llm import LLM, LLMError, cost
from collab.store import Store
from collab.tasks import apply_guards, infer_tree, time_split_problem

CFG = {"split_min_spans": 4, "min_spans_per_node": 3, "max_depth": 6, "effort": "low"}


class ScriptedLLM:
    """Stands in for the model: splits by keywords found in the prompt's work-item lines."""

    def __init__(self, plans):
        self.plans = plans  # node name -> [(child name, label regex, anchors)]
        self.prompts = []

    def json(self, prompt_version, system, user, schema, effort="medium", max_tokens=16000):
        self.prompts.append(user)
        node = re.search(r"Path to this node: (.*)", user).group(1).split(" > ")[-1]
        items = re.findall(r"^(g\d+) \| x\d+ \| [^|]* \| [^|]* \| (.*)$", user, re.M)
        children = [{"name": name, "summary": f"{name} work", "anchors": anchors, "status": "done",
                     "items": [gid for gid, label in items if re.search(rx, label, re.I)]}
                    for name, rx, anchors in self.plans.get(node, [])]
        return {"decision": "split" if children else "keep", "reason": f"scripted for {node}",
                "status": "ongoing", "children": children}

    def json_batch(self, prompt_version, system, items, schema, **kw):
        return {i: self.json(prompt_version, system, u, schema) for i, u in items}


PLANS = {
    "Build a small web game": [("Launch", r"landing|announce", ["launch"]),  # first match wins
                               ("Build the game", r"build|fix|implement|refactor|set up|ui", []),
                               ("Concept", r"concept", [])],  # 1 span, no anchors -> dissolved
    "Build the game": [("Backend", r"backend", ["backend"]), ("Frontend", r"ui|input|frontend", [])],
}


@pytest.fixture
def untreed(records_a):
    """Fixture A without its ground-truth tree: the pipeline has to infer one."""
    recs = []
    for r in records_a:
        r = dict(r)
        if r["record"] == "manifest":
            r["capabilities"] = {**r["capabilities"], "task_tree": False}
        if r["record"] == "task" and r["id"] != "a:root":
            continue
        r.pop("task_id", None)
        recs.append(r)
    s = Store()
    s.apply_many(recs)
    yield s
    s.close()


def tree_of(store):
    return {t["id"]: t for t in store.subtree_tasks("a:root")}


def test_top_down_inference_with_guards(untreed):
    llm = ScriptedLLM(PLANS)
    summary = infer_tree(untreed, llm, "run-a", cfg=CFG, progress=lambda *_: None)
    tasks = tree_of(untreed)
    assert set(tasks) == {"a:root", "a:root/build-the-game", "a:root/launch",
                          "a:root/build-the-game/backend", "a:root/build-the-game/frontend"}
    assert summary == {"source": "llm", "assigned": 13, "tasks": 5, "calls": 2}
    assign = {r["span_id"]: r["task_id"] for r in untreed.annotations("span_task")}
    assert assign["a:s-ada-1"] == "a:root"                       # dissolved child's work stays general
    assert assign["a:s-ada-2"] == "a:root/build-the-game"        # "Set up repo": general work on Build
    assert assign["a:s-cy-3"] == "a:root/build-the-game/backend"
    assert assign["a:s-bo-4"] == "a:root/launch"
    assert all(r["provenance"] == "llm" for r in untreed.annotations("span_task"))
    root, launch = tasks["a:root"], tasks["a:root/launch"]
    assert root["attrs"]["decision"] == "split" and root["status"] == "ongoing"
    assert launch["attrs"]["decision"] == "keep" and "only 3" in launch["attrs"]["reason"]
    assert launch["attrs"]["anchors"] == ["launch"] and launch["provenance"] == "llm"


def test_rerun_replaces_the_inferred_tree(untreed):
    infer_tree(untreed, ScriptedLLM(PLANS), "run-a", cfg=CFG, progress=lambda *_: None)
    infer_tree(untreed, ScriptedLLM({"Build a small web game": PLANS["Build a small web game"]}), "run-a",
               cfg=CFG, progress=lambda *_: None)
    assert set(tree_of(untreed)) == {"a:root", "a:root/build-the-game", "a:root/launch"}
    assert len(untreed.annotations("span_task")) == 13


def test_max_depth_is_a_hard_stop(untreed):
    llm = ScriptedLLM(PLANS)
    summary = infer_tree(untreed, llm, "run-a", cfg={**CFG, "max_depth": 2}, progress=lambda *_: None)
    assert summary["calls"] == 1 and len(llm.prompts) == 1
    assert tree_of(untreed)["a:root/build-the-game"]["attrs"]["reason"] == "max_depth reached"


def test_prompts_are_source_neutral_and_grouped(untreed):
    llm = ScriptedLLM(PLANS)
    infer_tree(untreed, llm, "run-a", cfg=CFG, progress=lambda *_: None)
    root_prompt = llm.prompts[0]
    assert "Goal (root of the tree): Build a small web game" in root_prompt
    assert "| x1 | Cy | step 19 -> step 22 | Fix backend build error (attempt 4)" in root_prompt


def test_source_tree_is_copied_not_inferred(store):
    summary = infer_tree(store, ScriptedLLM({}), "run-a", cfg=CFG, progress=lambda *_: None)
    assert summary == {"source": "source", "assigned": 13, "tasks": 10, "calls": 0}
    assert {r["provenance"] for r in store.annotations("span_task", "episode_id = 'run-a'")} == {"source"}


def test_guards():
    groups = [{"id": f"g{i}", "span_ids": [f"s{i}"] * n} for i, n in enumerate([5, 5, 1])]
    keep = apply_guards({"decision": "split", "reason": "r", "children": [
        {"name": "A", "anchors": [], "items": ["g0", "g1"]},
        {"name": "B", "anchors": [], "items": ["g1", "g9"]}]}, groups, CFG)  # B: g1 taken, g9 unknown
    assert keep[0] == "keep" and "fewer than 2" in keep[1]
    split = apply_guards({"decision": "split", "reason": "r", "children": [
        {"name": "A", "anchors": [], "items": ["g0"]}, {"name": "B", "anchors": [], "items": ["g1"]},
        {"name": "C", "anchors": ["PR #9"], "items": ["g2"]}]}, groups, CFG)  # C is thin but a named artifact
    assert split[0] == "split" and [c["name"] for c in split[2]] == ["A", "B", "C"] and split[3] == []


def test_time_split_detection():
    groups = [{"id": f"g{i}", "start": s, "end": e, "span_ids": ["x"]} for i, (s, e) in
              enumerate([(0, 10), (20, 30), (40, 50), (5, 45)])]
    by_day = {"decision": "split", "children": [{"name": "Day 338 bootstrap", "items": ["g0"]},
                                                {"name": "Day 339 features", "items": ["g1"]}]}
    assert "named after time periods" in time_split_problem(by_day, groups)
    consecutive = {"decision": "split", "children": [{"name": n, "items": [g]} for n, g in
                                                     [("Scaffold", "g0"), ("Features", "g1"), ("Polish", "g2")]]}
    assert time_split_problem(consecutive, groups) is None  # sequential work is still work
    semantic = {"decision": "split", "children": [{"name": "Combat system", "items": ["g0", "g2"]},
                                                  {"name": "Code review", "items": ["g1", "g3"]},
                                                  {"name": "Testing", "items": ["g3"]}]}
    assert time_split_problem(semantic, groups) is None
    assert time_split_problem({"decision": "keep", "children": []}, groups) is None


class DaySplitThenFixed(ScriptedLLM):
    """Splits the root by day first; splits by work once told not to split by time."""

    def json(self, prompt_version, system, user, schema, effort="medium", max_tokens=16000):
        if "Path to this node: Build a small web game\n" in user + "\n" and "An earlier answer" not in user:
            self.prompts.append(user)
            items = re.findall(r"^(g\d+) \|", user, re.M)
            half = len(items) // 2
            return {"decision": "split", "reason": "by day", "status": "ongoing", "children": [
                {"name": "Day 1 work", "summary": "", "anchors": [], "status": "done", "items": items[:half]},
                {"name": "Day 2 work", "summary": "", "anchors": [], "status": "done", "items": items[half:]}]}
        return super().json(prompt_version, system, user, schema, effort, max_tokens)


def test_a_time_split_is_retried_once(untreed):
    llm = DaySplitThenFixed(PLANS)
    summary = infer_tree(untreed, llm, "run-a", cfg=CFG, progress=lambda *_: None)
    assert summary["calls"] == 3  # root, root again (corrected), then "Build the game"
    assert "An earlier answer split this node by time" in llm.prompts[1]
    assert "a:root/launch" in tree_of(untreed) and not any("day" in t for t in tree_of(untreed))


class AlwaysByDay(ScriptedLLM):
    def json(self, prompt_version, system, user, schema, effort="medium", max_tokens=16000):
        self.prompts.append(user)
        items = re.findall(r"^(g\d+) \|", user, re.M)
        return {"decision": "split", "reason": "by day", "status": "ongoing", "children": [
            {"name": f"Day {i} work", "summary": "", "anchors": [], "status": "done", "items": items[i::2]}
            for i in range(2)]}


def test_a_repeated_time_split_keeps_the_node_whole(untreed):
    infer_tree(untreed, AlwaysByDay({}), "run-a", cfg=CFG, progress=lambda *_: None)
    root = tree_of(untreed)["a:root"]
    assert set(tree_of(untreed)) == {"a:root"}
    assert root["attrs"]["decision"] == "keep" and "split by time twice" in root["attrs"]["reason"]


class FakeClient:
    def __init__(self, text='{"ok": true}', stop_reason="end_turn"):
        self.calls = 0
        usage = SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0,
                                cache_creation_input_tokens=0)
        response = SimpleNamespace(stop_reason=stop_reason, usage=usage, stop_details=None,
                                   content=[SimpleNamespace(type="text", text=text)])

        class Stream:
            def __enter__(s):
                return SimpleNamespace(get_final_message=lambda: response)

            def __exit__(s, *exc):
                return False

        def stream(**kwargs):
            self.calls += 1
            self.last = kwargs
            return Stream()
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=stream))


def test_llm_caches_results_and_sends_fallbacks():
    store, client = Store(), FakeClient()
    llm = LLM(store, model="claude-opus-5", client=client)
    schema = {"type": "object"}
    assert llm.json("v1", "sys", "user", schema) == {"ok": True}
    assert llm.json("v1", "sys", "user", schema) == {"ok": True}
    assert client.calls == 1 and llm.usage["cached"] == 1
    assert client.last["fallbacks"] == "default" and client.last["betas"] == ["server-side-fallback-2026-07-01"]
    assert client.last["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert client.last["output_config"]["format"]["schema"] == schema
    assert LLM(Store(), client=client).json("v2", "sys", "user", schema) == {"ok": True}  # new store, new call
    assert client.calls == 2


def test_llm_refusal_raises_after_recording_usage():
    store = Store()
    llm = LLM(store, client=FakeClient(stop_reason="refusal"))
    with pytest.raises(LLMError):
        llm.json("v1", "sys", "user", {"type": "object"})
    [row] = store.db.execute("SELECT input_tokens, output_tokens FROM llm_usage").fetchall()
    assert tuple(row) == (10, 5) and llm.usage["calls"] == 1


def test_cost_estimate():
    usage = {"input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_input_tokens": 1_000_000,
             "cache_creation_input_tokens": 0}
    assert cost("claude-opus-5", usage) == pytest.approx(5 + 2.5 + 0.5)
    assert cost("claude-opus-5", usage, batch=True) == pytest.approx(4.0)
