import type { Model } from "../lib/model";
import { formatDuration, formatTime } from "../lib/timeScale";
import { STATUS_ICON } from "./Timeline";

interface Props {
  model: Model;
  taskId: string;
  mentions: number;
  onSelect(id: string | null): void;
}

export function TaskDrawer({ model, taskId, mentions, onSelect }: Props) {
  const { tree } = model;
  const task = tree.tasks.get(taskId);
  if (!task) return null;
  const items = model.rolled.get(taskId) ?? [];
  const byActor = new Map<string, number>();
  for (const it of items) byActor.set(it.actor, (byActor.get(it.actor) ?? 0) + (it.end - it.start));
  const total = [...byActor.values()].reduce((a, b) => a + b, 0);
  const ext = model.extent.get(taskId);
  const labels = new Map<string, number>();
  for (const it of items) labels.set(it.label, (labels.get(it.label) ?? 0) + 1);
  const topLabels = [...labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const sub = [...tree.subtree(taskId)];
  const loops = sub.flatMap((id) => model.loopsByTask.get(id) ?? []);
  const overlaps = sub.flatMap((id) => model.overlapsByTask.get(id) ?? []);
  const attrs = task.attrs ?? {};
  const name = (id: string) => model.actors.get(id)?.name ?? id;
  const dot = (id: string) => <span className="swatch" style={{ background: model.colorOf.get(id), borderRadius: "50%", marginRight: 6 }} />;

  return (
    <aside className="drawer" aria-label="Task details">
      <div className="path">
        {tree.path(taskId).slice(0, -1).map((id) => (
          <span key={id}><button className="linkish" onClick={() => onSelect(id)}>{tree.tasks.get(id)!.name}</button> › </span>
        ))}
      </div>
      <h3>{task.name}</h3>
      <div>
        {task.status && <span className={`status ${task.status}`}>{STATUS_ICON[task.status]} {task.status}</span>}
        <span className="muted"> · {task.provenance === "source" ? "from the source" : task.provenance === "llm" ? "inferred" : task.provenance}</span>{" "}
        <button className="linkish" onClick={() => onSelect(null)}>close</button>
      </div>
      {task.description && <p>{task.description}</p>}
      {attrs.decision && <p className="secondary"><strong>{attrs.decision === "split" ? "Split" : "Kept as one task"}:</strong> {attrs.reason}</p>}
      {!!attrs.anchors?.length && <p className="muted">Terms: {attrs.anchors.join(", ")}</p>}

      <h4>Activity</h4>
      {ext ? (
        <div>
          {formatTime(ext[0], model.unit, model.tz, model.unit === "s")} → {formatTime(ext[1], model.unit, model.tz, model.unit === "s")}
          <br />{items.length} work stretches · {formatDuration(total, model.unit)} of agent time · {mentions} sentences mention it
        </div>
      ) : <div className="muted">No recorded work.</div>}

      {byActor.size > 0 && (<>
        <h4>Agents</h4>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {[...byActor.entries()].sort((a, b) => b[1] - a[1]).map(([id, secs]) => (
            <li key={id}>{dot(id)}{name(id)} <span className="muted">{formatDuration(secs, model.unit)} ({Math.round((100 * secs) / total)}%)</span></li>
          ))}
        </ul>
      </>)}

      {tree.children(taskId).length > 0 && (<>
        <h4>Subtasks</h4>
        <ul>{tree.children(taskId).map((id) => (
          <li key={id}><button className="linkish" onClick={() => onSelect(id)}>{tree.tasks.get(id)!.name}</button></li>
        ))}</ul>
      </>)}

      {loops.length > 0 && (<>
        <h4>Repeated attempts</h4>
        <ul>{loops.map((lp) => (
          <li key={lp.id}>{name(lp.actor)}: ×{lp.count} {lp.kind} <span className="muted">"{model.spanById.get(lp.span_ids[0])?.label}"</span></li>
        ))}</ul>
      </>)}

      {overlaps.length > 0 && (<>
        <h4>Overlapping work</h4>
        <ul>{overlaps.map((ov) => (
          <li key={ov.id}>{ov.coordinated ? "" : "⚠ "}{ov.actors.map(name).join(" & ")} · {formatDuration(ov.end - ov.start, model.unit)}
            <span className="muted">{ov.coordinated ? " (talking to each other)" : " (no messages between them)"}</span></li>
        ))}</ul>
      </>)}

      {topLabels.length > 0 && (<>
        <h4>What the agents said they were doing</h4>
        <ul>{topLabels.map(([label, n]) => <li key={label}>{label}{n > 1 ? <span className="muted"> ×{n}</span> : null}</li>)}</ul>
      </>)}
    </aside>
  );
}
