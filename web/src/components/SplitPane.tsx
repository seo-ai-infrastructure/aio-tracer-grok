import { useRef, useState } from "react";

/** A top/bottom split with a draggable divider (shared by the Tasks and Influence tabs). */
export function SplitPane({ top, bottom, initial = 0.5 }: { top: React.ReactNode; bottom: React.ReactNode; initial?: number }) {
  const [topPx, setTopPx] = useState(() => Math.round(window.innerHeight * initial));
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: React.PointerEvent) => {
    const offset = ref.current?.getBoundingClientRect().top ?? 0;
    const move = (ev: PointerEvent) => setTopPx(Math.max(120, Math.min(window.innerHeight - 160, ev.clientY - offset)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  return (
    <div className="split" ref={ref} style={{ gridTemplateRows: `${topPx}px 5px 1fr` }}>
      {top}
      <div className="splitter" role="separator" aria-orientation="horizontal" onPointerDown={onDown} />
      {bottom}
    </div>
  );
}
