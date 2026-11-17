# 0002 — Tasks own sessions; executions own processes

Status: Accepted

## Decision

A subagent is an assignment with one native Pi session. Each execution is a fresh short-lived process. At most one execution owns that session at a time. Ready and paused tasks retain data, not workers or concurrency slots. Do not pool processes or reuse task sessions for unrelated work. Journals and reports are volatile working data owned by the active parent session, not an archive or automatic job recovery.

```text
queued -- admission --> active -- reply or failure + process exit --> ready(reply | error)
   |                      |                                             |
   | pause                | pause + process exit                        +-- message --> queued
   v                      v                                             +-- accept or stop --> removed
 paused <-----------------+
   +-- explicit continue --> queued
```

Reply/error/stopped are outcomes, not additional states. Retries and automatic compaction remain native execution. Pausing and closing describe an operation on the exact owned execution.

A failure is the outcome of one execution, not the end of its task. A crash, a non-zero exit, a provider error or a missing response leaves the journal as an interruption does, so the task stays open: a message continues its session and resends input the journal does not prove. Admission failures are the same; nothing ran. Only a lost session is final: a journal that is corrupt, rewritten, substituted or gone after it was observed. Such a task rejects input and can only be read, accepted or stopped. A journal that never existed loses nothing, so a first start may repeat. Nothing retries on its own: the parent receives the failure like a reply and decides.

Active redirection retains the correction, interrupts the old process, waits for closure and final capture, then queues a new process on the same session. It never injects input into a busy native session. A pause between these steps prevents restart and retains the correction. Only new saved native user entries prove input persistence, not streamed message events emitted before the write. Instructions without that evidence are retained after interruption or failure; transformed inputs may be conservatively replayed.

Aborting the parent stops the parent. Its children are separate work and keep running: an abort is most often the user interjecting, and stopping work as a side effect would have to be undone by someone. The coordinator therefore holds no interruption state, closes no admission and never delays, cancels or aborts user input or a parent run.

One consequence is kept: an aborted parent stays stopped. Replies and failures that arrive afterwards wait in the inbox and do not wake it until real interactive or RPC input, or an operator continue. They join that run at its boundaries.

Pausing is always explicit, for one task or for all. It requests native SIGTERM shutdown, escalates to SIGKILL on a bounded deadline and awaits exit. Failed termination retains ownership and its slot for retry and is reported to the caller; not exiting in time says nothing about the work and is not an outcome of the task. A paused task stays paused until it is continued or messaged. The global `/sub:pause` is the one command that stops everything: it pauses every task, aborts the parent and holds replies like an abort does.

Replies and failures await an explicit parent decision, not an idle process. Delivery is independent of that decision: a complete handoff (text or the saved-file reference; see [0007](0007-file-backed-handoffs.md)) in the parent's native context is acknowledged by its reply identity and folds its widget row without removing the task. Proposing or announcing a batch without delivery into model context does not acknowledge the reply; an older delivery cannot acknowledge a successor. A new execution produces a fresh reply identity. Accepting or stopping removes the live task and retains a complete idempotent result receipt without workers, promises or listeners for the coordinator's lifetime. Receipts, including responses and pending input, are not bounded in count or size.

After every execution, read final saved native entries, including late shutdown usage. Replace the task's cumulative usage snapshot; never add successive snapshots of the same journal. A corrupt, missing or identity-mismatched final journal, or one that changes a previously observed entry, cannot contribute new usage; retain the confirmed pre-execution snapshot instead. Partial records from an untrusted snapshot do not establish their own provenance. Charge the growth of each confirmed snapshot once, independent of acceptance: delivered replies need no acceptance, so tying usage to task removal would leave most work uncharged. Pi exposes parent usage only through tool results, so charged usage waits for the next subagent tool result. Metrics and pending delivery outlive task removal. Shutdown, reload and session replacement terminate owned executions without model-managed collection, then dispose of receipts, report reuse and the temporary workspace. Reopening parent history does not restore tasks or artifacts. Already-delivered text remains ordinary conversation history, and project changes are untouched. Hard crashes may leave temporary files; no background collector is introduced.

## Native boundaries

Process exit is decisive for execution lifetime, not success or semantic task completion. A zero exit code can accompany a native provider error. Require new native response evidence and inspect exit/error information; do not return a restored old answer as new output.

Continuation restores saved native history and issues another request. It does not resume an interrupted request, retain extension memory, roll back side effects or guarantee exactly-once actions. The coordinator retains an observed native journal identity across executions. A missing journal, changed identity or detected corruption fails explicitly and finally rather than silently becoming a new session. Identity and structural checks do not prove complete history: valid truncation or substitution retaining the same identity between executions may go undetected. Interruption before any journal was created still permits a genuine first start.

An abort is observed only as `agent_settled.aborted`. Bare RPC `abort` has no extension event when the parent is idle, and raw TUI input precedes focused components, so an idle Escape cannot be told from one closing a selector, dialog or autocomplete menu: an idle parent has nothing to stop, and replies wake it as usual. No abort signals are watched, and no parent RPC transport interception or SDK patch is introduced.

## Rationale

Physical process ownership removes child idle inference, heartbeat polling and input/settlement handshakes. The coordinator manages bounded executions and result transfer, not native conversation internals or a second agent engine.
