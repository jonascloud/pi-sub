# 0001 — Coordinate native Pi executions

Status: Accepted

## Decision

Build a small coordinator around the native single-shot CLI: `pi --mode json --print --session <file>`. Send the instruction over stdin. Pi owns sessions, conversation history, tools, compaction, retries and restoration. The coordinator owns minimum-strength selection, task admission, process ownership and compact presentation.

All work is asynchronous. Waiting observes an existing task, not a separate foreground runner. Native JSON events show progress; actual process closure with drained output ends an execution. This replaces the original persistent RPC-worker approach: untagged settlement events and state snapshots could not prove the absence of native deferred work.

## Rationale and consequences

The process boundary replaces our in-process framework, not merely its executor. Do not introduce session construction, provider replay, transcript reconstruction, role presets, turn loops, budgets or a service/event platform.

Each continuation pays process startup and reloads native resources. In-memory extension state does not survive. An explicitly loaded native extension verifies the assigned session, provider, model and thinking before requests, including native thinking clamps. It uses public hooks and abort, not SDK patches or private fields.

Children use native Pi configuration; parent-only runtime registrations are not inherited. Process separation is not a filesystem sandbox. Task/session lifetime is defined in [0002](0002-process-lifetime-and-interruption.md).
