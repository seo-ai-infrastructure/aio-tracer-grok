// Agent color = model family. Only three families get hues: that is how many of the reference
// palette's slots stay distinguishable when any two bands can sit side by side (validated
// all-pairs, light and dark). Other families share a neutral; individual agents are told apart by
// labels, hover and legend isolation - never by invented shades.
import type { Actor, Manifest } from "../types";

export const FAMILY_SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
export const OTHER = "var(--series-other)";
export const HUMAN = "var(--human)";
export const SYSTEM = "var(--system)";

export interface LegendGroup {
  family: string;
  color: string;
  actors: Actor[];
}

/** Family order: the dataset's preference (manifest.attrs.family_order), then by agent count. */
export function familyOrder(actors: Actor[], manifest: Manifest | null): string[] {
  const counts = new Map<string, number>();
  for (const a of actors) {
    if (a.kind !== "agent") continue;
    const fam = a.attrs?.family ?? "Other";
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
  }
  const preferred = ((manifest?.attrs?.family_order as string[] | undefined) ?? []).filter((f) => counts.has(f));
  const rest = [...counts.keys()].filter((f) => !preferred.includes(f))
    .sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
  return [...preferred, ...rest];
}

/** Family -> color. Families in the dataset's preferred order keep their slot in every episode, even
 * when an earlier family is absent; other families take the remaining slots by agent count. */
function familyColors(actors: Actor[], manifest: Manifest | null): Map<string, string> {
  const preferred = ((manifest?.attrs?.family_order as string[] | undefined) ?? []).slice(0, FAMILY_SLOTS.length);
  const out = new Map(preferred.map((f, i) => [f, FAMILY_SLOTS[i]]));
  const free = FAMILY_SLOTS.filter((_, i) => i >= preferred.length);
  for (const f of familyOrder(actors, manifest)) {
    if (!out.has(f)) out.set(f, f !== "Other" && free.length ? free.shift()! : OTHER);
  }
  return out;
}

export function actorColors(actors: Actor[], manifest: Manifest | null): { colorOf: Map<string, string>; legend: LegendGroup[] } {
  const order = familyOrder(actors, manifest);
  const famColor = familyColors(actors, manifest);
  const colorOf = new Map<string, string>();
  const groups = new Map<string, LegendGroup>();
  for (const a of actors) {
    let family: string;
    let color: string;
    if (a.kind === "agent") {
      family = a.attrs?.family ?? "Other";
      color = famColor.get(family) ?? OTHER;
      if (color === OTHER) family = "Other families";
    } else {
      family = a.kind === "human" ? "Humans" : "System";
      color = a.kind === "human" ? HUMAN : SYSTEM;
    }
    colorOf.set(a.id, color);
    const g = groups.get(family) ?? { family, color, actors: [] };
    g.actors.push(a);
    groups.set(family, g);
  }
  const rank = (g: LegendGroup) => (g.color === HUMAN ? 1e6 : g.color === SYSTEM ? 1e6 + 1 : g.color === OTHER ? 1e5 : order.indexOf(g.family));
  const legend = [...groups.values()].sort((a, b) => rank(a) - rank(b));
  for (const g of legend) g.actors.sort((a, b) => a.name.localeCompare(b.name));
  return { colorOf, legend };
}

/** Short display name for tight spaces: drop a leading family word ("Claude Opus 4.6" -> "Opus 4.6"). */
export function shortName(a: Actor): string {
  const fam = a.attrs?.family;
  if (fam && a.name.startsWith(fam + " ") && a.name.length > fam.length + 1) return a.name.slice(fam.length + 1);
  return a.name;
}
