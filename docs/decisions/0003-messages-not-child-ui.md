# 0003 — Messages, not interactive child UI

Status: Accepted

## Decision

Use ordinary child replies for questions and answers. Execution completion is not semantic task completion. The parent decides whether to give another instruction or accept the result; reading a question must not remove its task. Do not introduce an ask-parent framework or classify question text mechanically.

The coordinator renders its own status widget from native events. Child widgets, status, titles and editor changes are not forwarded.

Native JSON/print execution has no interactive UI. Its public defaults return `false` for `confirm` and `undefined` for `select`, `input` and `editor`. Extensions must honor denial/cancellation and `ctx.hasUI`. Never approve automatically, forward approval to an LLM or patch SDK UI objects. A command that only opens a dialog and produces no new assistant response fails as an execution.

## Instruction placement

Keep operating guidance in one stable system-prompt section and operation-specific tool contracts. Replace that section when context changes rather than appending tutorials to replies. The section holds no task state and changes only with the ladder or native availability: providers cache the prompt as a prefix, and some resend the whole conversation uncached when it changes. Task state reaches the parent as conversation: tool results and replies, each carrying its task's identity. Nothing restores identities a compaction summary dropped; the widget and the operator commands still reach every task. Notifications carry identity and new information only. TUI reply previews are compact and expandable without reducing the model-visible delivery. The parent uses routine reports internally and does not acknowledge historical deliveries again.

Ready tasks are the reply inbox, not a second queue of frozen reports. A failure is handed off through the same inbox as an answer, names its cause and wakes an idle parent; it has no separate notice or cleanup path. At native turn boundaries, batch the current unannounced replies into one persisted custom message. Complete tool returns suppress redundant announcements before the next request,. Natural continuation satisfies the batch's continuation request; it does not add a second turn. Coalesce idle arrivals once per event-loop turn, without polling or a debounce delay. An aborted parent is not woken ([0002](0002-process-lifetime-and-interruption.md)); native dialogs defer delivery until they close. Oversized batches use one cached report handoff ([0007](0007-bounded-report-cache.md)). Delivery remains reply-specific and separate from reading or task acceptance.

Waiting observes and must not hold the user back. A steering message reaches the parent only after its current tool calls, so it ends every wait, and no wait blocks while one is queued. A wait also ends when its task pauses: nothing more can arrive. Ended this way, a wait returns the current state, not an error, and does not accept an unfinished task. Pi announces neither the queueing nor the withdrawal of a steering message, so an open wait checks for it while one is expected. Aborting remains an interruption.

Optimize for the smallest sufficient handoff for the next decision or action, not isolated message length. Briefings include scope, success criteria and decisive context; replies include verification, decisive reasons and material uncertainty. Follow-ups add new information with enough context to interpret it. Native global and project context loading supplies standing instructions without a second copy in task messages. Brevity must not hide evidence needed to judge correctness. Stale reports alone must not trigger revisiting accepted/stopped tasks; deliberate review of cached reports remains valid.

Task results carry identity, state, response or preview, errors, an unsent count and the report reference. Native details contain compact task and execution diagnostics for display. Full responses and pending instructions are not duplicated there. This separates coordination needs from presentation and accounting without changing delivery or task lifetime.

## Native views

Use native tool call/result and custom-message renderers, not another screen or UI controller. The widget shows outstanding attention; transcript rows show historical actions and observations. A report handed to Pi inline or by reference folds automatically into a delivered count, not a read or done count. Its task remains available for follow-up until explicit acceptance or stop. The coordinator owns this reply-specific acknowledgment; rendering neither acknowledges delivery nor changes task lifetime. Task identity and useful outcomes outrank IDs, execution settings and diagnostic JSON. Expansion exposes requests, delivered inline text or report references, and compact metadata without changing the model-facing protocol. It does not archive full reports; references may expire on eviction or runtime teardown ([0007](0007-bounded-report-cache.md)).

Tool requests use action labels until a result exists; only confirmed outcomes use past-tense success labels. Keeping the outcome in the result renderer also works with native HTML exports, which render requests before their results. Physical pausing/closing and any failure cause remain distinguishable. Unknown batch progress is not presented as complete success.

Display does not infer semantic completion, collect tasks or manage processes.

## Rationale and consequences

Print mode does not wrap its no-op UI with observable dialog events. The coordinator cannot diagnose every UI attempt. It uses native safe defaults rather than claiming universal interception.

Permission extensions must support headless denial. If they require human authorization, configure that separately; an ordinary parent/child text exchange cannot grant it. This is not a security sandbox against misbehaving trusted extensions.
