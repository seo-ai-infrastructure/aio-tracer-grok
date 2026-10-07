// The table twin of the influence graph: initiators (rows) x workers (columns), hours of the
// worker's time the initiator got going. Every number in the graph is readable here.
import type { Edge } from "../lib/influence";
import type { Model } from "../lib/model";
import { formatDuration } from "../lib/timeScale";

interface Props {
  model: Model;
  edges: Edge[];
  selected: string | null;
  onSelect(edgeId: string): void;
}

export function InfluenceMatrix({ model, edges, selected, onSelect }: Props) {
  const total = (key: "src" | "dst", id: string) => edges.filter((e) => e[key] === id).reduce((s, e) => s + e.effort, 0);
  const rows = [...new Set(edges.map((e) => e.src))].sort((a, b) => total("src", b) - total("src", a));
  const cols = [...new Set(edges.map((e) => e.dst))].sort((a, b) => total("dst", b) - total("dst", a));
  const byId = new Map(edges.map((e) => [e.id, e]));
  const max = Math.max(1, ...edges.map((e) => e.effort));
  const name = (id: string) => model.actors.get(id)?.name ?? id;
  const dot = (id: string) => <span className="swatch" style={{ background: model.colorOf.get(id) ?? "var(--human)", borderRadius: "50%", marginRight: 5 }} />;
  if (!edges.length) return <div className="table-view"><p className="placeholder">No edges match the filters.</p></div>;
  return (
    <div className="table-view influence-matrix">
      <table>
        <thead>
          <tr>
            <th>Got going ↓ / worker →</th>
            {cols.map((c) => <th key={c} className="num">{dot(c)}{name(c)}</th>)}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th scope="row">{dot(r)}{name(r)}</th>
              {cols.map((c) => {
                const e = byId.get(`${r}->${c}`);
                if (!e) return <td key={c} className="num muted">·</td>;
                const pct = Math.round(6 + 28 * (e.effort / max)); // neutral ramp: series hues mean model families
                return (
                  <td key={c} className={`num cell${selected === e.id ? " sel" : ""}`}
                    style={{ background: `color-mix(in srgb, var(--text-primary) ${pct}%, transparent)` }}>
                    <button className="linkish cell-btn" onClick={() => onSelect(e.id)}
                      title={`${name(r)} → ${name(c)}: ${e.tasks.length} task(s)`}>{formatDuration(e.effort, model.unit)}</button>
                  </td>
                );
              })}
              <td className="num">{formatDuration(total("src", r), model.unit)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            {cols.map((c) => <td key={c} className="num">{formatDuration(total("dst", c), model.unit)}</td>)}
            <td className="num">{formatDuration(edges.reduce((s, e) => s + e.effort, 0), model.unit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
