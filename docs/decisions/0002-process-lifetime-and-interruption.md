# 0002 — Input-driven task ownership

Status: Accepted

## Decision

A subagent is one native Pi process serving one task. Keep its process and session while working, paused or awaiting an answer. Do not pool workers or reuse completed subagents for unrelated work. Saved sessions are artifacts, not automatic job recovery.

A live task has four states: `queued`, `active`, `paused`, `ready`. A ready outcome is a reply, error or deliberate stop. Retries and automatic compaction remain native execution, not new task states. Starting, sending, pausing and closing are serialized operations, not parallel lifecycle flags.

```text
queued -- admission --> active -- reply --> ready(reply)
   |                      |                    |
   | interrupt            | interrupt          +-- answer --> active
   v                      v                    +-- accept --> removed
 paused <-----------------+
   +-- explicit continue --> queued / active

final failure --> ready(error) -- user prompt cleanup --> removed
```

The controller accepts two user inputs:

- **Interrupt:** block admission first, pause queued tasks, clear child queued inputs before aborting and preserve their text. Abort the parent through its native context. Confirm child quiescence rather than claiming an instantaneous freeze. A later child reply must not restart an interrupted parent.
- **Prompt:** before forwarding real interactive/RPC input, capture and close remaining failed workers, deliver failure reports and undelivered inputs, then remove failed tasks without an LLM cleanup call. A later interrupt invalidates this handoff. Reopen admission for new work, but keep existing paused children paused. Explicit operator start/continue commands use the same preparation.

Fatal workers may close before the next prompt. The coordinator owns release and does not wait for the parent model. Failed closure retains ownership and the process slot; a subsequent cleanup can retry it.

Accepting a final reply or stopping a task captures its result, original usage and session path, closes the process and removes the live entry. A small result receipt permits idempotent retrieval without retaining a worker, promises or listeners. Statistics and pending usage delivery are independent of live task retention. Read final saved native entries after closure to include late persisted usage. Parent shutdown closes owned workers immediately without waiting for result collection.

## Native boundaries

Untagged `agent_start`/`agent_settled` events can overlap awaited extension handlers. Native events trigger bounded state verification; every input receives a fresh post-acknowledgement check. Readiness additionally requires a settlement observation and no unresolved input/control operation. Do not correlate a new input with an arbitrary earlier start event or rebuild native turn execution.

Pi 1.5 RPC state does not expose settlement-hook activity or deferred prompts. Strict quiescence with overlapping asynchronous input/settlement hooks or autonomously prompting extensions is not guaranteed and is outside the supported initial configuration. A stronger guarantee requires a native SDK contract, not guessed run identities.

Bare RPC `abort` has no extension event when the parent is idle. The reliable idle RPC global interrupt is the operator command `/sub:pause`; active runs additionally use abort signals and `agent_settled.aborted`. Compaction has its own public signal. No SDK patch or parent RPC transport interception is introduced.

## Rationale and consequences

Ownership, result transfer and release are explicit without a retention service or a model-managed cleanup protocol. The widget shows live tasks only: consumed failures disappear, while cumulative metrics and original usage survive removal. Pausing never rolls back external side effects; continuation is another input in the retained native session.
