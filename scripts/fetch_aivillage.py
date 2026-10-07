#!/usr/bin/env python3
"""
Download the AI Village dataset from Hugging Face (tables only, no screenshots) into
data/hf/<revision>/ and print each table's fields, so the adapter can be checked against them.

The dataset is gated: request access at https://huggingface.co/datasets/aidigestorg/ai-village,
then put a read token in .env as HF_TOKEN (or run `huggingface-cli login`).

By default only the core tables are fetched (~430 MB). In-session steps add ~2.5 GB
(--with-turns); agent memories and Claude Code logs add ~2.5 GB more (--all).

Usage:
    python scripts/fetch_aivillage.py                # core tables, latest revision, then print fields
    python scripts/fetch_aivillage.py --with-turns   # also computer_use_turns (step detail)
    python scripts/fetch_aivillage.py --no-download  # just print fields of the newest local copy
"""
import argparse
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.cli import ROOT  # noqa: E402

REPO = "aidigestorg/ai-village"
HF_DIR = ROOT / "data" / "hf"
CORE = ["agents", "chat_rooms", "chat_messages", "computer_use_sessions", "events", "village_goals",
        "agent_goals", "summaries", "villages"]


def download(with_turns=False, everything=False):
    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError

    sha = HfApi().dataset_info(REPO).sha
    target = HF_DIR / sha
    tables = ["*"] if everything else CORE + (["computer_use_turns"] if with_turns else [])
    try:
        snapshot_download(REPO, repo_type="dataset", revision=sha, local_dir=target,
                          allow_patterns=[f"{t}.jsonl.gz" for t in tables] + ["*.md", "example.py"])
    except (GatedRepoError, HfHubHTTPError) as e:
        sys.exit(f"download failed ({type(e).__name__}). The dataset is gated: request access at "
                 f"https://huggingface.co/datasets/{REPO} and log in with `huggingface-cli login`.\n{e}")
    (HF_DIR / "LATEST").write_text(sha)
    return target


def summarize(path, sample=500):
    fields = defaultdict(lambda: {"types": set(), "example": None})
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= sample:
                break
            for k, v in json.loads(line).items():
                fields[k]["types"].add(type(v).__name__)
                if fields[k]["example"] is None and v not in (None, "", [], {}):
                    fields[k]["example"] = v
    print(f"\n== {path.name}")
    for k, info in fields.items():
        ex = json.dumps(info["example"], ensure_ascii=False)
        print(f"  {k:28} {'/'.join(sorted(info['types'])):18} {ex[:90]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--no-download", action="store_true")
    parser.add_argument("--with-turns", action="store_true", help="also fetch computer_use_turns (~2.5 GB)")
    parser.add_argument("--all", action="store_true", help="fetch every table (~5.4 GB)")
    args = parser.parse_args()
    if args.no_download:
        latest = HF_DIR / "LATEST"
        if not latest.exists():
            sys.exit("no local copy yet; run without --no-download")
        target = HF_DIR / latest.read_text().strip()
    else:
        target = download(with_turns=args.with_turns, everything=args.all)
    print(f"dataset at {target}")
    for path in sorted(target.glob("*.jsonl.gz")):
        summarize(path)


if __name__ == "__main__":
    main()
