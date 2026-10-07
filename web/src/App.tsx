import { useEffect } from "react";
import { useStore, type Tab, type Theme } from "./state";
import { ActsTab } from "./tabs/ActsTab";
import { InfluenceTab } from "./tabs/InfluenceTab";
import { TasksTab } from "./tabs/TasksTab";
import type { EpisodeSummary } from "./types";

const TABS: { id: Tab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "acts", label: "Communication" },
  { id: "influence", label: "Influence" },
];

/** "Apr 2, 2025", "Mar 5 – 13, 2026", or "steps 0–60": which slice of data an episode is. */
export function episodeRange(e: EpisodeSummary): string {
  if (e.time_unit === "step") return `steps ${e.start}–${e.end ?? "…"}`;
  const fmt = (t: number, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { timeZone: e.display_tz ?? undefined, ...opts }).format(new Date(t * 1000));
  const day = (t: number) => fmt(t, { year: "numeric", month: "short", day: "numeric" });
  if (e.end === null || day(e.start) === day(e.end)) return day(e.start);
  return `${fmt(e.start, { month: "short", day: "numeric" })} – ${day(e.end)}`;
}

function ModeBadge() {
  const { info, follow, setFollow, replay } = useStore();
  if (!info) return null;
  if (info.mode === "static") return <span className="muted">static</span>;
  const r = info.replay;
  return (
    <span className="mode-badge">
      <span className="live-dot" aria-hidden />
      <span>{info.mode === "replay" ? `Replay ×${r?.speed ?? ""}` : "Following"}</span>
      {r && <span className="muted">{r.position.toLocaleString()} / {r.total.toLocaleString()}{r.done ? " · done" : r.paused ? " · paused" : ""}</span>}
      {r && !r.done && (
        <>
          <button className="ghost" onClick={() => replay({ action: r.paused ? "resume" : "pause" })}>{r.paused ? "Resume" : "Pause"}</button>
          <select value={r.speed} aria-label="Replay speed" onChange={(e) => replay({ speed: Number(e.target.value) })}>
            {[...new Set([r.speed, 10, 60, 240, 1000, 5000])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>×{s}</option>)}
          </select>
        </>
      )}
      <label className="secondary"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
    </span>
  );
}

export function App() {
  const { episodes, episodeId, snap, loading, error, tab, theme, loadEpisodes, openEpisode, setTab, setTheme } = useStore();
  useEffect(() => {
    loadEpisodes();
  }, [loadEpisodes]);

  const shared = episodes.filter((e) => e.scope === "shared");
  const other = episodes.filter((e) => e.scope !== "shared");
  const nextTheme: Record<Theme, Theme> = { dark: "light", light: "system", system: "dark" };

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">Swarm Tracer</span>
        <select value={episodeId ?? ""} onChange={(e) => openEpisode(e.target.value)} aria-label="Episode">
          {shared.length > 0 && (
            <optgroup label="Shared goal">
              {shared.map((e) => <option key={e.id} value={e.id}>{episodeRange(e)} · {e.name ?? e.id}</option>)}
            </optgroup>
          )}
          {other.length > 0 && (
            <optgroup label="Other">
              {other.map((e) => <option key={e.id} value={e.id}>{episodeRange(e)} · {e.name ?? e.id}</option>)}
            </optgroup>
          )}
        </select>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <span className="spacer" />
        {snap && <span className="muted">{snap.manifest?.name ?? snap.manifest?.id}</span>}
        <ModeBadge />
        <button className="ghost" onClick={() => setTheme(nextTheme[theme])} aria-label="Theme">Theme: {theme}</button>
      </header>
      <main style={{ minHeight: 0, display: "grid" }}>
        {error && <div className="status-line">Could not load: {error}. Is the API running (python scripts/serve.py)?</div>}
        {!error && (loading || !snap) && <div className="status-line">Loading…</div>}
        {!error && !loading && snap && tab === "tasks" && <TasksTab key={snap.episode.id} snap={snap} />}
        {!error && !loading && snap && tab === "influence" && <InfluenceTab key={snap.episode.id} snap={snap} />}
        {!error && !loading && snap && tab === "acts" && <ActsTab key={snap.episode.id} snap={snap} />}
      </main>
    </div>
  );
}
