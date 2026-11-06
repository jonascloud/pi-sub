# 0003 — Messages, not interactive child UI

Status: Accepted

## Decision

Use ordinary child replies for questions and answers. Execution completion is not semantic task completion. The parent decides whether to give another instruction or accept the result; reading a question must not remove its task. Do not introduce an ask-parent framework or classify question text mechanically.

The coordinator renders its own status widget from native events. Child widgets, status, titles and editor changes are not forwarded.

Native JSON/print execution has no interactive UI. Its public defaults return `false` for `confirm` and `undefined` for `select`, `input` and `editor`. Extensions must honor denial/cancellation and `ctx.hasUI`. Never approve automatically, forward approval to an LLM or patch SDK UI objects. A command that only opens a dialog and produces no new assistant response fails as an execution.

## Instruction placement

Keep operating guidance in one stable system-prompt section and operation-specific tool contracts. Replace that section when context changes rather than appending tutorials to replies. Notifications carry identity and new information only. TUI reply previews are compact and expandable without reducing the model-visible delivery. The parent uses routine reports internally and does not acknowledge historical deliveries again.

Ready tasks are the reply inbox, not a second queue of frozen reports. At native turn boundaries, batch the current unannounced replies into one persisted custom message. Complete tool returns suppress redundant announcements before the next request, while native history prevents repeated announcements of truncated reports. Natural continuation satisfies the batch's continuation request; it does not add a second turn. Coalesce idle arrivals once per event-loop turn, without polling or a debounce delay. Interruptions suppress wakeups, and model selection may display reports without starting the parent. Bounded overflow stays eligible at the next boundary. Delivery remains reply-specific and separate from task acceptance.

State-dependent actions and consequential warnings remain visible where needed: an uncommitted draft is not active, empty selection disables delegation, and cancellation cannot undo publication. Persistent controls are not repeated chat messages. Dynamic routing facts are grouped rather than repeating identical choices for every level.

## Native views

Use native tool call/result and custom-message renderers, not another screen or UI controller. The widget shows outstanding attention; transcript rows show historical actions and observations. A complete reply actually included in the parent's native context folds automatically into a delivered count, not a done count. Its task remains available for follow-up until explicit acceptance or stop. The coordinator owns this reply-specific acknowledgment; rendering neither acknowledges delivery nor changes task lifetime. Task identity and useful outcomes outrank IDs, execution settings and diagnostic JSON. Expansion exposes full requests, results and metadata without changing the model-facing protocol.

Tool requests use action labels until a result exists; only confirmed outcomes use past-tense success labels. Keeping the outcome in the result renderer also works with native HTML exports, which render requests before their results. A self-rendered tool shell prevents an ordinary observation timeout from inheriting the native error background. Physical pausing/closing and any failure cause remain distinguishable. Unknown batch progress is not presented as complete success.

Model proposals stay explicitly unsaved. Comparisons refer to the opening baseline; publication remains the existing optimistic transaction. Display does not grant approval, infer semantic completion, collect tasks or manage processes.

## Rationale and consequences

Print mode does not wrap its no-op UI with observable dialog events. Unlike the earlier RPC bridge, the coordinator cannot diagnose every UI attempt. It uses native safe defaults rather than claiming universal interception.

Permission extensions must support headless denial. If they require human authorization, configure that separately; an ordinary parent/child text exchange cannot grant it. This is not a security sandbox against misbehaving trusted extensions.
