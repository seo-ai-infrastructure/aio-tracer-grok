# Swarm Tracer

**Visualize agent coordination, communication, and influence.**

Swarm Tracer turns the record of a multi-agent run (who worked on what, when, and what everyone said) into three linked, interactive views. It's built on the [AI Village](https://theaidigest.org/village) dataset, where a team of AI agents and their human audience pursue a shared goal for days or weeks at a time.

> **A proof of concept** Code (including most of this README) was written by a coding agent with human steering. Treat the inferred labels and counts as a first pass to explore, not as measurements. Expect some rough edges.

![The Task view: a tree of tasks over time, with a band for each agent at work, above the chat](docs/images/tasks.png)

## The three views

All three share one chat transcript and one timeline position. Scrolling the chat moves the timeline, and selecting something highlights the messages behind it.

- **Task view: how tasks are broken down and distributed among agents.** The shared goal as a tree of tasks, inferred from the agents' work sessions and chat. Each row is a task or subtask, and each colored band is an agent working on it. Expand a task to see its parts, or select one to highlight where the chat discusses it.
- **Communication view: how the conversation is structured among agents and humans.** Every chat sentence is labeled by what it does (asking, committing, informing, correcting) and linked to what it responds to. A summary shows each speaker's mix, which questions got answered, which requests were taken up, and which commitments were kept.
- **Influence view: who initiates work and how it spreads.** Arrows point from those who requested or initiated work to those who performed it, weighted by hours of the performer's time. Click an arrow to see the tasks behind it and the messages that started them. A table view shows the same data.

| Communication | Influence |
|---|---|
| ![Per-speaker summary of speech acts above the chat](docs/images/communication.png) | ![Influence graph with one link's evidence open](docs/images/influence.png) |

## How it works

A Python pipeline loads a run into SQLite, enriches it with model-inferred structure, and serves it to a React + D3 front end.

1. **Ingest** messages, work sessions and actors as neutral trace records, and split messages into sentences.
2. **Infer the task tree** top-down from session descriptions and chat, and assign each work session to a task (Claude Opus 5).
3. **Compute markers** deterministically: retry loops, duplicated effort, and what agents were waiting on.
4. **Infer influence:** for each task and worker, who got them started (asked, proposed, or joined), with the messages as evidence (Claude Opus 5).
5. **Label speech acts:** what each sentence does, and which earlier sentence it responds to (Claude Sonnet 5).

Every model answer is cached in the database, so re-running a step is free and repeatable. Each paid step has a `--dry-run` that shows what it would send without calling the API. For the five-week charity season (8,118 messages), the whole pipeline cost roughly $15–20 in API calls, using the Batch API for the speech-act labels.

## Getting started

**Environment.** Open the repo in its dev container, which creates the `pyc` conda environment. Or create it yourself:

```bash
conda env create -f environment.yml
conda activate pyc
```

The web app needs Node.js 22 or later.

**Keys.** Put an Anthropic API key in `.env` at the repo root, plus a Hugging Face token if you'll download the dataset tables:

```
ANTHROPIC_API_KEY=...
HF_TOKEN=...
```

**Data.** The AI Village data isn't included in this repo (`data/` is git-ignored).
- The current ingest adapter reads the AI Village website's transcript export from `data/village-transcript.json`.
- The full dataset is [on Hugging Face](https://huggingface.co/datasets/aidigestorg/ai-village) (gated: request access). `python scripts/fetch_aivillage.py` downloads its tables.

The dataset is shared under AI Digest's research terms. Use it for research and analysis, don't train or fine-tune AI systems on it without their written permission, don't try to re-identify anyone in it, and cite it (see [Acknowledgments and citation](#acknowledgments-and-citation)).

**Build an episode.** Episodes (shared-goal periods) are defined in `config/aivillage_episodes.yaml`. For the charity season:

```bash
python scripts/ingest.py --source aivillage-transcript --days 1-37
python scripts/infer_tasks.py --episode charity-2025
python scripts/compute_markers.py --episode charity-2025
python scripts/compute_influence.py --episode charity-2025
python scripts/label_acts.py --episode charity-2025 --batch
```

Add `--dry-run` to any model step to see its cost first, or `--days 1` to `label_acts.py` for a quick look at one day.

**Run the app.**

```bash
cd web && npm install && npm run build && cd ..
python scripts/serve.py
```

Then open http://localhost:8000.

## Using your own runs

Nothing in the views is specific to AI Village. Runs come in as a neutral NDJSON trace (actors, tasks, episodes, messages, spans and events), defined in `schema/trace.schema.json`, so an LLM simulation can write its runs directly:

```bash
python scripts/validate_trace.py my-run.ndjson
python scripts/ingest.py --source ndjson my-run.ndjson
```

The server can also stream: `--mode replay` plays a stored episode back at any speed, and `--mode follow` tails an NDJSON file as a run writes it.

```bash
python scripts/serve.py --mode replay --episode rpg-with-saboteurs --speed 120
python scripts/serve.py --mode follow --ndjson runs/today.ndjson
```

`scripts/check_replay.py` checks that a replay ends with exactly the same derived data as a static build.

## Demo video

`web/demo/record.mjs` records a captioned, voice-free walkthrough of the running app as an MP4, using Playwright and ffmpeg. The card wording and captions live at the top of the script and in its scenes.

```bash
cd web
npm run demo             # -> output/swarm-tracer-demo.mp4 (needs the server running)
npm run demo -- --cards  # just the title card and view bumpers, as images
```

## Development

```bash
pytest                      # pipeline, store, streaming and replay tests
cd web && npm test          # front-end logic
cd web && npm run dev       # hot-reloading app on :5173, proxying /api to the server on :8000
```

| Path | What's there |
|---|---|
| `collab/` | Store, ingest adapters, inference passes (tasks, markers, influence, speech acts), live pipeline, API server |
| `scripts/` | Command-line entry points for each pipeline step, the server and checks |
| `config/` | Episode definitions and settings for each inference pass |
| `schema/` | The neutral trace format |
| `web/` | The React + D3 app, and the demo recorder in `web/demo/` |
| `tests/` | Python tests and small simulated fixtures |

## Limitations

- **Inferred, not observed.** The task tree, influence triggers and speech-act labels come from a model. They are usually sensible and sometimes wrong, and each links back to the sessions or messages behind it so you can check.
- **Follow-ups are found only within reach.** The speech-act labeler looks back about 65 messages, plus each speaker's recent commitments. So "answered", "taken up" and "kept" are lower bounds, especially for agents that talk a lot.
- **Tried on two AI Village goals so far:** the 2025 charity season (all three views) and a 2026 RPG-building episode (Task view). Other goals, and other kinds of runs, may need prompt or config changes.
- **Interim data source.** The transcript export lacks chat rooms, and some later periods lack computer sessions. A Hugging Face adapter would fix both but isn't written yet.

## Related work

- [AI Village Explorer](https://github.com/Plswearpants/ai-village-explorer)
- [village-collab-graph](https://github.com/ai-village-agents/village-collab-graph)
- [village-chronicle](https://github.com/ai-village-agents/village-chronicle)
- [AgentLens](https://arxiv.org/abs/2402.08995)
- [Langfuse](https://langfuse.com/)
- [AgentOps](https://github.com/AgentOps-AI/agentops)
- [Arize Phoenix](https://github.com/Arize-ai/phoenix)

## Acknowledgments and citation

The AI Village and its dataset are by [AI Digest](https://theaidigest.org). Swarm Tracer isn't affiliated with them. If you use the dataset, cite it as they ask:

> AI Digest, "AI Village dataset", 2026. https://theaidigest.org/village
