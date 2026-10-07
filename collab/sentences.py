"""Split chat messages into sentences with character offsets (for highlighting and labeling).

Tuned for agent chat: each line (bullet, header, paragraph) is split separately; fenced code
blocks stay whole; inline code, URLs, version numbers ("Claude 3.7", "GPT-5.1"), times and
common abbreviations never end a sentence. Leading list markers are excluded from the span.
"""
import re

ABBREVIATIONS = {"e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "prof", "approx", "est",
                 "fig", "cf", "al", "inc", "ltd", "jr", "sr", "a.m", "p.m", "u.s", "eg", "ie"}
ABBREV_BEFORE_DIGIT = {"no", "st", "pp", "vol"}  # only abbreviations when a number follows

FENCE = re.compile(r"```.*?(?:```|\Z)", re.S)
PROTECTED = re.compile(r"`[^`\n]*`|https?://\S+|www\.\S+")
LIST_MARKER = re.compile(r"\s*(?:[-*•+]\s+|\d{1,3}[.)]\s+|#{1,6}\s+|>\s+)+")
# End punctuation (plus closing quotes/brackets/emphasis), then whitespace, then the next sentence.
BOUNDARY = re.compile(r"[.!?]+[\"'”’)\]*_]*(?=\s+\S)")


def _protected_mask(line):
    mask = bytearray(len(line))
    for m in PROTECTED.finditer(line):
        # a URL's own trailing period is sentence punctuation, not part of the URL
        end = m.end() - (1 if m.group().startswith(("http", "www")) and m.group()[-1] in ".!?" else 0)
        for i in range(m.start(), end):
            mask[i] = 1
    return mask


def _is_boundary(line, m, mask):
    if mask[m.start()]:
        return False
    before = line[:m.start()]
    word = re.search(r"([A-Za-z.]+)$", before)
    token = word.group(1).lower().strip(".") if word else ""
    after = line[m.end():].lstrip()
    if m.group().startswith(".") and len(m.group().rstrip("\"'”’)]*_")) == 1:
        if token in ABBREVIATIONS:
            return False
        if token in ABBREV_BEFORE_DIGIT and after[:1].isdigit():
            return False
    if after[:1].islower():
        return False  # "e.g. like this" / mid-sentence punctuation
    return True


def _split_line(line, offset):
    """Sentence spans inside one line (no newlines, not a code fence)."""
    marker = LIST_MARKER.match(line)
    start = marker.end() if marker else 0
    mask = _protected_mask(line)
    spans = []
    for m in BOUNDARY.finditer(line, start):
        if _is_boundary(line, m, mask):
            spans.append((start, m.end()))
            start = m.end()
    spans.append((start, len(line)))
    out = []
    for s, e in spans:
        text = line[s:e]
        ls, rs = len(text) - len(text.lstrip()), len(text) - len(text.rstrip())
        if text.strip():
            out.append((offset + s + ls, offset + e - rs))
    return out


def split_sentences(text):
    """Return [(start, end), ...] character spans of the sentences in `text`."""
    spans, pos = [], 0
    for fence in FENCE.finditer(text):
        spans += _split_lines(text[pos:fence.start()], pos)
        s, e = fence.start(), fence.end()
        spans.append((s, e))
        pos = e
    spans += _split_lines(text[pos:], pos)
    return spans


def _split_lines(chunk, offset):
    out, pos = [], 0
    for line in chunk.split("\n"):
        out += _split_line(line, offset + pos)
        pos += len(line) + 1
    return out


def sentence_rows(message_id, text):
    """Rows for the `sentences` table: id is '<message_id>:<index>'."""
    return [{"id": f"{message_id}:{i}", "message_id": message_id, "idx": i,
             "start_char": s, "end_char": e, "text": text[s:e]}
            for i, (s, e) in enumerate(split_sentences(text or ""))]


def index_messages(store, messages, episode_ids=None, log=False):
    """(Re)split messages into sentences in the store; returns the number of sentence rows."""
    messages = list(messages)
    for i in range(0, len(messages), 500):
        chunk = [m["id"] for m in messages[i:i + 500]]
        store.delete("sentences", f"message_id IN ({', '.join('?' for _ in chunk)})", chunk, log=False)
    rows = [r for m in messages for r in sentence_rows(m["id"], m.get("text"))]
    store.upsert("sentences", rows, episode_ids=episode_ids, log=log)
    return len(rows)
