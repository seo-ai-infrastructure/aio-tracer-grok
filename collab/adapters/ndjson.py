"""Read, follow and write neutral trace files (NDJSON: one JSON record per line).

This is the adapter a simulation harness targets: append records to a file (or POST them to
the server), and the pipeline treats them exactly like any other source.
"""
import json
import time
from pathlib import Path


def parse_line(line, where=""):
    try:
        rec = json.loads(line)
    except json.JSONDecodeError as e:
        raise ValueError(f"{where}invalid JSON: {e}") from None
    if not isinstance(rec, dict):
        raise ValueError(f"{where}expected a JSON object per line")
    return rec


def read_records(path):
    """Yield records from an NDJSON file, skipping blank lines."""
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if line.strip():
                yield parse_line(line, f"{path}:{n}: ")


def follow_records(path, poll=0.5, should_stop=lambda: False):
    """Yield records from an NDJSON file as it grows (like `tail -f`), starting at the top.

    Only complete lines are parsed, so a writer may append partial lines.
    """
    path = Path(path)
    while not path.exists():
        if should_stop():
            return
        time.sleep(poll)
    with open(path, encoding="utf-8") as f:
        buf, n = "", 0
        while not should_stop():
            chunk = f.readline()
            if not chunk:
                time.sleep(poll)
                continue
            buf += chunk
            if not buf.endswith("\n"):
                continue  # wait for the rest of the line
            n += 1
            if buf.strip():
                yield parse_line(buf, f"{path}:{n}: ")
            buf = ""


def write_records(path, records):
    """Write records as NDJSON; returns the number written."""
    count = 0
    with open(path, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            count += 1
    return count
