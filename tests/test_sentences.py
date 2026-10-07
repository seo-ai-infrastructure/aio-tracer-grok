import pytest

from collab.sentences import sentence_rows, split_sentences


def sents(text):
    return [text[s:e] for s, e in split_sentences(text)]


@pytest.mark.parametrize("text, expected", [
    ("I'll use Claude 3.7 Sonnet. Then GPT-5.1 will review.", ["I'll use Claude 3.7 Sonnet.", "Then GPT-5.1 will review."]),
    ("Merged at 10:41:50 AM. Next step is QA.", ["Merged at 10:41:50 AM.", "Next step is QA."]),
    ("See https://example.com/a.b.c. Then go.", ["See https://example.com/a.b.c.", "Then go."]),
    ("Fixed PR #6. Now reviewing PR #7.", ["Fixed PR #6.", "Now reviewing PR #7."]),
    ("Use a tool e.g. Figma for this. But not now.", ["Use a tool e.g. Figma for this.", "But not now."]),
    ("Use `foo. Bar` carefully. Done.", ["Use `foo. Bar` carefully.", "Done."]),
    ("Wait... Really? Yes!", ["Wait...", "Really?", "Yes!"]),
    ("**Done.** Next up: tests.", ["**Done.**", "Next up: tests."]),
    ("Plan A. Then plan B.", ["Plan A.", "Then plan B."]),
    ("see page no. 5 for details.", ["see page no. 5 for details."]),
])
def test_edge_cases(text, expected):
    assert sents(text) == expected


def test_lines_and_list_markers():
    text = "Status:\n- ✅ PR #137 merged\n- ⏳ PR #135 open\n\n1. First item\n2. Second item"
    assert sents(text) == ["Status:", "✅ PR #137 merged", "⏳ PR #135 open", "First item", "Second item"]


def test_fenced_code_stays_whole():
    text = "Run this:\n```\nx = 1. y = 2.\nprint(x)\n```\nThen report back."
    out = sents(text)
    assert out[0] == "Run this:" and out[-1] == "Then report back."
    assert out[1].startswith("```") and "print(x)" in out[1]


def test_rows_have_ids_and_exact_offsets():
    text = "  Hello there. General Kenobi!  "
    rows = sentence_rows("m1", text)
    assert [r["id"] for r in rows] == ["m1:0", "m1:1"]
    assert all(text[r["start_char"]:r["end_char"]] == r["text"] for r in rows)
    assert sentence_rows("m2", "") == [] and sentence_rows("m3", None) == []
