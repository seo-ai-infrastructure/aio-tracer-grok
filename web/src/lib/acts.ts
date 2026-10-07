// Speech acts for the Communication tab: what each sentence does, which sentences respond to which,
// and per-speaker summaries. Pure functions over the model, cached per snapshot.
import type { Act, ActLink, Actor, Message, Relation, Snapshot } from "../types";
import type { Model } from "./model";

export type GroupId = "asks" | "commitments" | "corrections" | "social" | "information";

/** Five groups, in the order they stack in the summary bars (the order the palette was validated in). */
export const GROUPS: { id: GroupId; label: string; acts: Act[] }[] = [
  { id: "asks", label: "Asks", acts: ["question", "request", "propose"] },
  { id: "commitments", label: "Commitments", acts: ["commit", "accept", "reject"] },
  { id: "corrections", label: "Corrections", acts: ["correct"] },
  { id: "social", label: "Social", acts: ["thank", "social"] },
  { id: "information", label: "Information", acts: ["inform", "answer", "narrate", "wait"] },
];
const GROUP_OF = new Map<Act, GroupId>(GROUPS.flatMap((g) => g.acts.map((a): [Act, GroupId] => [a, g.id])));
export const groupOf = (a: Act): GroupId => GROUP_OF.get(a) ?? "information";
const GROUP_RANK = new Map(GROUPS.map((g, i) => [g.id, i]));

export const ACT_LABEL: Record<Act, string> = {
  inform: "inform", narrate: "narrate own action", wait: "wait", question: "question", answer: "answer", request: "request",
  propose: "propose", commit: "commit", accept: "accept", reject: "reject", thank: "thank", correct: "correct", social: "social",
};
export const RELATION_LABEL: Record<Relation, [string, string]> = { // [as a response, as what it got]
  answers: ["answers", "answered by"], accepts: ["accepts", "accepted by"], rejects: ["rejects", "rejected by"],
  commits_to: ["commits to", "taken on by"], fulfills: ["fulfills", "fulfilled by"], updates: ["updates on", "updated by"],
  acknowledges: ["acknowledges", "acknowledged by"], corrects: ["corrects", "corrected by"], elaborates: ["elaborates on", "elaborated by"],
};

export interface Speech {
  acts: Map<string, Act[]>; // sentence id -> its acts
  group: Map<string, GroupId>; // sentence id -> the group it is shown in (its first act's group in GROUPS order)
  out: Map<string, ActLink[]>; // sentence id -> links to the earlier sentences it responds to
  in: Map<string, ActLink[]>; // sentence id -> links from later sentences that respond to it
  message: Map<string, Message>; // sentence id -> its message
  text: Map<string, string>; // sentence id -> its text
  labeledMessages: number;
  lastLabeled: number | null; // time of the newest labeled message
}

const cache = new WeakMap<Snapshot, Speech>();

export function speechFor(model: Model): Speech {
  let s = cache.get(model.snap);
  if (!s) {
    s = buildSpeech(model);
    cache.set(model.snap, s);
  }
  return s;
}

export function buildSpeech(model: Model): Speech {
  const message = new Map<string, Message>();
  const text = new Map<string, string>();
  for (const m of model.messages) {
    for (const s of model.sentencesByMessage.get(m.id) ?? []) {
      message.set(s.id, m);
      text.set(s.id, m.text.slice(s.start_char, s.end_char).trim());
    }
  }
  const acts = new Map<string, Act[]>();
  for (const r of model.snap.acts) {
    if (!message.has(r.sentence_id)) continue;
    const list = acts.get(r.sentence_id) ?? [];
    if (!list.includes(r.act)) list.push(r.act);
    acts.set(r.sentence_id, list);
  }
  const group = new Map<string, GroupId>();
  for (const [sid, list] of acts) {
    group.set(sid, list.map(groupOf).sort((a, b) => GROUP_RANK.get(a)! - GROUP_RANK.get(b)!)[0]);
  }
  const out = new Map<string, ActLink[]>();
  const inn = new Map<string, ActLink[]>();
  for (const l of model.snap.act_links) {
    if (!message.has(l.src_id) || !message.has(l.dst_id)) continue;
    out.set(l.src_id, [...(out.get(l.src_id) ?? []), l]);
    inn.set(l.dst_id, [...(inn.get(l.dst_id) ?? []), l]);
  }
  const labeled = new Set([...acts.keys()].map((sid) => message.get(sid)!.id));
  const times = [...labeled].map((id) => model.messages[model.messageIndex.get(id)!]?.t ?? -Infinity);
  return { acts, group, out, in: inn, message, text, labeledMessages: labeled.size, lastLabeled: times.length ? Math.max(...times) : null };
}

/** A row in the summary: one agent, or the people of one role (organizers, viewers, ...) together. */
export interface Speaker {
  id: string;
  name: string;
  color: string;
  members: Set<string>;
  people: boolean;
}

export function speakers(model: Model, humans: boolean): Speaker[] {
  const out: Speaker[] = [];
  const roles = new Map<string, Speaker>();
  for (const g of model.legend) {
    for (const a of g.actors) {
      if (a.kind === "agent") {
        out.push({ id: a.id, name: a.name, color: g.color, members: new Set([a.id]), people: false });
      } else if (humans) {
        const role = a.kind === "system" ? "system" : a.role ?? a.kind;
        const id = `role:${role}`;
        const row = roles.get(id) ?? { id, name: plural(role), color: g.color, members: new Set<string>(), people: true };
        row.members.add(a.id);
        roles.set(id, row);
      }
    }
  }
  return [...out, ...[...roles.values()].sort((a, b) => a.name.localeCompare(b.name))];
}

function plural(role: string): string {
  const cap = role.charAt(0).toUpperCase() + role.slice(1);
  return role === "system" ? "System" : cap.endsWith("s") ? cap : `${cap}s`;
}

/** Items of one kind (questions, requests, promises) and how they turned out. */
export interface Outcome {
  items: string[]; // sentence ids, in chat order
  done: Set<string>; // answered / taken up / kept
  other: Set<string>; // requests declined; promises in progress
}

export type Metric = "questions" | "requests" | "promises";
// Every item is done, other (declined / in progress) or none: no follow-up was found within the labeler's reach,
// which is not the same as unanswered or broken. Shown together so the parts add up to the whole.
// Each count is drawn from one group: questions and requests are Asks; commitments (a commitment, or accepting a
// request) are Commitments.
export const METRICS: { id: Metric; label: string; group: GroupId; done: string; other?: string; none: string }[] = [
  { id: "questions", label: "Questions", group: "asks", done: "answered", none: "no answer found" },
  { id: "requests", label: "Requests", group: "asks", done: "taken up", other: "declined", none: "no response found" },
  { id: "promises", label: "Commitments", group: "commitments", done: "kept", other: "in progress", none: "no follow-up found" },
];
const METRIC_ACTS: Record<Metric, Act[]> = { questions: ["question"], requests: ["request"], promises: ["commit", "accept"] };
const DONE: Record<Metric, Relation[]> = {
  questions: ["answers"], requests: ["accepts", "commits_to", "fulfills", "updates"], promises: ["fulfills"],
};
const OTHER: Record<Metric, Relation[]> = { questions: [], requests: ["rejects"], promises: ["updates"] };

export interface SpeakerSummary {
  speaker: Speaker;
  sentences: number; // labeled sentences
  byGroup: Record<GroupId, number>;
  byAct: Map<Act, number>;
  outcomes: Record<Metric, Outcome>;
}

export function summarize(model: Model, speech: Speech, rows: Speaker[]): SpeakerSummary[] {
  const of = new Map<string, Speaker>();
  for (const r of rows) for (const id of r.members) of.set(id, r);
  const blank = (): SpeakerSummary["outcomes"] => ({
    questions: { items: [], done: new Set(), other: new Set() }, requests: { items: [], done: new Set(), other: new Set() },
    promises: { items: [], done: new Set(), other: new Set() },
  });
  const sums = new Map(rows.map((r) => [r.id, {
    speaker: r, sentences: 0, byGroup: { asks: 0, commitments: 0, corrections: 0, social: 0, information: 0 } as Record<GroupId, number>,
    byAct: new Map<Act, number>(), outcomes: blank(),
  }]));
  for (const m of model.messages) {
    const row = of.get(m.sender);
    if (!row) continue;
    const sum = sums.get(row.id)!;
    for (const s of model.sentencesByMessage.get(m.id) ?? []) {
      const acts = speech.acts.get(s.id);
      if (!acts) continue;
      sum.sentences += 1;
      sum.byGroup[speech.group.get(s.id)!] += 1;
      for (const a of acts) sum.byAct.set(a, (sum.byAct.get(a) ?? 0) + 1);
      for (const metric of ["questions", "requests", "promises"] as Metric[]) {
        if (!acts.some((a) => METRIC_ACTS[metric].includes(a))) continue;
        if (metric === "promises" && !acts.includes("commit") && !acceptsARequest(speech, s.id)) continue; // agreeing isn't promising
        const o = sum.outcomes[metric];
        o.items.push(s.id);
        const responses = (speech.in.get(s.id) ?? []).filter((l) => speech.message.get(l.src_id)!.sender !== m.sender || metric === "promises");
        const by = (rels: Relation[]) => responses.some((l) => rels.includes(l.relation))
          || (metric === "promises" && reportedOnTarget(model, speech, s.id, m, rels));
        if (by(DONE[metric])) o.done.add(s.id);
        else if (by(OTHER[metric])) o.other.add(s.id);
      }
    }
  }
  return rows.map((r) => sums.get(r.id)!);
}

/** "Sure, I'll do it": an acceptance whose target is a request (not a view or a general proposal). */
function acceptsARequest(speech: Speech, sid: string): boolean {
  return (speech.out.get(sid) ?? []).some((l) => (l.relation === "accepts" || l.relation === "commits_to")
    && (speech.acts.get(l.dst_id) ?? []).includes("request"));
}

/** A promise made by accepting (or committing to) a request also counts when the promiser later reports
 * on the request itself: models often link the report there rather than to the "Sure, I'll do it". */
function reportedOnTarget(model: Model, speech: Speech, sid: string, m: Message, rels: Relation[]): boolean {
  const after = (other: string) => model.messageIndex.get(speech.message.get(other)!.id)! > model.messageIndex.get(m.id)!;
  return (speech.out.get(sid) ?? []).filter((l) => l.relation === "accepts" || l.relation === "commits_to")
    .some((l) => (speech.in.get(l.dst_id) ?? []).some((r) => rels.includes(r.relation)
      && speech.message.get(r.src_id)!.sender === m.sender && after(r.src_id)));
}

export type ActsSelection =
  | { kind: "sentence"; id: string }
  | { kind: "group"; speaker: string; group: GroupId }
  | { kind: "metric"; speaker: string; metric: Metric }
  | null;

export interface Focus {
  highlight: Set<string>; // sentences to highlight and step through
  kinds: Map<string, "trigger" | "follow">; // darker: what was picked; lighter: what responds to it
  label: string | null;
}

/** The sentences a selection points at, and the ones linked to them. */
export function focusOf(speech: Speech, sums: SpeakerSummary[], sel: ActsSelection, showElaborations: boolean, name: (actor: string) => string): Focus {
  const kinds = new Map<string, "trigger" | "follow">();
  const keep = (l: ActLink) => showElaborations || l.relation !== "elaborates";
  if (!sel) return { highlight: new Set(), kinds, label: null };
  if (sel.kind === "sentence") {
    kinds.set(sel.id, "trigger");
    for (const l of (speech.out.get(sel.id) ?? []).filter(keep)) if (!kinds.has(l.dst_id)) kinds.set(l.dst_id, "follow");
    for (const l of (speech.in.get(sel.id) ?? []).filter(keep)) if (!kinds.has(l.src_id)) kinds.set(l.src_id, "follow");
    const m = speech.message.get(sel.id);
    return { highlight: new Set(kinds.keys()), kinds, label: m ? `a sentence by ${name(m.sender)} and what it's linked to` : null };
  }
  const sum = sums.find((s) => s.speaker.id === sel.speaker);
  if (!sum) return { highlight: new Set(), kinds, label: null };
  if (sel.kind === "group") {
    const g = GROUPS.find((x) => x.id === sel.group)!;
    for (const [sid, acts] of speech.acts) {
      if (sum.speaker.members.has(speech.message.get(sid)!.sender) && acts.some((a) => g.acts.includes(a))) kinds.set(sid, "trigger");
    }
    return { highlight: new Set(kinds.keys()), kinds, label: `${sum.speaker.name}: ${g.label.toLowerCase()}` };
  }
  const o = sum.outcomes[sel.metric];
  for (const sid of o.items) kinds.set(sid, "trigger");
  for (const sid of o.items) for (const l of speech.in.get(sid) ?? []) if (keep(l) && !kinds.has(l.src_id)) kinds.set(l.src_id, "follow");
  const metric = METRICS.find((x) => x.id === sel.metric)!;
  return { highlight: new Set(kinds.keys()), kinds, label: `${sum.speaker.name}: ${metric.label.toLowerCase()}` };
}

export function actorName(actors: Map<string, Actor>, id: string): string {
  return actors.get(id)?.name ?? id;
}
