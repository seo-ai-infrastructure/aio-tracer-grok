#!/usr/bin/env python3
"""
Export AI Village transcript events to a CSV spreadsheet, one row per turn.

Columns: day, date, time, type, speaker, text, thinking
  - speaker is speakerName (talk events) or agentName (actions)
  - text is the main payload for the event type (content, goal, query, duration)

Usage:
    python scripts/export_turns.py                        # all events -> output/turns.csv
    python scripts/export_turns.py --talk                 # only AGENT_TALK / USER_TALK
    python scripts/export_turns.py --days 1-5             # restrict to a day range
    python scripts/export_turns.py --no-thinking -o output/day1.csv --days 1
"""
import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from collab.cli import parse_days  # noqa: E402

DEFAULT_INPUT = ROOT / "data" / "village-transcript.json"
DEFAULT_OUTPUT = ROOT / "output" / "turns.csv"

TALK_TYPES = {"AGENT_TALK", "USER_TALK"}
TEXT_FIELDS = ("content", "goal", "query", "duration")


def event_text(event):
    for field in TEXT_FIELDS:
        if event.get(field):
            return event[field]
    return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("-i", "--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--days", type=parse_days, help="day or range, e.g. 3 or 1-10")
    parser.add_argument("--talk", action="store_true", help="only chat messages")
    parser.add_argument("--no-thinking", action="store_true", help="omit thinking column")
    args = parser.parse_args()

    transcript = json.load(open(args.input))

    columns = ["day", "date", "time", "type", "speaker", "text"]
    if not args.no_thinking:
        columns.append("thinking")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    # utf-8-sig so Excel/Numbers detect the encoding correctly
    with open(args.output, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(columns)
        for day in transcript["days"]:
            if args.days and not args.days[0] <= day["day"] <= args.days[1]:
                continue
            for event in day["events"] or []:
                if args.talk and event["type"] not in TALK_TYPES:
                    continue
                row = [
                    day["day"],
                    day["date"],
                    event["time"],
                    event["type"],
                    event.get("speakerName") or event.get("agentName", ""),
                    event_text(event),
                ]
                if not args.no_thinking:
                    row.append(event.get("thinking", ""))
                writer.writerow(row)
                rows += 1

    print(f"Wrote {rows:,} rows to {args.output}")


if __name__ == "__main__":
    main()
