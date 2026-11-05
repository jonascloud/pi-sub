# 0003 — Messages, not interactive child UI

Status: Accepted

## Decision

Use ordinary child messages for progress, questions and answers. The parent decides whether a response requires further instruction or is the final result to accept. Pi becoming idle is not proof that the task is complete. Reading a question must not close the subagent.

Do not initially introduce a dedicated ask-parent framework or machine classification of question text. Control-tool names and schemas remain unspecified.

The coordinator renders its own status widget from child events. Child widget, status and title requests need no replies and are not forwarded into the parent's UI. Interactive child-extension dialogs (`confirm`, `select`, `input`, `editor`) are unsupported. If encountered, stop the affected task and report the unsupported interaction rather than silently approving or hanging. Never substitute a model's approval for human authorization.

## Rationale and consequences

The existing `RpcClient` already provides process control, prompts, steering, interruption, events, session inspection and usage access. Start with that client, not a new transport implementation. Its public API lacks a dialog-response writer and an exit callback; these are explicit limitations to validate, not reasons to rebuild the framework preemptively.

No child-dialog bridge is needed for our status widget or ordinary task communication. Extensions requiring interactive authorization are outside the initial compatibility boundary.
