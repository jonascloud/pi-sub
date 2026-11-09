# 0007 — File-backed handoffs

Status: Accepted

## Decision

A complete handoff is either the report text or a reference to its complete saved file. Delivery means that exact handoff reached the parent's model context, not that the parent read every detail. The parent chooses what to read. Acceptance, stopping and follow-up keep their existing meanings.

Never truncate serialized task reports. Bound the entire model-facing envelope, including metadata and file references. An oversized batch uses one file rather than an unbounded list of paths or additional notification turns. Preserve response text, errors and pending input in readable UTF-8, with full original diagnostics in native message details.

Save reports in private, ignored files alongside project session data. Finish writing before returning a reference and never overwrite an earlier report. Reuse successful writes within the current process, without shared-writer coordination or ongoing integrity checks. Keep files after tasks close and sessions stop: parent history still refers to them.

Report storage is not a prerequisite for user input. On a storage error, preserve the full report in native details, expose the confirmed task state and retain the result receipt. Failure cleanup can then finish without blocking the next prompt. This fallback is neither rollback nor complete reply delivery; ready-reply notifications still require a complete handoff.

## Rationale and consequences

Line-based truncation of compact JSON can erase the entire report, including identity and state. A file reference retains access without forcing large output into the model context. No new reading tool, read tracking or second delivery ledger is needed; native history retains the exact handoff and its reply identities.

Synchronous local writes avoid asynchronous snapshot coordination, but can delay the event loop for large reports or slow storage. File growth and cleanup are explicit ownership costs, like retained session journals. External edits or deletion can invalidate references; pi-sub does not monitor operator changes. See the [delivery contract](../../README.md#replies-and-delivery) for limits and native result shapes.
