import { useMemo, useState } from "react";
import { EdgeEvidence } from "../components/EdgeEvidence";
import { InfluenceGraph, type Selection } from "../components/InfluenceGraph";
import { InfluenceMatrix } from "../components/InfluenceMatrix";
import { SplitPane } from "../components/SplitPane";
import { Transcript } from "../components/Transcript";
import { buildEdges, buildNodes, CREDITED, type EvidenceItem, evidenceFor, NODE_SIZES, type NodeSize, type SentenceKind } from "../lib/influence";
import { modelFor } from "../lib/model";
import { useStore } from "../state";
import type { How, Snapshot } from "../types";

const NODE_SIZE_KEY = "collab:nodeSize"; // per-browser convenience: keep the chosen node sizing

function savedNodeSize(): NodeSize {
  try {
    const v = localStorage.getItem(NODE_SIZE_KEY);
    return NODE_SIZES.some(([k]) => k === v) ? (v as NodeSize) : "out";
  } catch {
    return "out";
  }
}

export function InfluenceTab({ snap }: { snap: Snapshot }) {
  const model = modelFor(snap);
  const { cursor, setCursor } = useStore();
  const [hows, setHows] = useState<Set<How>>(() => new Set(CREDITED));
  const [minMinutes, setMinMinutes] = useState(0);
  const [humans, setHumans] = useState(true);
  const [view, setView] = useState<"graph" | "matrix">("graph");
  const [sizeBy, setSizeBy] = useState<NodeSize>(savedNodeSize);
  const chooseSize = (v: NodeSize) => {
    setSizeBy(v);
    try {
      localStorage.setItem(NODE_SIZE_KEY, v);
    } catch {
      // storage unavailable: the choice lasts until reload
    }
  };
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null); // a message picked in the panel
  const [current, setCurrent] = useState<string | null>(null); // the highlighted message the chat is on
  const perUnit = model.unit === "s" ? 60 : 1; // the slider is in minutes (steps for step-time sources)

  const edges = useMemo(() => buildEdges(snap.influence, model.actors, { hows, minEffort: minMinutes * perUnit, humans }),
    [snap.influence, model, hows, minMinutes, perUnit, humans]);
  const nodes = useMemo(() => buildNodes(model, snap.triggers, edges), [model, snap.triggers, edges]);

  const evidence = useMemo(() => {
    const kinds = new Map<string, SentenceKind>();
    let items: EvidenceItem[] = [];
    const chosen = selection?.kind === "edge" ? edges.filter((e) => e.id === selection.id)
      : selection?.kind === "node" ? edges.filter((e) => e.src === selection.id) : [];
    for (const e of chosen) {
      const ev = evidenceFor(model, snap.triggers, e, hows);
      items = items.concat(ev.items);
      for (const [k, v] of ev.kinds) if (!kinds.has(k) || v === "trigger") kinds.set(k, v);
    }
    return { items, kinds };
  }, [selection, edges, model, snap.triggers, hows]);

  const highlight = useMemo(() => new Set(evidence.kinds.keys()), [evidence]); // stable: the chat re-scrolls on change

  const toggleHow = (h: How) => setHows((prev) => {
    const next = new Set(prev);
    if (next.has(h)) next.delete(h);
    else next.add(h);
    return next;
  });
  const name = (id: string) => model.actors.get(id)?.name ?? id;
  const label = selection?.kind === "edge" ? (() => {
    const e = edges.find((x) => x.id === selection.id);
    return e ? `${name(e.src)} → ${name(e.dst)}` : null;
  })() : selection?.kind === "node" ? `${name(selection.id)} getting others to work` : null;

  if (!snap.triggers.length) {
    return (
      <div className="placeholder">
        No influence data for this episode yet. Build it with
        <pre>python scripts/compute_influence.py --episode {snap.episode.id}</pre>
        (after infer_tasks.py and compute_markers.py), then reload.
      </div>
    );
  }

  return (
    <div className="tasks-tab">
      <div className="toolbar">
        <div className="legend">
          <span className="secondary">Count as influence:</span>
          {CREDITED.map((h) => (
            <label key={h} className="secondary"><input type="checkbox" checked={hows.has(h)} onChange={() => toggleHow(h)} /> {h}</label>
          ))}
          <label className="secondary">at least
            <input type="range" min={0} max={model.unit === "s" ? 60 : 20} value={minMinutes} onChange={(e) => setMinMinutes(Number(e.target.value))} />
            {minMinutes} {model.unit === "s" ? "min" : "steps"}
          </label>
          <label className="secondary"><input type="checkbox" checked={humans} onChange={(e) => setHumans(e.target.checked)} /> humans</label>
        </div>
        <div className="controls">
          {view === "graph" && (
            <label className="secondary">Node size
              <select value={sizeBy} onChange={(e) => chooseSize(e.target.value as NodeSize)}>
                {NODE_SIZES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
          )}
          <span className="muted">{edges.length} edges · width = hours of the worker's time</span>
          <button className="ghost" aria-pressed={view === "matrix"} onClick={() => setView((v) => (v === "graph" ? "matrix" : "graph"))}>
            {view === "graph" ? "Matrix view" : "Graph"}
          </button>
        </div>
      </div>
      <SplitPane
        top={
          <div className="influence-top">
            {view === "graph"
              ? <InfluenceGraph model={model} nodes={nodes} edges={edges} selection={selection} sizeBy={sizeBy} onSelect={setSelection} />
              : <InfluenceMatrix model={model} edges={edges} selected={selection?.kind === "edge" ? selection.id : null}
                  onSelect={(id) => setSelection({ kind: "edge", id })} />}
            <EdgeEvidence model={model} selection={selection} edges={edges} nodes={nodes} items={evidence.items} current={current}
              onSelect={setSelection} onFocus={(id) => setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 }))}
              onJump={(t) => setCursor(t, "timeline")} />
          </div>
        }
        bottom={
          <div className="bottom">
            <Transcript model={model} highlight={highlight} highlightKind={evidence.kinds} label={label}
              note=" · darker: the ask or proposal · lighter: the worker's later messages about it"
              cursor={cursor} onCursor={(t) => setCursor(t, "transcript")} focus={focus} onCurrent={setCurrent} />
          </div>
        } />
    </div>
  );
}
