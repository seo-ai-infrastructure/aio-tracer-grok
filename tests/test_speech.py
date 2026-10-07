import re

import pytest

from collab.speech import Episode, first_days, guard, heuristic_acts, infer_acts, load_config, window_prompt, windows

SMALL = dict(load_config(), window=5, context=3, commitments=2, horizon={"s": 3600, "step": 100})


def acts_of(store):
    out = {}
    for r in store.annotations("acts"):
        out.setdefault(r["sentence_id"], set()).add((r["act"], r["provenance"]))
    return out


@pytest.mark.parametrize("text, agent, expected", [
    ("I'll wait for input handling to land before wiring the backend.", True, "wait"),
    ("@Bo can you start on the UI?", True, "request"),
    ("Which charity did we pick?", False, "question"),
    ("Thanks Ada!", True, "thank"),
    ("I'll draft the game concept.", True, "commit"),
    ("I'll click the Share button.", True, "narrate"),
    ("Let's split the work by charity.", True, "propose"),
    ("Backend build is failing.", True, "inform"),
    ("Hi everyone!", False, "social"),
    ("Let me know if there's anything else you need!", True, "request"),
    ("Since I can't complete CAPTCHAs, I paused at that step.", True, "inform"),
])
def test_rules_stand_in_for_the_model(text, agent, expected):
    assert heuristic_acts(text, agent) == [expected]


def test_windows_carry_context_and_earlier_commitments(store):
    ws = windows(Episode(store, "run-a", SMALL))
    assert [len(w["messages"]) for w in ws] == [5, 5, 2]
    assert [m["id"] for m in ws[1]["context"]] == ["a:m3", "a:m4", "a:m5"]
    assert [c[1] for c in ws[1]["commitments"]] == ["a:m2:0"]  # Ada's "I'll draft the game concept."
    assert [c[1] for c in ws[2]["commitments"]] == ["a:m2:0", "a:m6:0"]


def test_prompt_aliases_cover_every_sentence(store):
    ep = Episode(store, "run-a", SMALL)
    p = window_prompt(ep, windows(ep)[1])
    assert list(p["labeled"].values()) == ["a:m6:0", "a:m7:0", "a:m7:1", "a:m8:0", "a:m9:0", "a:m9:1", "a:m10:0", "a:m10:1"]
    assert p["targets"]["k1"] == "a:m2:0" and p["targets"]["c1"] == "a:m3:0" and p["targets"]["s1"] == "a:m6:0"
    assert "Ada (agent) → Bo:" in p["text"]  # the source's recipients
    assert all(sid in p["order"] and sid in p["speaker"] for sid in p["targets"].values())


def test_guard_keeps_only_what_the_window_allows(store):
    ep = Episode(store, "run-a", SMALL)
    acts, links = guard(window_prompt(ep, windows(ep)[1]), {
        "labels": [{"s": "s2", "acts": ["accept", "request", "accept"]}, {"s": "s99", "acts": ["inform"]},
                   {"s": "s3", "acts": ["commit"]}, {"s": "s4", "acts": ["dance"]}],
        "links": [{"from": "s2", "to": "s1", "relation": "accepts"},      # kept
                  {"from": "s5", "to": "s2", "relation": "fulfills"},     # kept
                  {"from": "s1", "to": "s2", "relation": "answers"},      # points forward: dropped
                  {"from": "s2", "to": "c9", "relation": "answers"},      # unknown target: dropped
                  {"from": "s2", "to": "s1", "relation": "accepts"},      # duplicate: dropped
                  {"from": "s3", "to": "s2", "relation": "commits_to"},   # Bo committing to Bo: dropped
                  {"from": "s3", "to": "s1", "relation": "fulfills"},     # a promise fulfills nothing: dropped
                  {"from": "s3", "to": "s2", "relation": "elaborates"},   # Bo adding to Bo: kept
                  {"from": "s5", "to": "s3", "relation": "elaborates"}],  # Ada "elaborating" Bo: dropped
    })
    assert acts == {"a:m7:0": ["accept", "request"], "a:m7:1": ["commit"]}
    assert links == [("a:m7:0", "a:m6:0", "accepts"), ("a:m9:0", "a:m7:0", "fulfills"), ("a:m7:1", "a:m7:0", "elaborates")]


class ScriptedModel:
    """Labels the window holding Bo's "Yes please, take keyboard events." and skips the others."""

    def __init__(self):
        self.calls = 0

    def json_many(self, prompt_version, system, requests, effort="medium", batch=False, progress=print):
        out = {}
        for key, (user, schema) in requests.items():
            self.calls += 1
            alias = {re.search(r"(\w\d+) " + re.escape(t), user).group(1): t for t in
                     ["@Bo I can help with input handling if you want.", "Yes please, take keyboard events.",
                      "Keyboard events done.", "Thanks Ada!"] if re.search(r"(\w\d+) " + re.escape(t), user)}
            if "Yes please, take keyboard events." not in alias.values():
                continue
            a = {t: k for k, t in alias.items()}
            out[key] = {"labels": [{"s": a["@Bo I can help with input handling if you want."], "acts": ["propose", "commit"]},
                                   {"s": a["Yes please, take keyboard events."], "acts": ["accept", "request"]},
                                   {"s": a["Keyboard events done."], "acts": ["inform"]},
                                   {"s": a["Thanks Ada!"], "acts": ["thank"]}],
                        "links": [{"from": a["Yes please, take keyboard events."], "to": a["@Bo I can help with input handling if you want."], "relation": "accepts"},
                                  {"from": a["Keyboard events done."], "to": a["Yes please, take keyboard events."], "relation": "fulfills"},
                                  {"from": a["Thanks Ada!"], "to": a["Keyboard events done."], "relation": "acknowledges"}]}
        return out


def test_model_labels_win_and_the_rest_fall_back_to_rules(store):
    model = ScriptedModel()
    summary = infer_acts(store, model, "run-a", cfg=SMALL, progress=lambda *_: None)
    assert model.calls == 3 and summary["sentences"] == 19 and summary["fallback"] == 15
    a = acts_of(store)
    assert a["a:m7:0"] == {("accept", "llm"), ("request", "llm")}
    assert a["a:m8:0"] == {("wait", "heuristic")}
    assert a["a:m2:1"] == {("request", "heuristic")}
    links = {(r["src_id"], r["dst_id"], r["relation"]) for r in store.annotations("act_links")}
    assert links == {("a:m7:0", "a:m6:0", "accepts"), ("a:m9:0", "a:m7:0", "fulfills"), ("a:m10:1", "a:m9:0", "acknowledges")}
    infer_acts(store, None, "run-a", cfg=SMALL, progress=lambda *_: None)  # a rerun replaces, never duplicates
    assert acts_of(store)["a:m7:0"] == {("request", "heuristic")} and not store.annotations("act_links")


def test_days_select_whole_calendar_days():
    day = 86_400
    msgs = [{"id": str(i), "t": t} for i, t in enumerate([10 * 3600, 11 * 3600, day + 9 * 3600, 3 * day, 3 * day + 60])]
    assert [m["id"] for m in first_days(msgs, 1, "UTC")] == ["0", "1"]
    assert [m["id"] for m in first_days(msgs, 2, "UTC")] == ["0", "1", "2"]
    assert len(first_days(msgs, 9, "UTC")) == 5


def test_days_need_clock_time(store):
    with pytest.raises(ValueError):
        Episode(store, "run-a", SMALL, days=1)
