"""HTTP API for the views.

GET  /api/info                         serving mode and, when replaying, replay status
GET  /api/episodes                     episode list (with root-task scope for the picker)
GET  /api/episodes/{id}/snapshot       records + annotations for one episode, and the delta seq
GET  /api/episodes/{id}/stream         Server-Sent Events: batches of deltas after ?from_seq=
                                       (or the Last-Event-ID header when reconnecting)
GET  /api/messages/{id}/reasoning      a message's private reasoning (loaded on demand)
POST /api/ingest                       NDJSON trace records, applied through the live pipeline
POST /api/replay                       {"action": "pause"|"resume", "speed": n}
The built frontend (web/dist) is served at / when present.
"""
import asyncio
import json
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from collab.acts import chunks, placeholders
from collab.adapters.ndjson import parse_line
from collab.live import LivePipeline
from collab.schema import record_errors


def rows_in(store, table, column, ids):
    out = []
    for chunk in chunks(list(ids)):
        out += store.annotations(table, f"{column} IN ({placeholders(chunk)})", chunk)
    return out


def episode_summary(store, ep):
    root = store.get("task", ep["root_task_id"]) or {}
    manifests = store.all("manifest")
    manifest = next((m for m in manifests if m["id"] == ep.get("dataset_id")), manifests[0] if len(manifests) == 1 else {})
    return {**ep, "root_name": root.get("name"), "scope": root.get("scope"), "status": root.get("status"),
            "time_unit": (manifest or {}).get("time_unit"), "display_tz": (manifest or {}).get("display_tz")}


def snapshot(store, episode_id):
    """Everything a view needs for one episode, keyed by table. Message reasoning is left out
    (see /api/messages/{id}/reasoning); `has_reasoning` marks messages that have it."""
    seq = store.last_seq()  # read first: deltas after this may already be reflected, never missed
    m = store.episode_members(episode_id)
    messages = [{**{k: v for k, v in msg.items() if k != "reasoning"}, "has_reasoning": bool(msg["reasoning"])}
                for msg in m["messages"]]
    message_ids = [msg["id"] for msg in messages]
    sentences = [{k: v for k, v in s.items() if k != "text"} for s in rows_in(store, "sentences", "message_id", message_ids)]
    sentence_ids = [s["id"] for s in sentences]
    wait_ids = [s["id"] for s in m["spans"] if s["kind"] == "wait"]
    by_episode = lambda table: store.annotations(table, "episode_id = ?", (episode_id,))
    return {
        "seq": seq,
        "manifest": m["manifest"],
        "episode": episode_summary(store, m["episode"]),
        "actors": m["actors"],
        "channels": m["channels"],
        "tasks": m["tasks"],
        "messages": messages,
        "spans": m["spans"],
        "events": m["events"],
        "sentences": sentences,
        "span_task": by_episode("span_task"),
        "sentence_task": by_episode("sentence_task"),
        "acts": rows_in(store, "acts", "sentence_id", sentence_ids),
        "act_links": rows_in(store, "act_links", "src_id", sentence_ids),
        "addressees": rows_in(store, "addressees", "message_id", message_ids),
        "waits": rows_in(store, "waits", "span_id", wait_ids),
        "loops": by_episode("loops"),
        "overlaps": by_episode("overlaps"),
        "triggers": by_episode("triggers"),
        "influence": by_episode("influence"),
        "metrics": by_episode("metrics"),
    }


def create_app(store, static_dir=None, pipeline=None, replay=None, mode="static", source=None, poll=0.25):
    app = FastAPI(title="collab")
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    pipeline = pipeline or LivePipeline(store)

    @app.get("/api/info")
    def info():
        return {"mode": mode, "source": source, "seq": store.last_seq(),
                "replay": replay.status() if replay is not None else None}

    @app.get("/api/episodes")
    def list_episodes():
        return [episode_summary(store, ep) for ep in sorted(store.episodes(), key=lambda e: (e["start"], e["id"]))]

    @app.get("/api/episodes/{episode_id}/snapshot")
    def get_snapshot(episode_id: str):
        if store.get("episode", episode_id) is None:
            raise HTTPException(404, f"no episode {episode_id}")
        return snapshot(store, episode_id)

    @app.get("/api/episodes/{episode_id}/stream")
    async def stream(episode_id: str, request: Request, from_seq: int = 0, once: bool = False):
        last_id = request.headers.get("last-event-id", "")
        start = int(last_id) if last_id.isdigit() else from_seq

        async def events():
            seq, beat = start, time.time()
            while not await request.is_disconnected():
                batch, seq = store.scan_deltas(seq, episode_id)
                if batch:
                    yield f"id: {seq}\ndata: {json.dumps(batch)}\n\n"
                    continue
                if once:  # tests and one-shot catch-up
                    return
                if time.time() - beat > 15:
                    beat = time.time()
                    yield ": keep-alive\n\n"
                await asyncio.sleep(poll)

        headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Content-Encoding": "identity"}
        return StreamingResponse(events(), media_type="text/event-stream", headers=headers)

    @app.get("/api/messages/{message_id}/reasoning")
    def get_reasoning(message_id: str):
        msg = store.get("message", message_id)
        if msg is None:
            raise HTTPException(404, f"no message {message_id}")
        return {"id": message_id, "reasoning": msg["reasoning"]}

    @app.post("/api/ingest")
    async def ingest(request: Request):
        body = (await request.body()).decode("utf-8")
        records, errors = [], []
        for n, line in enumerate(body.splitlines(), 1):
            if not line.strip():
                continue
            try:
                rec = parse_line(line, f"line {n}: ")
            except ValueError as e:
                errors.append(str(e))
                continue
            errors += [f"line {n}: {err}" for err in record_errors(rec)]
            records.append(rec)
        if errors:
            raise HTTPException(400, {"errors": errors[:50]})
        for rec in records:
            pipeline.apply(rec)
        pipeline.tick()
        return {"applied": len(records), "seq": store.last_seq()}

    @app.post("/api/replay")
    async def control_replay(request: Request):
        if replay is None:
            raise HTTPException(409, "not replaying")
        cmd = await request.json()
        if cmd.get("action") == "pause":
            replay.paused.set()
        elif cmd.get("action") == "resume":
            replay.paused.clear()
        if cmd.get("speed"):
            replay.speed = float(cmd["speed"])
        return replay.status()

    if static_dir and Path(static_dir).exists():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")
    return app
