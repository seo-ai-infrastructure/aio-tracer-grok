#!/usr/bin/env python3
"""
Serve the views: the HTTP API plus the built frontend (web/dist) at http://localhost:8000.

Modes:
    static   serve the store as built by the numbered scripts (POST /api/ingest still works)
    replay   stream a stored episode (or an NDJSON file) into a fresh live store at --speed x real time
    follow   tail an NDJSON file a simulation is writing, into a fresh live store

Usage:
    python scripts/serve.py                                                   # static
    python scripts/serve.py --mode replay --episode rpg-with-saboteurs --speed 120
    python scripts/serve.py --mode replay --ndjson tests/fixtures/sim_small_a.ndjson --speed 2
    python scripts/serve.py --mode follow --ndjson runs/today.ndjson
For frontend development, run `npm run dev` in web/ as well; Vite proxies /api to this server.
"""
import argparse
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn  # noqa: E402

from collab.adapters.ndjson import follow_records, read_records  # noqa: E402
from collab.cli import DEFAULT_DB, ROOT  # noqa: E402
from collab.live import LivePipeline, Replay, episode_records  # noqa: E402
from collab.llm import LLM  # noqa: E402
from collab.server import create_app  # noqa: E402
from collab.store import Store  # noqa: E402

LIVE_DB = ROOT / "data" / "live.db"


def fresh_store(path):
    for p in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        p.unlink(missing_ok=True)
    return Store(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--mode", choices=["static", "replay", "follow"], default="static")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="the static store (and replay reference)")
    parser.add_argument("--live-db", type=Path, default=LIVE_DB, help="where replay/follow write (recreated)")
    parser.add_argument("--episode", help="replay: a stored episode to stream")
    parser.add_argument("--ndjson", type=Path, help="replay/follow: a trace file")
    parser.add_argument("--speed", type=float, default=60.0, help="replay: source seconds per real second")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    static_dir = ROOT / "web" / "dist"
    if args.mode == "static":
        store = Store(args.db)
        app = create_app(store, static_dir=static_dir, mode="static", source=str(args.db))
    else:
        store = fresh_store(args.live_db)
        reference = Store(args.db) if args.db.exists() else None
        llm = LLM(reference, offline=True) if reference is not None else None  # cache only: replays never spend money
        pipeline = LivePipeline(store, llm=llm, reference=reference)
        if args.mode == "replay":
            if args.episode:
                records, source = episode_records(reference, args.episode), f"episode {args.episode}"
            elif args.ndjson:
                records, source = list(read_records(args.ndjson)), str(args.ndjson)
            else:
                parser.error("replay needs --episode or --ndjson")
            replay = Replay(pipeline, records, speed=args.speed)
            app = create_app(store, static_dir=static_dir, pipeline=pipeline, replay=replay, mode="replay", source=source)
            replay.start()
        else:
            if not args.ndjson:
                parser.error("follow needs --ndjson")

            def follow():
                for rec in follow_records(args.ndjson):
                    pipeline.apply(rec)
                    pipeline.tick()

            threading.Thread(target=follow, daemon=True).start()
            app = create_app(store, static_dir=static_dir, pipeline=pipeline, mode="follow", source=str(args.ndjson))
    print(f"serving {args.mode} on http://localhost:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
