import { describe, expect, it } from "vitest";
import type { Actor, InfluenceRow, Snapshot, Task, Trigger } from "../types";
import { buildEdges, buildNodes, curve, evidenceFor, type GraphNode, nodeRadius } from "./influence";
import { buildModel } from "./model";

const actor = (id: string, kind: Actor["kind"] = "agent"): Actor => ({ id, name: id.toUpperCase(), kind, role: null, attrs: { family: "F" } });
const actors = new Map([["a", actor("a")], ["b", actor("b")], ["h", actor("h", "human")]]);
const row = (src: string, dst: string, how: InfluenceRow["how"], effort: number, tasks: string[]): InfluenceRow =>
  ({ episode_id: "e", src, dst, how, effort, n_tasks: tasks.length, tasks });
const ALL = { hows: new Set(["asked", "proposed", "joined"] as const), minEffort: 0, humans: true };

describe("buildEdges", () => {
  const rows = [row("a", "b", "asked", 600, ["t1"]), row("a", "b", "joined", 300, ["t2"]), row("b", "a", "proposed", 120, ["t3"]),
    row("h", "a", "asked", 900, ["t4"])];
  it("merges kinds per direction and keeps both directions", () => {
    const edges = buildEdges(rows, actors, ALL);
    const ab = edges.find((e) => e.id === "a->b")!;
    expect([ab.effort, ab.byHow, ab.tasks]).toEqual([900, { asked: 600, joined: 300 }, ["t1", "t2"]]);
    expect(edges.map((e) => e.id).sort()).toEqual(["a->b", "b->a", "h->a"]);
  });
  it("filters by kind, size and humans", () => {
    expect(buildEdges(rows, actors, { ...ALL, hows: new Set(["asked"] as const) }).map((e) => e.id).sort()).toEqual(["a->b", "h->a"]);
    expect(buildEdges(rows, actors, { ...ALL, minEffort: 700 }).map((e) => e.id).sort()).toEqual(["a->b", "h->a"]);
    expect(buildEdges(rows, actors, { ...ALL, humans: false }).map((e) => e.id).sort()).toEqual(["a->b", "b->a"]);
  });
});

describe("curve", () => {
  it("bends the two directions to opposite sides", () => {
    const ab = curve([0, 0], [100, 0], 10, 10);
    const ba = curve([100, 0], [0, 0], 10, 10);
    expect(Math.sign(ab.control[1])).toBe(-Math.sign(ba.control[1]));
    const [sx, sy] = ab.d.slice(1).split(" ")[0].split(",").map(Number);
    expect(Math.hypot(sx, sy)).toBeCloseTo(10, 6); // starts on the node's rim, not its center
  });
});

describe("evidence", () => {
  const task = (id: string, parent: string | null, name: string, anchors?: string[]): Task => ({
    id, name, description: null, parent_id: parent, scope: null, assignees: null, start: null, end: null, status: null,
    attrs: anchors ? { anchors } : null, provenance: "llm", confidence: null, merged_into: null,
  });
  const msg = (id: string, t: number, sender: string, text: string) =>
    ({ id, t, sender, channel_id: null, recipients: null, reply_to: null, text, has_reasoning: false, episode_id: "e" });
  const sent = (mid: string, idx: number, s: number, e: number) => ({ id: `${mid}:${idx}`, message_id: mid, idx, start_char: s, end_char: e });
  const snap = {
    seq: 0, manifest: null, channels: [], events: [], acts: [], act_links: [], addressees: [], waits: [], loops: [], overlaps: [],
    influence: [], metrics: [], sentence_task: [],
    episode: { id: "e", name: "E", dataset_id: null, root_task_id: "r", start: 0, end: 100, actors: [], channels: null, attrs: null, root_name: "Goal", scope: "shared", status: null },
    actors: [actor("a"), actor("b")],
    tasks: [task("r", null, "Goal"), task("t1", "r", "Landing page", ["landing page"])],
    spans: [{ id: "s1", actor: "b", start: 20, end: 50, kind: "work", label: "landing", parent_id: null, task_id: null, attrs: null }],
    span_task: [{ episode_id: "e", span_id: "s1", task_id: "t1", provenance: "llm", confidence: null }],
    messages: [msg("m1", 5, "a", "Hi all. B, could you build the landing page?"), msg("m2", 30, "b", "The landing page is half done."),
      msg("m3", 40, "a", "Nice."), msg("m4", 60, "b", "Unrelated note.")],
    sentences: [sent("m1", 0, 0, 7), sent("m1", 1, 8, 45), sent("m2", 0, 0, 30), sent("m3", 0, 0, 5), sent("m4", 0, 0, 15)],
  } as unknown as Snapshot;
  const model = buildModel(snap);
  const triggers: Trigger[] = [{ episode_id: "e", task_id: "t1", worker: "b", triggered_by: "a", how: "asked", evidence: ["m1"], provenance: "llm", confidence: null, note: null }];
  it("marks the ask and the worker's follow-ups, even when far apart", () => {
    const [edge] = buildEdges([row("a", "b", "asked", 30, ["t1"])], actors, ALL);
    const { items, kinds } = evidenceFor(model, triggers, edge, ALL.hows);
    expect([...kinds.entries()].sort()).toEqual([["m1:1", "trigger"], ["m2:0", "follow"]]);
    expect(items.map((i) => [i.task, i.how, i.effort, i.firstWork, i.triggers.map((m) => m.id)])).toEqual([["t1", "asked", 30, 20, ["m1"]]]);
  });
  it("lists every point in chat order, quoting only the sentences that count", () => {
    const [edge] = buildEdges([row("a", "b", "asked", 30, ["t1"])], actors, ALL);
    const [item] = evidenceFor(model, triggers, edge, ALL.hows).items;
    expect(item.points.map((p) => [p.message.id, p.kind, p.excerpt])).toEqual([
      ["m1", "trigger", "B, could you build the landing page?"],
      ["m2", "follow", "The landing page is half done."],
    ]);
  });
  it("prefers the sentence labeled as the request", () => {
    const withActs = { ...snap, acts: [{ sentence_id: "m1:1", act: "request", provenance: "llm", confidence: null },
      { sentence_id: "m1:0", act: "social", provenance: "llm", confidence: null }] } as unknown as Snapshot;
    const m = buildModel(withActs);
    const [edge] = buildEdges([row("a", "b", "asked", 30, ["t1"])], actors, ALL);
    const { kinds, items } = evidenceFor(m, triggers, edge, ALL.hows);
    expect(kinds.get("m1:1")).toBe("trigger");
    expect(kinds.has("m1:0")).toBe(false);
    expect(items[0].points[0].excerpt).toBe("B, could you build the landing page?");
  });
  it("counts self-started work on nodes", () => {
    const nodes = buildNodes(model, [{ ...triggers[0], how: "self", triggered_by: null }], []);
    expect(nodes.find((n) => n.id === "b")).toMatchObject({ work: 30, self: 30, out: 0, in: 0 });
  });
});

describe("nodeRadius", () => {
  const nodes = [{ id: "a", out: 600, in: 0, work: 100 }, { id: "h", out: 900, in: 0, work: 0 }, { id: "b", out: 0, in: 900, work: 1000 }] as unknown as GraphNode[];
  it("sizes by the chosen measure", () => {
    const out = nodeRadius(nodes, "out");
    expect([out(nodes[1]), out(nodes[2])]).toEqual([24, 7]); // a human who got others working outranks an agent who didn't
    expect(out(nodes[0])).toBeGreaterThan(7);
    expect(nodeRadius(nodes, "in")(nodes[2])).toBe(24);
    expect(nodeRadius(nodes, "work")(nodes[1])).toBe(7);
    expect(new Set(nodes.map(nodeRadius(nodes, "same"))).size).toBe(1);
  });
});
