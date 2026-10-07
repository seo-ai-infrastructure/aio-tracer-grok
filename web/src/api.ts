import type { EpisodeSummary, Snapshot } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const fetchEpisodes = () => getJson<EpisodeSummary[]>("/api/episodes");

export const fetchSnapshot = (episodeId: string) =>
  getJson<Snapshot>(`/api/episodes/${encodeURIComponent(episodeId)}/snapshot`);

export const fetchReasoning = (messageId: string) =>
  getJson<{ id: string; reasoning: string | null }>(`/api/messages/${encodeURIComponent(messageId)}/reasoning`);

export interface ReplayStatus {
  position: number;
  total: number;
  speed: number;
  paused: boolean;
  done: boolean;
  clock: number | null;
}

export interface ServerInfo {
  mode: "static" | "replay" | "follow";
  source: string | null;
  seq: number;
  replay: ReplayStatus | null;
}

export const fetchInfo = () => getJson<ServerInfo>("/api/info");

export async function controlReplay(cmd: { action?: "pause" | "resume"; speed?: number }): Promise<ReplayStatus> {
  const res = await fetch("/api/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  if (!res.ok) throw new Error(`replay control: ${res.status}`);
  return (await res.json()) as ReplayStatus;
}

export const streamUrl = (episodeId: string, fromSeq: number) =>
  `/api/episodes/${encodeURIComponent(episodeId)}/stream?from_seq=${fromSeq}`;
