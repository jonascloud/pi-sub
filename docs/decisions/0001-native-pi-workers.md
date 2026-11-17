# 0001 — Coordinate native Pi executions

Status: Accepted

## Decision

Build a small coordinator around the native single-shot CLI: `pi --mode json --print --session <file>`. Send the instruction over stdin. Pi owns sessions, conversation history, tools, compaction, retries and restoration. The coordinator owns minimum-strength selection, task admission, process ownership and compact presentation.

All work is asynchronous. Waiting observes an existing task, not a separate foreground runner. Native JSON events show progress; process exit ends an execution. Output is progress only and the saved journal is the result, so draining after exit is bounded: a descendant holding an inherited pipe cannot keep an execution open.

## Rationale and consequences

The process boundary replaces our in-process framework, not merely its executor. Do not introduce session construction, provider replay, transcript reconstruction, role presets, turn loops, budgets or a service/event platform.

Each continuation pays process startup and reloads native resources. In-memory extension state does not survive. An explicitly loaded native extension checks the assigned provider, model and thinking before requests, including native thinking clamps. It uses public hooks and abort, not SDK patches or private fields.

Children use native Pi configuration; parent-only runtime registrations are not inherited. Process separation is not a filesystem sandbox. Task/session lifetime is defined in [0002](0002-process-lifetime-and-interruption.md).
