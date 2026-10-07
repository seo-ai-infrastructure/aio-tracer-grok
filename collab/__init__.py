"""Source-agnostic pipeline for visualizing multi-agent collaboration traces.

Everything downstream of `collab.adapters` works on the neutral trace format defined in
`schema/trace.schema.json`; source-specific logic (e.g. AI Village) lives only in adapters.
"""
