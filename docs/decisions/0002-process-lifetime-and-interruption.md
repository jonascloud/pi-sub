# 0002 — Tasks own sessions; executions own processes

Status: Accepted

## Decision

A subagent is an assignment with one native Pi session. Each execution is a fresh short-lived process. At most one execution owns that session at a time. Ready and paused tasks retain data, not workers or concurrency slots. Do not pool processes or reuse task sessions for unrelated work. Saved journals are artifacts, not automatic job recovery.

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

Active redirection retains the correction, interrupts the old process, waits for closure and final capture, then queues a new process on the same session. It never injects input into a busy native session. An interrupt between these steps prevents restart and retains the correction. Instructions without specific persistence evidence are retained after interruption or failure; transformed inputs may be conservatively replayed.

The controller accepts two user inputs:

- **Interrupt:** block admission first, pause queued tasks, then terminate active processes. Request native SIGTERM shutdown, escalate to SIGKILL on a bounded deadline and await closure including output drainage. Failed termination retains ownership and its slot for retry. Later replies cannot restart an interrupted parent.
- **Prompt:** before forwarding real interactive/RPC input, finish failed-execution cleanup, deliver failure reports and pending instructions, then remove failed tasks without an LLM cleanup call. An intervening interrupt invalidates this handoff. Reopen admission but leave paused tasks paused. Explicit operator start/continue commands use the same preparation.

Normal replies await an explicit parent decision, not an idle process. Delivery is independent of that decision: a complete reply in the parent's native context is acknowledged by its reply identity and folds its widget row, without removing the task or transferring billing usage. Queuing a follow-up and delivering a truncated preview do not acknowledge the reply; an older delivery cannot acknowledge a successor. A new execution produces a fresh reply identity. Accepting or stopping removes the live task and leaves a small idempotent result receipt without workers, promises or listeners. Failures release execution resources independently of model decisions and disappear after user-prompt delivery.

After every execution, read final saved native entries, including late shutdown usage. Replace the task's cumulative usage snapshot; never add successive snapshots of the same journal. Transfer that original usage once on acceptance, stop or automatic failure collection. Metrics and pending delivery outlive task removal. Shutdown terminates owned executions without model-managed collection.

## Native boundaries

Process closure is decisive for execution lifetime, not success or semantic task completion. A zero exit code can accompany a native provider error. Require new native response evidence and inspect exit/error information; do not return a restored old answer as new output.

Continuation restores saved native history and issues another request. It does not resume an interrupted request, retain extension memory, roll back side effects or guarantee exactly-once actions. Corrupt journals fail explicitly rather than silently becoming new sessions.

Bare RPC `abort` has no extension event when the parent is idle. The reliable idle global interrupt remains `/sub:pause`; active parent runs additionally use abort signals and `agent_settled.aborted`. Compaction has its own public signal. No parent RPC transport interception or SDK patch is introduced.

## Rationale

Physical process ownership removes child idle inference, heartbeat polling and input/settlement handshakes. The coordinator manages bounded executions and result transfer, not native conversation internals or a second agent engine.
