import { create } from "zustand";
import { controlReplay, fetchEpisodes, fetchInfo, fetchSnapshot, type ServerInfo, streamUrl } from "./api";
import { applyDeltas, type Delta } from "./lib/deltas";
import type { EpisodeSummary, Snapshot } from "./types";

export type Tab = "tasks" | "acts" | "influence";
const TAB_IDS: Tab[] = ["tasks", "acts", "influence"];
export type Theme = "system" | "light" | "dark";
export type CursorSource = "timeline" | "transcript";

const FLUSH_MS = 400; // apply streamed deltas at most this often

interface State {
  info: ServerInfo | null;
  episodes: EpisodeSummary[];
  episodeId: string | null;
  snap: Snapshot | null;
  loading: boolean;
  error: string | null;
  tab: Tab;
  theme: Theme;
  selectedTask: string | null;
  withDescendants: boolean;
  isolated: string | null; // actor emphasized from the legend
  cursor: { t: number; from: CursorSource } | null;
  follow: boolean; // in live modes, keep the playhead and chat at the newest data
  loadEpisodes(): Promise<void>;
  openEpisode(id: string): Promise<void>;
  setTab(tab: Tab): void;
  setTheme(theme: Theme): void;
  selectTask(id: string | null): void;
  setWithDescendants(v: boolean): void;
  isolate(actor: string | null): void;
  setCursor(t: number, from: CursorSource): void;
  setFollow(v: boolean): void;
  replay(cmd: { action?: "pause" | "resume"; speed?: number }): Promise<void>;
}

function readHash(): { episode?: string; tab?: Tab } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const tab = params.get("tab") as Tab | null;
  return { episode: params.get("episode") ?? undefined, tab: tab && TAB_IDS.includes(tab) ? tab : undefined }; // old links may name a removed tab
}

const LAST_EPISODE = "collab:lastEpisode"; // per-browser convenience: reopen what you looked at last
const THEME = "collab:theme";

function storedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME);
    return t === "system" || t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

/** Dark unless the viewer chose otherwise; "system" follows the OS setting. */
function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

const initialTheme: Theme = storedTheme() ?? "dark";
applyTheme(initialTheme);

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_EPISODE);
  } catch {
    return null;
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(LAST_EPISODE, id);
  } catch {
    // storage unavailable (private window): nothing to remember
  }
}

function writeHash(episode: string | null, tab: Tab) {
  const params = new URLSearchParams();
  if (episode) params.set("episode", episode);
  params.set("tab", tab);
  history.replaceState(null, "", `#${params.toString()}`);
}

let source: EventSource | null = null;
let pending: Delta[] = [];
let flushTimer: number | null = null;
let infoTimer: number | null = null;

export const useStore = create<State>((set, get) => {
  const flush = () => {
    flushTimer = null;
    const snap = get().snap;
    if (snap && pending.length) set({ snap: applyDeltas(snap, pending) });
    pending = [];
  };

  const subscribe = (episodeId: string, fromSeq: number) => {
    source?.close();
    pending = [];
    source = new EventSource(streamUrl(episodeId, fromSeq));
    source.onmessage = (ev) => {
      if (get().episodeId !== episodeId) return;
      pending.push(...(JSON.parse(ev.data) as Delta[]));
      if (flushTimer === null) flushTimer = window.setTimeout(flush, FLUSH_MS);
    };
  };

  const pollInfo = () => {
    if (infoTimer !== null) return;
    infoTimer = window.setInterval(async () => {
      const info = await fetchInfo().catch(() => null);
      if (!info) return;
      set({ info });
      if (!get().episodes.length) await get().loadEpisodes(); // live store may start empty
      if (info.mode === "static" || info.replay?.done) {
        window.clearInterval(infoTimer!);
        infoTimer = null;
      }
    }, 2000);
  };

  return {
    info: null,
    episodes: [],
    episodeId: null,
    snap: null,
    loading: false,
    error: null,
    tab: readHash().tab ?? "tasks",
    theme: initialTheme,
    selectedTask: null,
    withDescendants: true,
    isolated: null,
    cursor: null,
    follow: true,

    async loadEpisodes() {
      try {
        const [info, episodes] = await Promise.all([fetchInfo(), fetchEpisodes()]);
        set({ info, episodes });
        if (info.mode !== "static") pollInfo();
        if (get().episodeId && episodes.some((e) => e.id === get().episodeId)) return;
        const byId = (id: string | null | undefined) => episodes.find((e) => e.id === id);
        const pick = byId(readHash().episode) ?? byId(remembered()) ?? episodes.find((e) => e.attrs?.pilot)
          ?? episodes.find((e) => e.scope === "shared") ?? episodes[0];
        if (pick) await get().openEpisode(pick.id);
      } catch (e) {
        set({ error: String(e) });
      }
    },

    async openEpisode(id) {
      set({ episodeId: id, loading: true, error: null, selectedTask: null, isolated: null, cursor: null });
      writeHash(id, get().tab);
      remember(id);
      try {
        const snap = await fetchSnapshot(id);
        if (get().episodeId !== id) return;
        set({ snap, loading: false });
        subscribe(id, snap.seq);
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    setTab(tab) {
      set({ tab });
      writeHash(get().episodeId, tab);
    },

    setTheme(theme) {
      set({ theme });
      applyTheme(theme);
      try {
        localStorage.setItem(THEME, theme);
      } catch {
        // storage unavailable: the choice lasts until reload
      }
    },

    selectTask: (id) => set({ selectedTask: id }),
    setWithDescendants: (v) => set({ withDescendants: v }),
    isolate: (actor) => set((s) => ({ isolated: s.isolated === actor ? null : actor })),
    setCursor: (t, from) => {
      const c = get().cursor;
      if (!c || c.t !== t || c.from !== from) set({ cursor: { t, from } }); // no-op updates can't start render loops
    },
    setFollow: (v) => set({ follow: v }),

    async replay(cmd) {
      const status = await controlReplay(cmd);
      const info = get().info;
      if (info) set({ info: { ...info, replay: status } });
    },
  };
});
