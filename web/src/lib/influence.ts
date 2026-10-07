// Influence graph data: who got whom to work (see collab/influence.py). Pure and unit-tested.
import type { Actor, How, InfluenceRow, Message, Trigger } from "../types";
import { speechFor } from "./acts";
import type { Model } from "./model";

export const CREDITED: How[] = ["asked", "proposed", "joined"];

export interface Filters {
  hows: Set<How>;
  minEffort: number; // in source units (seconds or steps)
  humans: boolean;
}

export interface Edge {
  id: string; // "src->dst"
  src: string;
  dst: string;
  effort: number;
  byHow: Partial<Record<How, number>>;
  tasks: string[];
}

export interface GraphNode {
  id: string;
  actor: Actor;
  work: number; // all the actor's work time in the episode
  out: number; // work it triggered in others (shown edges)
  in: number; // its work that others triggered (shown edges)
  self: number; // its self-started work
}

export type NodeSize = "out" | "in" | "work" | "same";
export const NODE_SIZES: [NodeSize, string][] = [
  ["out", "got others working"], ["in", "got to work by others"], ["work", "total work"], ["same", "equal"],
];

/** Radius by the chosen measure: area grows with the minutes (square root), with a floor so every node stays clickable. */
export function nodeRadius(nodes: GraphNode[], by: NodeSize): (n: GraphNode) => number {
  if (by === "same") return () => 13;
  const value = (n: GraphNode) => (by === "out" ? n.out : by === "in" ? n.in : n.work);
  const max = Math.max(1, ...nodes.map(value));
  return (n) => 7 + 17 * Math.sqrt(value(n) / max);
}

export const edgeId = (src: string, dst: string) => `${src}->${dst}`;

export function buildEdges(rows: InfluenceRow[], actors: Map<string, Actor>, f: Filters): Edge[] {
  const out = new Map<string, Edge>();
  for (const r of rows) {
    if (!f.hows.has(r.how)) continue;
    if (!f.humans && actors.get(r.src)?.kind !== "agent") continue;
    const id = edgeId(r.src, r.dst);
    const e = out.get(id) ?? { id, src: r.src, dst: r.dst, effort: 0, byHow: {}, tasks: [] };
    e.effort += r.effort;
    e.byHow[r.how] = (e.byHow[r.how] ?? 0) + r.effort;
    for (const t of r.tasks) if (!e.tasks.includes(t)) e.tasks.push(t);
    out.set(id, e);
  }
  return [...out.values()].filter((e) => e.effort >= f.minEffort).sort((a, b) => b.effort - a.effort);
}

/** Time `worker` spent on work attached directly to `task`. */
export function directTime(model: Model, task: string, worker: string): number {
  return (model.direct.get(task) ?? []).filter((i) => i.actor === worker).reduce((s, i) => s + (i.end - i.start), 0);
}

export function buildNodes(model: Model, triggers: Trigger[], edges: Edge[]): GraphNode[] {
  const work = new Map<string, number>();
  for (const it of model.rolled.get(model.tree.rootId) ?? []) work.set(it.actor, (work.get(it.actor) ?? 0) + (it.end - it.start));
  const self = new Map<string, number>();
  for (const t of triggers) {
    if (t.how === "self") self.set(t.worker, (self.get(t.worker) ?? 0) + directTime(model, model.tree.resolve(t.task_id), t.worker));
  }
  const ids = new Set<string>([...work.keys()]);
  for (const e of edges) ids.add(e.src).add(e.dst);
  const nodes: GraphNode[] = [];
  for (const id of ids) {
    const actor = model.actors.get(id);
    if (!actor) continue;
    nodes.push({
      id, actor, work: work.get(id) ?? 0, self: self.get(id) ?? 0,
      out: edges.filter((e) => e.src === id).reduce((s, e) => s + e.effort, 0),
      in: edges.filter((e) => e.dst === id).reduce((s, e) => s + e.effort, 0),
    });
  }
  return nodes.sort((a, b) => a.actor.name.localeCompare(b.actor.name));
}

/**
 * A curved edge from a to b that stops at the node rims. The bend is to the left of the direction
 * of travel, so the two directions between a pair bend to opposite sides and never overlap.
 */
export function curve(a: [number, number], b: [number, number], ra: number, rb: number, bend = 0.2) {
  const [ax, ay] = a;
  const [bx, by] = b;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
  const [cx, cy] = [(ax + bx) / 2 + nx * bend * len, (ay + by) / 2 + ny * bend * len];
  const toward = (px: number, py: number, qx: number, qy: number, r: number): [number, number] => {
    const l = Math.hypot(qx - px, qy - py) || 1;
    return [px + ((qx - px) / l) * r, py + ((qy - py) / l) * r];
  };
  const [sx, sy] = toward(ax, ay, cx, cy, ra);
  const [ex, ey] = toward(bx, by, cx, cy, rb);
  return { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, control: [cx, cy] as [number, number], mid: [(sx + 2 * cx + ex) / 4, (sy + 2 * cy + ey) / 4] as [number, number] };
}

export type SentenceKind = "trigger" | "follow";
const ASKING = new Set(["request", "propose", "question"]);

export interface EvidencePoint {
  message: Message;
  kind: SentenceKind; // the initiator's ask, proposal or mention, or one of the worker's later messages
  excerpt: string; // the sentences that make it evidence
}

export interface EvidenceItem {
  task: string;
  how: How;
  effort: number;
  firstWork: number | null;
  triggers: Message[]; // the initiator's messages that show it
  follows: Message[]; // the worker's later messages about the task
  points: EvidencePoint[]; // both, in chat order
}

const EXCERPT = 240;

/**
 * Everything in the chat that backs an edge: the initiator's trigger sentences (preferring those
 * that mention the task) and the worker's later sentences about the same tasks.
 */
export function evidenceFor(model: Model, triggers: Trigger[], edge: Edge, hows: Set<How>): { items: EvidenceItem[]; kinds: Map<string, SentenceKind> } {
  const byId = new Map(model.messages.map((m) => [m.id, m]));
  const order = new Map(model.messages.map((m, i) => [m.id, i]));
  const kinds = new Map<string, SentenceKind>();
  const items: EvidenceItem[] = [];
  const sentencesOf = (m: Message) => model.sentencesByMessage.get(m.id) ?? [];
  const speech = speechFor(model);
  const excerpt = (m: Message, keep: (id: string) => boolean) => {
    const picked = sentencesOf(m).filter((s) => keep(s.id)).map((s) => m.text.slice(s.start_char, s.end_char).trim());
    const text = picked.length ? picked.join(" … ") : m.text;
    return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
  };
  for (const t of triggers) {
    const task = model.tree.resolve(t.task_id);
    if (t.worker !== edge.dst || t.triggered_by !== edge.src || !hows.has(t.how) || !edge.tasks.includes(task)) continue;
    const about = model.mentions.get(task) ?? new Set<string>();
    const starts = (model.direct.get(task) ?? []).filter((i) => i.actor === edge.dst).map((i) => i.start);
    const firstWork = starts.length ? Math.min(...starts) : null;
    let trig = (t.evidence ?? []).map((id) => byId.get(id)).filter((m): m is Message => !!m && m.sender === edge.src);
    if (!trig.length && firstWork !== null) {
      // no cited message (e.g. "joined"): the initiator's latest mention of the task before the worker started
      const prior = model.messages.filter((m) => m.sender === edge.src && m.t <= firstWork && sentencesOf(m).some((s) => about.has(s.id)));
      trig = prior.slice(-1);
    }
    const points: EvidencePoint[] = [];
    for (const m of trig) {
      // The ask itself: sentences labeled as a request or proposal (when speech acts exist), preferring those about
      // the task; else the sentences that mention the task; else the whole message.
      const all = sentencesOf(m);
      const on = all.filter((s) => about.has(s.id));
      const asks = t.how === "joined" ? [] : all.filter((s) => (speech.acts.get(s.id) ?? []).some((a) => ASKING.has(a)));
      const askOn = asks.filter((s) => about.has(s.id));
      const pick = new Set((askOn.length ? askOn : asks.length ? asks : on.length ? on : all).map((s) => s.id));
      for (const id of pick) kinds.set(id, "trigger");
      points.push({ message: m, kind: "trigger", excerpt: excerpt(m, (id) => pick.has(id)) });
    }
    const since = Math.min(...trig.map((m) => m.t), firstWork ?? Infinity);
    const follows = model.messages.filter((m) => m.sender === edge.dst && m.t >= since && sentencesOf(m).some((s) => about.has(s.id)));
    for (const m of follows) {
      for (const s of sentencesOf(m)) if (about.has(s.id) && !kinds.has(s.id)) kinds.set(s.id, "follow");
      points.push({ message: m, kind: "follow", excerpt: excerpt(m, (id) => about.has(id)) });
    }
    points.sort((a, b) => (order.get(a.message.id) ?? 0) - (order.get(b.message.id) ?? 0));
    items.push({ task, how: t.how, effort: directTime(model, task, edge.dst), firstWork, triggers: trig, follows, points });
  }
  items.sort((a, b) => (a.triggers[0]?.t ?? a.firstWork ?? 0) - (b.triggers[0]?.t ?? b.firstWork ?? 0));
  return { items, kinds };
}
