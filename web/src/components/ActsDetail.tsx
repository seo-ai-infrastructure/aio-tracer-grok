// The panel beside the summary: what a picked sentence does and what it's linked to, or every sentence
// behind a picked bar segment or count. Each entry jumps the chat to its message.
import { useEffect, useRef } from "react";
import {
  ACT_LABEL, type ActsSelection, GROUPS, groupOf, type Metric, METRICS, RELATION_LABEL, type SpeakerSummary, type Speech,
} from "../lib/acts";
import type { Model } from "../lib/model";
import { formatTime } from "../lib/timeScale";
import type { ActLink } from "../types";

interface Props {
  model: Model;
  speech: Speech;
  sums: SpeakerSummary[];
  selection: ActsSelection;
  elaborations: boolean;
  current: string | null; // the message the chat is on
  onSelect(s: ActsSelection): void;
  onFocus(messageId: string): void;
}

const LIST_CAP = 200;

export function ActsDetail({ model, speech, sums, selection, elaborations, current, onSelect, onFocus }: Props) {
  const active = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    active.current?.scrollIntoView({ block: "nearest" }); // in braces: newer browsers return a Promise here, not a cleanup
  }, [current]);
  const name = (id: string) => model.actors.get(id)?.name ?? id;
  const when = (t: number) => formatTime(t, model.unit, model.tz, model.unit === "s");
  const keep = (l: ActLink) => elaborations || l.relation !== "elaborates";

  const point = (sid: string, kind: "trigger" | "follow", tag?: string) => {
    const m = speech.message.get(sid);
    if (!m) return null;
    const on = m.id === current;
    const text = speech.text.get(sid) ?? "";
    return (
      <button key={`${sid}-${tag ?? ""}`} ref={on ? active : undefined} className={`point ${kind}${on ? " active" : ""}`}
        onClick={() => onFocus(m.id)} title="Find it in the chat">
        <span className="point-head">
          <span className="muted">{when(m.t)}</span> <b>{name(m.sender)}</b>
          {tag && <span className="tag">{tag}</span>}
        </span>
        <span className="point-text">{text.length > 240 ? `${text.slice(0, 240)}…` : text}</span>
      </button>
    );
  };
  const chips = (sid: string) => (
    <span className="act-chips">
      {(speech.acts.get(sid) ?? []).map((a) => (
        <span key={a} className={`act-chip act-${groupOf(a)}`}><span className="swatch act" aria-hidden />{ACT_LABEL[a]}</span>
      ))}
    </span>
  );

  if (!selection) {
    return (
      <aside className="drawer evidence">
        <h3>How the conversation is structured</h3>
        <p>Every chat sentence is labeled by what it does (asking, committing, informing, correcting) and linked to what it
          responds to. Together they show which questions get answered, which requests get taken up, and which commitments are kept.</p>
        <p className="muted">Underlines in the chat show each sentence's group. Hover a sentence for its labels; click it to see
          what it responds to and what responded to it.</p>
        <ul className="evidence-list">
          {GROUPS.map((g) => (
            <li key={g.id}>
              <span className={`act-chip act-${g.id}`}><span className="swatch act" aria-hidden />{g.label}</span>{" "}
              <span className="muted">{g.acts.map((a) => ACT_LABEL[a]).join(", ")}</span>
            </li>
          ))}
        </ul>
        <p className="muted">Click a bar segment for every sentence of that kind, or a count to see which questions were answered,
          which requests were taken up and which commitments were kept.</p>
      </aside>
    );
  }

  if (selection.kind === "sentence") {
    const sid = selection.id;
    const m = speech.message.get(sid);
    if (!m) return <aside className="drawer evidence"><p className="muted">That sentence isn't in this episode.</p></aside>;
    const out = (speech.out.get(sid) ?? []).filter(keep);
    const inn = (speech.in.get(sid) ?? []).filter(keep);
    return (
      <aside className="drawer evidence">
        <h3>{name(m.sender)}</h3>
        <p className="muted">{when(m.t)} · <button className="linkish" onClick={() => onSelect(null)}>clear</button></p>
        {point(sid, "trigger")}
        {speech.acts.has(sid) ? chips(sid) : <p className="muted">Not labeled yet.</p>}
        <h4>Responds to</h4>
        {out.length ? <div className="points">{out.map((l) => point(l.dst_id, "follow", RELATION_LABEL[l.relation][0]))}</div>
          : <p className="muted">Nothing earlier.</p>}
        <h4>Responses</h4>
        {inn.length ? <div className="points">{inn.map((l) => point(l.src_id, "follow", RELATION_LABEL[l.relation][0]))}</div>
          : <p className="muted">None found.</p>}
      </aside>
    );
  }

  const sum = sums.find((s) => s.speaker.id === selection.speaker);
  if (!sum) return <aside className="drawer evidence"><p className="muted">Nothing to show with the current filters.</p></aside>;

  if (selection.kind === "group") {
    const g = GROUPS.find((x) => x.id === selection.group)!;
    const ids = [...speech.acts].filter(([sid, acts]) => sum.speaker.members.has(speech.message.get(sid)!.sender)
      && acts.some((a) => g.acts.includes(a))).map(([sid]) => sid)
      .sort((a, b) => model.messageIndex.get(speech.message.get(a)!.id)! - model.messageIndex.get(speech.message.get(b)!.id)! || a.localeCompare(b));
    return (
      <aside className="drawer evidence">
        <h3>{sum.speaker.name}: {g.label.toLowerCase()}</h3>
        <p>{ids.length} sentences: {g.acts.filter((a) => sum.byAct.get(a)).map((a) => `${ACT_LABEL[a]} ${sum.byAct.get(a)}`).join(", ")}.{" "}
          <button className="linkish" onClick={() => onSelect(null)}>clear</button></p>
        <div className="points">{ids.slice(0, LIST_CAP).map((sid) => point(sid, "trigger", (speech.acts.get(sid) ?? []).filter((a) => g.acts.includes(a)).map((a) => ACT_LABEL[a]).join(" + ")))}</div>
        {ids.length > LIST_CAP && <p className="muted">and {ids.length - LIST_CAP} more: use Next in the chat to reach them all.</p>}
      </aside>
    );
  }

  const metric = METRICS.find((x) => x.id === selection.metric)!;
  const o = sum.outcomes[selection.metric as Metric];
  const status = (sid: string) => o.done.has(sid) ? <span className="outcome done">✓ {metric.done}</span>
    : o.other.has(sid) ? <span className="outcome other">◐ {metric.other}</span>
    : <span className="outcome none">– no {selection.metric === "questions" ? "answer" : selection.metric === "requests" ? "response" : "follow-up"} found</span>;
  return (
    <aside className="drawer evidence">
      <h3>{sum.speaker.name}: {metric.label.toLowerCase()}</h3>
      <p>Of {o.items.length.toLocaleString()}: {o.done.size} {metric.done}{metric.other ? `, ${o.other.size} ${metric.other}` : ""},{" "}
        {(o.items.length - o.done.size - o.other.size).toLocaleString()} {metric.none}.{" "}
        <button className="linkish" onClick={() => onSelect(null)}>clear</button></p>
      <p className="muted">"Found" means a later message in reach of the labeler (about 65 messages, or the speaker's recent
        commitments) shows it; anything further away isn't counted.</p>
      <ul className="evidence-list">
        {o.items.slice(0, LIST_CAP).map((sid) => {
          const responses = (speech.in.get(sid) ?? []).filter(keep);
          return (
            <li key={sid}>
              <div>{status(sid)}</div>
              {point(sid, "trigger")}
              {responses.length > 0 && <div className="points">{responses.map((l) => point(l.src_id, "follow", RELATION_LABEL[l.relation][0]))}</div>}
            </li>
          );
        })}
      </ul>
      {o.items.length > LIST_CAP && <p className="muted">and {o.items.length - LIST_CAP} more: use Next in the chat to reach them all.</p>}
    </aside>
  );
}
