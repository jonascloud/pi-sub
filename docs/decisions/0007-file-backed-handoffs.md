# 0007 — File-backed handoffs and volatile working data

Status: Accepted

## Decision

A complete handoff is either the report text or a reference to its complete saved file. Delivery means that exact handoff reached the parent's model context, not that the parent read every detail. The parent chooses what to read. Acceptance, stopping and follow-up keep their existing meanings.

Never truncate serialized task reports. Bound the entire model-facing envelope, including metadata and file references. An oversized batch uses one file rather than an unbounded list of paths or additional notification turns. Preserve response text, errors and pending input in readable UTF-8.

Each active parent session owns a private system-temporary workspace for child journals and oversized reports. Finish writing unique files before returning references; never overwrite an earlier report. Reuse successful writes only within that workspace, without shared-writer coordination or ongoing integrity checks. Keep reports after task acceptance or stop: the returned reference must still be readable.

On session switch, fork/clone, reload or orderly shutdown, close owned processes and capture final usage before deleting the workspace. Dispose of receipts and report reuse too. Reopening a saved conversation starts fresh. Preserve relevant findings in ordinary parent history or project artifacts before leaving the active session. Neither parent history nor project changes are deleted. Hard crashes may leave temporary files; no background garbage collector or guaranteed deletion deadline is introduced.

Native message details retain compact state/execution diagnostics, bounded previews and delivery hashes, not duplicate full reports or unsent instructions. Delivered inline text remains ordinary conversation content. Renderers expose that text or the temporary reference without loading file contents. An expired historical reference does not change the recorded task outcome.

Report storage is not a prerequisite for user input. On a storage error, expose the confirmed task state and retain the complete report only in the active coordinator's task or receipt for retry. Failure cleanup can finish without blocking the next prompt. This fallback is neither rollback nor complete reply delivery; ready-reply notifications still require a complete handoff. Process-closure failures still prevent workspace deletion.

## Rationale and consequences

Line-based truncation of compact JSON can erase the entire report, including identity and state. A file reference retains access without forcing large output into the model context. No new reading tool, read tracking or second delivery ledger is needed; native history retains the handoff and its reply identities.

Subagents are working context, not a parallel archive. Session ownership bounds retention by a clear user-visible lifetime without timers, reference scanners or restoration services. Storage can still grow within a long active session. Existing historical data is not rewritten, and legacy project-local directories are not automatically removed.

Synchronous local writes avoid asynchronous snapshot coordination, but can delay the event loop for large reports or slow storage. External edits or deletion can invalidate references; pi-sub does not monitor operator changes. See the [delivery contract](../../README.md#replies-and-delivery) for limits and native result shapes.
