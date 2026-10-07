// One row per agent (and per human role): the mix of what they say, and what came of their questions,
// requests and commitments. Every bar segment and count is clickable; the table doubles as the accessible view.
import { useState } from "react";
import { ACT_LABEL, type ActsSelection, GROUPS, type Metric, METRICS, type SpeakerSummary } from "../lib/acts";

interface Props {
  sums: SpeakerSummary[];
  selection: ActsSelection;
  onSelect(s: ActsSelection): void;
}

export function ActsSummary({ sums, selection, onSelect }: Props) {
  const [tip, setTip] = useState<{ x: number; y: number; body: React.ReactNode } | null>(null);
  const isSel = (speaker: string, key: string) =>
    (selection?.kind === "group" && selection.speaker === speaker && selection.group === key)
    || (selection?.kind === "metric" && selection.speaker === speaker && selection.metric === key);
  const rows = sums.filter((s) => s.sentences > 0);

  return (
    <div className="acts-summary">
      <table>
        <thead>
          <tr>
            <th>Speaker</th>
            <th className="num">Sentences</th>
            <th>What they say</th>
            {METRICS.map((m) => (
              <th key={m.id} className={`num act-${m.group}`}><span className="swatch act" aria-hidden /> {m.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.speaker.id}>
              <th scope="row" style={{ fontWeight: "normal" }}>
                <span className="who">
                  <span className="swatch" style={{ background: s.speaker.color, borderRadius: "50%" }} aria-hidden />
                  {s.speaker.name}{s.speaker.people && <span className="muted">({s.speaker.members.size})</span>}
                </span>
              </th>
              <td className="num">{s.sentences.toLocaleString()}</td>
              <td>
                <div className="mix" role="group" aria-label={`${s.speaker.name}: what they say`}>
                  {GROUPS.filter((g) => s.byGroup[g.id] > 0).map((g) => {
                    const n = s.byGroup[g.id];
                    const pct = Math.round((100 * n) / s.sentences);
                    const detail = g.acts.filter((a) => s.byAct.get(a)).map((a) => `${ACT_LABEL[a]} ${s.byAct.get(a)}`).join(" · ");
                    return (
                      <button key={g.id} className={`act-${g.id}${isSel(s.speaker.id, g.id) ? " sel" : ""}`} style={{ flexGrow: n, flexBasis: 0 }}
                        aria-label={`${g.label}: ${n} sentences, ${pct}%`}
                        onClick={() => onSelect({ kind: "group", speaker: s.speaker.id, group: g.id })}
                        onPointerEnter={(e) => setTip({ x: e.clientX, y: e.clientY, body: (<>
                          <strong>{s.speaker.name} · {g.label}</strong>
                          <div>{n} sentences ({pct}%)</div>
                          <div className="muted">{detail}</div>
                          <div className="muted">Click to find them in the chat</div>
                        </>) })}
                        onPointerMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
                        onPointerLeave={() => setTip(null)} />
                    );
                  })}
                </div>
              </td>
              {METRICS.map((m) => {
                const o = s.outcomes[m.id as Metric];
                if (!o.items.length) return <td key={m.id} className="num muted">–</td>;
                return (
                  <td key={m.id} className="num">
                    <button className={`metric${isSel(s.speaker.id, m.id) ? " sel" : ""}`}
                      onClick={() => onSelect({ kind: "metric", speaker: s.speaker.id, metric: m.id })}
                      title={`Of ${o.items.length}: ${o.done.size} ${m.done}${m.other ? `, ${o.other.size} ${m.other}` : ""}, `
                        + `${o.items.length - o.done.size - o.other.size} ${m.none}. Click for the list.`}>
                      <span className="metric-main">{o.done.size} {m.done}{m.other && o.other.size > 0 ? ` · ${o.other.size} ${m.other}` : ""}</span>
                      <span className="metric-rest">of {o.items.length.toLocaleString()} · {(o.items.length - o.done.size - o.other.size).toLocaleString()} {m.none}</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="acts-note">
        Questions and Requests count sentences from <b>Asks</b>; Commitments counts sentences from <b>Commitments</b> (a
        commitment, or accepting a request). Each count says how many got a follow-up a later message shows: answered, taken up,
        or kept. Follow-ups are found within about 65 messages, so the counts are a floor, not a verdict.
      </p>
      {tip && <div className="tooltip" style={{ left: Math.min(window.innerWidth - 380, tip.x + 14), top: tip.y + 14 }}>{tip.body}</div>}
    </div>
  );
}
