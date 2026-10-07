"""Task-tree utilities: any depth, rooted at the episode goal.

Works on plain task dicts ({id, parent_id, merged_into?, ...}) so it serves both the pipeline
and tests; web/src/tree.ts mirrors the parts the UI needs.
"""
from collections import defaultdict


class TaskTree:
    def __init__(self, tasks, root_id):
        self.tasks = {t["id"]: t for t in tasks}
        if root_id not in self.tasks:
            raise KeyError(f"root task {root_id} not found")
        self.root_id = root_id
        self.children_of = defaultdict(list)
        for t in tasks:
            if t.get("merged_into") or t["id"] == root_id:
                continue
            if t.get("parent_id") in self.tasks:
                self.children_of[t["parent_id"]].append(t["id"])
        for kids in self.children_of.values():
            kids.sort(key=lambda i: (self.tasks[i].get("start") is None, self.tasks[i].get("start") or 0, i))
        self.live = set(self.preorder())

    def resolve(self, task_id):
        """Follow merged_into to the live node a (possibly merged) task id now points at."""
        seen = set()
        while task_id in self.tasks and self.tasks[task_id].get("merged_into") and task_id not in seen:
            seen.add(task_id)
            task_id = self.tasks[task_id]["merged_into"]
        return task_id

    def children(self, task_id):
        return list(self.children_of.get(task_id, []))

    def parent(self, task_id):
        return None if task_id == self.root_id else self.tasks[task_id].get("parent_id")

    def ancestors(self, task_id):
        """Nearest first, ending at the root."""
        out, node = [], self.parent(task_id)
        while node is not None:
            out.append(node)
            node = self.parent(node)
        return out

    def path(self, task_id):
        return list(reversed(self.ancestors(task_id))) + [task_id]

    def depth(self, task_id):
        return len(self.ancestors(task_id))

    def preorder(self, task_id=None):
        task_id = self.root_id if task_id is None else task_id
        out, stack = [], [task_id]
        while stack:
            node = stack.pop()
            out.append(node)
            stack.extend(reversed(self.children_of.get(node, [])))
        return out

    def subtree(self, task_id):
        return set(self.preorder(task_id))

    def is_leaf(self, task_id):
        return not self.children_of.get(task_id)

    def max_depth(self):
        return max(self.depth(t) for t in self.live)

    def breadth_per_level(self):
        counts = defaultdict(int)
        for t in self.live:
            counts[self.depth(t)] += 1
        return [counts[d] for d in range(self.max_depth() + 1)]


def merge_intervals(intervals):
    """Merge overlapping (start, end) pairs; open ends (None) extend to infinity."""
    norm = sorted((s, float("inf") if e is None else e) for s, e in intervals)
    out = []
    for s, e in norm:
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, None if e == float("inf") else e) for s, e in out]


def rollup(tree, spans, span_task):
    """Per node, per actor: merged intervals of work on that node or any descendant.

    `span_task` maps span id -> task id (possibly a merged id; resolved here).
    Returns {task_id: {actor: [(start, end), ...]}}.
    """
    direct = defaultdict(lambda: defaultdict(list))
    for s in spans:
        task = span_task.get(s["id"])
        if task is None:
            continue
        task = tree.resolve(task)
        if task in tree.live:
            direct[task][s["actor"]].append((s["start"], s["end"]))
    out = {}
    for node in reversed(tree.preorder()):  # children before parents
        per_actor = defaultdict(list)
        for actor, ivs in direct[node].items():
            per_actor[actor].extend(ivs)
        for child in tree.children(node):
            for actor, ivs in out[child].items():
                per_actor[actor].extend(ivs)
        out[node] = {a: merge_intervals(ivs) for a, ivs in per_actor.items()}
    return out


def active_profile(per_actor):
    """Step function of how many distinct actors are active: [(t, count), ...] at each change."""
    edges = []
    for ivs in per_actor.values():
        for s, e in ivs:
            edges.append((s, 1))
            if e is not None:
                edges.append((e, -1))
    edges.sort(key=lambda x: (x[0], x[1]))  # ends before starts at the same instant
    profile, count = [], 0
    for t, d in edges:
        count += d
        if profile and profile[-1][0] == t:
            profile[-1] = (t, count)
        else:
            profile.append((t, count))
    return profile


def max_active(per_actor):
    return max((c for _, c in active_profile(per_actor)), default=0)


def general_spans(tree, spans, span_task, task_id):
    """Spans attached directly to an internal node; shown in its '(general)' row when expanded."""
    if tree.is_leaf(task_id):
        return []
    return [s for s in spans if span_task.get(s["id"]) is not None and tree.resolve(span_task[s["id"]]) == task_id]


def move(tasks, task_id, new_parent_id):
    """Re-parent a task (returns an updated copy of the task dict); refuses to create a cycle."""
    node = new_parent_id
    while node is not None:
        if node == task_id:
            raise ValueError(f"moving {task_id} under {new_parent_id} would create a cycle")
        node = tasks[node].get("parent_id")
    return {**tasks[task_id], "parent_id": new_parent_id}


def merge(tasks, src_id, dst_id):
    """Merge src into dst: src's children move to dst, src is marked merged_into dst.

    Returns the list of updated task dicts. Span assignments to src keep working via
    TaskTree.resolve, so ids stay stable for the UI.
    """
    if src_id == dst_id:
        return []
    node = dst_id
    while node is not None:
        if node == src_id:
            raise ValueError(f"cannot merge {src_id} into its own descendant {dst_id}")
        node = tasks[node].get("parent_id")
    updated = [move(tasks, c["id"], dst_id) for c in tasks.values()
               if c.get("parent_id") == src_id and not c.get("merged_into")]
    updated.append({**tasks[src_id], "merged_into": dst_id})
    return updated
