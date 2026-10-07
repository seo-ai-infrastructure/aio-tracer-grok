import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { shortName } from "../lib/colors";
import type { Model, Row, WorkItem } from "../lib/model";
import { dayLabels, daySpans, formatDuration, formatTime, spacedTicks, tickLabel, timeTicks } from "../lib/timeScale";
import { TimeNavigator } from "./TimeNavigator";
import type { Loop, Overlap, TaskStatus } from "../types";

export const LABEL_W = 400; // default width of the task-name column; the divider can be dragged
const MIN_LABEL_W = 140;
const MIN_PLOT_W = 240;
const LABEL_W_KEY = "collab:labelWidth";

function savedLabelW(): number {
  try {
    const v = Number(localStorage.getItem(LABEL_W_KEY));
    return v >= MIN_LABEL_W ? v : LABEL_W;
  } catch {
    return LABEL_W;
  }
}
const LANE_H = 10;
const LANE_GAP = 2; // surface gap between stacked lanes
const PAD = 6;
const BRACKET_H = 20;
const MIN_ROW = 24;
const AXIS_H = 36;
const MAX_INDENT = 8;

const BADGE_STRIP = 14; // extra room under the bands for loop badges
const LABEL_TIP_DELAY = 1000; // ms of hovering a task name before its description shows (about a browser tooltip's)
const PX_PER_HOUR = 180; // long episodes open at about this scale (Fit shows everything); short ones open fitted
const PX_PER_STEP = 24;

/** Zoom for opening an episode: fitted when it fits at a readable scale, else zoomed in at the start. */
export function openingZoom(total: number, plotW: number, unit: "s" | "step"): number {
  const want = unit === "s" ? (total / 3600) * PX_PER_HOUR : total * PX_PER_STEP;
  return Math.min(4000, Math.max(1, want / plotW));
}

export function rowHeight(r: Row, badges = false): number {
  if (r.mode === "bracket") return BRACKET_H;
  return Math.max(MIN_ROW, PAD * 2 + Math.max(1, r.lanes) * (LANE_H + LANE_GAP) - LANE_GAP + 3) + (badges ? BADGE_STRIP : 0);
}

export const STATUS_ICON: Record<TaskStatus, string> = { done: "✓", blocked: "⛔", abandoned: "✕", ongoing: "▸" };

interface Props {
  model: Model;
  rows: Row[];
  expanded: Set<string>;
  onToggle(id: string): void;
  highlight: Set<string>; // selected task (and, optionally, its descendants)
  selectedTask: string | null;
  onSelectTask(id: string | null): void;
  isolated: string | null;
  cursor: number | null;
  onCursor(t: number): void;
}

interface Hover {
  kind: "item" | "overlap" | "loop";
  clientX: number;
  clientY: number;
  x: number;
  item?: WorkItem;
  overlap?: Overlap;
  loop?: Loop;
}

export function Timeline(p: Props) {
  const { model, rows } = p;
  const bodyRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<SVGSVGElement>(null);
  const [bodyW, setBodyW] = useState(1100);
  const [labelW, setLabelW] = useState(savedLabelW);
  const [zoom, setZoom] = useState({ k: 1, tx: 0 });
  const [hover, setHover] = useState<Hover | null>(null);
  const [crumb, setCrumb] = useState<string>("");
  const [labelTip, setLabelTip] = useState<{ row: Row; rect: DOMRect } | null>(null);
  const tipTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);
  // Descriptions wait for a deliberate hover, so sweeping over or clicking the names doesn't pop them up;
  // keyboard focus shows them at once.
  const hoverLabel = (row: Row | null, rect?: DOMRect, immediate = false) => {
    window.clearTimeout(tipTimer.current);
    if (!row || !rect) return setLabelTip(null);
    if (immediate) setLabelTip({ row, rect });
    else tipTimer.current = window.setTimeout(() => setLabelTip({ row, rect }), LABEL_TIP_DELAY);
  };
  const drag = useRef<{ x0: number; tx0: number; moved: boolean } | null>(null);
  const plotW = Math.max(MIN_PLOT_W, bodyW - labelW - 1);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setBodyW(el.clientWidth);
    setZoom({ k: openingZoom(model.time.total, Math.max(MIN_PLOT_W, el.clientWidth - labelW - 1), model.unit), tx: 0 });
    const ro = new ResizeObserver(() => setBodyW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The divider between task names and the plot: drag it, or focus it and use the arrow keys.
  const resizeLabels = (w: number) => {
    const next = Math.round(Math.min(Math.max(MIN_LABEL_W, w), bodyW - MIN_PLOT_W));
    setLabelW(next);
    try {
      localStorage.setItem(LABEL_W_KEY, String(next));
    } catch {
      // storage unavailable: the width just isn't remembered
    }
  };
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = labelW;
    const move = (ev: PointerEvent) => resizeLabels(w0 + ev.clientX - x0);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onDividerKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === "ArrowLeft") resizeLabels(labelW - step);
    else if (e.key === "ArrowRight") resizeLabels(labelW + step);
    else return;
    e.preventDefault();
  };

  const total = model.time.total;
  const clampTx = (tx: number, k: number) => Math.min(0, Math.max(plotW - plotW * k, tx));
  const xOfU = (u: number) => (u / total) * plotW * zoom.k + zoom.tx;
  const uOfX = (x: number) => ((x - zoom.tx) / (plotW * zoom.k)) * total;
  const xOf = (t: number) => xOfU(model.time.toU(t));
  const tOf = (x: number) => model.time.toT(uOfX(x));

  // Keep the playhead in view when it moves from elsewhere (the chat, live follow): pan, keeping the zoom.
  useEffect(() => {
    if (p.cursor === null) return;
    const u = model.time.toU(p.cursor);
    setZoom((z) => {
      const x = (u / total) * plotW * z.k + z.tx;
      return x >= 0 && x <= plotW ? z : { ...z, tx: clampTx(z.tx - (x - plotW / 3), z.k) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.cursor]);

  // Ctrl/Cmd + wheel zooms around the pointer; horizontal or Shift + wheel pans. Plain wheel scrolls rows.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom((z) => {
          const k = Math.min(4000, Math.max(1, z.k * Math.exp(-e.deltaY * 0.002)));
          return { k, tx: clampTx(px - ((px - z.tx) * k) / z.k, k) };
        });
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setZoom((z) => ({ ...z, tx: clampTx(z.tx - d, z.k) }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const rootId = model.tree.rootId;
  const subtreeItems = <T,>(row: Row, byTask: Map<string, T[]>): T[] => {
    if (!row.taskId || row.mode === "waiting") return [];
    if (row.mode === "leaf" || row.mode === "general") return byTask.get(row.taskId) ?? [];
    if (row.mode === "rollup" && (row.taskId !== rootId || model.tree.isLeaf(rootId))) {
      return [...model.tree.subtree(row.taskId)].flatMap((id) => byTask.get(id) ?? []);
    }
    return [];
  };

  const { tops, heights } = useMemo(() => {
    const t: number[] = [];
    const h: number[] = [];
    let y = 0;
    for (const r of rows) {
      t.push(y);
      h.push(rowHeight(r, subtreeItems(r, model.loopsByTask).length > 0));
      y += h[h.length - 1];
    }
    t.push(y);
    return { tops: t, heights: h };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, model]);
  const height = tops[tops.length - 1];

  const rowAt = (y: number) => {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // Bring the selected task's row into view when it was selected from somewhere else and is off screen.
  useEffect(() => {
    const el = bodyRef.current;
    const i = p.selectedTask ? rows.findIndex((r) => r.taskId === p.selectedTask) : -1;
    if (!el || i < 0) return;
    if (tops[i] < el.scrollTop || tops[i] + heights[i] > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, tops[i] - el.clientHeight / 3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selectedTask, rows]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    window.clearTimeout(tipTimer.current); // a pending or shown description would point at the old position
    setLabelTip(null);
    const r = rows[rowAt(el.scrollTop)];
    const id = r?.taskId;
    setCrumb(id && el.scrollTop > 0 ? model.tree.path(id).map((t) => model.tree.tasks.get(t)!.name).join(" › ") : "");
  };

  const mentionTimes = useMemo(() => {
    const byMsg = new Map(model.messages.map((m) => [m.id, m.t]));
    const out = new Map<string, number[]>();
    for (const [task, sids] of model.mentions) {
      out.set(task, [...sids].map((sid) => byMsg.get(sid.slice(0, sid.lastIndexOf(":"))) ?? NaN).filter(Number.isFinite));
    }
    return out;
  }, [model]);

  // ---- pointer interaction ---------------------------------------------------------------

  const pick = (e: React.PointerEvent<SVGSVGElement>): Hover | null => {
    const rect = plotRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const badge = (e.target as Element).closest?.("[data-loop]");
    const loop = badge ? model.loopById.get(badge.getAttribute("data-loop")!) : undefined;
    if (loop) return { kind: "loop", clientX: e.clientX, clientY: e.clientY, x, loop };
    const i = rowAt(y);
    const row = rows[i];
    if (!row) return null;
    const localY = y - tops[i] - PAD;
    const lane = Math.floor(localY / (LANE_H + LANE_GAP));
    const tol = 3;
    let best: WorkItem | null = null;
    let bestD = Infinity;
    for (const it of row.placed) {
      const x0 = xOf(it.start);
      const x1 = Math.max(xOf(it.end), x0 + 1.5);
      if (x < x0 - tol || x > x1 + tol) continue;
      const d = Math.abs(it.lane - lane) + (x < x0 || x > x1 ? 0.5 : 0);
      if (d < bestD) {
        best = it;
        bestD = d;
      }
    }
    if (best) return { kind: "item", clientX: e.clientX, clientY: e.clientY, x, item: best };
    for (const ov of subtreeItems(row, model.overlapsByTask)) {
      if (x >= xOf(ov.start) && x <= xOf(ov.end)) return { kind: "overlap", clientX: e.clientX, clientY: e.clientY, x, overlap: ov };
    }
    return { kind: "item", clientX: e.clientX, clientY: e.clientY, x };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    drag.current = { x0: e.clientX, tx0: zoom.tx, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x0;
      if (Math.abs(dx) > 3) d.moved = true;
      if (d.moved) {
        setZoom((z) => ({ ...z, tx: clampTx(d.tx0 + dx, z.k) }));
        setHover(null);
        return;
      }
    }
    setHover(pick(e));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const h = pick(e);
    if (h?.loop) {
      p.onSelectTask(h.loop.task_id ? model.tree.resolve(h.loop.task_id) : model.spanTask.get(h.loop.span_ids[0]) ?? null);
      p.onCursor(model.spanById.get(h.loop.span_ids[0])?.start ?? tOf(h.x));
    } else if (h?.item) {
      p.onSelectTask(model.spanTask.get(h.item.id) ?? null);
      p.onCursor(h.item.start);
    } else if (h) {
      p.onCursor(tOf(h.x));
    }
  };
  const zoomBy = (f: number) =>
    setZoom((z) => {
      const k = Math.min(4000, Math.max(1, z.k * f));
      const cx = plotW / 2;
      return { k, tx: clampTx(cx - ((cx - z.tx) * k) / z.k, k) };
    });

  // ---- rendering ----------------------------------------------------------------------

  const u0 = uOfX(0);
  const u1 = uOfX(plotW);
  const pxPerU = (plotW * zoom.k) / total;
  // Hour ticks only while they can be a few hours apart; zoomed further out, the day labels carry the axis.
  const ticks = model.unit === "s" && pxPerU * 3 * 3600 < 70 ? [] : timeTicks(model.time, u0, u1, pxPerU, model.unit);
  const days = useMemo(() => daySpans(model.time, model.tz), [model]);
  const visible = (s: number, e: number) => xOf(e) >= -2 && xOf(s) <= plotW + 2;
  const fade = (actor: string) => (p.isolated && p.isolated !== actor ? 0.16 : 1);

  // Everything drawn per row, kept between renders that only move the hover crosshair: at season scale
  // that's thousands of bars, and redrawing them on every mouse move made hovering lag.
  const { bands, overlays, markers, gapBands } = useMemo(() => {
    const bands: React.ReactNode[] = [];
    const overlays: React.ReactNode[] = [];
    const markers: React.ReactNode[] = [];
    rows.forEach((row, i) => {
      const top = tops[i];
      const h = heights[i];
      if (row.taskId && p.highlight.has(row.taskId) && row.mode !== "waiting") {
        overlays.push(<rect key={`sel-${row.key}`} x={0} y={top} width={plotW} height={h} fill="var(--select-wash)" />);
      }
      overlays.push(<line key={`sep-${row.key}`} className="row-sep" x1={0} x2={plotW} y1={top + h - 0.5} y2={top + h - 0.5} />);

      if (row.mode === "bracket") {
        const ext = row.taskId ? model.extent.get(row.taskId) : undefined;
        if (ext && visible(ext[0], ext[1])) {
          const x0 = xOf(ext[0]);
          const x1 = Math.max(xOf(ext[1]), x0 + 2);
          const y = top + h / 2 + 2;
          bands.push(<path key={`br-${row.key}`} className="bracket" d={`M${x0},${y + 4}V${y}H${x1}V${y + 4}`} />);
        }
      } else {
        const opacity = row.mode === "waiting" ? 0.35 : 1;
        for (const it of row.placed) {
          if (!visible(it.start, it.end)) continue;
          const x0 = xOf(it.start);
          const w = Math.max(1.5, xOf(it.end) - x0);
          const y = top + PAD + it.lane * (LANE_H + LANE_GAP);
          const inset = w > 5 ? 1 : 0; // 2px surface gap between touching segments
          bands.push(
            <rect key={`${row.key}-${it.id}`} x={x0 + inset} y={y} width={w - 2 * inset} height={LANE_H} rx={w > 8 ? 3 : 0}
              fill={model.colorOf.get(it.actor) ?? "var(--series-other)"} opacity={opacity * fade(it.actor)} />,
          );
          if (w > 90 && row.mode !== "waiting") {
            const a = model.actors.get(it.actor);
            bands.push(<text key={`${row.key}-${it.id}-t`} className="band-label" x={x0 + 4} y={y + LANE_H - 2} opacity={fade(it.actor)}>
              {a ? shortName(a) : it.actor}</text>);
          }
          const steps = row.mode !== "waiting" && w > 60 ? model.actions.get(it.id) ?? [] : [];
          for (const s of steps) {
            const sx = xOf(s.start);
            bands.push(<line key={`${row.key}-${s.id}`} x1={sx} x2={sx} y1={y + 1} y2={y + LANE_H - 1} stroke="var(--surface-1)" strokeWidth={1} />);
          }
        }
      }

      // duplicate effort: neutral wash when coordinated, warning wash + icon when not
      for (const ov of subtreeItems(row, model.overlapsByTask)) {
        if (!visible(ov.start, ov.end)) continue;
        const x0 = xOf(ov.start);
        const w = Math.max(2, xOf(ov.end) - x0);
        overlays.push(<rect key={`ov-${row.key}-${ov.id}`} x={x0} y={top + 1} width={w} height={h - 2}
          fill={ov.coordinated ? "var(--overlap-ok)" : "var(--overlap-warn)"} />);
        if (!ov.coordinated) markers.push(<text key={`ovi-${row.key}-${ov.id}`} x={x0 + 2} y={top + 10} fontSize={10} fill="var(--warning)">⚠</text>);
      }

      // retry / polling loops: a bracket over the attempts, and a badge where there is room
      let lastBadgeEnd = -Infinity;
      for (const lp of subtreeItems(row, model.loopsByTask)) {
        const spans = lp.span_ids.flatMap((id) => model.spanById.get(id) ?? []);
        if (!spans.length) continue;
        const s0 = spans[0].start;
        const s1 = Math.max(...spans.map((s) => s.end ?? s.start));
        if (!visible(s0, s1)) continue;
        const x0 = xOf(s0);
        const x1 = Math.max(xOf(s1), x0 + 2);
        markers.push(<path key={`lp-${row.key}-${lp.id}`} className="bracket" d={`M${x0},${top + 4}V${top + 1.5}H${x1}V${top + 4}`} opacity={fade(lp.actor)} />);
        const text = `×${lp.count} ${lp.kind}`;
        const bw = text.length * 5.6 + 8;
        const bx = Math.max(0, Math.min(plotW - bw - 1, x0));
        if (bx > lastBadgeEnd + 4) {
          lastBadgeEnd = bx + bw;
          markers.push(
            <g key={`lb-${row.key}-${lp.id}`} className="badge" data-loop={lp.id} transform={`translate(${bx},${top + h - 13})`}
              opacity={fade(lp.actor)} style={{ cursor: "pointer" }}>
              <rect width={bw} height={12} rx={6} />
              <text x={4} y={9}>{text}</text>
            </g>,
          );
        }
      }

      // mentions in chat, as a rug along the row's bottom edge
      if (row.taskId && row.taskId !== rootId && row.mode !== "general") {
        const ids = row.mode === "rollup" ? [...model.tree.subtree(row.taskId)] : [row.taskId];
        for (const t of ids.flatMap((id) => mentionTimes.get(id) ?? [])) {
          if (!visible(t, t)) continue;
          const x = xOf(t);
          markers.push(<line key={`rug-${row.key}-${t}-${x}`} className="rug" x1={x} x2={x} y1={top + h - 3} y2={top + h - 0.5} />);
        }
      }

      // status end cap: icon now, label in the row header and tooltip
      const task = row.taskId ? model.tree.tasks.get(row.taskId) : undefined;
      const ext = row.taskId ? model.extent.get(row.taskId) : undefined;
      if (task?.status && ext && row.mode !== "general" && row.mode !== "waiting" && visible(ext[1], ext[1])) {
        markers.push(<text key={`st-${row.key}`} className={`status ${task.status}`} x={xOf(ext[1]) + 4} y={top + Math.min(h, 24) / 2 + 4}
          fontSize={11}><title>{task.status}</title>{STATUS_ICON[task.status]}</text>);
      }
    });

    // waits linked to what they wait on (task rows, or the row where the awaited agent is working)
    const rowIndexOfTask = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.taskId && r.mode !== "general" && !rowIndexOfTask.has(r.taskId)) rowIndexOfTask.set(r.taskId, i);
    });
    const waitRow = rows.findIndex((r) => r.mode === "waiting");
    if (waitRow >= 0) {
      for (const it of rows[waitRow].placed) {
        const target = model.waitTargets.get(it.id);
        if (!target || !visible(it.start, it.end)) continue;
        let ti: number | undefined;
        if (target.target_kind === "task" && target.target_id) {
          for (const id of model.tree.path(model.tree.resolve(target.target_id)).reverse()) {
            if (rowIndexOfTask.has(id)) { ti = rowIndexOfTask.get(id); break; }
          }
        } else if (target.target_kind === "actor") {
          ti = rows.findIndex((r) => r.mode !== "waiting" && r.mode !== "bracket" && r.placed.some((x) => x.actor === target.target_id && x.start <= it.end && x.end >= it.start));
          if (ti === -1) ti = 0;
        }
        if (ti === undefined) continue;
        const x = xOf(it.start) + 2;
        const y0 = tops[waitRow] + PAD + it.lane * (LANE_H + LANE_GAP);
        const y1 = tops[ti] + heights[ti] / 2;
        markers.push(<path key={`wl-${it.id}`} className="wait-link" d={`M${x},${y0}V${y1 + 5}M${x - 3},${y1 + 5}L${x},${y1}L${x + 3},${y1 + 5}`} opacity={fade(it.actor)} />);
      }
    }

    const gapBands = model.time.gaps().map(([ga, gb], i) => {
      const x0 = xOfU(ga);
      const x1 = xOfU(gb);
      return x1 < 0 || x0 > plotW ? null : <rect key={`gap-${i}`} className="gap-band" x={x0} y={0} width={Math.max(0, x1 - x0)} height={height} />;
    });
    return { bands, overlays, markers, gapBands };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tops, heights, height, p.highlight, p.isolated, plotW, zoom, model, mentionTimes]);

  const cursorX = p.cursor !== null ? xOf(p.cursor) : null;

  return (
    <div className="timeline" style={{ ["--label-w" as string]: `${labelW}px` }}>
      <div className="label-divider" style={{ left: labelW - 3 }} role="separator" aria-orientation="vertical"
        aria-label="Width of the task names (drag, or use the arrow keys; double-click to reset)"
        aria-valuenow={labelW} aria-valuemin={MIN_LABEL_W} aria-valuemax={bodyW - MIN_PLOT_W} tabIndex={0}
        onPointerDown={onDividerDown} onKeyDown={onDividerKey} onDoubleClick={() => resizeLabels(LABEL_W)} />
      <div className="timeline-head">
        <div className="breadcrumb" title={crumb}>{crumb || model.tree.tasks.get(rootId)?.name}</div>
        <svg className="axis" width={plotW} height={AXIS_H}>
          {model.unit === "s" && dayLabels(days, xOf, plotW).map((l) => (
            <text key={`d-${l.text}-${l.x}`} className="day" x={l.x} y={13}>{l.text}</text>
          ))}
          {spacedTicks(ticks, (t) => Math.min(plotW - 28, Math.max(28, xOf(t))), (t) => tickLabel(t, model.unit, model.tz))
            .filter((t) => !hover || Math.abs(xOf(t) - hover.x) > 56).map((t) => (
              <text key={`t-${t}`} x={Math.min(plotW - 28, Math.max(28, xOf(t)))} y={30} textAnchor="middle">{tickLabel(t, model.unit, model.tz)}</text>
            ))}
          {model.time.gaps().map(([ga, gb], i) => {
            const x = (xOfU(ga) + xOfU(gb)) / 2;
            return x < 0 || x > plotW || xOfU(gb) - xOfU(ga) < 10 ? null
              : <path key={`b-${i}`} className="break" d={`M${x - 3},${34}L${x + 1},${22}M${x},${34}L${x + 4},${22}`} />;
          })}
          {hover && <text x={Math.min(plotW - 40, Math.max(40, hover.x))} y={30} textAnchor="middle" fill="var(--text-primary)">{formatTime(tOf(hover.x), model.unit, model.tz)}</text>}
        </svg>
        <div className="zoom-controls" title="ctrl/⌘ + wheel over the timeline to zoom · drag it to pan">
          <button className="ghost" onClick={() => zoomBy(0.5)} aria-label="Zoom out">−</button>
          <button className="ghost" onClick={() => zoomBy(2)} aria-label="Zoom in">+</button>
          <button className="ghost" onClick={() => setZoom({ k: 1, tx: 0 })}>Fit</button>
          <span className="hint">ctrl/⌘ + wheel · drag</span>
        </div>
        <TimeNavigator model={model} width={plotW} k={zoom.k} tx={zoom.tx} cursor={p.cursor}
          onPan={(tx) => setZoom((z) => ({ ...z, tx: clampTx(tx, z.k) }))} />
      </div>
      <div className="timeline-body" ref={bodyRef} onScroll={onScroll}>
        <div className="timeline-grid" style={{ height }}>
          <div className="labels" style={{ height }}>
            {rows.map((row, i) => (
              <RowLabel key={row.key} row={row} top={tops[i]} height={heights[i]} model={model}
                expanded={row.taskId ? p.expanded.has(row.taskId) : false} selected={!!row.taskId && p.highlight.has(row.taskId)}
                onToggle={p.onToggle} onSelect={p.onSelectTask}
                onHover={hoverLabel} />
            ))}
          </div>
          <svg ref={plotRef} className="plot" width={plotW} height={height}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerLeave={() => { setHover(null); drag.current = null; }}
            onDoubleClick={() => zoomBy(2)}>
            {gapBands}
            {ticks.map((t) => <line key={`g-${t}`} className="tick-line" x1={xOf(t)} x2={xOf(t)} y1={0} y2={height} />)}
            {overlays}
            {bands}
            {markers}
            {cursorX !== null && cursorX >= 0 && cursorX <= plotW && <line className="playhead" x1={cursorX} x2={cursorX} y1={0} y2={height} />}
            {hover && <line className="crosshair" x1={hover.x} x2={hover.x} y1={0} y2={height} />}
          </svg>
        </div>
      </div>
      {hover && <Tooltip hover={hover} model={model} />}
      {labelTip && <LabelTooltip row={labelTip.row} rect={labelTip.rect} model={model} />}
    </div>
  );
}

function RowLabel(props: {
  row: Row; top: number; height: number; model: Model; expanded: boolean; selected: boolean;
  onToggle(id: string): void; onSelect(id: string | null): void; onHover(row: Row | null, rect?: DOMRect, immediate?: boolean): void;
}) {
  const { row, model } = props;
  const task = row.taskId ? model.tree.tasks.get(row.taskId) : undefined;
  const isRoot = row.taskId === model.tree.rootId && row.mode === "rollup";
  const internal = !!row.taskId && !model.tree.isLeaf(row.taskId) && !isRoot && row.mode !== "general";
  const agents = new Set(row.items.map((i) => i.actor)).size;
  const work = row.items.reduce((s, i) => s + (i.end - i.start), 0);
  const name = row.mode === "waiting" ? "Waiting" : row.mode === "general" ? "(general)" : task?.name ?? "";
  const show = (el: Element, immediate = false) => props.onHover(row, el.getBoundingClientRect(), immediate);
  return (
    <div className="row-label" data-selected={props.selected} style={{ top: props.top, height: props.height, paddingLeft: 6 + Math.min(row.depth, MAX_INDENT) * 14 }}
      onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => props.onHover(null)} onMouseDown={() => props.onHover(null)}>
      {internal ? (
        <button className="twist" aria-expanded={props.expanded} aria-label={props.expanded ? "Collapse" : "Expand"}
          onClick={() => props.onToggle(row.taskId!)}>{props.expanded ? "▾" : "▸"}</button>
      ) : <span className="twist" />}
      <button className={`name ${isRoot ? "root" : row.mode}`} aria-describedby={`tip-${row.key}`}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && show(e.currentTarget.parentElement!, true)}
        onBlur={() => props.onHover(null)}
        onClick={() => row.mode !== "waiting" && props.onSelect(row.taskId)}>{name}</button>
      {task?.status && row.mode !== "general" && (
        <span className={`status ${task.status}`} aria-label={`status: ${task.status}`}>{STATUS_ICON[task.status]}</span>
      )}
      <span className="meta">{agents ? `${agents} ${agents === 1 ? "agent" : "agents"} · ${formatDuration(work, model.unit)}` : ""}</span>
    </div>
  );
}

/** Shown at once beside a hovered or focused task name (the browser's title tooltip has a delay). */
function LabelTooltip({ row, rect, model }: { row: Row; rect: DOMRect; model: Model }) {
  const task = row.taskId ? model.tree.tasks.get(row.taskId) : undefined;
  const agents = new Set(row.items.map((i) => i.actor)).size;
  const work = row.items.reduce((s, i) => s + (i.end - i.start), 0);
  let title = task?.name ?? "";
  let body = task?.description ?? null;
  if (row.mode === "waiting") {
    title = "Waiting";
    body = "Time agents spent waiting or paused, one band per agent.";
  } else if (row.mode === "general") {
    title = `${task?.name}: general work`;
    body = "Work attached to this task itself rather than to one of its subtasks.";
  }
  const style = { left: Math.min(window.innerWidth - 380, rect.right + 8), top: Math.max(8, Math.min(window.innerHeight - 180, rect.top)) };
  return (
    <div className="tooltip" style={style} role="tooltip" id={`tip-${row.key}`}>
      <strong>{title}</strong>
      {body && <div>{body}</div>}
      {task?.status && row.mode !== "general" && row.mode !== "waiting" && (
        <div className={`status ${task.status}`} style={{ marginTop: 4 }}>{STATUS_ICON[task.status]} {task.status}</div>
      )}
      {agents > 0 && <div className="muted">{agents} {agents === 1 ? "agent" : "agents"} · {formatDuration(work, model.unit)} of agent time</div>}
      {task?.provenance === "llm" && row.mode !== "general" && <div className="muted">Inferred from the agents' own session descriptions</div>}
    </div>
  );
}

function Tooltip({ hover, model }: { hover: Hover; model: Model }) {
  const style = { left: Math.min(window.innerWidth - 380, hover.clientX + 14), top: hover.clientY + 14 };
  const actorLine = (id: string) => {
    const a = model.actors.get(id);
    return <div key={id}><span className="key" style={{ background: model.colorOf.get(id) }} />{a?.name ?? id}</div>;
  };
  if (hover.overlap) {
    const ov = hover.overlap;
    return (
      <div className="tooltip" style={style}>
        <strong>{ov.coordinated ? "Overlapping work, coordinated" : "⚠ Overlapping work, no messages between them"}</strong>
        {ov.actors.map(actorLine)}
        <div className="muted">{model.tree.tasks.get(ov.task_id)?.name} · {formatDuration(ov.end - ov.start, model.unit)}</div>
      </div>
    );
  }
  if (hover.loop) {
    const lp = hover.loop;
    const labels = lp.span_ids.slice(0, 6).map((id) => model.spanById.get(id)?.label ?? id);
    return (
      <div className="tooltip" style={style}>
        <strong>{lp.count} similar attempts in a row ({lp.kind})</strong>
        {actorLine(lp.actor)}
        <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>{labels.map((l, i) => <li key={i}>{l}</li>)}</ul>
        {lp.count > 6 && <div className="muted">…and {lp.count - 6} more</div>}
      </div>
    );
  }
  const it = hover.item;
  if (!it) return null;
  const task = model.spanTask.get(it.id);
  const wait = it.span.kind === "wait";
  const target = model.waitTargets.get(it.id);
  return (
    <div className="tooltip" style={style}>
      <strong>{wait ? "Waiting" : it.label || "(no description)"}</strong>
      {actorLine(it.actor)}
      <div className="muted">
        {formatTime(it.start, model.unit, model.tz, model.unit === "s")} – {formatTime(it.end, model.unit, model.tz)} · {formatDuration(it.end - it.start, model.unit)}
      </div>
      {task && <div className="muted">{model.tree.path(task).slice(1).map((t) => model.tree.tasks.get(t)!.name).join(" › ") || "(not assigned to a subtask)"}</div>}
      {target && <div className="muted">waiting on {target.target_kind === "external" ? target.target_text : target.target_kind === "task"
        ? model.tree.tasks.get(target.target_id ?? "")?.name : model.actors.get(target.target_id ?? "")?.name}</div>}
    </div>
  );
}
