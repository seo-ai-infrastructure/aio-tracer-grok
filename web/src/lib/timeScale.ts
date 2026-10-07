// A time axis that compresses long idle gaps (nights, weekends) so active stretches get the space.
// t = source time (epoch seconds or steps); u = compressed time; a linear scale maps u to pixels.

export interface Segment {
  start: number;
  end: number;
  u0: number; // compressed coordinate of `start`
}

export class CompressedTime {
  readonly segments: Segment[];
  readonly gapWidth: number;
  readonly total: number;

  /** Intervals closer than `gapThreshold` merge into one segment; longer gaps shrink to `gapWidth`. */
  constructor(intervals: [number, number][], gapThreshold: number, gapWidth: number) {
    const sorted = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e)).sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of sorted) {
      const last = merged[merged.length - 1];
      if (last && s - last[1] <= gapThreshold) last[1] = Math.max(last[1], e);
      else merged.push([s, Math.max(s, e)]);
    }
    if (!merged.length) merged.push([0, 1]);
    this.gapWidth = gapWidth;
    let u = 0;
    this.segments = merged.map(([start, end], i) => {
      if (i > 0) u += gapWidth;
      const seg = { start, end, u0: u };
      u += end - start;
      return seg;
    });
    this.total = Math.max(u, 1e-9);
  }

  toU(t: number): number {
    const segs = this.segments;
    if (t <= segs[0].start) return segs[0].u0 - (segs[0].start - t);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (t <= s.end) return s.u0 + (t - s.start);
      const next = segs[i + 1];
      if (next && t < next.start) {
        return s.u0 + (s.end - s.start) + (this.gapWidth * (t - s.end)) / (next.start - s.end);
      }
    }
    const last = segs[segs.length - 1];
    return last.u0 + (t - last.start);
  }

  toT(u: number): number {
    const segs = this.segments;
    if (u <= segs[0].u0) return segs[0].start - (segs[0].u0 - u);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const uEnd = s.u0 + (s.end - s.start);
      if (u <= uEnd) return s.start + (u - s.u0);
      const next = segs[i + 1];
      if (next && u < next.u0) return s.end + ((u - uEnd) / this.gapWidth) * (next.start - s.end);
    }
    const last = segs[segs.length - 1];
    return last.start + (u - last.u0);
  }

  /** Compressed gaps, as [u of gap start, u of gap end]. */
  gaps(): [number, number][] {
    return this.segments.slice(1).map((s, i) => {
      const prev = this.segments[i];
      return [prev.u0 + (prev.end - prev.start), s.u0];
    });
  }
}

const STEPS_S = [60, 300, 900, 1800, 3600, 7200, 10800, 21600, 43200];

/** Tick times (source units) for the visible compressed range, spaced at least `minPx` apart. */
export function timeTicks(time: CompressedTime, u0: number, u1: number, pxPerU: number, unit: "s" | "step", minPx = 70): number[] {
  const t0 = time.toT(u0);
  const t1 = time.toT(u1);
  if (unit === "step") {
    const raw = minPx / pxPerU;
    const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
    const out: number[] = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
    return out;
  }
  const step = STEPS_S.find((s) => s * pxPerU >= minPx) ?? STEPS_S[STEPS_S.length - 1];
  const out: number[] = [];
  for (const seg of time.segments) {
    const a = Math.max(seg.start, t0);
    const b = Math.min(seg.end, t1);
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) out.push(t);
  }
  return out;
}

export function formatTime(t: number, unit: "s" | "step", tz: string | null, withDay = false): string {
  if (unit === "step") return `step ${Number.isInteger(t) ? t : t.toFixed(1)}`;
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZone: tz ?? undefined };
  if (withDay) Object.assign(opts, { weekday: "short", month: "numeric", day: "numeric" });
  return new Intl.DateTimeFormat(undefined, opts).format(new Date(t * 1000));
}

/** Axis label: "10 AM" on the hour, "10:30" otherwise; "step 12" for step time. */
export function tickLabel(t: number, unit: "s" | "step", tz: string | null): string {
  if (unit === "step") return formatTime(t, unit, tz);
  const d = new Date(t * 1000);
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz ?? undefined }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return get("minute") === "00" ? `${get("hour")} ${get("dayPeriod")}` : `${get("hour")}:${get("minute")}`;
}

/** Drop ticks whose labels would collide (estimated width per character), keeping order. */
export function spacedTicks<T>(ticks: T[], x: (t: T) => number, label: (t: T) => string, charPx = 6.2, gapPx = 10): T[] {
  const out: T[] = [];
  let lastRight = -Infinity;
  for (const t of ticks) {
    const w = label(t).length * charPx;
    const left = x(t) - w / 2;
    if (left >= lastRight + gapPx) {
      out.push(t);
      lastRight = left + w;
    }
  }
  return out;
}

export interface DaySpan {
  start: number; // first active moment of the day
  end: number; // last active moment of the day
  long: string; // "Wed, 4/2"
  short: string; // "4/2"
}

/** Calendar days (in the display zone) of the active stretches, in order. */
export function daySpans(time: CompressedTime, tz: string | null): DaySpan[] {
  const zone = { timeZone: tz ?? undefined };
  const key = new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const long = new Intl.DateTimeFormat(undefined, { ...zone, weekday: "short", month: "numeric", day: "numeric" });
  const short = new Intl.DateTimeFormat(undefined, { ...zone, month: "numeric", day: "numeric" });
  const out: (DaySpan & { key: string })[] = [];
  for (const seg of time.segments) {
    const d = new Date(seg.start * 1000);
    const k = key.format(d);
    const last = out[out.length - 1];
    if (last && last.key === k) last.end = seg.end;
    else out.push({ key: k, start: seg.start, end: seg.end, long: long.format(d), short: short.format(d) });
  }
  return out.map(({ key: _, ...day }) => day);
}

/**
 * Left-anchored labels that never overlap: each day gets its long label if the day is wide enough, else
 * the short one; labels that would collide are dropped. A label pinned to the left edge (its day began
 * off screen) gives way to the next day's.
 */
export function dayLabels(days: DaySpan[], x: (t: number) => number, width: number, charPx = 6.6, gapPx = 8): { x: number; text: string }[] {
  const shown = days.filter((d) => x(d.end) >= 0 && x(d.start) <= width).map((d) => {
    const left = Math.max(2, x(d.start) + 2);
    const room = Math.min(width, x(d.end)) - left;
    const text = d.long.length * charPx <= room ? d.long : d.short;
    return { x: left, text, pinned: x(d.start) < 0 };
  });
  if (shown.length > 1 && shown[0].pinned && shown[1].x < shown[0].x + shown[0].text.length * charPx + gapPx) shown.shift();
  const out: { x: number; text: string }[] = [];
  let right = -Infinity;
  for (const l of shown) {
    if (l.x < right + gapPx || l.x + l.text.length * charPx > width + 1) continue;
    out.push({ x: l.x, text: l.text });
    right = l.x + l.text.length * charPx;
  }
  return out;
}

/** Average number of intervals active in each `bucket`-pixel slice of [0, width). */
export function density(intervals: [number, number][], x: (t: number) => number, width: number, bucket = 3): number[] {
  const n = Math.max(1, Math.ceil(width / bucket));
  const acc = new Array<number>(n).fill(0);
  for (const [s, e] of intervals) {
    const a = Math.max(0, x(s));
    const b = Math.min(width, x(e));
    for (let i = Math.floor(a / bucket); i < n && i * bucket < b; i++) {
      acc[i] += (Math.min(b, (i + 1) * bucket) - Math.max(a, i * bucket)) / bucket;
    }
  }
  return acc;
}

export function formatDuration(seconds: number, unit: "s" | "step"): string {
  if (unit === "step") return `${seconds} step${seconds === 1 ? "" : "s"}`;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
