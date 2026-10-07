// Everything the Tasks view derives from a snapshot, computed once per snapshot.
import type { Actor, Loop, Message, Overlap, Sentence, Snapshot, Span, Task, Wait } from "../types";
import { actorColors, type LegendGroup } from "./colors";
import { CompressedTime } from "./timeScale";
import { type Item, packLanes, type Placed, rollupItems, TaskTree } from "./tree";

export interface WorkItem extends Item {
  label: string;
  span: Span;
}

export interface Model {
  snap: Snapshot;
  unit: "s" | "step";
  tz: string | null;
  now: number; // newest observed time
  end: number; // max(now, the episode's planned end)
  actors: Map<string, Actor>;
  colorOf: Map<string, string>;
  legend: LegendGroup[];
  tree: TaskTree;
  spanTask: Map<string, string>; // work span -> live task id (unassigned work -> root)
  direct: Map<string, WorkItem[]>;
  rolled: Map<string, WorkItem[]>;
  extent: Map<string, [number, number]>; // subtree time extent per task
  waits: WorkItem[];
  actions: Map<string, Span[]>; // work span id -> its action spans
  spanById: Map<string, Span>;
  loopById: Map<string, Loop>;
  messages: Message[]; // sorted by time
  messageIndex: Map<string, number>;
  sentencesByMessage: Map<string, Sentence[]>;
  mentions: Map<string, Set<string>>; // task id -> sentence ids that refer to it
  mentionSource: "labels" | "anchors";
  loopsByTask: Map<string, Loop[]>;
  overlapsByTask: Map<string, Overlap[]>;
  waitTargets: Map<string, Wait>;
  time: CompressedTime;
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "work", "task", "tasks", "build", "make", "general"]);

const GENERIC_ACRONYMS = new Set(["PR", "PRS"]); // too common to identify a task on their own

/** Terms that identify a task in chat: its anchors (LLM trees), else its name, distinctive words and
 * acronyms. Mirrors collab/mentions.py; keep the two in step. */
export function taskTerms(task: Task, root: Task): string[] {
  const anchors = task.attrs?.anchors ?? [];
  if (anchors.length) return anchors;
  const rootWords = new Set(root.name.toLowerCase().split(/\W+/));
  const words = task.name.toLowerCase().split(/[^\w#]+/).filter((w) => w.length >= 4 && !STOP.has(w) && !rootWords.has(w));
  const acronyms = (task.name.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !GENERIC_ACRONYMS.has(w));
  return [task.name, ...words, ...acronyms];
}

export function termRegex(terms: string[]): RegExp | null {
  const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  if (!clean.length) return null;
  const body = clean.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?<![\\w#])(?:${body})(?![\\w])`, "i");
}

const models = new WeakMap<Snapshot, Model>();

/** buildModel, cached per snapshot object so tabs share one model. */
export function modelFor(snap: Snapshot): Model {
  let m = models.get(snap);
  if (!m) {
    m = buildModel(snap);
    models.set(snap, m);
  }
  return m;
}

export function buildModel(snap: Snapshot): Model {
  const unit = snap.manifest?.time_unit ?? "s";
  const tz = snap.manifest?.display_tz ?? null;
  const actors = new Map(snap.actors.map((a) => [a.id, a]));
  const { colorOf, legend } = actorColors(snap.actors, snap.manifest);
  const rootId = snap.episode.root_task_id;
  const tree = new TaskTree(snap.tasks, rootId);

  // `now` is the newest time actually observed; open spans (still running in a live stream) end
  // there, never at the episode's planned end.
  let now = -Infinity;
  for (const s of snap.spans) now = Math.max(now, s.end ?? s.start);
  for (const m of snap.messages) now = Math.max(now, m.t);
  for (const e of snap.events) now = Math.max(now, e.t);
  if (!Number.isFinite(now)) now = snap.episode.start;
  const end = Math.max(now, snap.episode.end ?? now);
  const closeEnd = (s: Span) => s.end ?? now;

  const assigned = new Map(snap.span_task.map((r) => [r.span_id, tree.resolve(r.task_id)]));
  const spanTask = new Map<string, string>();
  const direct = new Map<string, WorkItem[]>();
  const waits: WorkItem[] = [];
  const actions = new Map<string, Span[]>();
  for (const s of snap.spans) {
    const item: WorkItem = { id: s.id, actor: s.actor, start: s.start, end: closeEnd(s), label: s.label, span: s };
    if (s.kind === "work") {
      const task = assigned.get(s.id) ?? (s.task_id && tree.tasks.has(s.task_id) ? tree.resolve(s.task_id) : rootId);
      spanTask.set(s.id, task);
      direct.set(task, [...(direct.get(task) ?? []), item]);
    } else if (s.kind === "wait") {
      waits.push(item);
    } else if (s.kind === "action" && s.parent_id) {
      actions.set(s.parent_id, [...(actions.get(s.parent_id) ?? []), s]);
    }
  }
  const rolled = rollupItems(tree, direct) as Map<string, WorkItem[]>;
  const extent = new Map<string, [number, number]>();
  for (const [id, items] of rolled) {
    if (items.length) extent.set(id, [Math.min(...items.map((i) => i.start)), Math.max(...items.map((i) => i.end))]);
  }

  const messages = [...snap.messages].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  const messageIndex = new Map(messages.map((m, i) => [m.id, i]));
  const sentencesByMessage = new Map<string, Sentence[]>();
  for (const s of snap.sentences) sentencesByMessage.set(s.message_id, [...(sentencesByMessage.get(s.message_id) ?? []), s]);
  for (const list of sentencesByMessage.values()) list.sort((a, b) => a.idx - b.idx);

  const mentions = new Map<string, Set<string>>();
  let mentionSource: Model["mentionSource"] = "anchors";
  if (snap.sentence_task.length) {
    mentionSource = "labels";
    for (const r of snap.sentence_task) {
      const task = tree.resolve(r.task_id);
      if (!mentions.has(task)) mentions.set(task, new Set());
      mentions.get(task)!.add(r.sentence_id);
    }
  } else {
    const root = tree.tasks.get(rootId)!;
    const byId = new Map(messages.map((m) => [m.id, m]));
    const regexes = tree.preorder().filter((id) => id !== rootId)
      .map((id) => [id, termRegex(taskTerms(tree.tasks.get(id)!, root))] as const)
      .filter((x): x is readonly [string, RegExp] => x[1] !== null);
    for (const s of snap.sentences) {
      const text = byId.get(s.message_id)?.text.slice(s.start_char, s.end_char) ?? "";
      for (const [id, rx] of regexes) {
        if (rx.test(text)) {
          if (!mentions.has(id)) mentions.set(id, new Set());
          mentions.get(id)!.add(s.id);
        }
      }
    }
  }

  const group = <T,>(rows: T[], key: (r: T) => string | null) => {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      if (k !== null) out.set(k, [...(out.get(k) ?? []), r]);
    }
    return out;
  };
  const loopsByTask = group(snap.loops, (l) => (l.task_id ? tree.resolve(l.task_id) : spanTask.get(l.span_ids[0]) ?? rootId));
  const overlapsByTask = group(snap.overlaps, (o) => tree.resolve(o.task_id));
  const waitTargets = new Map(snap.waits.map((w) => [w.span_id, w]));

  const intervals: [number, number][] = [
    ...snap.spans.map((s): [number, number] => [s.start, closeEnd(s)]),
    ...messages.map((m): [number, number] => [m.t, m.t]),
  ];
  const time = unit === "step" ? new CompressedTime(intervals, Infinity, 0) : new CompressedTime(intervals, 2 * 3600, 20 * 60);

  const spanById = new Map(snap.spans.map((s) => [s.id, s]));
  const loopById = new Map(snap.loops.map((l) => [l.id, l]));

  return {
    snap, unit, tz, now, end, actors, colorOf, legend, tree, spanTask, direct, rolled, extent, waits, actions, spanById, loopById,
    messages, messageIndex, sentencesByMessage, mentions, mentionSource, loopsByTask, overlapsByTask, waitTargets, time,
  };
}

export type RowMode = "rollup" | "bracket" | "leaf" | "general" | "waiting";

export interface Row {
  key: string;
  taskId: string | null;
  depth: number;
  mode: RowMode;
  items: WorkItem[];
  placed: (Placed & WorkItem)[];
  lanes: number;
}

function row(key: string, taskId: string | null, depth: number, mode: RowMode, items: WorkItem[]): Row {
  const drawn = mode === "bracket" ? [] : items;
  const { placed, lanes } = packLanes(drawn);
  const byId = new Map(drawn.map((i) => [i.id, i]));
  return { key, taskId, depth, mode, items, placed: placed.map((p) => ({ ...byId.get(p.id)!, lane: p.lane })), lanes };
}

/**
 * Rows for the current expansion. The root (goal) is always an overview track of all work.
 * An expanded internal node shows a bracket, then a "(general)" row for work attached to it
 * directly, then its children; a collapsed node shows its rolled-up work.
 */
export function visibleRows(m: Model, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const { tree } = m;
  const root = tree.rootId;
  rows.push(row(root, root, 0, "rollup", m.rolled.get(root) ?? []));
  const visit = (id: string, depth: number) => {
    const isLeaf = tree.isLeaf(id);
    if (id !== root) {
      if (isLeaf) rows.push(row(id, id, depth, "leaf", m.direct.get(id) ?? []));
      else if (expanded.has(id)) rows.push(row(id, id, depth, "bracket", m.rolled.get(id) ?? []));
      else rows.push(row(id, id, depth, "rollup", m.rolled.get(id) ?? []));
    }
    if (!isLeaf && (expanded.has(id) || id === root)) {
      const own = m.direct.get(id) ?? [];
      if (own.length && (id !== root || tree.children(root).length)) rows.push(row(`${id}::general`, id, depth + 1, "general", own));
      for (const c of tree.children(id)) visit(c, depth + 1);
    }
  };
  visit(root, 0);
  if (m.waits.length) rows.push(row("::waiting", null, 0, "waiting", m.waits));
  return rows;
}

/** Nodes expanded by "expand to level N": every internal node shallower than N. */
export function expandedToLevel(tree: TaskTree, level: number): Set<string> {
  return new Set(tree.preorder().filter((id) => !tree.isLeaf(id) && tree.depth(id) < level));
}
