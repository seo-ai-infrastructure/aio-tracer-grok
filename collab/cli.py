"""Shared helpers for the numbered scripts in scripts/.

Importing this module loads the repo's .env (e.g. HF_TOKEN, ANTHROPIC_API_KEY) into the
environment; variables already set in the shell take precedence.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "collab.db"


def load_env(path=ROOT / ".env"):
    """Read KEY=value lines (optionally 'export KEY=value', quoted values, # comments).
    Empty values are skipped so a blank template never masks other credentials."""
    path = Path(path)
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")
        if key and value:
            os.environ.setdefault(key, value)


load_env()


def parse_days(spec):
    """'5' -> (5, 5); '1-10' -> (1, 10)."""
    lo, _, hi = spec.partition("-")
    return int(lo), int(hi or lo)


def print_issues(issues, limit=30):
    """Print validator issues; returns the number of errors."""
    errors = [i for i in issues if i[0] == "error"]
    for level, rtype, rid, msg in issues[:limit]:
        print(f"  {level:7} {rtype or '-'}:{rid or '-'}  {msg}", file=sys.stderr)
    if len(issues) > limit:
        print(f"  ... and {len(issues) - limit} more", file=sys.stderr)
    return len(errors)
