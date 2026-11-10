# 0002 — Tasks own sessions; executions own processes

Status: Accepted

## Decision

A subagent is an assignment with one native Pi session. Each execution is a fresh short-lived process. At most one execution owns that session at a time. Ready and paused tasks retain data, not workers or concurrency slots. Do not pool processes or reuse task sessions for unrelated work. Journals and reports are volatile working data owned by the active parent session, not an archive or automatic job recovery.

```text
queued -- admission --> active -- reply + process close --> ready(reply)
   |                      |                                   |
   | interrupt            | interrupt + process close         +-- answer --> queued
   v                      v                                   +-- accept --> removed
 paused <-----------------+
   +-- explicit continue --> queued

failure + process close --> ready(error) -- user prompt cleanup --> removed
```

Reply/error/stopped are outcomes, not additional states. Retries and automatic compaction remain native execution. Pausing and closing describe an operation on the exact owned execution.

Active redirection retains the correction, interrupts the old process, waits for closure and final capture, then queues a new process on the same session. It never injects input into a busy native session. An interrupt between these steps prevents restart and retains the correction. Only new saved native user entries prove input persistence, not streamed message events emitted before the write. Instructions without that evidence are retained after interruption or failure; transformed inputs may be conservatively replayed.

The controller accepts two user inputs:

- **Interrupt:** block admission first, pause queued tasks, then terminate active processes. Request native SIGTERM shutdown, escalate to SIGKILL on a bounded deadline and await closure including output drainage. Failed termination retains ownership and its slot for retry. Later replies cannot restart an interrupted parent.
- **Prompt:** before forwarding real interactive/RPC input, finish failed-execution cleanup, hand off failure reports and pending instructions as text or temporary file references, then remove failed tasks without an LLM cleanup call. Report-storage failures use a visible error with compact native diagnostics and an in-memory receipt rather than blocking input. Process-closure failures still block forwarding. An intervening interrupt invalidates this handoff. Reopen admission but leave paused tasks paused. Explicit operator start/continue commands use the same preparation.

Normal replies await an explicit parent decision, not an idle process. Delivery is independent of that decision: a complete handoff (text or the saved-file reference; see [0007](0007-file-backed-handoffs.md)) in the parent's native context is acknowledged by its reply identity and folds its widget row without removing the task. Proposing or announcing a batch without delivery into model context does not acknowledge the reply; an older delivery cannot acknowledge a successor. A new execution produces a fresh reply identity. Accepting or stopping removes the live task and retains a complete idempotent result receipt without workers, promises or listeners for the coordinator's lifetime. Receipts, including responses and pending input, are not bounded in count or size. Failures release execution resources independently of model decisions and disappear after user-prompt delivery.

After every execution, read final saved native entries, including late shutdown usage. Replace the task's cumulative usage snapshot; never add successive snapshots of the same journal. A corrupt, missing or identity-mismatched final journal, or one that changes a previously observed entry, cannot contribute new usage; retain the confirmed pre-execution snapshot instead. Partial records from an untrusted snapshot do not establish their own provenance. Charge the growth of each confirmed snapshot once, independent of acceptance: delivered replies need no acceptance, so tying usage to task removal would leave most work uncharged. Pi exposes parent usage only through tool results, so charged usage waits for the next subagent tool result. Metrics and pending delivery outlive task removal. Shutdown, reload and session replacement terminate owned executions without model-managed collection, then dispose of receipts, report reuse and the temporary workspace. Reopening parent history does not restore tasks or artifacts. Already-delivered text remains ordinary conversation history, and project changes are untouched. Hard crashes may leave temporary files; no background collector is introduced.

## Native boundaries

Process closure is decisive for execution lifetime, not success or semantic task completion. A zero exit code can accompany a native provider error. Require new native response evidence and inspect exit/error information; do not return a restored old answer as new output.

Continuation restores saved native history and issues another request. It does not resume an interrupted request, retain extension memory, roll back side effects or guarantee exactly-once actions. The coordinator retains an observed native journal identity across executions. A missing journal, changed identity or detected corruption fails explicitly rather than silently becoming a new session. Identity and structural checks do not prove complete history: valid truncation or substitution retaining the same identity between executions may go undetected. Interruption before any journal was created still permits a genuine first start.

Bare RPC `abort` has no extension event when the parent is idle. Raw TUI input precedes focused components, so an extension cannot tell an idle interrupt from Escape closing a selector, dialog or autocomplete menu. The idle global interrupt is therefore `/sub:pause`; active parent runs additionally use abort signals and `agent_settled.aborted`. Compaction has its own public signal. No parent RPC transport interception or SDK patch is introduced.

## Rationale

Physical process ownership removes child idle inference, heartbeat polling and input/settlement handshakes. The coordinator manages bounded executions and result transfer, not native conversation internals or a second agent engine.
