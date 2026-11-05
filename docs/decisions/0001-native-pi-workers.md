# 0001 — Coordinate native Pi workers

Status: Accepted

## Decision

Build a small coordinator around native Pi RPC subprocesses, using the exported `RpcClient`. Pi owns sessions, conversation history, tools, compaction and retries. The coordinator owns level-based execution selection, child lifecycle, concurrency and compact progress presentation.

All work is asynchronous. Waiting observes an existing task; it is not a separate foreground execution mode. Use Pi's events and inspection methods, including `agent_settled` for quiescence, rather than rebuilding an agent loop.

## Rationale and consequences

The process boundary replaces our in-process framework, not merely its executor. Do not port custom session construction, provider replay, prompt/context reconstruction, role presets, turn loops and hard turn budgets, workspace-provider and service/event platforms, retention services or a custom transcript viewer.

Children use native Pi configuration. Parent-only runtime registrations are not automatically inherited. Process separation is not a filesystem sandbox. Reuse routing evidence and useful presentation code selectively, preserving applicable attribution; do not inherit the old API or tests as requirements.
