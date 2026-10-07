import { useEffect, useMemo, useState } from "react";
import { SplitPane } from "../components/SplitPane";
import { TableView } from "../components/TableView";
import { TaskDrawer } from "../components/TaskDrawer";
import { Timeline } from "../components/Timeline";
import { Transcript } from "../components/Transcript";
import { expandedToLevel, modelFor, visibleRows } from "../lib/model";
import { useStore } from "../state";
import type { Snapshot } from "../types";

export function TasksTab({ snap }: { snap: Snapshot }) {
  const model = modelFor(snap);
  const { selectedTask, withDescendants, setWithDescendants, isolated, isolate, cursor, setCursor, info, follow, setFollow } = useStore();
  const live = !!info && info.mode !== "static";
  // Selecting or scrolling means the viewer wants to look around: stop following the newest data.
  const selectTask = (id: string | null) => {
    if (live) setFollow(false);
    useStore.getState().selectTask(id);
  };
  useEffect(() => {
    if (live && follow) setCursor(model.now, "timeline");
  }, [live, follow, model, setCursor]);
  const maxDepth = model.tree.maxDepth();
  const [level, setLevel] = useState(2);
  const [expanded, setExpanded] = useState(() => expandedToLevel(model.tree, level));
  const [table, setTable] = useState(false);

  useEffect(() => setExpanded(expandedToLevel(model.tree, level)), [model, level]);
  // A task selected elsewhere (the Influence tab's "Show in Tasks") may sit under collapsed parents: open them.
  const selectedId = selectedTask && model.tree.tasks.has(selectedTask) ? selectedTask : null;
  useEffect(() => {
    if (!selectedId) return;
    const ancestors = model.tree.path(selectedId).slice(0, -1);
    setExpanded((prev) => (ancestors.every((id) => prev.has(id)) ? prev : new Set([...prev, ...ancestors])));
  }, [model, selectedId, level]);
  const rows = useMemo(() => visibleRows(model, expanded), [model, expanded]);

  const highlightTasks = useMemo(() => {
    if (!selectedTask || !model.tree.tasks.has(selectedTask)) return new Set<string>();
    return withDescendants ? model.tree.subtree(selectedTask) : new Set([selectedTask]);
  }, [model, selectedTask, withDescendants]);

  const highlightSentences = useMemo(() => {
    const out = new Set<string>();
    for (const id of highlightTasks) if (id !== model.tree.rootId) for (const s of model.mentions.get(id) ?? []) out.add(s);
    return out;
  }, [model, highlightTasks]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selected = selectedId;
  const agentGroups = model.legend.filter((g) => g.actors.some((a) => a.kind === "agent"));

  return (
    <div className="tasks-tab">
      <div className="toolbar">
        <div className="legend" aria-label="Agents by model family (click to highlight one)">
          {agentGroups.map((g) => (
            <span className="legend-group" key={g.family}>
              <span className="swatch" style={{ background: g.color }} aria-hidden />
              <span className="legend-family">{g.family}</span>
              {g.actors.map((a) => (
                <button key={a.id} className="chip" aria-pressed={isolated === a.id} onClick={() => isolate(a.id)}>
                  {a.attrs?.icon ? `${a.attrs.icon} ` : ""}{a.name}
                </button>
              ))}
            </span>
          ))}
        </div>
        <div className="controls">
          {maxDepth > 1 && (
            <label>Expand to level
              <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                {Array.from({ length: maxDepth }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          <label><input type="checkbox" checked={withDescendants} onChange={(e) => setWithDescendants(e.target.checked)} /> include subtasks</label>
          <button className="ghost" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? "Timeline" : "Table view"}</button>
        </div>
      </div>
      <SplitPane
        top={table ? <TableView model={model} onSelect={selectTask} /> : (
          <Timeline model={model} rows={rows} expanded={expanded} onToggle={toggle} highlight={highlightTasks}
            selectedTask={selected} onSelectTask={selectTask} isolated={isolated}
            cursor={cursor?.t ?? null} onCursor={(t) => setCursor(t, "timeline")} />
        )}
        bottom={
          <div className="bottom">
            <Transcript model={model} highlight={highlightSentences}
              label={selected && selected !== model.tree.rootId ? model.tree.tasks.get(selected)!.name : null}
              cursor={cursor} onCursor={(t) => setCursor(t, "transcript")}
              onUserScroll={() => live && follow && setFollow(false)} />
            {selected ? <TaskDrawer model={model} taskId={selected} onSelect={selectTask}
              mentions={[...highlightTasks].reduce((s, id) => s + (model.mentions.get(id)?.size ?? 0), 0)} />
              : (
                <aside className="drawer">
                  <h3>How tasks are decomposed and distributed</h3>
                  <p>The shared goal as a tree of tasks, inferred from the agents' work sessions and chat, showing who worked on each
                    one and when.</p>
                  <p className="muted">Click a task to see its details and where the chat discusses it.</p>
                </aside>
              )}
          </div>
        } />
    </div>
  );
}
