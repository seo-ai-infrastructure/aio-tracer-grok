import { useMemo, useState } from "react";
import { ActsDetail } from "../components/ActsDetail";
import { ActsSummary } from "../components/ActsSummary";
import { SplitPane } from "../components/SplitPane";
import { Transcript } from "../components/Transcript";
import {
  ACT_LABEL, type ActsSelection, focusOf, type GroupId, GROUPS, RELATION_LABEL, speakers, speechFor, summarize,
} from "../lib/acts";
import { modelFor } from "../lib/model";
import { formatTime } from "../lib/timeScale";
import { useStore } from "../state";
import type { ActLink, Snapshot } from "../types";

const UNDERLINED: GroupId[] = ["asks", "commitments", "corrections", "social"]; // information is most of the chat

export function ActsTab({ snap }: { snap: Snapshot }) {
  const model = modelFor(snap);
  const speech = speechFor(model);
  const { cursor, setCursor } = useStore();
  const [underlined, setUnderlined] = useState<Set<GroupId>>(() => new Set(UNDERLINED));
  const [humans, setHumans] = useState(true);
  const [elaborations, setElaborations] = useState(false);
  const [selection, setSelection] = useState<ActsSelection>(null);
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  const name = (id: string) => model.actors.get(id)?.name ?? id;
  const rows = useMemo(() => speakers(model, humans), [model, humans]);
  const sums = useMemo(() => summarize(model, speech, rows), [model, speech, rows]);
  const f = useMemo(() => focusOf(speech, sums, selection, elaborations, name),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speech, sums, selection, elaborations]);
  const tint = useMemo(() => {
    const out = new Map<string, string>();
    for (const [sid, g] of speech.group) if (underlined.has(g)) out.set(sid, g);
    return out;
  }, [speech, underlined]);

  if (!speech.labeledMessages) {
    return (
      <div className="placeholder">
        No speech acts for this episode yet. Label them with
        <pre>python scripts/label_acts.py --episode {snap.episode.id}</pre>
        (add <code>--days 1</code> for a quick look at the first day, or <code>--dry-run</code> for the cost first), then reload.
      </div>
    );
  }

  const keep = (l: ActLink) => elaborations || l.relation !== "elaborates";
  const when = (t: number) => formatTime(t, model.unit, model.tz, model.unit === "s");
  const describe = (sid: string) => {
    const acts = speech.acts.get(sid);
    if (!acts) return null;
    const line = (l: ActLink, other: string, label: string) => {
      const m = speech.message.get(other)!;
      return <div key={`${l.src_id}-${l.dst_id}-${l.relation}`}>{label} {name(m.sender)} <span className="muted">({when(m.t)})</span></div>;
    };
    return (<>
      <strong>{acts.map((a) => ACT_LABEL[a]).join(" + ")}</strong>
      {(speech.out.get(sid) ?? []).filter(keep).map((l) => line(l, l.dst_id, RELATION_LABEL[l.relation][0]))}
      {(speech.in.get(sid) ?? []).filter(keep).map((l) => line(l, l.src_id, RELATION_LABEL[l.relation][1]))}
      <div className="muted">Click for details</div>
    </>);
  };
  const toggle = (g: GroupId) => setUnderlined((prev) => {
    const next = new Set(prev);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    return next;
  });
  const partial = speech.labeledMessages < model.messages.length;

  return (
    <div className="tasks-tab">
      <div className="toolbar">
        <div className="legend">
          <span className="tool-group" role="group" aria-label="Underline in the chat">
            <span className="secondary">Underline in chat:</span>
            {GROUPS.map((g) => (
              <label key={g.id} className={`secondary act-${g.id}`} title={g.acts.map((a) => ACT_LABEL[a]).join(", ")}>
                <input type="checkbox" checked={underlined.has(g.id)} onChange={() => toggle(g.id)} />
                <span className="swatch act" aria-hidden /> {g.label}
              </label>
            ))}
          </span>
          <span className="tool-group" role="group" aria-label="Table">
            <span className="secondary">Table:</span>
            <label className="secondary" title="Rows for organizers, viewers and system messages">
              <input type="checkbox" checked={humans} onChange={(e) => setHumans(e.target.checked)} /> include humans
            </label>
          </span>
          <span className="tool-group" role="group" aria-label="Links">
            <span className="secondary">Links:</span>
            <label className="secondary" title="Links where a speaker adds detail to their own earlier sentence">
              <input type="checkbox" checked={elaborations} onChange={(e) => setElaborations(e.target.checked)} /> show elaborations
            </label>
          </span>
        </div>
        <div className="controls">
          <span className="muted">
            {partial ? `Labeled ${speech.labeledMessages.toLocaleString()} of ${model.messages.length.toLocaleString()} messages`
              + (speech.lastLabeled !== null ? `, through ${formatTime(speech.lastLabeled, model.unit, model.tz, model.unit === "s")}` : "")
              : `${speech.labeledMessages.toLocaleString()} messages labeled`}
          </span>
        </div>
      </div>
      <SplitPane
        top={
          <div className="influence-top">
            <ActsSummary sums={sums} selection={selection} onSelect={setSelection} />
            <ActsDetail model={model} speech={speech} sums={sums} selection={selection} elaborations={elaborations} current={current}
              onSelect={setSelection} onFocus={(id) => setFocus((x) => ({ id, seq: (x?.seq ?? 0) + 1 }))} />
          </div>
        }
        bottom={
          <div className="bottom">
            <Transcript model={model} highlight={f.highlight} highlightKind={f.kinds} label={f.label}
              note=" · darker: what you picked · lighter: what it's linked to"
              cursor={cursor} onCursor={(t) => setCursor(t, "transcript")} focus={focus} onCurrent={setCurrent}
              tint={tint} picked={selection?.kind === "sentence" ? selection.id : null}
              onSentence={(id) => setSelection({ kind: "sentence", id })} describe={describe} />
          </div>
        } />
    </div>
  );
}
