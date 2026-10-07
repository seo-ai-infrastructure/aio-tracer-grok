import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchReasoning } from "../api";
import type { Model } from "../lib/model";
import { formatTime } from "../lib/timeScale";
import type { CursorSource } from "../state";
import type { Message, Sentence } from "../types";

interface Props {
  model: Model;
  highlight: Set<string>; // sentence ids
  highlightKind?: Map<string, string>; // optional extra class per sentence (e.g. "trigger", "follow")
  label: string | null; // what is highlighted, for the bar
  note?: string; // shown after the count in the bar
  cursor: { t: number; from: CursorSource } | null;
  onCursor(t: number): void;
  onUserScroll?(): void; // a real gesture (wheel, touch, keys), not a programmatic scroll
  focus?: { id: string; seq: number } | null; // bring this message to the top; seq repeats a request for the same one
  onCurrent?(id: string | null): void; // the highlighted message the reader went to last
  tint?: Map<string, string>; // sentence id -> a category drawn as a colored underline (class "act-<category>")
  picked?: string | null; // a sentence to outline
  onSentence?(sentenceId: string): void; // makes sentences clickable
  describe?(sentenceId: string): React.ReactNode; // shown at once while a sentence is hovered
}

function firstAtOrAfter(msgs: Message[], t: number): number {
  let lo = 0;
  let hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msgs[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, msgs.length - 1);
}

export function Transcript(p: Props) {
  const { model } = p;
  const msgs = model.messages;
  const listRef = useRef<HTMLDivElement>(null);
  const ignoreScrollUntil = useRef(0);
  const virtualizer = useVirtualizer({
    count: msgs.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 64,
    overscan: 10,
  });

  const hits = useMemo(() => {
    if (!p.highlight.size) return [];
    const out: number[] = [];
    msgs.forEach((m, i) => {
      if ((model.sentencesByMessage.get(m.id) ?? []).some((s) => p.highlight.has(s.id))) out.push(i);
    });
    return out;
  }, [msgs, model, p.highlight]);
  const hitSet = useMemo(() => new Set(hits), [hits]);
  const indexOf = useMemo(() => new Map(msgs.map((m, i) => [m.id, i])), [msgs]);
  const [current, setCurrent] = useState<string | null>(null);

  const scrollTo = (index: number) => {
    ignoreScrollUntil.current = Date.now() + 500;
    virtualizer.scrollToIndex(index, { align: "start" });
  };
  const go = (index: number) => {
    scrollTo(index);
    p.onCursor(msgs[index].t);
    setCurrent(msgs[index].id);
  };

  useEffect(() => {
    if (p.cursor && p.cursor.from === "timeline" && msgs.length) scrollTo(firstAtOrAfter(msgs, p.cursor.t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.cursor]);

  useEffect(() => {
    if (hits.length) go(hits[0]);
    else setCurrent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits]);

  useEffect(() => {
    const i = p.focus ? indexOf.get(p.focus.id) : undefined;
    if (i !== undefined) go(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus]);

  useEffect(() => {
    p.onCurrent?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const topIndex = () => {
    const el = listRef.current;
    const items = virtualizer.getVirtualItems();
    return (items.find((v) => v.end > (el?.scrollTop ?? 0) + 4) ?? items[0])?.index ?? 0;
  };

  const onScroll = () => {
    if (Date.now() < ignoreScrollUntil.current || !msgs.length) return;
    p.onCursor(msgs[topIndex()].t);
  };

  const inView = (index: number) => {
    const el = listRef.current;
    const v = virtualizer.getVirtualItems().find((x) => x.index === index);
    return !!el && !!v && v.start < el.scrollTop + el.clientHeight && v.end > el.scrollTop;
  };

  // Step from the message last gone to while it's on screen (near the end it can't reach the top), else from the top one.
  const jump = (dir: 1 | -1) => {
    if (!hits.length) return;
    const at = current !== null ? indexOf.get(current) : undefined;
    const cur = at !== undefined && inView(at) ? at : topIndex();
    const next = dir > 0 ? hits.find((i) => i > cur) ?? hits[0] : [...hits].reverse().find((i) => i < cur) ?? hits[hits.length - 1];
    go(next);
  };
  const pos = current !== null ? hits.indexOf(indexOf.get(current) ?? -1) : -1;

  const [tip, setTip] = useState<{ sid: string; x: number; y: number } | null>(null);
  const onHover = (e: React.MouseEvent) => {
    if (!p.describe) return;
    const el = (e.target as Element).closest?.("[data-sid]");
    if (!el) return setTip(null);
    const sid = el.getAttribute("data-sid")!;
    if (tip?.sid === sid) return;
    const r = el.getBoundingClientRect();
    setTip({ sid, x: Math.min(window.innerWidth - 380, e.clientX + 12), y: r.bottom + 6 });
  };
  const tipBody = tip && p.describe ? p.describe(tip.sid) : null;

  return (
    <div className={`transcript${p.onSentence ? " clickable" : ""}`}>
      <div className="transcript-bar">
        {p.label ? (
          <>
            <span>Highlighting <strong>{p.label}</strong> · {pos >= 0 ? `${pos + 1} of ${hits.length}` : hits.length} message{hits.length === 1 ? "" : "s"}
              {p.note ?? (model.mentionSource === "anchors" ? " (matched on task terms)" : "")}</span>
            <button className="ghost" onClick={() => jump(-1)} disabled={!hits.length}>↑ Previous</button>
            <button className="ghost" onClick={() => jump(1)} disabled={!hits.length}>↓ Next</button>
          </>
        ) : (
          <span>{msgs.length.toLocaleString()} messages · select a task to highlight where it is discussed</span>
        )}
      </div>
      <div className="transcript-list" ref={listRef} onScroll={() => { setTip(null); onScroll(); }} tabIndex={0}
        onWheel={p.onUserScroll} onTouchMove={p.onUserScroll} onKeyDown={p.onUserScroll}
        onMouseOver={onHover} onMouseLeave={() => setTip(null)}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const m = msgs[v.index];
            return (
              <div key={m.id} ref={virtualizer.measureElement} data-index={v.index}
                style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}>
                <MessageRow model={model} message={m} sentences={model.sentencesByMessage.get(m.id) ?? []}
                  highlight={p.highlight} kinds={p.highlightKind} hit={hitSet.has(v.index)} dim={p.highlight.size > 0 && !hitSet.has(v.index)}
                  current={m.id === current} tint={p.tint} picked={p.picked} onSentence={p.onSentence} />
              </div>
            );
          })}
        </div>
      </div>
      {tip && tipBody && <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">{tipBody}</div>}
    </div>
  );
}

function MessageRow(props: {
  model: Model; message: Message; sentences: Sentence[]; highlight: Set<string>; kinds?: Map<string, string>; hit: boolean; dim: boolean;
  current: boolean; tint?: Map<string, string>; picked?: string | null; onSentence?(sentenceId: string): void;
}) {
  const { model, message: m } = props;
  const actor = model.actors.get(m.sender);
  const [reasoning, setReasoning] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const toggleReasoning = async () => {
    if (reasoning === undefined) setReasoning((await fetchReasoning(m.id)).reasoning);
    setOpen((o) => !o);
  };
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const s of props.sentences) {
    if (s.start_char > pos) parts.push(m.text.slice(pos, s.start_char));
    const tint = props.tint?.get(s.id);
    const cls = ["sent", props.highlight.has(s.id) && `hl ${props.kinds?.get(s.id) ?? ""}`, tint && `act act-${tint}`,
      props.picked === s.id && "picked"].filter(Boolean).join(" ");
    parts.push(
      <span key={s.id} data-sid={s.id} className={cls} onClick={props.onSentence ? () => props.onSentence!(s.id) : undefined}>
        {m.text.slice(s.start_char, s.end_char)}
      </span>,
    );
    pos = s.end_char;
  }
  if (pos < m.text.length) parts.push(m.text.slice(pos));
  return (
    <div className={`msg${props.dim ? " dim" : ""}${props.hit ? " hit" : ""}${props.current ? " current" : ""}`}>
      <div aria-hidden style={{ paddingTop: 4 }}>
        <span className="swatch" style={{ background: model.colorOf.get(m.sender) ?? "var(--human)", borderRadius: "50%" }} />
      </div>
      <div>
        <div className="msg-head">
          <span className="who">{actor?.attrs?.icon ? `${actor.attrs.icon} ` : ""}{actor?.name ?? m.sender}</span>
          {actor && actor.kind !== "agent" && <span className="muted">{actor.role ?? actor.kind}</span>}
          <span className="when">{formatTime(m.t, model.unit, model.tz, model.unit === "s")}</span>
          {m.has_reasoning && <button className="linkish" onClick={toggleReasoning}>{open ? "hide reasoning" : "reasoning"}</button>}
        </div>
        <div className="msg-body">{parts}</div>
        {open && <div className="reasoning">{reasoning ?? "(no reasoning recorded)"}</div>}
      </div>
    </div>
  );
}
