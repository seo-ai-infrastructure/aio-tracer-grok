"""Which chat messages mention a task: its anchor terms (LLM trees) or its name and distinctive words.

Mirrors taskTerms/termRegex in web/src/lib/model.ts; keep the two in step.
"""
import re

STOP = {"the", "and", "for", "with", "from", "into", "this", "that", "work", "task", "tasks", "build", "make", "general"}
GENERIC_ACRONYMS = {"PR", "PRS"}  # too common to identify a task on their own


def task_terms(task, root):
    """Anchors if the task has them; else its name, distinctive words (4+ letters) and acronyms."""
    anchors = (task.get("attrs") or {}).get("anchors") or []
    if anchors:
        return list(anchors)
    root_words = set(re.split(r"\W+", (root.get("name") or "").lower()))
    words = [w for w in re.split(r"[^\w#]+", task["name"].lower())
             if len(w) >= 4 and w not in STOP and w not in root_words]
    acronyms = [w for w in re.findall(r"\b[A-Z]{2,}\b", task["name"]) if w not in GENERIC_ACRONYMS]
    return [task["name"], *words, *acronyms]


def term_regex(terms):
    """Case-insensitive whole-term matcher ("PR #6" does not match "PR #61"); None if no usable terms."""
    clean = sorted({t.strip() for t in terms if len(t.strip()) >= 2}, key=len, reverse=True)
    if not clean:
        return None
    return re.compile(r"(?<![\w#])(?:" + "|".join(map(re.escape, clean)) + r")(?![\w])", re.I)


def task_regexes(tree):
    """{task id: compiled matcher} for every task below the root."""
    root = tree.tasks[tree.root_id]
    out = {}
    for tid in tree.preorder():
        if tid != tree.root_id:
            rx = term_regex(task_terms(tree.tasks[tid], root))
            if rx is not None:
                out[tid] = rx
    return out
