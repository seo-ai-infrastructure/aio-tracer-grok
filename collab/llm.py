"""Claude client for pipeline annotation.

- Structured outputs: every call returns JSON validated against a schema (output_config.format).
- Prompt caching: the stable system prompt carries cache_control.
- Batches: bulk runs go through Message Batches (50% cost); items the batch refuses or fails
  are retried synchronously, where server-side fallbacks apply.
- Result cache: responses are stored in the `llm_cache` table keyed by
  sha256(model, prompt_version, system, user, schema), so re-runs and replays are free and
  deterministic.
"""
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

DEFAULT_MODEL = os.environ.get("COLLAB_MODEL", "claude-opus-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"  # pairs with fallbacks="default"
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
# $ per million tokens (input, output), from the claude-api skill's model table (2026-06-24).
PRICES = {"claude-opus-5": (5.0, 25.0), "claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5": (2.0, 10.0),
          "claude-haiku-4-5": (1.0, 5.0), "claude-fable-5-1": (10.0, 50.0)}


class LLMError(RuntimeError):
    pass


class CacheMiss(LLMError):
    """Raised by an offline LLM (replays) instead of making a paid call."""


def cost(model, usage, batch=False):
    """Estimated dollars for one call's usage: cache writes 1.25x, cache reads 0.1x, batches half."""
    p_in, p_out = PRICES.get(model, (0.0, 0.0))
    dollars = (usage.get("input_tokens", 0) * p_in + usage.get("cache_creation_input_tokens", 0) * p_in * 1.25
               + usage.get("cache_read_input_tokens", 0) * p_in * 0.1 + usage.get("output_tokens", 0) * p_out) / 1e6
    return dollars * (0.5 if batch else 1.0)


def cache_key(model, prompt_version, system, user, schema):
    blob = json.dumps([model, prompt_version, system, user, schema], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


class LLM:
    def __init__(self, store, model=DEFAULT_MODEL, client=None, offline=False):
        """`offline`: answer only from the cache (replays never spend money); misses raise CacheMiss
        from json() and are left out of json_many() results."""
        self.store = store
        self.model = model
        self._client = client
        self.offline = offline
        self.usage = {"calls": 0, "cached": 0, **{k: 0 for k in USAGE_KEYS}, "dollars": 0.0}

    @property
    def client(self):
        if self._client is None:
            import anthropic  # resolves ANTHROPIC_API_KEY / auth token / `ant auth login` profile
            self._client = anthropic.Anthropic()
        return self._client

    # ---- cache ----------------------------------------------------------------------------

    def cached(self, key):
        return self.store.cache_get(key)

    def save(self, key, prompt_version, data):
        self.store.cache_put(key, self.model, prompt_version, data)

    def _params(self, system, user, schema, effort, max_tokens):
        return {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}],
            "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        }

    def _parse(self, response, key, prompt_version, batch=False):
        """Record the call's usage (money is spent even when the answer is unusable), then parse."""
        usage = {k: getattr(response.usage, k, 0) or 0 for k in USAGE_KEYS}
        for k, v in usage.items():
            self.usage[k] += v
        self.usage["calls"] += 1
        self.usage["dollars"] += cost(self.model, usage, batch)
        self.store.usage_put(key, self.model, prompt_version, batch, usage)
        if response.stop_reason == "refusal":
            raise LLMError(f"refused: {getattr(response, 'stop_details', None)}")
        if response.stop_reason == "max_tokens":
            raise LLMError("output hit max_tokens; raise max_tokens or shrink the input")
        text = next(b.text for b in response.content if b.type == "text")
        return json.loads(text)

    # ---- calls ----------------------------------------------------------------------------

    def json(self, prompt_version, system, user, schema, effort="medium", max_tokens=64000):
        """One structured call, answered from the cache when possible.

        Streams (large outputs plus thinking can exceed HTTP timeouts otherwise) and opts into
        server-side refusal fallbacks.
        """
        key = cache_key(self.model, prompt_version, system, user, schema)
        hit = self.cached(key)
        if hit is not None:
            self.usage["cached"] += 1
            return hit
        if self.offline:
            raise CacheMiss(f"no cached answer for this {prompt_version} request")
        with self.client.beta.messages.stream(
            **self._params(system, user, schema, effort, max_tokens),
            betas=[FALLBACK_BETA], fallbacks="default",
        ) as stream:
            response = stream.get_final_message()
        data = self._parse(response, key, prompt_version)
        self.save(key, prompt_version, data)
        return data

    def json_batch(self, prompt_version, system, items, schema, effort="medium", max_tokens=16000, poll=30,
                   progress=print, schemas=None):
        """Many structured calls sharing one system prompt. `items` is [(item_id, user_text)].

        `schemas` ({item_id: schema}) overrides `schema` per item. Returns {item_id: data}.
        Uses Message Batches for uncached items; anything the batch does not answer is retried
        synchronously (server-side fallbacks are not available on Batches).
        """
        from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
        from anthropic.types.messages.batch_create_params import Request

        schema_of = lambda item_id: (schemas or {}).get(item_id, schema)
        out, pending = {}, []
        for item_id, user in items:
            key = cache_key(self.model, prompt_version, system, user, schema_of(item_id))
            hit = self.cached(key)
            if hit is not None:
                self.usage["cached"] += 1
                out[item_id] = hit
            else:
                pending.append((item_id, user, key))
        if not pending or self.offline:
            return out
        by_custom = {f"r{i}": p for i, p in enumerate(pending)}  # custom_id must be [a-zA-Z0-9_-]{1,64}
        batch = self.client.messages.batches.create(requests=[
            Request(custom_id=cid, params=MessageCreateParamsNonStreaming(
                **self._params(system, user, schema_of(item_id), effort, max_tokens)))
            for cid, (item_id, user, _) in by_custom.items()])
        progress(f"batch {batch.id}: {len(pending)} requests submitted")
        while batch.processing_status != "ended":
            time.sleep(poll)
            batch = self.client.messages.batches.retrieve(batch.id)
            progress(f"batch {batch.id}: {batch.request_counts}")
        retry = []
        for result in self.client.messages.batches.results(batch.id):
            item_id, user, key = by_custom[result.custom_id]
            if result.result.type == "succeeded":
                try:
                    data = self._parse(result.result.message, key, prompt_version, batch=True)
                except LLMError:
                    retry.append((item_id, user))
                    continue
                self.save(key, prompt_version, data)
                out[item_id] = data
            else:
                retry.append((item_id, user))
        for item_id, user in retry:  # streamed, so a long answer that ran out of room in the batch gets more
            out[item_id] = self.json(prompt_version, system, user, schema_of(item_id), effort, max(max_tokens, 64000))
        return out

    def json_many(self, prompt_version, system, requests, effort="medium", batch=False, progress=print, workers=8):
        """{key: (user_text, schema)} -> {key: data}: one Message Batch, or concurrent calls."""
        if not requests:
            return {}
        if self.offline:
            found = {k: self.cached(cache_key(self.model, prompt_version, system, u, s)) for k, (u, s) in requests.items()}
            self.usage["cached"] += sum(v is not None for v in found.values())
            return {k: v for k, v in found.items() if v is not None}
        if batch:
            return self.json_batch(prompt_version, system, [(k, u) for k, (u, _) in requests.items()], None,
                                   effort=effort, progress=progress, schemas={k: s for k, (_, s) in requests.items()})
        with ThreadPoolExecutor(max_workers=min(workers, len(requests))) as pool:
            futures = {k: pool.submit(self.json, prompt_version, system, u, s, effort=effort)
                       for k, (u, s) in requests.items()}
            return {k: f.result() for k, f in futures.items()}
