import { describe, expect, it } from "vitest";
import type { Act, ActLink, Actor, Relation, Snapshot } from "../types";
import { buildSpeech, focusOf, speakers, summarize } from "./acts";
import { buildModel } from "./model";

const actor = (id: string, kind: Actor["kind"] = "agent", role: string | null = null): Actor =>
  ({ id, name: id.toUpperCase(), kind, role, attrs: kind === "agent" ? { family: "F" } : null });
const msg = (id: string, t: number, sender: string, text: string) =>
  ({ id, t, sender, channel_id: null, recipients: null, reply_to: null, text, has_reasoning: false, episode_id: "e" });
// one sentence per message, except m1 which has two
const MESSAGES = [
  msg("m1", 1, "a", "Can you draft the doc? I'll review it."),
  msg("m2", 2, "b", "Sure, drafting now."),
  msg("m3", 3, "v1", "Which charity won?"),
  msg("m4", 4, "b", "HKI won."),
  msg("m5", 5, "a", "Doc reviewed."),
  msg("m6", 6, "v2", "Please post on Twitter."),
  msg("m7", 7, "a", "No, we can't post there."),
  msg("m8", 8, "b", "Also, it has 12 charities."),
  msg("m9", 9, "b", "Draft is done."),
  msg("m10", 10, "a", "Good idea."),
];
const SENTENCES = [
  { id: "m1:0", message_id: "m1", idx: 0, start_char: 0, end_char: 23 },
  { id: "m1:1", message_id: "m1", idx: 1, start_char: 24, end_char: 39 },
  ...MESSAGES.slice(1).map((m) => ({ id: `${m.id}:0`, message_id: m.id, idx: 0, start_char: 0, end_char: m.text.length })),
];
const act = (sentence_id: string, a: Act) => ({ sentence_id, act: a, provenance: "llm" as const, confidence: null });
const link = (src_id: string, dst_id: string, relation: Relation): ActLink => ({ src_id, dst_id, relation, provenance: "llm", confidence: null });

const snap = {
  seq: 0, manifest: null, channels: [], events: [], addressees: [], waits: [], loops: [], overlaps: [], triggers: [], influence: [],
  metrics: [], sentence_task: [], span_task: [], spans: [],
  episode: { id: "e", name: "E", dataset_id: null, root_task_id: "r", start: 0, end: 10, actors: [], channels: null, attrs: null, root_name: "Goal", scope: "shared", status: null },
  actors: [actor("a"), actor("b"), actor("v1", "human", "viewer"), actor("v2", "human", "viewer")],
  tasks: [{ id: "r", name: "Goal", description: null, parent_id: null, scope: null, assignees: null, start: null, end: null, status: null, attrs: null, provenance: "source", confidence: null, merged_into: null }],
  messages: MESSAGES, sentences: SENTENCES,
  acts: [act("m1:0", "request"), act("m1:1", "commit"), act("m2:0", "accept"), act("m3:0", "question"), act("m4:0", "answer"),
    act("m5:0", "inform"), act("m6:0", "request"), act("m7:0", "reject"), act("m8:0", "inform"), act("m8:0", "propose"),
    act("m9:0", "inform"), act("m10:0", "accept")],
  act_links: [link("m2:0", "m1:0", "accepts"), link("m4:0", "m3:0", "answers"), link("m5:0", "m1:1", "fulfills"),
    link("m7:0", "m6:0", "rejects"), link("m8:0", "m4:0", "elaborates"), link("m9:0", "m1:0", "fulfills"),
    link("m10:0", "m8:0", "accepts")],
} as unknown as Snapshot;

describe("speech acts", () => {
  const model = buildModel(snap);
  const speech = buildSpeech(model);
  it("shows a sentence in the first group its acts fall in", () => {
    expect(speech.group.get("m8:0")).toBe("asks"); // inform + propose
    expect(speech.group.get("m5:0")).toBe("information");
    expect(speech.labeledMessages).toBe(10);
  });
  it("has one row per agent and one per human role", () => {
    expect(speakers(model, true).map((s) => [s.name, [...s.members]])).toEqual([["A", ["a"]], ["B", ["b"]], ["Viewers", ["v1", "v2"]]]);
    expect(speakers(model, false).map((s) => s.name)).toEqual(["A", "B"]);
  });
  it("counts what happened to questions, requests and promises", () => {
    const [a, b, viewers] = summarize(model, speech, speakers(model, true));
    expect(a.outcomes.requests.items).toEqual(["m1:0"]);
    expect([...a.outcomes.requests.done]).toEqual(["m1:0"]); // B accepted
    expect([...a.outcomes.promises.done]).toEqual(["m1:1"]); // "Doc reviewed." fulfills "I'll review it."
    expect(a.outcomes.promises.items).toEqual(["m1:1"]); // "Good idea." agrees with a proposal; it promises nothing
    expect([...b.outcomes.promises.done]).toEqual(["m2:0"]); // B said "Sure" to A's request, then reported the request done
    expect([...viewers.outcomes.questions.done]).toEqual(["m3:0"]);
    expect([...viewers.outcomes.requests.other]).toEqual(["m6:0"]); // declined
    expect(viewers.byGroup.asks).toBe(2);
    expect(a.byGroup).toEqual({ asks: 1, commitments: 3, corrections: 0, social: 0, information: 1 });
  });
  it("focuses a sentence with what it responds to and what responds to it", () => {
    const sums = summarize(model, speech, speakers(model, true));
    const name = (id: string) => id.toUpperCase();
    const f = focusOf(speech, sums, { kind: "sentence", id: "m4:0" }, false, name);
    expect([...f.kinds]).toEqual([["m4:0", "trigger"], ["m3:0", "follow"]]); // the elaboration is hidden by default
    expect(focusOf(speech, sums, { kind: "sentence", id: "m4:0" }, true, name).highlight.has("m8:0")).toBe(true);
    const p = focusOf(speech, sums, { kind: "metric", speaker: "a", metric: "promises" }, false, name);
    expect([...p.kinds]).toEqual([["m1:1", "trigger"], ["m5:0", "follow"]]);
  });
});
