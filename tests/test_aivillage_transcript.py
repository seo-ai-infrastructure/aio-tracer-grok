import json
from pathlib import Path

import pytest

from collab.adapters import aivillage_transcript as av
from collab.validate import check

T0 = 1_700_000_000  # an arbitrary UTC epoch second


def ev(sec, typ, who, **kw):
    from datetime import datetime, timezone
    iso = datetime.fromtimestamp(T0 + sec, timezone.utc).isoformat().replace("+00:00", "Z")
    key = "speakerName" if typ in ("AGENT_TALK", "USER_TALK") else "agentName"
    return {"timestamp": iso, "time": "", "type": typ, key: who, **kw}


@pytest.fixture
def transcript(tmp_path):
    day1 = [
        ev(0, "USER_TALK", "adam", content="New goal: build a game."),
        ev(1, "USER_TALK", "SomeViewer", content="good luck"),
        ev(10, "START_USING_COMPUTER", "Claude Opus 4.1", goal="Set up repo", thinking="start with the repo"),
        ev(12, "AGENT_TALK", "o3", content="I'll review. Then merge.", thinking="plan"),
        ev(20, "WAIT", "o3"),
        ev(20, "AGENT_TALK", "o3", content="I'll wait."),  # logged together with the WAIT
        ev(80, "AGENT_TALK", "o3", content="Back."),
        ev(100, "STOP_USING_COMPUTER", "Claude Opus 4.1"),
        ev(110, "START_USING_COMPUTER", "Claude Opus 4.1", goal="Write tests"),
        ev(150, "START_USING_COMPUTER", "Claude Opus 4.1", goal="Fix tests"),  # previous never stopped
        ev(200, "PAUSE", "o3", duration="0h 3m 0s"),
        ev(300, "USER_TALK", "automated", content="pausing the village for today"),
    ]
    day2 = [
        ev(90_000, "CONSOLIDATE", "Gemini 2.5 Pro", goal="Draft landing page"),
        ev(90_600, "CONSOLIDATE", "Gemini 2.5 Pro", goal="Polish landing page"),
        ev(90_900, "WAIT", "Gemini 2.5 Pro"),
        ev(91_000, "SEARCH_HISTORY", "o3", query="PR #6", answerToQuery="merged"),
    ]
    data = {"village": {"id": "v1", "name": "test"}, "days": [
        {"day": 1, "date": "2023-11-14", "events": day1},
        {"day": 2, "date": "2023-11-15", "events": day2},
        {"day": 3, "date": "2023-11-16", "events": []},
    ]}
    path = tmp_path / "transcript.json"
    path.write_text(json.dumps(data))
    return path


EPISODES = [{"id": "game", "goal": "Build a game", "days": [1, 2]}]


def recs(path, **kw):
    return list(av.records(path, episodes=EPISODES, **kw))


def spans_of(records, actor, kind=None):
    return sorted(((r["start"] - T0, r["end"] - T0, r["label"]) for r in records if r["record"] == "span"
                   and r["actor"] == actor and (kind is None or r["kind"] == kind)))


def test_output_is_valid_neutral_trace(transcript):
    assert [i for i in check(recs(transcript)) if i[0] == "error"] == []


def test_computer_sessions_pair_and_close(transcript):
    assert spans_of(recs(transcript), "claude-opus-4-1", "work") == [
        (10, 100, "Set up repo"), (110, 150, "Write tests"), (150, 300, "Fix tests")]  # last closes at day end


def test_waits_skip_the_paired_message_and_pauses_use_duration(transcript):
    waits = spans_of(recs(transcript), "o3", "wait")
    assert waits == [(20, 80, "wait"), (200, 300, "pause")]  # pause capped at day end (3 min > 100 s)


def test_consolidations_become_work_only_without_sessions(transcript):
    assert spans_of(recs(transcript), "gemini-2-5-pro", "work") == [
        (90_000, 90_600, "Draft landing page"), (90_600, 90_900, "Polish landing page")]


def test_roles_families_and_messages(transcript):
    r = recs(transcript)
    actors = {a["id"]: a for a in r if a["record"] == "actor"}
    assert actors["adam"]["role"] == "organizer" and actors["someviewer"]["role"] == "viewer"
    assert actors["automated"]["kind"] == "system"
    assert actors["o3"]["attrs"]["family"] == "GPT" and actors["claude-opus-4-1"]["attrs"]["family"] == "Claude"
    msgs = [m for m in r if m["record"] == "message"]
    assert len(msgs) == 6 and msgs[2]["reasoning"] == "plan"
    assert {e["type"] for e in r if e["record"] == "event"} == {"consolidate", "search_history"}


def test_episode_window_actors_and_dataset(transcript):
    [ep] = [r for r in recs(transcript) if r["record"] == "episode"]
    assert ep["dataset_id"] == "aivillage" and ep["root_task_id"] == "game:goal"
    assert (ep["start"] - T0, ep["end"] - T0) == (0, 91_000)
    assert ep["actors"] == ["claude-opus-4-1", "gemini-2-5-pro", "o3"]


def test_ids_are_deterministic_and_independent_of_day_selection(transcript):
    ids = lambda rs: {r["id"] for r in rs if r["record"] in ("message", "span", "event")}
    full, again, day2 = recs(transcript), recs(transcript), recs(transcript, days=[2])
    assert ids(full) == ids(again)
    assert ids(day2) <= ids(full) and ids(day2)


def test_parse_duration():
    assert av.parse_duration("0h 25m 0s") == 1500
    assert av.parse_duration("10 seconds") == 10
    assert av.parse_duration("1 hour 30 minutes") == 5400
    assert av.parse_duration(None) == 0


def test_no_source_specific_code_outside_adapters():
    pkg = Path(av.__file__).resolve().parents[1]
    offenders = [p.name for p in pkg.rglob("*.py") if "adapters" not in p.parts
                 and "aivillage" in p.read_text().lower()]
    assert offenders == []
