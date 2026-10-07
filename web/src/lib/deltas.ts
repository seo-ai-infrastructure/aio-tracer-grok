// Apply server deltas (collab/store.py log) to a snapshot. Pure: returns a new snapshot.
import type { Snapshot } from "../types";

export interface Delta {
  seq: number;
  kind: "record" | "annotation";
  episode_ids: string[] | null;
  payload: {
    record?: string;
    op: "put" | "patch" | "delete" | "upsert";
    row?: Record<string, unknown>;
    table?: string;
    rows?: Record<string, unknown>[];
  };
}

type Row = Record<string, unknown>;

export const ANNOTATION_KEYS: Record<string, string[]> = {
  sentences: ["id"],
  span_task: ["episode_id", "span_id"],
  sentence_task: ["episode_id", "sentence_id", "task_id"],
  acts: ["sentence_id", "act"],
  act_links: ["src_id", "dst_id", "relation"],
  addressees: ["message_id", "actor_id"],
  waits: ["span_id"],
  loops: ["episode_id", "id"],
  overlaps: ["episode_id", "id"],
  triggers: ["episode_id", "task_id", "worker"],
  influence: ["episode_id", "src", "dst", "how"],
  metrics: ["episode_id", "name", "actor"],
};

const RECORD_KEYS: Record<string, keyof Snapshot> = {
  actor: "actors", channel: "channels", task: "tasks", message: "messages", span: "spans", event: "events",
};

function keyOf(row: Row, cols: string[]): string {
  return cols.map((c) => String(row[c] ?? "")).join("\u0000");
}

function viewRow(record: string, row: Row): Row {
  if (record === "message") {
    const { reasoning, ...rest } = row;
    return { ...rest, has_reasoning: !!reasoning };
  }
  if (record === "sentence") {
    const { text: _text, ...rest } = row;
    return rest;
  }
  return row;
}

export function applyDeltas(snap: Snapshot, deltas: Delta[]): Snapshot {
  if (!deltas.length) return snap;
  const tables = new Map<string, Map<string, Row>>();
  const table = (name: string, cols: string[]) => {
    let t = tables.get(name);
    if (!t) {
      t = new Map(((snap as unknown as Record<string, Row[]>)[name] ?? []).map((r) => [keyOf(r, cols), r]));
      tables.set(name, t);
    }
    return t;
  };
  let manifest = snap.manifest;
  let episode = snap.episode;
  let seq = snap.seq;

  for (const d of deltas) {
    seq = Math.max(seq, d.seq);
    const p = d.payload;
    if (d.kind === "record" && p.record && p.row) {
      const row = p.row;
      if (p.record === "manifest") {
        if (!manifest || manifest.id === row.id) manifest = row as unknown as Snapshot["manifest"];
      } else if (p.record === "episode") {
        if (row.id === episode.id) episode = { ...episode, ...(p.op === "delete" ? {} : row) } as Snapshot["episode"];
      } else if (RECORD_KEYS[p.record]) {
        const t = table(RECORD_KEYS[p.record] as string, ["id"]);
        const k = keyOf(row, ["id"]);
        if (p.op === "delete") t.delete(k);
        else t.set(k, viewRow(p.record, row));
        if (p.record === "task" && row.id === episode.root_task_id && p.op !== "delete") {
          episode = { ...episode, root_name: row.name as string, scope: row.scope as never, status: row.status as never };
        }
      }
    } else if (d.kind === "annotation" && p.table && p.rows && ANNOTATION_KEYS[p.table]) {
      const cols = ANNOTATION_KEYS[p.table];
      const t = table(p.table, cols);
      for (const row of p.rows) {
        if (p.op === "delete") t.delete(keyOf(row, cols));
        else t.set(keyOf(row, cols), p.table === "sentences" ? viewRow("sentence", row) : row);
      }
    }
  }

  const next = { ...snap, manifest, episode, seq } as unknown as Record<string, unknown>;
  for (const [name, t] of tables) next[name] = [...t.values()];
  return next as unknown as Snapshot;
}
