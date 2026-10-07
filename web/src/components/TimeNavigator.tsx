// The whole episode at a glance under the time axis: how many agents were working when, which days,
// where the chat is, and a window for the part the timeline shows. Drag the window, or click to jump.
import { useMemo, useRef } from "react";
import type { Model } from "../lib/model";
import { dayLabels, daySpans, density } from "../lib/timeScale";

export const NAV_H = 30;
const TOP = 12; // room for the date labels
const BUCKET = 3; // px per density slice

interface Props {
  model: Model;
  width: number; // the plot's width
  k: number; // the timeline's zoom (1 = everything fits)
  tx: number; // the timeline's pan offset, in its own pixels
  cursor: number | null;
  onPan(tx: number): void;
}

export function TimeNavigator({ model, width, k, tx, cursor, onPan }: Props) {
  const total = model.time.total;
  const xOf = (t: number) => (model.time.toU(t) / total) * width;
  const drag = useRef<number | null>(null); // where in the window the pointer grabbed it

  const days = useMemo(() => daySpans(model.time, model.unit === "s" ? model.tz : null), [model]);
  const area = useMemo(() => {
    const work = model.snap.spans.filter((s) => s.kind === "work").map((s): [number, number] => [s.start, s.end ?? model.now]);
    const d = density(work, (t) => (model.time.toU(t) / total) * width, width, BUCKET);
    const max = Math.max(1, ...d);
    let path = `M0,${NAV_H}`;
    d.forEach((v, i) => {
      const y = NAV_H - (v / max) * (NAV_H - TOP - 1);
      path += `L${i * BUCKET},${y}L${(i + 1) * BUCKET},${y}`;
    });
    return `${path}L${width},${NAV_H}Z`;
  }, [model, total, width]);

  const w = width / k;
  const left = -tx / k;
  const zoomed = k > 1.001;
  const place = (px: number, grab: number) => onPan(-Math.min(width - w, Math.max(0, px - grab)) * k);
  const at = (e: React.PointerEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left;

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!zoomed || e.button !== 0) return;
    const px = at(e);
    const inside = px >= left && px <= left + w;
    drag.current = inside ? px - left : w / 2;
    if (!inside) place(px, drag.current);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current !== null) place(at(e), drag.current);
  };
  const end = () => {
    drag.current = null;
  };

  const labels = model.unit === "s" ? dayLabels(days.map((d) => ({ ...d, long: d.short })), xOf, width, 6, 10) : [];
  const cx = cursor !== null ? xOf(cursor) : null;
  return (
    <svg className={`navigator${zoomed ? " zoomed" : ""}`} width={width} height={NAV_H} onPointerDown={onDown} onPointerMove={onMove}
      onPointerUp={end} onPointerCancel={end} role="slider" aria-label="Part of the episode shown (drag the window, or click to jump)"
      aria-valuemin={0} aria-valuemax={Math.round(width - w)} aria-valuenow={Math.round(left)}>
      {model.time.gaps().map(([ga, gb], i) => (
        <rect key={i} className="nav-gap" x={(ga / total) * width} y={0} width={Math.max(0, ((gb - ga) / total) * width)} height={NAV_H} />
      ))}
      <path d={area} className="nav-density" />
      {labels.map((l) => <text key={`${l.text}-${l.x}`} x={l.x} y={9}>{l.text}</text>)}
      {cx !== null && <line className="nav-playhead" x1={cx} x2={cx} y1={TOP - 2} y2={NAV_H} />}
      {zoomed && <rect className="nav-window" x={left + 0.75} y={0.75} width={Math.max(4, w - 1.5)} height={NAV_H - 1.5} rx={3} />}
    </svg>
  );
}
