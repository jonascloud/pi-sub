# 0003 — Messages, not interactive child UI

Status: Accepted

## Decision

Use ordinary child replies for questions and answers. Execution completion is not semantic task completion. The parent decides whether to give another instruction or accept the result; reading a question must not remove its task. Do not introduce an ask-parent framework or classify question text mechanically.

The coordinator renders its own status widget from native events. Child widgets, status, titles and editor changes are not forwarded.

Native JSON/print execution has no interactive UI. Its public defaults return `false` for `confirm` and `undefined` for `select`, `input` and `editor`. Extensions must honor denial/cancellation and `ctx.hasUI`. Never approve automatically, forward approval to an LLM or patch SDK UI objects. A command that only opens a dialog and produces no new assistant response fails as an execution.

## Instruction placement

Keep operating guidance in one stable system-prompt section and operation-specific tool contracts. Replace that section when context changes rather than appending tutorials to replies. Notifications carry identity and new information only. TUI reply previews are compact and expandable without reducing the model-visible delivery. The parent uses routine reports internally and does not acknowledge historical deliveries again.

State-dependent actions and consequential warnings remain visible where needed: an uncommitted draft is not active, empty selection disables delegation, and cancellation cannot undo publication. Persistent controls are not repeated chat messages. Dynamic routing facts are grouped rather than repeating identical choices for every level.

## Rationale and consequences

Print mode does not wrap its no-op UI with observable dialog events. Unlike the earlier RPC bridge, the coordinator cannot diagnose every UI attempt. It uses native safe defaults rather than claiming universal interception.

Permission extensions must support headless denial. If they require human authorization, configure that separately; an ordinary parent/child text exchange cannot grant it. This is not a security sandbox against misbehaving trusted extensions.
