// Records a captioned, voice-free walkthrough of Swarm Tracer from the running app, as an MP4.
// Needs the server up (python scripts/serve.py) with the charity season built.
//
//   npm run demo                                   # -> ../output/swarm-tracer-demo.mp4
//   npm run demo -- --url http://localhost:8000 --out /tmp/demo.mp4
//   npm run demo -- --cards                        # just the title card and bumpers, as PNGs
//
// Frames come from Chrome's screencast (sharper than Playwright's built-in video) and are encoded
// with ffmpeg at a constant 30 fps. Captions, title cards and a visible pointer are overlays added
// to the page during the recording only.
import { chromium } from "playwright";
import ffmpeg from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const W = 1600;
const H = 900;
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("url", "http://localhost:8000");
const EPISODE = arg("episode", "charity-2025");
const OUT = path.resolve(arg("out", "../output/swarm-tracer-demo.mp4"));
const PRESET = arg("preset", "slow"); // x264 preset: "veryfast" for quick test takes
const PACE = Number(arg("pace", "1.4")); // scales every pause: higher gives captions more reading time
const TIMEOUT = 5000; // an element that isn't there within this long is skipped, not waited for

// ---- the words on the cards (captions live in the scenes below) -----------------------------

const TITLE = `<h1>Swarm Tracer</h1><p>Visualize agent coordination, communication, and influence</p>
  <p class="small">Built on the AI Village dataset</p>`;
// Bumpers: shown over each view as it opens, pointing at its tab. [tab to point at, title, one line]
const SECTIONS = {
  tasks: ["Tasks", "Task view", "Shows how tasks are broken down and distributed among agents"],
  communication: ["Communication", "Communication view", "Shows how the conversation is structured among agents and humans"],
  influence: ["Influence", "Influence view", "Shows who initiates work and how it spreads"],
};
// Viewer names to blur wherever they appear (labels, chat, tooltips), and the Influence view's "at least" filter:
// 30 minutes keeps the main links and drops one-off viewers, including both of these accounts (27 and 29 min).
const HIDE_NAMES = ["H4ck3r (Poopoo Pee)", "Poopoo Pee"];
const INFLUENCE_MIN_MINUTES = 30;
// The Influence view's worked example: an explicit request from one agent to another (its graph edge, and the
// caption shown once the chat is on the request).
const INFLUENCE_EXAMPLE = {
  edge: "claude-3-5-sonnet->o1",
  caption: "Here Claude 3.5 Sonnet asks o1 to analyze the team's donor data, which started 32 minutes of o1's work",
};
// The Task view's two panes, highlighted one after the other right after its bumper: [element, title, one line]
const PANES = [
  [".timeline", "Task timeline", "Each row is a task or subtask; each colored band is an agent working on it"],
  [".transcript", "Transcript", "The full chat between agents and humans, linked to the timeline"],
];

// ---- overlays: pointer, click ripple, caption bar, title cards --------------------------------

const POINTER = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16 26.5 L11.5 17 L19 17 Z" fill="white" stroke="black" stroke-width="1.6" stroke-linejoin="round"/></svg>`);

function overlays({ pointer, hide }) {
  const install = () => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-pointer { position: fixed; left: 0; top: 0; width: 22px; height: 30px; margin: -2px 0 0 -2px; z-index: 2147483647;
        pointer-events: none; background: url("${pointer}") no-repeat; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
      .demo-ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 3px solid #3987e5;
        z-index: 2147483646; pointer-events: none; animation: demo-ripple 550ms ease-out forwards; }
      @keyframes demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
      #demo-caption { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); width: max-content; max-width: 1240px;
        padding: 16px 30px; border-radius: 14px; background: #fff; color: #111; font: 600 27px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        z-index: 2147483645; pointer-events: none; opacity: 0; transition: opacity 350ms; text-align: center;
        box-shadow: 0 12px 36px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.15); }
      #demo-caption.on { opacity: 1 }
      #demo-caption b { color: #1a5fc4; font-weight: 700 }
      #demo-card { position: fixed; inset: 0; z-index: 2147483640; display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 18px; background: radial-gradient(circle at 30% 25%, #1c2a46, #0b0b0b 70%); color: #fff;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif; opacity: 0; transition: opacity 600ms; pointer-events: none; text-align: center; }
      #demo-card.on { opacity: 1 }
      #demo-card h1 { font-size: 72px; margin: 0; letter-spacing: -1.5px; font-weight: 700 }
      #demo-card p { font-size: 27px; margin: 0; color: #d7d6cf; max-width: 1100px; line-height: 1.45 }
      #demo-card .small { font-size: 19px; color: #9a9890 }
      #demo-bumper { position: fixed; inset: 0; z-index: 2147483641; pointer-events: none; opacity: 0; transition: opacity 450ms;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      #demo-bumper.on { opacity: 1 }
      #demo-bumper .dim { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, .4); }
      #demo-bumper .ring { position: absolute; border: 3px solid #fff; border-radius: 10px;
        box-shadow: 0 0 0 4px rgba(26, 95, 196, .6), 0 0 26px rgba(255, 255, 255, .35); }
      #demo-bumper .box { position: absolute; background: #fff; color: #111; border-radius: 16px; padding: 22px 36px; text-align: center;
        box-shadow: 0 18px 50px rgba(0, 0, 0, .6), 0 0 0 1px rgba(0, 0, 0, .15); white-space: nowrap; }
      #demo-bumper .t { font-size: 42px; font-weight: 800; letter-spacing: -.5px; line-height: 1.2 }
      #demo-bumper .l { font-size: 26px; font-weight: 500; color: #333; margin-top: 6px }
      #demo-bumper svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
      #demo-bumper path.arrow { fill: none; stroke: #fff; stroke-width: 4; stroke-linecap: round; filter: drop-shadow(0 2px 5px rgba(0, 0, 0, .7)); }
      #demo-bumper path.head { fill: #fff; filter: drop-shadow(0 2px 5px rgba(0, 0, 0, .7)); }
      #demo-spot { position: fixed; inset: 0; z-index: 2147483641; pointer-events: none; opacity: 0; transition: opacity 400ms;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      #demo-spot.on { opacity: 1 }
      #demo-spot .hole { position: absolute; border: 3px solid #fff; border-radius: 10px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, .58),
        0 0 0 7px rgba(26, 95, 196, .55); transition: all 450ms ease; }
      #demo-spot .box { position: absolute; background: #fff; color: #111; border-radius: 14px; padding: 16px 30px; text-align: center;
        box-shadow: 0 16px 44px rgba(0, 0, 0, .6); white-space: nowrap; transition: all 450ms ease; }
      #demo-spot .t { font-size: 32px; font-weight: 800; letter-spacing: -.3px }
      #demo-spot .l { font-size: 22px; font-weight: 500; color: #333; margin-top: 4px }
      #demo-hide { position: fixed; inset: 0; z-index: 2147483630; pointer-events: none; }
      #demo-hide div { position: fixed; border-radius: 4px; backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
        background: rgba(120, 120, 120, .45); }
    `;
    document.head.appendChild(style);
    for (const id of ["demo-pointer", "demo-caption", "demo-card", "demo-hide"]) {
      const el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
    }
    // Blur boxes over hidden names: re-measured a few times a second, so they follow scrolling and re-renders
    // without touching the app's own DOM.
    if (hide.length) {
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(hide.map(esc).join("|"), "gi");
      const layer = document.getElementById("demo-hide");
      const ours = "#demo-hide, #demo-caption, #demo-card, #demo-bumper, #demo-spot";
      setInterval(() => {
        const rects = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const t = n.nodeValue;
          if (!t || n.parentElement?.closest(ours)) continue;
          pattern.lastIndex = 0;
          if (!pattern.test(t)) continue;
          if (n.parentElement instanceof SVGElement) {
            rects.push(n.parentElement.getBoundingClientRect());
            continue;
          }
          for (const m of t.matchAll(pattern)) {
            const r = document.createRange();
            r.setStart(n, m.index);
            r.setEnd(n, m.index + m[0].length);
            rects.push(...r.getClientRects());
          }
        }
        layer.replaceChildren(...rects.filter((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight).map((r) => {
          const d = document.createElement("div");
          Object.assign(d.style, { left: `${r.left - 3}px`, top: `${r.top - 2}px`, width: `${r.width + 6}px`, height: `${r.height + 4}px` });
          return d;
        }));
      }, 120);
    }
    const p = document.getElementById("demo-pointer");
    window.addEventListener("mousemove", (e) => { p.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
    window.addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.className = "demo-ripple";
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 650);
    }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
}

// ---- recording -----------------------------------------------------------------------------

async function startRecording(page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-demo-"));
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `f${String(frames.length).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await client.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  return async function stop() {
    const end = Date.now() / 1000; // frames carry seconds since the epoch; a still screen sends none, so close the last one here
    await client.send("Page.stopScreencast");
    if (!frames.length) throw new Error("no frames captured");
    const list = frames.map((f, i) => {
      const next = frames[i + 1]?.t ?? Math.max(end, f.t + 0.5);
      return `file '${f.file}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}`;
    });
    list.push(`file '${frames[frames.length - 1].file}'`); // the concat demuxer ignores the last duration otherwise
    fs.writeFileSync(path.join(dir, "frames.txt"), list.join("\n"));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"),
      "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-crf", "17", "-preset", PRESET,
      "-movflags", "+faststart", OUT], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed");
    fs.rmSync(dir, { recursive: true, force: true });
    return { frames: frames.length, seconds: Math.max(end, frames[frames.length - 1].t + 0.5) - frames[0].t };
  };
}

// ---- choreography helpers -------------------------------------------------------------------

let page;
let at = { x: W / 2, y: H / 2 };
const hold = (ms) => page.waitForTimeout(ms * PACE);

/** Glide the pointer: paced by the clock, so a page that is slow to repaint doesn't stretch the take. */
async function moveTo(x, y, ms = 650, steps = Math.max(6, Math.round(ms / 40))) {
  const from = { ...at };
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease in-out
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    const wait = t0 + (ms * i) / steps - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  }
  at = { x, y };
}
async function center(locator, scroll = false) {
  if (scroll) await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error("element not visible");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function hover(locator, ms, scroll = false) {
  const c = await center(locator, scroll);
  await moveTo(c.x, c.y, ms);
}
async function clickAt(x, y, ms) {
  await moveTo(x, y, ms);
  await page.mouse.down();
  await hold(90);
  await page.mouse.up();
}
async function click(locator, ms, scroll = false) {
  const c = await center(locator, scroll);
  await clickAt(c.x, c.y, ms);
}
async function caption(html) {
  await page.evaluate((h) => {
    const c = document.getElementById("demo-caption");
    if (!h) return c.classList.remove("on");
    c.innerHTML = h;
    c.classList.add("on");
  }, html);
}
async function card(html) {
  await page.evaluate((h) => {
    const c = document.getElementById("demo-card");
    document.getElementById("demo-pointer").style.opacity = h ? "0" : "1";
    if (!h) return c.classList.remove("on");
    c.innerHTML = h;
    c.classList.add("on");
  }, html);
}
/** A bumper over the view: two lines in the middle, the view's tab ringed, and an arrow from one to the other. */
async function bumper(which) {
  const [, title, line] = SECTIONS[which];
  await page.evaluate(([t, l]) => {
    document.getElementById("demo-bumper")?.remove();
    const header = document.querySelector(".app-header").getBoundingClientRect();
    const tab = document.querySelector('[role="tab"][aria-selected="true"]').getBoundingClientRect();
    const root = document.createElement("div");
    root.id = "demo-bumper";
    root.innerHTML = `<div class="dim" style="top:${header.bottom}px"></div>
      <div class="ring" style="left:${tab.left - 7}px;top:${tab.top - 5}px;width:${tab.width + 14}px;height:${tab.height + 10}px"></div>
      <div class="box"><div class="t"></div><div class="l"></div></div><svg><path class="arrow"/><path class="head"/></svg>`;
    root.querySelector(".t").textContent = t;
    root.querySelector(".l").textContent = l;
    document.body.appendChild(root);
    const box = root.querySelector(".box");
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    const left = Math.round(innerWidth / 2 - bw / 2);
    const top = Math.round(header.bottom + (innerHeight - header.bottom) * 0.36 - bh / 2);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
    // from the box's top edge, curving up to just under the tab
    const from = { x: left + bw / 2 + (tab.left + tab.width / 2 < left + bw / 2 ? -60 : 60), y: top - 10 };
    const to = { x: tab.left + tab.width / 2, y: tab.bottom + 14 };
    const c1 = { x: from.x, y: from.y - (from.y - to.y) * 0.55 };
    const c2 = { x: to.x, y: to.y + (from.y - to.y) * 0.45 };
    root.querySelector(".arrow").setAttribute("d", `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y + 6}`);
    root.querySelector(".head").setAttribute("d", `M${to.x},${to.y - 6} L${to.x - 12},${to.y + 14} L${to.x + 12},${to.y + 14} Z`);
    document.getElementById("demo-pointer").style.opacity = "0";
    requestAnimationFrame(() => root.classList.add("on"));
  }, [title, line]);
}
async function bumperOff() {
  await page.evaluate(() => {
    const b = document.getElementById("demo-bumper");
    if (b) {
      b.classList.remove("on");
      setTimeout(() => b.remove(), 500);
    }
    document.getElementById("demo-pointer").style.opacity = "1";
  });
}
/** Dim everything but one pane, outline it, and label it on the side with more room (so the pane stays clear). */
async function spotlight(selector, title, line) {
  await page.evaluate(([sel, t, l]) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    let root = document.getElementById("demo-spot");
    if (!root) {
      root = document.createElement("div");
      root.id = "demo-spot";
      root.innerHTML = '<div class="hole"></div><div class="box"><div class="t"></div><div class="l"></div></div>';
      document.body.appendChild(root);
    }
    const pad = 4;
    Object.assign(root.querySelector(".hole").style, { left: `${r.left + pad}px`, top: `${r.top + pad}px`,
      width: `${r.width - 2 * pad}px`, height: `${r.height - 2 * pad}px` });
    root.querySelector(".t").textContent = t;
    root.querySelector(".l").textContent = l;
    const box = root.querySelector(".box");
    const below = innerHeight - r.bottom > r.top; // more room under the pane than above it
    const y = below ? r.bottom + (innerHeight - r.bottom) / 2 : r.top / 2;
    Object.assign(box.style, { left: `${innerWidth / 2 - box.offsetWidth / 2}px`, top: `${Math.max(12, y - box.offsetHeight / 2)}px` });
    document.getElementById("demo-pointer").style.opacity = "0";
    requestAnimationFrame(() => root.classList.add("on"));
  }, [selector, title, line]);
}
async function spotlightOff() {
  await page.evaluate(() => {
    const s = document.getElementById("demo-spot");
    if (s) {
      s.classList.remove("on");
      setTimeout(() => s.remove(), 450);
    }
    document.getElementById("demo-pointer").style.opacity = "1";
  });
}
/** The Influence view's "at least N minutes" slider (a React-controlled range input). */
async function setMinMinutes(n) {
  await page.locator('.toolbar input[type="range"]').evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, n);
  await page.waitForTimeout(300);
}
async function section(which) {
  await card(null); // the title card, if it's still up
  await bumper(which);
  await hold(3800);
  await bumperOff();
  await hold(500);
}
/** Run a step; if the page doesn't offer what it needs, log and carry on rather than ruin the take. */
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`  ${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  } catch (e) {
    console.warn(`  skipped "${name}" after ${((Date.now() - t) / 1000).toFixed(1)} s: ${String(e.message ?? e).split("\n")[0]}`);
  }
}

// ---- the walkthrough ------------------------------------------------------------------------

async function tasks() {
  await section("tasks");
  await step("the two panes", async () => {
    for (const [selector, title, line] of PANES) {
      await spotlight(selector, title, line);
      await hold(3000);
    }
    await spotlightOff();
    await hold(400);
  });
  await moveTo(150, 330, 900);
  await hold(1200);

  await step("expand a task", async () => {
    await caption("Tasks are hierarchical: the goal breaks into tasks, and tasks into subtasks. Expand one to see its parts");
    const twist = await page.evaluate(() => {
      const body = document.querySelector(".timeline-body").getBoundingClientRect();
      const r = [...document.querySelectorAll('.row-label button.twist[aria-expanded="false"]')].map((e) => e.getBoundingClientRect())
        .find((b) => b.width > 0 && b.top > body.top + 20 && b.bottom < body.bottom - 120);
      return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await moveTo(twist.x, twist.y, 1000);
    await hold(600);
    await clickAt(twist.x, twist.y, 200);
    await moveTo(1000, 100, 700); // off the row, so its description tooltip doesn't open over the new subtasks
    await hold(3800);
  });

  await step("hover a work bar", async () => {
    await caption("Each band is one agent at work, colored by model family. Hover for details");
    const bar = await page.evaluate(() => {
      const body = document.querySelector(".timeline-body").getBoundingClientRect();
      const plot = document.querySelector(".plot").getBoundingClientRect();
      const bars = [...document.querySelectorAll(".plot rect")].filter((r) => r.getAttribute("height") === "10").map((r) => r.getBoundingClientRect())
        .filter((b) => b.width > 40 && b.top > body.top + 60 && b.bottom < body.bottom - 20 && b.left > plot.left + 20 && b.right < innerWidth - 20);
      const b = bars.sort((a, c) => c.width - a.width)[0];
      return b && { x: b.left + Math.min(b.width / 2, 60), y: b.top + b.height / 2 };
    });
    await moveTo(bar.x, bar.y, 800);
    await hold(3800);
  });

  await step("select a task", async () => {
    await caption("Click a task to highlight where the chat discusses it");
    const name = await page.evaluate(() => {
      const body = document.querySelector(".timeline-body").getBoundingClientRect();
      const plot = document.querySelector(".plot").getBoundingClientRect();
      const bars = [...document.querySelectorAll(".plot rect")].filter((r) => r.getAttribute("height") === "10")
        .map((r) => r.getBoundingClientRect()).filter((b) => b.right > plot.left && b.left < plot.right);
      let best = null;
      for (const label of document.querySelectorAll(".row-label")) {
        const r = label.getBoundingClientRect();
        const btn = label.querySelector(".name");
        if (!btn || btn.classList.contains("root") || btn.classList.contains("general") || btn.classList.contains("waiting")) continue;
        if (r.top < body.top + 20 || r.bottom > body.bottom - 10) continue;
        const n = bars.filter((b) => b.top >= r.top && b.bottom <= r.bottom).length;
        if (!best || n > best.n) best = { n, y: r.top + r.height / 2, x: btn.getBoundingClientRect().left + 40 };
      }
      return best;
    });
    await clickAt(name.x, name.y, 900);
    await hold(4000);
  });

  await step("drag the overview", async () => {
    await caption("The strip above the rows is the whole five-week season. Drag its window to move through it");
    const w = await center(page.locator(".nav-window"));
    await moveTo(w.x, w.y, 900);
    await page.mouse.down();
    const nav = await page.locator(".navigator").boundingBox();
    await moveTo(nav.x + nav.width * 0.45, w.y, 1800, 12); // each step pans the whole timeline: fewer, larger ones
    await moveTo(nav.x + nav.width * 0.62, w.y, 1400, 9);
    await page.mouse.up();
    await hold(2400);
  });
}

async function communication() {
  await caption(null);
  await click(page.getByRole("tab", { name: "Communication" }), 900);
  await section("communication");

  await step("GPT-4.1 talks the most", async () => {
    const row = page.locator(".acts-summary tbody tr", { hasText: "GPT-4.1" });
    await caption("GPT-4.1 talks the most by far: 8,170 sentences in five weeks, most of them status reports");
    await hover(row.locator(".mix button.act-information"), 900);
    await hold(3800);
  });

  await step("a speaker's commitments", async () => {
    const row = page.locator(".acts-summary tbody tr", { hasText: "Claude 3.7 Sonnet" });
    await caption("Click a count to list the commitments behind it, and which ones a later message shows were kept");
    await click(row.locator("button.metric").last(), 900);
    await hold(3800);
  });

  await step("jump to a kept commitment", async () => {
    await caption("Click any commitment to jump to it in the chat, together with the message that fulfilled it");
    const kept = page.locator(".drawer.evidence .evidence-list li", { has: page.locator(".outcome.done") }).nth(1);
    await click(kept.locator(".point").first(), 900, true);
    await hold(3800);
  });

  await step("hover a sentence", async () => {
    await caption("Hover any underlined sentence for what it does and what it responds to");
    const sent = await page.evaluate(() => {
      const list = document.querySelector(".transcript-list").getBoundingClientRect();
      const s = [...document.querySelectorAll(".sent.act")].map((e) => e.getBoundingClientRect())
        .find((b) => b.top > list.top + 40 && b.bottom < list.bottom - 140 && b.width > 80);
      return s && { x: s.left + Math.min(60, s.width / 2), y: s.top + s.height / 2 };
    });
    await moveTo(sent.x, sent.y, 900);
    await hold(4000);
    await caption("Click it to see what it responds to, and every reply it got");
    await page.mouse.down();
    await hold(90);
    await page.mouse.up();
    await moveTo(1420, 300, 800);
    await hold(4200);
  });
}

async function influence() {
  await caption(null);
  await click(page.getByRole("tab", { name: "Influence" }), 900);
  await setMinMinutes(INFLUENCE_MIN_MINUTES);
  await section("influence");
  await caption("Arrows point from those who requested (or initiated) the work to those who performed the work. Thicker arrows indicate greater influence.");
  await moveTo(560, 330, 900);
  await hold(4200);

  await step("hover the biggest initiator", async () => {
    await caption("Humans triggered nearly half of this work, by time. The organizer, zak, triggered the most: 11 hours");
    const zak = page.locator(".ig-node", { hasText: "zak" });
    await hover(zak, 900);
    await hold(3800);
  });

  await step("click an edge", async () => {
    await caption("Click an edge for the associated tasks");
    // a point on the example's arrow that isn't under a node
    const pt = await page.evaluate((id) => {
      const h = document.querySelector(`[data-edge="${id}"] .ig-hit`);
      if (!h) return null;
      for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.15, 0.85]) {
        const q = h.getPointAtLength(h.getTotalLength() * f).matrixTransform(h.getScreenCTM());
        if (document.elementFromPoint(q.x, q.y) === h) return { x: q.x, y: q.y };
      }
      return null;
    }, INFLUENCE_EXAMPLE.edge);
    await clickAt(pt.x, pt.y, 900);
    await moveTo(1300, 420, 700); // into the panel, so the edge's tooltip doesn't cover the graph
    await hold(3400);
  });

  await step("open the request", async () => {
    await caption("Expand a task and click a message to jump to it in the chat");
    const item = page.locator(".drawer.evidence .evidence-list > li", { has: page.locator(".how-asked") }).first();
    const head = item.locator(".ev-head");
    if ((await head.getAttribute("aria-expanded")) !== "true") {
      await click(head, 800, true);
      await hold(900);
    }
    await click(item.locator(".point.trigger").first(), 900, true);
    await hold(2400);
    await caption(INFLUENCE_EXAMPLE.caption);
    await hold(4200);
  });

  await step("matrix", async () => {
    await caption("Table view of the same influence data: each cell is the hours of work the row's participant triggered for the column's agent");
    await click(page.getByRole("button", { name: "Matrix view" }), 900);
    await hold(3800);
  });
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  context.setDefaultTimeout(TIMEOUT);
  page = await context.newPage();
  page.on("pageerror", (e) => console.warn("page error:", String(e).slice(0, 200)));
  await page.addInitScript(() => { try { localStorage.clear(); } catch { /* fresh look */ } });
  await page.addInitScript(overlays, { pointer: POINTER, hide: HIDE_NAMES });
  await page.goto(`${BASE}/#episode=${EPISODE}&tab=tasks`, { waitUntil: "networkidle" });
  await page.locator(".row-label").first().waitFor();
  await hold(800);

  if (process.argv.includes("--cards")) return previewCards(browser);
  await card(TITLE);
  await hold(700);
  const stop = await startRecording(page);
  console.log("recording…");
  await page.mouse.move(at.x, at.y);
  await hold(2400); // the Tasks chapter card replaces the title card directly

  for (const [name, scene] of [["tasks", tasks], ["communication", communication], ["influence", influence]]) {
    const t = Date.now();
    console.log(`${name}:`);
    await scene();
    console.log(`  = ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }

  await caption(null);
  await hold(1500); // end on the view itself, a beat after the last caption clears
  const { frames, seconds } = await stop();
  await browser.close();
  console.log(`wrote ${OUT}: ${seconds.toFixed(0)} s from ${frames} frames`);
}

/** --cards: save each card as a PNG next to the video, to check the wording without recording. */
async function previewCards(browser) {
  const dir = path.join(path.dirname(OUT), "demo-cards");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".png")) fs.rmSync(path.join(dir, f));
  const shot = (name) => page.screenshot({ path: path.join(dir, `${name}.png`) });
  await card(TITLE);
  await page.waitForTimeout(900);
  await shot("0-title");
  await card(null);
  for (const [i, [which, [tab]]] of Object.entries(SECTIONS).entries()) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(900);
    await bumper(which);
    await page.waitForTimeout(700);
    await shot(`${i + 1}-${which}`);
    await bumperOff();
    await page.waitForTimeout(600);
  }
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page.waitForTimeout(900);
  for (const [i, [selector, title, line]] of PANES.entries()) {
    await spotlight(selector, title, line);
    await page.waitForTimeout(800);
    await shot(`1${"ab"[i]}-pane`);
  }
  await spotlightOff();
  await page.waitForTimeout(500);
  await page.getByRole("tab", { name: "Influence" }).click();
  await page.waitForTimeout(1200);
  await shot("6-hidden-names");
  await page.getByRole("tab", { name: "Tasks" }).click();
  await caption("Click a task to highlight where the chat discusses it");
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(dir, "5-caption.png") });
  await browser.close();
  console.log(`wrote the title, three bumpers, the Task view panes and a sample caption to ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
