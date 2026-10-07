import { describe, expect, it } from "vitest";
import type { Snapshot } from "../types";
import { applyDeltas, type Delta } from "./deltas";

const base = {
  seq: 10, manifest: null,
  episode: { id: "e", name: "E", dataset_id: null, root_task_id: "r", start: 0, end: null, actors: [], channels: null, attrs: null, root_name: "Goal", scope: "shared", status: null },
  actors: [], channels: [], tasks: [{ id: "r", name: "Goal" }], messages: [], spans: [], events: [], sentences: [],
  span_task: [], sentence_task: [], acts: [], act_links: [], addressees: [], waits: [], loops: [], overlaps: [], influence: [], metrics: [],
} as unknown as Snapshot;

const rec = (seq: number, record: string, op: Delta["payload"]["op"], row: Record<string, unknown>): Delta =>
  ({ seq, kind: "record", episode_ids: ["e"], payload: { record, op, row } });
const ann = (seq: number, table: string, op: Delta["payload"]["op"], rows: Record<string, unknown>[]): Delta =>
  ({ seq, kind: "annotation", episode_ids: ["e"], payload: { table, op, rows } });

describe("applyDeltas", () => {
  it("upserts, patches, deletes and strips private fields", () => {
    const s = applyDeltas(base, [
      rec(11, "span", "put", { id: "s1", actor: "x", start: 5, end: null, kind: "work" }),
      rec(12, "message", "put", { id: "m1", t: 6, sender: "x", text: "Hi. Bye.", reasoning: "secret" }),
      ann(13, "sentences", "upsert", [{ id: "m1:0", message_id: "m1", idx: 0, start_char: 0, end_char: 3, text: "Hi." }]),
      rec(14, "span", "patch", { id: "s1", actor: "x", start: 5, end: 9, kind: "work" }),
      ann(15, "loops", "upsert", [{ episode_id: "e", id: "l1", count: 4 }]),
      ann(16, "loops", "delete", [{ episode_id: "e", id: "l1", count: 4 }]),
      rec(17, "task", "put", { id: "r", name: "Renamed goal", scope: "shared", status: "done" }),
    ]);
    expect(s.seq).toBe(17);
    expect(s.spans).toEqual([{ id: "s1", actor: "x", start: 5, end: 9, kind: "work" }]);
    expect(s.messages[0]).toEqual({ id: "m1", t: 6, sender: "x", text: "Hi. Bye.", has_reasoning: true });
    expect(s.sentences[0]).not.toHaveProperty("text");
    expect(s.loops).toEqual([]);
    expect(s.episode.root_name).toBe("Renamed goal");
    expect(base.spans).toEqual([]); // input untouched
  });
  it("keys annotations by their primary key", () => {
    const s = applyDeltas(base, [
      ann(11, "span_task", "upsert", [{ episode_id: "e", span_id: "s1", task_id: "a" }]),
      ann(12, "span_task", "upsert", [{ episode_id: "e", span_id: "s1", task_id: "b" }]),
    ]);
    expect(s.span_task).toEqual([{ episode_id: "e", span_id: "s1", task_id: "b" }]);
  });
});
