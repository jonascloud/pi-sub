# 0003 — Messages, not interactive child UI

Status: Accepted

## Decision

Use ordinary child replies for questions and answers. Execution completion is not semantic task completion. The parent decides whether to give another instruction or accept the result; reading a question must not remove its task. Do not introduce an ask-parent framework or classify question text mechanically.

The coordinator renders its own status widget from native events. Child widgets, status, titles and editor changes are not forwarded.

Native JSON/print execution has no interactive UI. Its public defaults return `false` for `confirm` and `undefined` for `select`, `input` and `editor`. Extensions must honor denial/cancellation and `ctx.hasUI`. Never approve automatically, forward approval to an LLM or patch SDK UI objects. A command that only opens a dialog and produces no new assistant response fails as an execution.

## Rationale and consequences

Print mode does not wrap its no-op UI with observable dialog events. Unlike the earlier RPC bridge, the coordinator cannot diagnose every UI attempt. It uses native safe defaults rather than claiming universal interception.

Permission extensions must support headless denial. If they require human authorization, configure that separately; an ordinary parent/child text exchange cannot grant it. This is not a security sandbox against misbehaving trusted extensions.
