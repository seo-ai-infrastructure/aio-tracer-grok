import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { shortName } from "../lib/colors";
import { curve, type Edge, type GraphNode, type NodeSize, nodeRadius } from "../lib/influence";
import type { Model } from "../lib/model";
import { formatDuration } from "../lib/timeScale";
import type { How } from "../types";

export type Selection = { kind: "edge"; id: string } | { kind: "node"; id: string } | null;

interface Props {
  model: Model;
  nodes: GraphNode[];
  edges: Edge[];
  selection: Selection;
  sizeBy: NodeSize;
  onSelect(s: Selection): void;
}

interface Pos { x: number; y: number }
type SimNode = SimulationNodeDatum & { id: string; r: number };

const HOW_LABEL: Record<How, string> = { asked: "asked", proposed: "proposed", joined: "joined", self: "self", none: "none" };
const MX = 70; // side margin: labels are centered under their nodes
const MY = 30; // top and bottom margin, plus room for the label under the lowest node
const LABEL = 14;

/** Scale the settled layout about its center, uniformly, so it uses the panel; then keep every node inside. */
function fit(sim: SimNode[], w: number, h: number) {
  const xs = sim.map((d) => d.x ?? w / 2);
  const ys = sim.map((d) => d.y ?? h / 2);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const room = { w: w - 2 * MX, h: h - 2 * MY - LABEL };
  const k = Math.max(0.6, Math.min(1.8, room.w / Math.max(1, x1 - x0), room.h / Math.max(1, y1 - y0)));
  for (const d of sim) {
    d.x = Math.min(w - MX, Math.max(MX, w / 2 + ((d.x ?? w / 2) - (x0 + x1) / 2) * k));
    d.y = Math.min(h - MY - LABEL, Math.max(MY, MY + room.h / 2 + ((d.y ?? h / 2) - (y0 + y1) / 2) * k));
  }
}

export function InfluenceGraph({ model, nodes, edges, selection, sizeBy, onSelect }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const positions = useRef(new Map<string, Pos>()); // survives data updates, so the layout stays put
  const [, setVersion] = useState(0);
  const [hover, setHover] = useState<{ kind: "node" | "edge"; id: string; x: number; y: number } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const reduceMotion = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(300, el.clientWidth), h: Math.max(240, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxEffort = Math.max(1, ...edges.map((e) => e.effort));
  const radius = nodeRadius(nodes, sizeBy);
  const width = (e: Edge) => 1.5 + 8.5 * Math.sqrt(e.effort / maxEffort);

  // Layout: agents who trigger each other a lot are pulled together. Warm-started, run to rest.
  useLayoutEffect(() => {
    const { w, h } = size;
    const known = positions.current;
    const sim: SimNode[] = nodes.map((n, i) => {
      const p = known.get(n.id) ?? { x: w / 2 + (w / 3) * Math.cos((2 * Math.PI * i) / nodes.length), y: h / 2 + (h / 3) * Math.sin((2 * Math.PI * i) / nodes.length) };
      return { id: n.id, r: radius(n), x: p.x, y: p.y };
    });
    const pair = new Map<string, { source: string; target: string; weight: number }>();
    for (const e of edges) {
      const key = [e.src, e.dst].sort().join("|");
      const l = pair.get(key) ?? { source: e.src, target: e.dst, weight: 0 };
      l.weight += e.effort;
      pair.set(key, l);
    }
    const maxPair = Math.max(1, ...[...pair.values()].map((l) => l.weight));
    const links = [...pair.values()];
    const s = forceSimulation(sim)
      .force("link", forceLink<SimNode, (typeof links)[number]>(links).id((d) => d.id)
        .strength((l) => 0.05 + 0.6 * (l.weight / maxPair)).distance((l) => 190 - 80 * (l.weight / maxPair)))
      .force("charge", forceManyBody().strength(-380))
      .force("collide", forceCollide<SimNode>((d) => d.r + 28))
      .force("x", forceX(w / 2).strength(0.04))
      .force("y", forceY(h / 2).strength(0.08))
      .stop();
    if (known.size) s.alpha(0.3); // warm start: settle gently from where things were
    for (let i = 0; i < 300; i++) s.tick();
    fit(sim, w, h);
    for (const d of sim) known.set(d.id, { x: d.x!, y: d.y! });
    setVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, size, sizeBy]);

  const pos = (id: string) => positions.current.get(id) ?? { x: size.w / 2, y: size.h / 2 };
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const focusNode = selection?.kind === "node" ? selection.id : hover?.kind === "node" ? hover.id : null;
  const touches = (e: Edge) => !focusNode || e.src === focusNode || e.dst === focusNode;

  const toSvg = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onNodeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const p = toSvg(e);
    const q = pos(id);
    drag.current = { id, dx: q.x - p.x, dy: q.y - p.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toSvg(e);
    positions.current.set(d.id, { x: p.x + d.dx, y: p.y + d.dy });
    setVersion((v) => v + 1);
  };

  const unit = model.unit;
  const name = (id: string) => model.actors.get(id)?.name ?? id;

  return (
    <div className="influence-graph" ref={boxRef}>
      <svg ref={svgRef} width={size.w} height={size.h} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}
        onClick={() => onSelect(null)}>
        <defs>
          {["plain", "accent"].map((k) => (
            <marker key={k} id={`ig-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9"
              markerUnits="userSpaceOnUse" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className={`ig-arrow ${k}`} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const a = nodeById.get(e.src);
          const b = nodeById.get(e.dst);
          if (!a || !b) return null;
          const pa = pos(e.src);
          const pb = pos(e.dst);
          const c = curve([pa.x, pa.y], [pb.x, pb.y], radius(a) + 2, radius(b) + 6);
          const selected = selection?.kind === "edge" && selection.id === e.id;
          const dim = !touches(e) || (selection?.kind === "edge" && !selected);
          const n = 1 + Math.round(3 * (e.effort / maxEffort));
          const dur = Math.max(1.8, Math.hypot(pb.x - pa.x, pb.y - pa.y) / 90);
          return (
            <g key={e.id} data-edge={e.id} opacity={dim ? 0.18 : 1}>
              <path d={c.d} className={`ig-edge${selected ? " sel" : ""}`} strokeWidth={width(e)}
                markerEnd={`url(#ig-arrow-${selected ? "accent" : "plain"})`} />
              {!reduceMotion && !dim && Array.from({ length: n }, (_, i) => (
                <circle key={i} r={2.4} className="ig-particle">
                  <animateMotion dur={`${dur}s`} begin={`${(i * dur) / n}s`} repeatCount="indefinite" path={c.d} />
                </circle>
              ))}
              <path d={c.d} className="ig-hit"
                onPointerEnter={(ev) => setHover({ kind: "edge", id: e.id, x: ev.clientX, y: ev.clientY })}
                onPointerMove={(ev) => setHover({ kind: "edge", id: e.id, x: ev.clientX, y: ev.clientY })}
                onPointerLeave={() => setHover(null)}
                onClick={(ev) => { ev.stopPropagation(); onSelect({ kind: "edge", id: e.id }); }} />
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos(n.id);
          const r = radius(n);
          const selected = selection?.kind === "node" && selection.id === n.id;
          const human = n.actor.kind !== "agent";
          const fill = model.colorOf.get(n.id) ?? "var(--series-other)";
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`ig-node${selected ? " sel" : ""}`}
              onPointerDown={(ev) => onNodeDown(ev, n.id)}
              onPointerEnter={(ev) => setHover({ kind: "node", id: n.id, x: ev.clientX, y: ev.clientY })}
              onPointerLeave={() => setHover(null)}
              onClick={(ev) => { ev.stopPropagation(); onSelect({ kind: "node", id: n.id }); }}>
              <circle r={r + 10} className="ig-node-hit" />
              <circle r={r} className={`mark${human ? " person" : ""}`} style={human ? ({ "--c": fill } as React.CSSProperties) : { fill }} />
              <text y={r + 13} textAnchor="middle" className="ig-label">{human ? n.actor.name : shortName(n.actor)}</text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: Math.min(window.innerWidth - 380, hover.x + 14), top: hover.y + 14 }}>
          {hover.kind === "node" ? (() => {
            const n = nodeById.get(hover.id)!;
            return (<>
              <strong>{n.actor.name}</strong>
              {n.actor.kind === "agent" && <div>{formatDuration(n.work, unit)} of work · {formatDuration(n.self, unit)} self-started</div>}
              <div>Got others working: {formatDuration(n.out, unit)}</div>
              {n.actor.kind === "agent" && <div>Got to work by others: {formatDuration(n.in, unit)}
                {n.work > 0 ? ` (${Math.round((100 * n.in) / n.work)}% of their work)` : ""}</div>}
            </>);
          })() : (() => {
            const e = edges.find((x) => x.id === hover.id)!;
            const kinds = (Object.entries(e.byHow) as [How, number][]).map(([h, v]) => `${formatDuration(v, unit)} ${HOW_LABEL[h]}`);
            return (<>
              <strong>{name(e.src)} → {name(e.dst)}</strong>
              <div>{formatDuration(e.effort, unit)} of {name(e.dst)}'s work on {e.tasks.length} task{e.tasks.length === 1 ? "" : "s"}</div>
              <div className="muted">{kinds.join(" · ")}</div>
              <div className="muted">Click to see the evidence in the chat</div>
            </>);
          })()}
        </div>
      )}
    </div>
  );
}
