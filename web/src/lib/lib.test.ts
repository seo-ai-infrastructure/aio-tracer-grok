import { describe, expect, it } from "vitest";
import type { Actor, Snapshot, Task } from "../types";
import { actorColors } from "./colors";
import { buildModel, expandedToLevel, termRegex, visibleRows } from "./model";
import { CompressedTime, dayLabels, daySpans, density, timeTicks } from "./timeScale";
import { activeProfile, packLanes, rollupItems, TaskTree } from "./tree";

const task = (id: string, parent: string | null, extra: Partial<Task> = {}): Task => ({
  id, name: id, description: null, parent_id: parent, scope: null, assignees: null, start: null, end: null,
  status: null, attrs: null, provenance: "source", confidence: null, merged_into: null, ...extra,
});

describe("TaskTree", () => {
  const tasks = [task("r", null), task("a", "r"), task("b", "r"), task("a1", "a"), task("a1x", "a1"), task("m", "r", { merged_into: "b" })];
  const tree = new TaskTree(tasks, "r");
  it("handles any depth and merged ids", () => {
    expect(tree.depth("a1x")).toBe(3);
    expect(tree.path("a1x")).toEqual(["r", "a", "a1", "a1x"]);
    expect(tree.preorder()).toEqual(["r", "a", "a1", "a1x", "b"]);
    expect(tree.resolve("m")).toBe("b");
    expect(tree.maxDepth()).toBe(3);
  });
  it("rolls up descendants", () => {
    const it1 = { id: "s1", actor: "x", start: 0, end: 5 };
    const it2 = { id: "s2", actor: "y", start: 3, end: 8 };
    const rolled = rollupItems(tree, new Map([["a1x", [it1]], ["a", [it2]]]));
    expect(rolled.get("a")!.map((i) => i.id).sort()).toEqual(["s1", "s2"]);
    expect(rolled.get("b")).toEqual([]);
    expect(activeProfile(rolled.get("r")!)).toEqual([[0, 1], [3, 2], [5, 1], [8, 0]]);
  });
});

describe("packLanes", () => {
  it("uses as many lanes as the peak number of active actors", () => {
    const items = [
      { id: "1", actor: "x", start: 0, end: 10 }, { id: "2", actor: "x", start: 5, end: 12 }, // same actor overlaps: one lane
      { id: "3", actor: "y", start: 2, end: 6 }, { id: "4", actor: "z", start: 7, end: 9 },
    ];
    const { placed, lanes } = packLanes(items);
    expect(lanes).toBe(2);
    const lane = Object.fromEntries(placed.map((p) => [p.id, p.lane]));
    expect(lane["1"]).toBe(lane["2"]);
    expect(lane["3"]).not.toBe(lane["1"]);
  });
});

describe("CompressedTime", () => {
  const time = new CompressedTime([[0, 100], [150, 200], [10_000, 10_100]], 60, 20);
  it("keeps short gaps and compresses long ones", () => {
    expect(time.segments.map((s) => [s.start, s.end, s.u0])).toEqual([[0, 200, 0], [10_000, 10_100, 220]]);
    expect(time.total).toBe(320);
    expect(time.toU(5_100)).toBeCloseTo(210, 5);
  });
  it("round-trips", () => {
    for (const t of [-5, 0, 42, 200, 3_000, 10_050, 20_000]) expect(time.toT(time.toU(t))).toBeCloseTo(t, 6);
  });
  it("ticks only inside active segments", () => {
    const hours = new CompressedTime([[0, 7_200], [86_400, 90_000]], 3_600, 600);
    const ticks = timeTicks(hours, 0, hours.total, 0.05, "s");
    expect(ticks.every((t) => t <= 7_200 || t >= 86_400)).toBe(true);
    expect(timeTicks(new CompressedTime([[0, 60]], Infinity, 0), 0, 60, 10, "step")).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });
});

describe("day labels", () => {
  const H = 3600;
  const d0 = Date.UTC(2025, 3, 2, 17) / 1000; // Wed 4/2, 10 AM in Los Angeles
  // three working days, the third with a long midday break (two segments, one day)
  const time = new CompressedTime([[d0, d0 + 4 * H], [d0 + 24 * H, d0 + 28 * H], [d0 + 48 * H, d0 + 49 * H], [d0 + 52 * H, d0 + 53 * H]], 2 * H, 1200);
  const days = daySpans(time, "America/Los_Angeles");
  it("groups segments by calendar day", () => {
    expect(days.map((d) => [d.long, d.short])).toEqual([["Wed, 4/2", "4/2"], ["Thu, 4/3", "4/3"], ["Fri, 4/4", "4/4"]]);
    expect(days[2].end - days[2].start).toBe(5 * H);
  });
  const x = (w: number) => (t: number) => (time.toU(t) / time.total) * w;
  it("uses long labels when there is room and never overlaps", () => {
    expect(dayLabels(days, x(1200), 1200).map((l) => l.text)).toEqual(["Wed, 4/2", "Thu, 4/3", "Fri, 4/4"]);
    const tight = dayLabels(days, x(80), 80);
    expect(tight.map((l) => l.text)).toEqual(["4/2", "4/3"]); // short labels; the last would run off the edge
    for (let i = 1; i < tight.length; i++) expect(tight[i].x).toBeGreaterThanOrEqual(tight[i - 1].x + tight[i - 1].text.length * 6.6);
  });
  it("lets a label pinned to the left edge give way to the next day's", () => {
    const shifted = (t: number) => x(300)(t) - 104; // scrolled so day 1 began off screen and ends at x=5
    const labels = dayLabels(days, shifted, 300);
    expect(labels.map((l) => l.text)).toEqual(["Thu, 4/3", "Fri, 4/4"]);
  });
});

describe("density", () => {
  it("averages how many intervals are active per slice", () => {
    const d = density([[0, 10], [5, 10]], (t) => t, 12, 3);
    expect(d).toEqual([1, 1 + 1 / 3, 2, 2 / 3]);
  });
});

describe("colors", () => {
  const agent = (id: string, family: string): Actor => ({ id, name: id, kind: "agent", role: null, attrs: { family } });
  it("gives three families hues in the dataset's order and folds the rest", () => {
    const actors = [agent("c1", "Claude"), agent("c2", "Claude"), agent("g1", "GPT"), agent("m1", "Gemini"),
      agent("d1", "DeepSeek"), { id: "h", name: "adam", kind: "human", role: "organizer", attrs: null } as Actor];
    const { colorOf, legend } = actorColors(actors, { id: "x", name: null, time_unit: "s", display_tz: null, capabilities: null,
      attrs: { family_order: ["Gemini", "Claude", "GPT"] } });
    expect(colorOf.get("m1")).toBe("var(--series-1)");
    expect(colorOf.get("c2")).toBe("var(--series-2)");
    expect(colorOf.get("g1")).toBe("var(--series-3)");
    expect(colorOf.get("d1")).toBe("var(--series-other)");
    expect(legend.map((g) => g.family)).toEqual(["Gemini", "Claude", "GPT", "Other families", "Humans"]);
  });
  it("keeps a family's color when an earlier family is absent", () => {
    const manifest = { id: "x", name: null, time_unit: "s" as const, display_tz: null, capabilities: null,
      attrs: { family_order: ["Gemini", "Claude", "GPT"] } };
    const { colorOf } = actorColors([agent("c1", "Claude"), agent("g1", "GPT"), agent("x1", "Grok")], manifest);
    expect(colorOf.get("c1")).toBe("var(--series-2)");
    expect(colorOf.get("g1")).toBe("var(--series-3)");
    expect(colorOf.get("x1")).toBe("var(--series-other)"); // every hue belongs to a named family
  });
  it("without a preferred order, families take slots by agent count", () => {
    const { colorOf } = actorColors([agent("a", "X"), agent("b", "X"), agent("c", "Y")], null);
    expect([colorOf.get("a"), colorOf.get("c")]).toEqual(["var(--series-1)", "var(--series-2)"]);
  });
});

describe("model", () => {
  const snap = {
    seq: 0, manifest: { id: "d", name: null, time_unit: "step", display_tz: null, capabilities: null, attrs: null },
    episode: { id: "e", name: "E", dataset_id: "d", root_task_id: "r", start: 0, end: 50, actors: ["x", "y"], channels: null, attrs: null, root_name: "Goal", scope: "shared", status: null },
    actors: [{ id: "x", name: "X", kind: "agent", role: null, attrs: { family: "F" } }, { id: "y", name: "Y", kind: "agent", role: null, attrs: { family: "F" } }],
    channels: [], events: [],
    tasks: [task("r", null, { name: "Ship the game" }), task("a", "r", { name: "Landing page" }), task("b", "r", { name: "Backend" }), task("b1", "b", { name: "Database" })],
    spans: [
      { id: "s1", actor: "x", start: 0, end: 10, kind: "work", label: "copy", parent_id: null, task_id: null, attrs: null },
      { id: "s2", actor: "y", start: 5, end: 20, kind: "work", label: "db", parent_id: null, task_id: null, attrs: null },
      { id: "s3", actor: "x", start: 12, end: 18, kind: "work", label: "misc", parent_id: null, task_id: null, attrs: null },
      { id: "w1", actor: "x", start: 20, end: 30, kind: "wait", label: "", parent_id: null, task_id: null, attrs: null },
    ],
    span_task: [{ episode_id: "e", span_id: "s1", task_id: "a", provenance: "llm", confidence: null },
      { episode_id: "e", span_id: "s2", task_id: "b1", provenance: "llm", confidence: null },
      { episode_id: "e", span_id: "s3", task_id: "b", provenance: "llm", confidence: null }],
    messages: [{ id: "m1", t: 3, sender: "x", channel_id: null, recipients: null, reply_to: null, text: "The landing page is live. Backend next.", has_reasoning: false, episode_id: "e" }],
    sentences: [{ id: "m1:0", message_id: "m1", idx: 0, start_char: 0, end_char: 25 }, { id: "m1:1", message_id: "m1", idx: 1, start_char: 26, end_char: 39 }],
    sentence_task: [], acts: [], act_links: [], addressees: [], waits: [], loops: [], overlaps: [], influence: [], metrics: [],
  } as unknown as Snapshot;
  const m = buildModel(snap);
  it("rolls up, finds mentions by name, and lays out rows", () => {
    expect(m.rolled.get("b")!.map((i) => i.id).sort()).toEqual(["s2", "s3"]);
    expect([...m.mentions.get("a")!]).toEqual(["m1:0"]);
    expect([...m.mentions.get("b")!]).toEqual(["m1:1"]);
    const collapsed = visibleRows(m, new Set());
    expect(collapsed.map((r) => [r.key, r.mode])).toEqual([["r", "rollup"], ["a", "leaf"], ["b", "rollup"], ["::waiting", "waiting"]]);
    const open = visibleRows(m, expandedToLevel(m.tree, 2));
    expect(open.map((r) => [r.key, r.mode])).toEqual([["r", "rollup"], ["a", "leaf"], ["b", "bracket"], ["b::general", "general"], ["b1", "leaf"], ["::waiting", "waiting"]]);
    expect(open[0].lanes).toBe(2);
  });
  it("matches whole terms only", () => {
    const rx = termRegex(["PR #6", "UI"])!;
    expect(rx.test("merged PR #6 today")).toBe(true);
    expect(rx.test("merged PR #61")).toBe(false);
    expect(rx.test("Build")).toBe(false);
  });
});
