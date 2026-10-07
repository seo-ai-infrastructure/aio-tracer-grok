import { useEffect, useRef, useState } from "react";
import type { Edge, EvidenceItem, GraphNode } from "../lib/influence";
import type { Model } from "../lib/model";
import { formatDuration, formatTime } from "../lib/timeScale";
import type { How } from "../types";
import type { Selection } from "./InfluenceGraph";

interface Props {
  model: Model;
  selection: Selection;
  edges: Edge[];
  nodes: GraphNode[];
  items: EvidenceItem[];
  current: string | null; // the highlighted message the chat is on
  onSelect(s: Selection): void;
  onFocus(messageId: string): void; // bring a message into view in the chat
  onJump(t: number): void; // bring a moment into view in the chat
}

// What the initiator's message was, by how the worker got going.
const TRIGGER_TAG: Record<How, string> = { asked: "ask", proposed: "proposal", joined: "mention", self: "mention", none: "mention" };

function helpers(model: Model) {
  const unit = model.unit;
  return {
    unit,
    name: (id: string) => model.actors.get(id)?.name ?? id,
    when: (t: number) => formatTime(t, unit, model.tz, unit === "s"),
    taskName: (id: string) => model.tree.tasks.get(id)?.name ?? id,
    parentName: (id: string) => {
      const p = model.tree.parent(id);
      return p && p !== model.tree.rootId ? model.tree.tasks.get(p)?.name : null;
    },
  };
}

export function EdgeEvidence(props: Props) {
  const { model, selection, edges, nodes, onSelect } = props;
  const { unit, name } = helpers(model);

  if (!selection) {
    return (
      <aside className="drawer evidence">
        <h3>How work spreads through the team</h3>
        <p>Each arrow is work one participant got another to do, by asking, proposing, or starting it first. It's measured in
          hours of the other's time and traced to the messages that started it.</p>
        <p className="muted">Edge width is that time, and the moving dots show the direction. The filters above count work
          someone was <b>asked</b> to do, took up from a <b>proposal</b>, or <b>joined</b> after someone else started it.</p>
        <p className="muted">Click an edge to list the tasks behind it. Expand a task for every message that shows the influence,
          and click one to find it in the chat below (darker: the ask or proposal, lighter: the worker's later messages about it).
          Click a person for everyone they got working.</p>
      </aside>
    );
  }

  if (selection.kind === "node") {
    const n = nodes.find((x) => x.id === selection.id);
    const out = edges.filter((e) => e.src === selection.id);
    const inn = edges.filter((e) => e.dst === selection.id);
    const row = (e: Edge, other: string) => (
      <li key={e.id}><button className="linkish" onClick={() => onSelect({ kind: "edge", id: e.id })}>{name(other)}</button>
        <span className="muted"> {formatDuration(e.effort, unit)} · {e.tasks.length} task{e.tasks.length === 1 ? "" : "s"}</span></li>
    );
    return (
      <aside className="drawer evidence">
        <h3>{name(selection.id)}</h3>
        {n && n.actor.kind === "agent" && <p className="muted">{formatDuration(n.work, unit)} of work, {formatDuration(n.self, unit)} self-started</p>}
        <h4>Got others working ({formatDuration(n?.out ?? 0, unit)})</h4>
        {out.length ? <ul>{out.map((e) => row(e, e.dst))}</ul> : <p className="muted">Nobody, with the current filters.</p>}
        {n?.actor.kind === "agent" && (<>
          <h4>Got to work by ({formatDuration(n?.in ?? 0, unit)})</h4>
          {inn.length ? <ul>{inn.map((e) => row(e, e.src))}</ul> : <p className="muted">Nobody, with the current filters.</p>}
        </>)}
        <button className="linkish" onClick={() => onSelect(null)}>clear</button>
      </aside>
    );
  }

  const edge = edges.find((e) => e.id === selection.id);
  if (!edge) return <aside className="drawer evidence"><p className="muted">That edge is hidden by the filters.</p></aside>;
  return <EdgeView key={edge.id} {...props} edge={edge} />;
}

/** One edge's tasks; each expands into the messages behind it, and a click finds one in the chat. */
function EdgeView({ model, edge, items, current, onSelect, onFocus, onJump }: Props & { edge: Edge }) {
  const { unit, name, when, taskName, parentName } = helpers(model);
  const [open, setOpen] = useState<Set<string>>(() => new Set(items.length === 1 ? [items[0].task] : []));
  const active = useRef<HTMLButtonElement | null>(null);
  const reveal = useRef(false);

  // Follow the chat: when it moves to another message (Previous/Next, or a click here), open its task and show it.
  useEffect(() => {
    if (!current) return;
    reveal.current = true;
    const holder = items.find((it) => it.points.some((pt) => pt.message.id === current));
    if (holder) setOpen((prev) => (prev.has(holder.task) ? prev : new Set(prev).add(holder.task)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  useEffect(() => {
    if (reveal.current && active.current) {
      active.current.scrollIntoView({ block: "nearest" });
      reveal.current = false;
    }
  });

  const toggle = (task: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(task)) next.delete(task);
    else next.add(task);
    return next;
  });
  const allOpen = items.length > 0 && items.every((it) => open.has(it.task));

  return (
    <aside className="drawer evidence">
      <h3>{name(edge.src)} → {name(edge.dst)}</h3>
      <p>{formatDuration(edge.effort, unit)} of {name(edge.dst)}'s work on {edge.tasks.length} task{edge.tasks.length === 1 ? "" : "s"}.{" "}
        {items.length > 1 && (<>
          <button className="linkish" onClick={() => setOpen(allOpen ? new Set() : new Set(items.map((it) => it.task)))}>
            {allOpen ? "collapse all" : "expand all"}</button>{" · "}
        </>)}
        <button className="linkish" onClick={() => onSelect(null)}>clear</button></p>
      <ul className="evidence-list">
        {items.map((it) => {
          const isOpen = open.has(it.task);
          const parent = parentName(it.task);
          const n = it.points.length;
          return (
            <li key={it.task}>
              <button className="ev-head" aria-expanded={isOpen} onClick={() => toggle(it.task)}>
                <span className="chev" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                <span>
                  <span className={`how how-${it.how}`}>{it.how}</span> <b>{taskName(it.task)}</b>
                  {parent && <span className="muted"> in {parent}</span>}
                  <span className="ev-meta muted">{formatDuration(it.effort, unit)} of work{it.firstWork !== null ? `, from ${when(it.firstWork)}` : ""}
                    {" · "}{n ? `${n} message${n === 1 ? "" : "s"}` : "no messages"}</span>
                </span>
              </button>
              {isOpen && (
                <ol className="points">
                  {it.points.map((pt) => {
                    const on = pt.message.id === current;
                    return (
                      <li key={pt.message.id}>
                        <button ref={on ? active : undefined} className={`point ${pt.kind}${on ? " active" : ""}`}
                          aria-current={on || undefined} onClick={() => onFocus(pt.message.id)} title="Find it in the chat">
                          <span className="point-head">
                            <span className="muted">{when(pt.message.t)}</span> <b>{name(pt.message.sender)}</b>
                            <span className="tag">{pt.kind === "trigger" ? TRIGGER_TAG[it.how] : "follow-up"}</span>
                          </span>
                          <span className="point-text">{pt.excerpt}</span>
                        </button>
                      </li>
                    );
                  })}
                  {!n && it.firstWork !== null && (
                    <li><button className="point" onClick={() => onJump(it.firstWork!)}>No message shows it; go to when {name(edge.dst)} started</button></li>
                  )}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
