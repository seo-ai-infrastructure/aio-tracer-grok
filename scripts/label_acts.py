#!/usr/bin/env python3
"""
Label speech acts: what each chat sentence does (asks, commits, reports, ...) and which earlier
sentence it responds to. Run after ingest.py. Model answers are cached, so re-runs are free.

Usage:
    python scripts/label_acts.py --episode charity-2025 --days 1 --dry-run  # windows, size, a sample prompt; no API call
    python scripts/label_acts.py --episode charity-2025 --days 1            # label the first day (prints the cost)
    python scripts/label_acts.py --episode charity-2025                     # label everything
    python scripts/label_acts.py --episode charity-2025 --batch             # Message Batches: half price, slower
    python scripts/label_acts.py --episode charity-2025 --heuristic         # rules only, no model
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collab.cli import DEFAULT_DB  # noqa: E402
from collab.llm import LLM, PRICES  # noqa: E402
from collab.speech import SYSTEM, Episode, infer_acts, load_config, window_prompt, windows  # noqa: E402
from collab.store import Store  # noqa: E402

MODEL = "claude-sonnet-5"  # labeling is high-volume and well-defined: Sonnet rather than Opus
# Calibrated on the day-1 charity pilot with claude-sonnet-5 (its tokenizer counts more than chars/4).
TOKENS_PER_CHAR = 0.43
OUT_TOKENS_PER_SENTENCE = 47  # a label entry, the odd link, and thinking at medium effort


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--episode", required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--days", type=int, help="only the first N days with messages (clock-time sources)")
    parser.add_argument("--heuristic", action="store_true", help="rule-based labels, no model")
    parser.add_argument("--batch", action="store_true", help="submit the calls as one Message Batch (50%% cost, slower)")
    parser.add_argument("--dry-run", action="store_true", help="show counts, a cost estimate and a sample prompt; no API call")
    args = parser.parse_args()

    store = Store(args.db)
    if store.get("episode", args.episode) is None:
        sys.exit(f"no episode {args.episode!r}; known: {[e['id'] for e in store.episodes()]}")
    if args.dry_run:
        ep = Episode(store, args.episode, load_config(), args.days)
        prompts = [window_prompt(ep, w)["text"] for w in windows(ep)]
        n_sent = sum(len(ep.sentences[m["id"]]) for m in ep.to_label)
        if prompts:
            sample = prompts[len(prompts) // 2]
            print(sample[:3000] + ("\n..." if len(sample) > 3000 else ""))
        tokens_in = int(sum(len(SYSTEM) + len(p) for p in prompts) * TOKENS_PER_CHAR)
        tokens_out = n_sent * OUT_TOKENS_PER_SENTENCE
        p_in, p_out = PRICES.get(args.model, (0.0, 0.0))
        dollars = (tokens_in * p_in + tokens_out * p_out) / 1e6
        print(f"\n{len(prompts)} calls for {len(ep.to_label):,} messages and {n_sent:,} sentences; ~{tokens_in:,} input "
              f"and ~{tokens_out:,} output tokens, about ${dollars:.2f} with {args.model}"
              f"{f', ${dollars / 2:.2f} with --batch' if p_in else ''}")
        return

    llm = None if args.heuristic else LLM(store, model=args.model)
    s = infer_acts(store, llm, args.episode, days=args.days, batch=args.batch)
    by_rules = f"; {s['fallback']:,} labeled by rules" if s["fallback"] else ""
    print(f"{s['messages']:,} messages, {s['sentences']:,} sentences in {s['windows']} windows{by_rules}")
    print("acts:", ", ".join(f"{k} {v:,}" for k, v in s["acts"].most_common()))
    print("links:", ", ".join(f"{k} {v:,}" for k, v in s["links"].most_common()) or "none")
    if llm is not None:
        u = llm.usage
        print(f"{u['calls']} API calls ({u['cached']} answered from cache): {u['input_tokens']:,} input "
              f"+ {u['cache_creation_input_tokens'] + u['cache_read_input_tokens']:,} cache tokens, "
              f"{u['output_tokens']:,} output tokens, about ${u['dollars']:.2f}")


if __name__ == "__main__":
    main()
