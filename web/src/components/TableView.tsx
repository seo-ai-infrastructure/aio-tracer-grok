// The table twin of the timeline: every value in the chart, readable without color or hover.
import type { Model } from "../lib/model";
import { formatDuration, formatTime } from "../lib/timeScale";
import { STATUS_ICON } from "./Timeline";

export function TableView({ model, onSelect }: { model: Model; onSelect(id: string): void }) {
  const { tree } = model;
  const rows = tree.preorder().map((id) => {
    const items = model.rolled.get(id) ?? [];
    const ext = model.extent.get(id);
    const sub = [...tree.subtree(id)];
    const actors = [...new Set(items.map((i) => i.actor))].map((a) => model.actors.get(a)?.name ?? a);
    return {
      id, depth: tree.depth(id), task: tree.tasks.get(id)!, ext, actors,
      work: items.reduce((s, i) => s + (i.end - i.start), 0), spans: items.length,
      mentions: sub.reduce((s, t) => s + (model.mentions.get(t)?.size ?? 0), 0),
      loops: sub.reduce((s, t) => s + (model.loopsByTask.get(t)?.length ?? 0), 0),
      overlaps: sub.reduce((s, t) => s + (model.overlapsByTask.get(t)?.length ?? 0), 0),
    };
  });
  const when = (t: number) => formatTime(t, model.unit, model.tz, model.unit === "s");
  return (
    <div className="table-view">
      <table>
        <thead>
          <tr>
            <th>Task</th><th>Status</th><th>First</th><th>Last</th><th className="num">Agent time</th>
            <th className="num">Stretches</th><th className="num">Agents</th><th>Who</th>
            <th className="num">Mentions</th><th className="num">Loops</th><th className="num">Overlaps</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ paddingLeft: 8 + r.depth * 14 }}><button className="linkish" onClick={() => onSelect(r.id)}>{r.task.name}</button></td>
              <td>{r.task.status ? `${STATUS_ICON[r.task.status]} ${r.task.status}` : ""}</td>
              <td>{r.ext ? when(r.ext[0]) : ""}</td>
              <td>{r.ext ? when(r.ext[1]) : ""}</td>
              <td className="num">{formatDuration(r.work, model.unit)}</td>
              <td className="num">{r.spans}</td>
              <td className="num">{r.actors.length}</td>
              <td title={r.actors.join(", ")}>{r.actors.slice(0, 3).join(", ")}{r.actors.length > 3 ? ` +${r.actors.length - 3}` : ""}</td>
              <td className="num">{r.mentions}</td>
              <td className="num">{r.loops}</td>
              <td className="num">{r.overlaps}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
